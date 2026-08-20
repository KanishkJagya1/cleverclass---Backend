import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { requireAuth, requireRole, requirePrimaryManager } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { serializeOrderForManager, serializeOrderForManagerBill } from '../utils/serializers.js';
import { changeOrderStatus } from '../lib/orderStatus.js';
import { getPrintConfig } from './config.routes.js';
import { parsePagination, paginate, containsInsensitive } from '../utils/pagination.js';

const router = Router();
// The manager portal is MANAGER-only. Admins have their own dashboard and have
// no authority over the store's staff or pricing.
router.use(requireAuth, requireRole('MANAGER'));

// Payment states a manager may see: paid orders plus refunded (cancelled) ones.
const MGR_PAYMENT = ['PAID', 'BYPASSED', 'REFUNDED'];
// Managers only see orders that are paid & ready to fulfil (never pending-payment).
const FULFILLABLE = ['PLACED', 'PROCESSING', 'PRINTED', 'SHIPPED', 'DELIVERED'];
// Statuses a manager may filter/view (active queue + cancelled history).
const VIEWABLE = [...FULFILLABLE, 'CANCELLED'];

// Every manager belongs to the single default store; scope their view to it.
// (A manager with no store assigned sees nothing — the sentinel never matches.)
function storeScope(req) {
  return { storeId: req.user.storeId || '__no_store_assigned__' };
}

/* ============================ FULFILMENT QUEUE ============================
 * Visible to ALL managers (primary + ordinary). No pricing is exposed here.
 */

// GET /api/manager/orders?status=&q=&page=&pageSize=
router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const { status, q } = req.query;
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 12 });
    const where = {
      status: status && VIEWABLE.includes(status) ? status : { in: FULFILLABLE },
      paymentStatus: { in: MGR_PAYMENT },
      ...storeScope(req),
    };
    // Managers may search by order number only (customer identity is hidden from them).
    if (q && q.trim()) where.orderNumber = containsInsensitive(q.trim());
    const [orders, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take, include: { items: true } }),
      prisma.order.count({ where }),
    ]);
    res.json(paginate(orders.map((o) => serializeOrderForManager(o)), total, page, pageSize));
  })
);

// GET /api/manager/stats -> simple fulfilment board counts
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const groups = await prisma.order.groupBy({
      by: ['status'],
      where: { paymentStatus: { in: MGR_PAYMENT }, status: { in: VIEWABLE }, ...storeScope(req) },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(VIEWABLE.map((s) => [s, 0]));
    groups.forEach((g) => (counts[g.status] = g._count._all));
    res.json({ counts });
  })
);

// GET /api/manager/orders/:id
router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, paymentStatus: { in: MGR_PAYMENT }, ...storeScope(req) },
      include: { items: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    res.json({ data: serializeOrderForManager(order) });
  })
);

// PATCH /api/manager/orders/:id/status  (fulfilment transitions only)
router.patch(
  '/orders/:id/status',
  validate(z.object({ status: z.enum(['PROCESSING', 'PRINTED', 'SHIPPED', 'DELIVERED', 'CANCELLED']) })),
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, paymentStatus: { in: MGR_PAYMENT }, ...storeScope(req) },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    const updated = await changeOrderStatus({ order, status: req.body.status, include: { items: true } });
    res.json({ data: serializeOrderForManager(updated) });
  })
);

/* ============================ PRINT PRICING (primary only) ================
 * The primary manager owns the print pricing model. The admin can only send
 * change requests, which show here as notifications.
 */
const pricingSchema = z.object({
  perPageBW: z.number().nonnegative().optional(),
  perPageColor: z.number().nonnegative().optional(),
  bindingCost: z.number().nonnegative().optional(),
  minCharge: z.number().nonnegative().optional(),
  doubleSidedDiscountPct: z.number().min(0).max(100).optional(),
  currency: z.string().optional(),
});

