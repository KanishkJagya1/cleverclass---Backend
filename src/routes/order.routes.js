import { Router } from 'express';
import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { effectivePaperPrice, evaluateCoupon, computePrintCost, money, seriesQuote } from '../utils/pricing.js';
import { serializeOrder, serializePaper, serializeTestSeries } from '../utils/serializers.js';
import { createPaymentOrder, verifyPaymentSignature } from '../lib/razorpay.js';
import { signToken, verifyToken } from '../lib/jwt.js';
import { getPrintConfig } from './config.routes.js';
import { logger } from '../lib/logger.js';
import { getDefaultStoreId } from '../lib/stores.js';
import { parsePagination, paginate } from '../utils/pagination.js';

const router = Router();
const orderNo = customAlphabet('0123456789ABCDEFGHJKMNPQRSTUVWXYZ', 8);
const PAID = ['PAID', 'BYPASSED'];

const shippingSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(6),
  email: z.string().email().optional(),
  line1: z.string().min(3),
  line2: z.string().optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  pincode: z.string().min(3),
});

// A single unified item. `mode` says what it is; one bag can mix all three.
const itemSchema = z.object({
  mode: z.enum(['BUY', 'BUY_SERIES', 'PRINT']),
  paperId: z.string().optional(),
  documentId: z.string().optional(),
  seriesId: z.string().optional(),
  copies: z.number().int().positive().max(1000).optional(),
  color: z.boolean().optional(),
  doubleSided: z.boolean().optional(),
  binding: z.boolean().optional(),
  pages: z.number().int().positive().max(5000).optional(),
});

const createSchema = z.object({
  items: z.array(itemSchema).min(1),
  couponCode: z.string().optional(),
  shipping: shippingSchema,
  notes: z.string().max(500).optional(),
});

// Split a bundle total across N papers so the line items sum exactly to it.
function allocate(total, n) {
  const each = Math.floor((Number(total) / n) * 100) / 100;
  const arr = Array(n).fill(each);
  arr[n - 1] = money(Number(total) - each * (n - 1));
  return arr;
}

// Does the user already OWN this paper digitally? (Only a BUY grants ownership —
// printing a paper does not.)
async function ownsPaper(userId, paperId) {
  const hit = await prisma.order.findFirst({
    where: { userId, paymentStatus: { in: PAID }, items: { some: { paperId, kind: 'PAPER' } } },
    select: { id: true },
  });
  return Boolean(hit);
}

function buildPrintItem(cfg, { title, paperId = null, documentId = null }, it) {
  const pages = it.pages || 1;
  const opts = { pages, copies: it.copies || 1, color: !!it.color, doubleSided: !!it.doubleSided, binding: !!it.binding };
  const { unitPrice, lineTotal, copies } = computePrintCost(cfg, opts);
  return { kind: 'PRINT', paperId, documentId, seriesId: null, seriesTitle: null, title: `Print: ${title}`, copies, unitPrice, lineTotal, printOptions: opts };
}

/**
 * Build validated, server-priced order items from a unified bag. Prices are
 * never trusted from the client. Supports BUY (digital paper), BUY_SERIES
 * (bundle → member papers), and PRINT (catalog paper or uploaded document).
 */