function serializePricing(cfg) {
  return {
    perPageBW: Number(cfg.perPageBW),
    perPageColor: Number(cfg.perPageColor),
    bindingCost: Number(cfg.bindingCost),
    minCharge: Number(cfg.minCharge),
    doubleSidedDiscountPct: Number(cfg.doubleSidedDiscountPct),
    currency: cfg.currency,
  };
}

function serializePriceRequest(r) {
  return {
    id: r.id,
    kind: 'REQUEST',
    message: r.message,
    status: r.status, // OPEN | RESOLVED (acknowledged)
    createdAt: r.createdAt,
    acknowledgedAt: r.resolvedAt,
    from: r.createdBy?.name || 'Admin',
  };
}

function serializePriceEvent(e) {
  return {
    id: e.id,
    kind: 'CHANGE',
    before: e.before,
    after: e.after,
    createdAt: e.createdAt,
    from: e.changedBy?.name || 'Manager',
  };
}

// GET /api/manager/print-config -> current pricing + open-request count (badge).
router.get(
  '/print-config',
  requirePrimaryManager,
  asyncHandler(async (_req, res) => {
    const cfg = await getPrintConfig();
    const openCount = await prisma.priceChangeRequest.count({ where: { status: 'OPEN' } });
    res.json({ data: serializePricing(cfg), openCount });
  })
);

// GET /api/manager/price-requests/count -> lightweight open-request count for the sidebar badge
router.get(
  '/price-requests/count',
  requirePrimaryManager,
  asyncHandler(async (_req, res) => {
    const openCount = await prisma.priceChangeRequest.count({ where: { status: 'OPEN' } });
    res.json({ openCount });
  })
);