async function buildItems(items, userId) {
  const built = [];
  let cfg = null;
  const getCfg = async () => (cfg ||= await getPrintConfig());

  for (const it of items) {
    if (it.mode === 'BUY') {
      if (!it.paperId) throw new ApiError(400, 'paperId is required for a BUY item');
      const paper = await prisma.paper.findFirst({ where: { id: it.paperId, isActive: true } });
      if (!paper) throw new ApiError(404, `Paper ${it.paperId} not found`);
      if (await ownsPaper(userId, paper.id)) throw new ApiError(400, `You already own "${paper.title}". Read it from My Library.`);
      const eff = effectivePaperPrice(paper);
      built.push({ kind: 'PAPER', paperId: paper.id, documentId: null, seriesId: null, seriesTitle: null, title: paper.title, copies: 1, unitPrice: eff.price, lineTotal: eff.price, printOptions: { pages: paper.pages || null } });
    } else if (it.mode === 'BUY_SERIES') {
      if (!it.seriesId) throw new ApiError(400, 'seriesId is required for a BUY_SERIES item');
      const series = await prisma.testSeries.findFirst({
        where: { OR: [{ id: it.seriesId }, { slug: it.seriesId }], isActive: true },
        include: { papers: { orderBy: { position: 'asc' }, include: { paper: true } } },
      });
      if (!series) throw new ApiError(404, 'Test series not found');
      const members = series.papers.map((l) => l.paper).filter((p) => p && p.isActive);
      if (!members.length) throw new ApiError(400, 'This series has no papers to sell');
      // Papers the buyer already owns are excluded — not re-charged, not re-granted.
      const ownedFlags = await Promise.all(members.map((p) => ownsPaper(userId, p.id)));
      const ownedIds = new Set(members.filter((_p, i) => ownedFlags[i]).map((p) => p.id));
      if (ownedIds.size === members.length) throw new ApiError(400, `You already own every paper in "${series.title}".`);
      // Price the not-yet-owned papers in the same ratio (bundle discount preserved).
      const quote = seriesQuote(series, members, ownedIds);
      const shares = allocate(quote.yourPrice, quote.notOwned.length);
      quote.notOwned.forEach((paper, i) => {
        built.push({ kind: 'PAPER', paperId: paper.id, documentId: null, seriesId: series.id, seriesTitle: series.title, title: paper.title, copies: 1, unitPrice: shares[i], lineTotal: shares[i], printOptions: { pages: paper.pages || null } });
      });
    } else {
      // PRINT — catalog paper or uploaded document, priced only by the print model.
      const c = await getCfg();
      if (it.paperId) {
        const paper = await prisma.paper.findFirst({ where: { id: it.paperId, isActive: true } });
        if (!paper) throw new ApiError(404, `Paper ${it.paperId} not found`);
        built.push(buildPrintItem(c, { title: paper.title, paperId: paper.id }, { ...it, pages: it.pages || paper.pages || 1 }));
      } else if (it.documentId) {
        const doc = await prisma.document.findFirst({ where: { id: it.documentId, userId } });
        if (!doc) throw new ApiError(404, `Document ${it.documentId} not found`);
        built.push(buildPrintItem(c, { title: doc.fileName, documentId: doc.id }, { ...it, pages: it.pages || doc.pages || 1 }));
      } else {
        throw new ApiError(400, 'Each PRINT item requires a paperId or documentId');
      }
    }
  }
  return built;
}

// POST /api/orders -> price the cart & open a payment intent.
// NOTE: no order row is created here. The order is only persisted once payment
// is confirmed (see /verify), so an unpaid/pending order can never exist. The
// server-priced draft is returned as a signed token the client hands back to
// /verify (the client cannot tamper with prices — the token is signed).
router.post(
  '/',
  requireAuth,
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const { items, couponCode, shipping, notes } = req.body;

    const built = await buildItems(items, req.user.id);
    const subtotal = money(built.reduce((s, it) => s + it.lineTotal, 0));

    // A single checkout = a single order, whatever the mix. Derive its type and
    // fulfilment status from the items it contains.
    const hasPrint = built.some((b) => b.kind === 'PRINT');
    const hasBuy = built.some((b) => b.kind === 'PAPER');
    const type = hasBuy && hasPrint ? 'MIXED' : hasPrint ? 'PRINT' : 'PURCHASE';
    // Bought papers are instant; anything to print enters fulfilment.
    const status = hasPrint ? 'PLACED' : 'BOUGHT';

    // Coupon
    let discount = 0;
    let coupon = null;
    if (couponCode) {
      coupon = await prisma.coupon.findUnique({ where: { code: couponCode.toUpperCase() } });
      const evalResult = evaluateCoupon(coupon, subtotal);
      if (!evalResult.valid) throw new ApiError(400, `Coupon invalid: ${evalResult.reason}`);
      discount = evalResult.discount;
    }
    const total = money(subtotal - discount);

    // Only orders with something to print are routed to the (single) default store.
    const storeId = hasPrint ? await getDefaultStoreId() : null;
    const orderNumber = `CC-${orderNo()}`;

    // Payment intent (Razorpay or bypass)
    const payment = await createPaymentOrder({
      amount: total,
      currency: 'INR',
      receipt: orderNumber,
      notes: { orderNumber },
    });

    // Signed draft — everything needed to persist the order after payment.
    const draftToken = signToken({
      draft: true,
      userId: req.user.id,
      orderNumber,
      storeId,
      type,
      status,
      currency: 'INR',
      items: built,
      subtotal,
      discount,
      total,
      couponId: coupon ? coupon.id : null,
      couponCode: coupon ? coupon.code : null,
      shipping,
      notes: notes || null,
      razorpayOrderId: payment.id,
    });

    logger.event('order.intent', { orderNumber, userId: req.user.id, type, total });

    res.status(201).json({
      draftToken,
      orderPreview: { orderNumber, subtotal, discount, total, currency: 'INR' },
      payment: {
        provider: 'razorpay',
        bypass: payment.bypass,
        razorpayOrderId: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        keyId: payment.keyId,
      },
    });
  })
);

// POST /api/orders/verify -> confirm payment and CREATE the order.
router.post(
  '/verify',
  requireAuth,
  validate(
    z.object({
      token: z.string(),
      razorpayPaymentId: z.string().optional(),
      razorpayOrderId: z.string().optional(),
      razorpaySignature: z.string().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    let draft;
    try {
      draft = verifyToken(req.body.token);
    } catch {
      throw new ApiError(400, 'Checkout session expired — please try again.');
    }
    if (!draft?.draft || draft.userId !== req.user.id) throw new ApiError(400, 'Invalid checkout session');

    // Idempotency: a repeated verify for the same intent returns the order.
    const existing = await prisma.order.findFirst({
      where: { razorpayOrderId: draft.razorpayOrderId, userId: req.user.id },
      include: { items: true, user: true, store: true },
    });
    if (existing) return res.json({ order: serializeOrder(existing), alreadyPaid: true });

    const { razorpayPaymentId, razorpaySignature } = req.body;
    const ok = verifyPaymentSignature({
      orderId: draft.razorpayOrderId,
      paymentId: razorpayPaymentId,
      signature: razorpaySignature,
    });
    if (!ok) throw new ApiError(400, 'Payment verification failed');

    const bypass = String(draft.razorpayOrderId || '').startsWith('bypass_') || !razorpaySignature;
    const s = draft.shipping;

    const created = await prisma.$transaction(async (tx) => {
      if (draft.couponId) {
        await tx.coupon.update({ where: { id: draft.couponId }, data: { usedCount: { increment: 1 } } });
      }
      return tx.order.create({
        data: {
          orderNumber: draft.orderNumber,
          userId: req.user.id,
          storeId: draft.storeId,
          type: draft.type,
          // Buy-only is terminal (BOUGHT); anything with printing enters fulfilment.
          status: draft.status || (draft.type === 'PURCHASE' ? 'BOUGHT' : 'PLACED'),
          paymentStatus: bypass ? 'BYPASSED' : 'PAID',
          subtotal: draft.subtotal,
          discount: draft.discount,
          total: draft.total,
          currency: draft.currency,
          couponId: draft.couponId,
          couponCode: draft.couponCode,
          razorpayOrderId: draft.razorpayOrderId,
          razorpayPaymentId: razorpayPaymentId || `bypass_pay_${Date.now()}`,
          razorpaySignature: razorpaySignature || null,
          shipName: s.name,
          shipPhone: s.phone,
          shipEmail: s.email,
          shipLine1: s.line1,
          shipLine2: s.line2,
          shipCity: s.city,
          shipState: s.state,
          shipPincode: s.pincode,
          notes: draft.notes,
          items: { create: draft.items },
        },
        include: { items: true, user: true, store: true },
      });
    });

    logger.event('order.paid', { orderId: created.id, orderNumber: created.orderNumber, method: bypass ? 'bypass' : 'razorpay' });
    res.status(201).json({ order: serializeOrder(created), paid: true });
  })
);

// GET /api/orders/paper/:paperId/owned -> has the current user bought this paper?
router.get(
  '/paper/:paperId/owned',
  requireAuth,
  asyncHandler(async (req, res) => {
    const owned = await prisma.order.findFirst({
      where: {
        userId: req.user.id,
        paymentStatus: { in: PAID },
        items: { some: { paperId: req.params.paperId, kind: 'PAPER' } },
      },
      select: { id: true },
    });
    res.json({ owned: Boolean(owned) });
  })
);

// GET /api/orders/owned-ids -> ids of every paper the user owns (for catalog badges)
router.get(
  '/owned-ids',
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await prisma.orderItem.findMany({
      where: { paperId: { not: null }, kind: 'PAPER', order: { userId: req.user.id, paymentStatus: { in: PAID } } },
      select: { paperId: true },
      distinct: ['paperId'],
    });
    res.json({ ids: items.map((i) => i.paperId) });
  })
);