// GET /api/manager/price-activity -> unified, filterable, paginated pricing log:
// admin change REQUESTs + recorded price CHANGE events (newest first).
//   ?type=all|request|change  ?q=<search>  ?from=<ISO>  ?to=<ISO>  ?page=1  ?pageSize=5
router.get(
  '/price-activity',
  requirePrimaryManager,
  asyncHandler(async (req, res) => {
    const type = ['request', 'change'].includes(req.query.type) ? req.query.type : 'all';
    const q = (req.query.q || '').trim().toLowerCase();
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if (to) to.setHours(23, 59, 59, 999); // inclusive end-of-day
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize, 10) || 5));

    const [requests, events] = await Promise.all([
      type === 'change'
        ? []
        : prisma.priceChangeRequest.findMany({ include: { createdBy: { select: { name: true } } } }),
      type === 'request'
        ? []
        : prisma.priceChangeEvent.findMany({ include: { changedBy: { select: { name: true } } } }),
    ]);

    let items = [...requests.map(serializePriceRequest), ...events.map(serializePriceEvent)];

    // Search: request message, actor name, and (for changes) changed field names.
    if (q) {
      items = items.filter((it) => {
        const hay = [
          it.from,
          it.message || '',
          it.kind === 'CHANGE' ? `price change ${changedFieldKeys(it.before, it.after).join(' ')}` : '',
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    // Date range on createdAt.
    if (from) items = items.filter((it) => new Date(it.createdAt) >= from);
    if (to) items = items.filter((it) => new Date(it.createdAt) <= to);

    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const total = items.length;
    const start = (page - 1) * pageSize;
    const openCount = await prisma.priceChangeRequest.count({ where: { status: 'OPEN' } });

    res.json({
      items: items.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
      openCount,
    });
  })
);

// Which pricing fields differ between two snapshots (used for search + is-change guard).
function changedFieldKeys(before, after) {
  if (!before || !after) return [];
  const keys = ['perPageBW', 'perPageColor', 'bindingCost', 'minCharge', 'doubleSidedDiscountPct', 'currency'];
  return keys.filter((k) => String(before[k]) !== String(after[k]));
}

// PATCH /api/manager/print-config -> update the pricing model. Records a
// PriceChangeEvent (before/after snapshot) whenever a value actually changes.
router.patch(
  '/print-config',
  requirePrimaryManager,
  validate(pricingSchema),
  asyncHandler(async (req, res) => {
    const prev = await getPrintConfig();
    const before = serializePricing(prev);
    const cfg = await prisma.printConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...req.body },
      update: req.body,
    });
    const after = serializePricing(cfg);
    if (changedFieldKeys(before, after).length > 0) {
      await prisma.priceChangeEvent.create({ data: { before, after, changedById: req.user.id } });
      // Actually changing the price satisfies any pending admin requests — auto-acknowledge them.
      await prisma.priceChangeRequest.updateMany({
        where: { status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
    }
    res.json({ data: after });
  })
);

// PATCH /api/manager/price-requests/:id -> ACKNOWLEDGE an admin change request.
// The request stays on record (status RESOLVED) — it is not deleted.
router.patch(
  '/price-requests/:id',
  requirePrimaryManager,
  asyncHandler(async (req, res) => {
    const existing = await prisma.priceChangeRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Request not found');
    const updated =
      existing.status === 'RESOLVED'
        ? existing
        : await prisma.priceChangeRequest.update({
            where: { id: req.params.id },
            data: { status: 'RESOLVED', resolvedAt: new Date() },
            include: { createdBy: { select: { name: true } } },
          });
    res.json({ acknowledged: true, data: serializePriceRequest(updated) });
  })
);

/* ============================ PRINT ORDER RECORD (primary only) ===========
 * The priced record of every print order for the store — details + pricing.
 */
router.get(
  '/print-orders',
  requirePrimaryManager,
  asyncHandler(async (req, res) => {
    const { status, q } = req.query;
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    // PRINT and MIXED orders both carry print work for the store.
    const where = {
      type: { in: ['PRINT', 'MIXED'] },
      paymentStatus: { in: MGR_PAYMENT },
      ...storeScope(req),
      ...(status && VIEWABLE.includes(status) ? { status } : {}),
    };
    if (q && q.trim()) where.orderNumber = containsInsensitive(q.trim());
    const [orders, total, revenueAgg] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { items: true } }),
      prisma.order.count({ where }),
      // Store revenue = PRINT items only (never the buyer's digital-paper spend).
      prisma.orderItem.aggregate({ _sum: { lineTotal: true }, where: { kind: 'PRINT', order: { ...where, status: { not: 'CANCELLED' } } } }),
    ]);
    res.json(paginate(orders.map((o) => serializeOrderForManagerBill(o)), total, page, pageSize, { revenue: Number(revenueAgg._sum.lineTotal || 0) }));
  })
);

// GET /api/manager/summary -> store print-revenue dashboard (primary only)
router.get(
  '/summary',
  requirePrimaryManager,
  asyncHandler(async (req, res) => {
    const scope = storeScope(req);
    const paidPrinty = { type: { in: ['PRINT', 'MIXED'] }, paymentStatus: { in: MGR_PAYMENT }, ...scope };
    const [revenueAgg, printOrders, pending, delivered, pagesAgg] = await Promise.all([
      prisma.orderItem.aggregate({ _sum: { lineTotal: true }, where: { kind: 'PRINT', order: { ...paidPrinty, status: { not: 'CANCELLED' } } } }),
      prisma.order.count({ where: { ...paidPrinty, status: { not: 'CANCELLED' } } }),
      prisma.order.count({ where: { ...paidPrinty, status: { in: ['PLACED', 'PROCESSING'] } } }),
      prisma.order.count({ where: { ...paidPrinty, status: 'DELIVERED' } }),
      prisma.orderItem.aggregate({ _sum: { copies: true }, where: { kind: 'PRINT', order: { ...paidPrinty, status: { not: 'CANCELLED' } } } }),
    ]);
    res.json({
      printRevenue: Number(revenueAgg._sum.lineTotal || 0),
      printOrders,
      pendingFulfilment: pending,
      delivered,
      printJobs: Number(pagesAgg._sum.copies || 0),
    });
  })
);

/* ============================ STAFF (primary only) =======================
 * The primary manager adds/removes the store's managers. New managers are
 * scoped to this store. The last active primary manager cannot be removed or
 * demoted (prevents lock-out).
 */
function serializeStaff(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    isActive: u.isActive,
    isPrimaryManager: u.isPrimaryManager,
    createdAt: u.createdAt,
  };
}

const staffSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  isActive: true,
  isPrimaryManager: true,
  role: true,
  storeId: true,
  createdAt: true,
};

// Ensure the action won't remove the store's last active primary manager.
async function assertNotLastPrimary(req, target) {
  if (!(target.isPrimaryManager && target.isActive)) return; // target isn't a live primary
  const others = await prisma.user.count({
    where: {
      role: 'MANAGER',
      storeId: req.user.storeId,
      isPrimaryManager: true,
      isActive: true,
      id: { not: target.id },
    },
  });
  if (others === 0) {
    throw new ApiError(409, 'You cannot remove the last primary manager. Promote another manager first.');
  }
}

// Load a manager that belongs to this store (else 404).
async function loadStoreManager(req, id) {
  const m = await prisma.user.findFirst({
    where: { id, role: 'MANAGER', storeId: req.user.storeId },
    select: staffSelect,
  });
  if (!m) throw new ApiError(404, 'Manager not found');
  return m;
}

// GET /api/manager/staff -> managers of this store
router.get(
  '/staff',
  requirePrimaryManager,
  asyncHandler(async (req, res) => {
    const managers = await prisma.user.findMany({
      where: { role: 'MANAGER', ...storeScope(req) },
      orderBy: [{ isPrimaryManager: 'desc' }, { createdAt: 'asc' }],
      select: staffSelect,
    });
    res.json({ data: managers.map(serializeStaff) });
  })
);

// POST /api/manager/staff -> add a manager (primary = the "check")
router.post(
  '/staff',
  requirePrimaryManager,
  validate(
    z.object({
      name: z.string().min(2).max(80),
      email: z.string().email(),
      phone: z.string().min(6).max(20).optional(),
      password: z.string().min(6).max(72),
      isPrimaryManager: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (existing) throw new ApiError(409, 'An account with this email already exists');
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    const user = await prisma.user.create({
      data: {
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
        passwordHash,
        role: 'MANAGER',
        storeId: req.user.storeId,
        isPrimaryManager: Boolean(req.body.isPrimaryManager),
      },
      select: staffSelect,
    });
    res.status(201).json({ data: serializeStaff(user) });
  })
);

// PATCH /api/manager/staff/:id -> toggle primary / active
router.patch(
  '/staff/:id',
  requirePrimaryManager,
  validate(z.object({ isPrimaryManager: z.boolean().optional(), isActive: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const target = await loadStoreManager(req, req.params.id);
    const data = {};
    if (req.body.isPrimaryManager !== undefined) data.isPrimaryManager = req.body.isPrimaryManager;
    if (req.body.isActive !== undefined) data.isActive = req.body.isActive;

    // Demoting or deactivating a live primary must not remove the last one.
    const demoting = data.isPrimaryManager === false;
    const deactivating = data.isActive === false;
    if (demoting || deactivating) await assertNotLastPrimary(req, target);

    const user = await prisma.user.update({ where: { id: target.id }, data, select: staffSelect });
    res.json({ data: serializeStaff(user) });
  })
);

// DELETE /api/manager/staff/:id -> remove a manager
router.delete(
  '/staff/:id',
  requirePrimaryManager,
  asyncHandler(async (req, res) => {
    const target = await loadStoreManager(req, req.params.id);
    await assertNotLastPrimary(req, target);
    // Managers never own orders, so a hard delete is safe.
    await prisma.user.delete({ where: { id: target.id } });
    res.json({ deleted: true });
  })
);

export default router;