// GET /api/orders/library -> the distinct papers the user has bought (their library)
router.get(
  '/library',
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await prisma.orderItem.findMany({
      where: { paperId: { not: null }, kind: 'PAPER', order: { userId: req.user.id, paymentStatus: { in: PAID } } },
      include: { paper: true, order: { select: { id: true, orderNumber: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const seen = new Set();
    const data = [];
    for (const it of items) {
      if (!it.paper || seen.has(it.paperId)) continue;
      seen.add(it.paperId);
      data.push({ ...serializePaper(it.paper), boughtAt: it.order.createdAt, orderId: it.order.id, orderNumber: it.order.orderNumber });
    }
    res.json({ data });
  })
);

// GET /api/orders/series/:seriesId/quote -> a personalized bundle price. If the
// buyer already owns some member papers, the price is reduced in the same ratio.
router.get(
  '/series/:seriesId/quote',
  requireAuth,
  asyncHandler(async (req, res) => {
    const series = await prisma.testSeries.findFirst({
      where: { OR: [{ id: req.params.seriesId }, { slug: req.params.seriesId }], isActive: true },
      include: { papers: { orderBy: { position: 'asc' }, include: { paper: true } } },
    });
    if (!series) throw new ApiError(404, 'Test series not found');
    const members = series.papers.map((l) => l.paper).filter((p) => p && p.isActive);
    const ownedFlags = await Promise.all(members.map((p) => ownsPaper(req.user.id, p.id)));
    const ownedIds = new Set(members.filter((_p, i) => ownedFlags[i]).map((p) => p.id));
    const q = seriesQuote(series, members, ownedIds);
    res.json({
      full: q.full,
      yourPrice: q.yourPrice,
      reduction: q.reduction,
      ownedCount: q.ownedCount,
      memberCount: members.length,
      ownsAll: members.length > 0 && ownedIds.size === members.length,
      ownedTitles: members.filter((_p, i) => ownedFlags[i]).map((p) => p.title),
    });
  })
);

// GET /api/orders/material -> the user's "My Material": standalone-bought papers
// at the top level PLUS every test series they bought as a folder (with its
// member papers). A paper bought on its own shows standalone; a paper obtained
// only inside a bought series shows only inside that series' folder. A paper can
// legitimately appear both places (bought standalone AND inside a bought series).
router.get(
  '/material',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const items = await prisma.orderItem.findMany({
      where: { kind: 'PAPER', order: { userId, paymentStatus: { in: PAID } } },
      include: { paper: true, order: { select: { id: true, orderNumber: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const seenPaper = new Set();
    const papers = [];
    const seriesMeta = new Map(); // seriesId -> { boughtAt, orderNumber }
    for (const it of items) {
      if (it.seriesId && !seriesMeta.has(it.seriesId)) {
        seriesMeta.set(it.seriesId, { boughtAt: it.order.createdAt, orderNumber: it.order.orderNumber });
      }
      // Standalone = bought directly (not via a series bundle).
      if (!it.seriesId && it.paper && !seenPaper.has(it.paperId)) {
        seenPaper.add(it.paperId);
        papers.push({ ...serializePaper(it.paper), boughtAt: it.order.createdAt, orderId: it.order.id, orderNumber: it.order.orderNumber });
      }
    }

    const seriesRows = seriesMeta.size
      ? await prisma.testSeries.findMany({
          where: { id: { in: [...seriesMeta.keys()] } },
          include: { papers: { orderBy: { position: 'asc' }, include: { paper: true } } },
        })
      : [];
    const series = seriesRows.map((s) => ({ ...serializeTestSeries(s), ...seriesMeta.get(s.id) }));

    res.json({ papers, series });
  })
);

// GET /api/orders -> current user's orders
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { q, type } = req.query;
    const where = { userId: req.user.id };
    if (type) where.type = type;
    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { orderNumber: { contains: term, mode: 'insensitive' } },
        { items: { some: { title: { contains: term, mode: 'insensitive' } } } },
      ];
    }
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { items: { include: { paper: { select: { viewable: true, slug: true } } } } },
      }),
      prisma.order.count({ where }),
    ]);
    res.json(paginate(orders.map((o) => serializeOrder(o)), total, page, pageSize));
  })
);

// GET /api/orders/:id -> a single order the user owns
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: { items: { include: { paper: { select: { viewable: true, slug: true } } } }, user: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    res.json({ data: serializeOrder(order) });
  })
);

export default router;
