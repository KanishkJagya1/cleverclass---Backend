import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { uploadPaperAssets } from '../middleware/upload.js';
import { saveFile, deleteFile } from '../lib/storage.js';
import { serializePaper, serializeOrder, serializeTestSeries } from '../utils/serializers.js';
import { uniqueSlug } from '../utils/slug.js';
import { countPdfPages } from '../utils/pdf.js';
import { fetchRemotePdf, fetchRemoteImage } from '../utils/remotePdf.js';
import { changeOrderStatus, resolveRefund } from '../lib/orderStatus.js';
import { getPrintConfig } from './config.routes.js';
import { parsePagination, paginate, containsInsensitive } from '../utils/pagination.js';

const router = Router();
router.use(requireAuth, requireRole('ADMIN'));

/* ------------------------------------------------------------------ helpers */
const toNum = (v) => (v === undefined || v === '' || v === null ? undefined : Number(v));
const toBool = (v) => v === true || v === 'true' || v === '1' || v === 'on';
const toDate = (v) => (v ? new Date(v) : null);

/* ============================== DASHBOARD ============================== */
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const paidWhere = { paymentStatus: { in: ['PAID', 'BYPASSED'] } };

    const [users, papers, orders, paidAgg, pending, coupons, recent] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.paper.count(),
      prisma.order.count(),
      prisma.order.aggregate({ _sum: { total: true }, where: paidWhere }),
      prisma.order.count({ where: { status: { in: ['PLACED', 'PROCESSING'] } } }),
      prisma.coupon.count({ where: { isActive: true } }),
      prisma.order.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: { items: true, user: true },
      }),
    ]);

    res.json({
      totals: {
        customers: users,
        papers,
        orders,
        revenue: Number(paidAgg._sum.total || 0),
        pendingFulfilment: pending,
        activeCoupons: coupons,
      },
      recentOrders: recent.map((o) => serializeOrder(o)),
    });
  })
);

/* ============================== PAPERS ============================== */

// List all papers (incl inactive)
router.get(
  '/papers',
  asyncHandler(async (req, res) => {
    const { q, status, featured, sale, from, to } = req.query;
    const where = {};
    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { title: containsInsensitive(term) },
        { subject: containsInsensitive(term) },
        { board: containsInsensitive(term) },
        { grade: containsInsensitive(term) },
        { description: containsInsensitive(term) },
      ];
    }
    if (status === 'active') where.isActive = true;
    else if (status === 'hidden') where.isActive = false;
    if (featured === 'featured') where.isFeatured = true;
    else if (featured === 'plain') where.isFeatured = false;
    if (sale === 'sale') where.salePrice = { not: null };
    else if (sale === 'regular') where.salePrice = null;
    applyDateRange(where, from, to);

    // `?all=1` returns every matching paper unpaginated — used by the series
    // paper-picker where the full list must be selectable.
    if (req.query.all === '1') {
      const papers = await prisma.paper.findMany({ where, orderBy: { createdAt: 'desc' } });
      const data = papers.map((p) => serializePaper(p, { includeFile: true }));
      return res.json(paginate(data, data.length, 1, data.length || 1));
    }

    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    const [papers, total] = await Promise.all([
      prisma.paper.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.paper.count({ where }),
    ]);
    res.json(paginate(papers.map((p) => serializePaper(p, { includeFile: true })), total, page, pageSize));
  })
);

// Create a paper (multipart: file[pdf], coverImage[optional])
router.post(
  '/papers',
  uploadPaperAssets.fields([
    { name: 'file', maxCount: 1 },
    { name: 'coverImage', maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (!b.title) throw new ApiError(400, 'title is required');
    if (b.price === undefined || b.price === '') throw new ApiError(400, 'price is required');
    const pdf = req.files?.file?.[0];
    if (!pdf) throw new ApiError(400, 'A PDF file is required (field: file)');

    const pages = countPdfPages(pdf.buffer);
    const saved = await saveFile({
      buffer: pdf.buffer,
      originalName: pdf.originalname,
      mimetype: pdf.mimetype,
      folder: 'papers',
    });

    let coverImage = null;
    const cover = req.files?.coverImage?.[0];
    if (cover) {
      const c = await saveFile({
        buffer: cover.buffer,
        originalName: cover.originalname,
        mimetype: cover.mimetype,
        folder: 'papers/covers',
      });
      coverImage = `/api/download/asset?provider=${c.provider}&key=${encodeURIComponent(c.key)}`;
    }

    const slug = await uniqueSlug(b.title, async (s) => Boolean(await prisma.paper.findUnique({ where: { slug: s } })));

    const paper = await prisma.paper.create({
      data: {
        title: b.title,
        slug,
        description: b.description || null,
        subject: b.subject || null,
        board: b.board || null,
        grade: b.grade || null,
        year: toNum(b.year) || null,
        previewText: b.previewText || null,
        coverImage,
        price: Number(b.price),
        salePrice: toNum(b.salePrice) ?? null,
        saleStartsAt: toDate(b.saleStartsAt),
        saleEndsAt: toDate(b.saleEndsAt),
        storageProvider: saved.provider,
        fileKey: saved.key,
        fileName: saved.fileName,
        fileSize: saved.size,
        pages: pages || toNum(b.pages) || null,
        isActive: b.isActive === undefined ? true : toBool(b.isActive),
        isFeatured: toBool(b.isFeatured),
        viewable: toBool(b.viewable),
      },
    });
    res.status(201).json({ data: serializePaper(paper, { includeFile: true }) });
  })
);

// Update a paper (JSON or multipart to replace file)
router.patch(
  '/papers/:id',
  uploadPaperAssets.fields([
    { name: 'file', maxCount: 1 },
    { name: 'coverImage', maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const existing = await prisma.paper.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Paper not found');
    const b = req.body;
    const data = {};
    if (b.title !== undefined) data.title = b.title;
    if (b.description !== undefined) data.description = b.description;
    if (b.subject !== undefined) data.subject = b.subject;
    if (b.board !== undefined) data.board = b.board;
    if (b.grade !== undefined) data.grade = b.grade;
    if (b.year !== undefined) data.year = toNum(b.year) || null;
    if (b.previewText !== undefined) data.previewText = b.previewText;
    if (b.price !== undefined) data.price = Number(b.price);
    if (b.salePrice !== undefined) data.salePrice = toNum(b.salePrice) ?? null;
    if (b.saleStartsAt !== undefined) data.saleStartsAt = toDate(b.saleStartsAt);
    if (b.saleEndsAt !== undefined) data.saleEndsAt = toDate(b.saleEndsAt);
    if (b.isActive !== undefined) data.isActive = toBool(b.isActive);
    if (b.isFeatured !== undefined) data.isFeatured = toBool(b.isFeatured);
    if (b.viewable !== undefined) data.viewable = toBool(b.viewable);

    const pdf = req.files?.file?.[0];
    if (pdf) {
      const saved = await saveFile({
        buffer: pdf.buffer,
        originalName: pdf.originalname,
        mimetype: pdf.mimetype,
        folder: 'papers',
      });
      await deleteFile({ provider: existing.storageProvider, key: existing.fileKey });
      data.storageProvider = saved.provider;
      data.fileKey = saved.key;
      data.fileName = saved.fileName;
      data.fileSize = saved.size;
      data.pages = countPdfPages(pdf.buffer) || existing.pages;
    }
    const cover = req.files?.coverImage?.[0];
    if (cover) {
      const c = await saveFile({
        buffer: cover.buffer,
        originalName: cover.originalname,
        mimetype: cover.mimetype,
        folder: 'papers/covers',
      });
      data.coverImage = `/api/download/asset?provider=${c.provider}&key=${encodeURIComponent(c.key)}`;
    }

    const paper = await prisma.paper.update({ where: { id: req.params.id }, data });
    res.json({ data: serializePaper(paper, { includeFile: true }) });
  })
);

router.delete(
  '/papers/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.paper.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Paper not found');
    const usedInOrder = await prisma.orderItem.findFirst({ where: { paperId: existing.id } });
    if (usedInOrder) {
      // Soft-delete to preserve order history
      await prisma.paper.update({ where: { id: existing.id }, data: { isActive: false } });
      return res.json({ softDeleted: true, message: 'Paper has orders; deactivated instead of deleting' });
    }
    await deleteFile({ provider: existing.storageProvider, key: existing.fileKey });
    await prisma.paper.delete({ where: { id: existing.id } });
    res.json({ deleted: true });
  })
);

/* ===================== BULK PAPER IMPORT (CSV) ===================== */
// Duplicate identity = normalized title + board + grade + year (metadata only).
const normKey = (r) => [r.title, r.board, r.grade, r.year].map((v) => String(v ?? '').trim().toLowerCase()).join('|');

// Run an async mapper over items with limited concurrency (downloads are network-bound).
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function saveCoverFromBuffer(buffer, mimetype, originalName) {
  const c = await saveFile({ buffer, originalName: originalName || 'cover', mimetype, folder: 'papers/covers' });
  return `/api/download/asset?provider=${c.provider}&key=${encodeURIComponent(c.key)}`;
}

// Check which CSV rows already exist in the DB (by normalized metadata key).
router.post(
  '/papers/bulk/check',
  validate(z.object({
    rows: z.array(z.object({
      title: z.string(),
      board: z.string().nullable().optional(),
      grade: z.string().nullable().optional(),
      year: z.union([z.number(), z.string()]).nullable().optional(),
    })).max(2000),
  })),
  asyncHandler(async (req, res) => {
    const { rows } = req.body;
    const titles = [...new Set(rows.map((r) => (r.title || '').trim()).filter(Boolean))];
    if (!titles.length) return res.json({ matches: {} });
    const candidates = await prisma.paper.findMany({
      where: { OR: titles.map((t) => ({ title: { equals: t, mode: 'insensitive' } })) },
      select: { id: true, title: true, board: true, grade: true, year: true, isActive: true },
    });
    const byKey = new Map();
    for (const p of candidates) byKey.set(normKey(p), { id: p.id, title: p.title, isActive: p.isActive });
    const matches = {};
    rows.forEach((r, i) => { const m = byKey.get(normKey(r)); if (m) matches[i] = m; });
    res.json({ matches });
  })
);

// Commit the reviewed rows: create new papers / update existing / skip, downloading each
// PDF from its link (or an attached override file). Returns per-row results + resolved paper ids.
router.post(
  '/papers/bulk/commit',
  uploadPaperAssets.any(),
  asyncHandler(async (req, res) => {
    let payload;
    try { payload = JSON.parse(req.body.payload || '{}'); } catch { throw new ApiError(400, 'Invalid payload'); }
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length) throw new ApiError(400, 'No rows to import');
    const defaultActive = payload.defaultActive !== false; // series mode passes false
    const filesByField = {};
    for (const f of req.files || []) filesByField[f.fieldname] = f;

    const results = await mapPool(rows, 4, async (row, index) => {
      try {
        const resolution = row.resolution || 'create';
        if (resolution === 'skip') {
          return { index, status: 'skipped', id: row.existingId || null };
        }
        if (!row.title || row.price === undefined || row.price === '' || row.price === null) {
          throw new ApiError(400, 'title and price are required');
        }

        // Resolve the PDF: an attached override file wins, else the link.
        const attached = row.fileField ? filesByField[row.fileField] : null;
        let pdfBuffer = null;
        let pdfName = null;
        if (attached) { pdfBuffer = attached.buffer; pdfName = attached.originalname; }
        else if (row.pdfUrl) { pdfBuffer = await fetchRemotePdf(row.pdfUrl); pdfName = `${row.title}.pdf`; }

        // Resolve the cover (optional): attached override file, else the link.
        const coverAttached = row.coverField ? filesByField[row.coverField] : null;
        let coverUrl = null;
        if (coverAttached) coverUrl = await saveCoverFromBuffer(coverAttached.buffer, coverAttached.mimetype, coverAttached.originalname);
        else if (row.coverImageUrl) { try { const img = await fetchRemoteImage(row.coverImageUrl); coverUrl = await saveCoverFromBuffer(img.buffer, img.mimetype, 'cover'); } catch { /* cover is optional */ } }

        const active = row.active === undefined ? defaultActive : Boolean(row.active);
        const scalar = {
          title: row.title,
          description: row.description || null,
          subject: row.subject || null,
          board: row.board || null,
          grade: row.grade || null,
          year: toNum(row.year) || null,
          previewText: row.previewText || null,
          price: Number(row.price),
          salePrice: toNum(row.salePrice) ?? null,
          isActive: active,
          isFeatured: Boolean(row.featured),
          viewable: Boolean(row.viewable),
        };

        if (resolution === 'update' && row.existingId) {
          const existing = await prisma.paper.findUnique({ where: { id: row.existingId } });
          if (!existing) throw new ApiError(404, 'Existing paper not found');
          const data = { ...scalar };
          if (coverUrl) data.coverImage = coverUrl;
          if (pdfBuffer) {
            const saved = await saveFile({ buffer: pdfBuffer, originalName: pdfName, mimetype: 'application/pdf', folder: 'papers' });
            if (existing.fileKey) await deleteFile({ provider: existing.storageProvider, key: existing.fileKey }).catch(() => {});
            data.storageProvider = saved.provider;
            data.fileKey = saved.key;
            data.fileName = saved.fileName;
            data.fileSize = saved.size;
            data.pages = countPdfPages(pdfBuffer) || existing.pages;
          }
          const p = await prisma.paper.update({ where: { id: existing.id }, data });
          return { index, status: 'updated', id: p.id };
        }

        // create
        if (!pdfBuffer) throw new ApiError(400, 'No PDF — add a valid link or attach a file');
        const saved = await saveFile({ buffer: pdfBuffer, originalName: pdfName, mimetype: 'application/pdf', folder: 'papers' });
        const slug = await uniqueSlug(row.title, async (s) => Boolean(await prisma.paper.findUnique({ where: { slug: s } })));
        const p = await prisma.paper.create({
          data: {
            ...scalar,
            slug,
            coverImage: coverUrl,
            storageProvider: saved.provider,
            fileKey: saved.key,
            fileName: saved.fileName,
            fileSize: saved.size,
            pages: countPdfPages(pdfBuffer) || null,
          },
        });
        return { index, status: 'created', id: p.id };
      } catch (e) {
        return { index, status: 'failed', error: e.message || 'Failed' };
      }
    });

    // Resolved paper ids in row order (for the series modal to attach), skipping failures.
    const paperIds = results.filter((r) => r.id).map((r) => r.id);
    res.json({ results, paperIds });
  })
);

/* ============================== TEST SERIES ============================== */
const seriesWithPapers = { papers: { orderBy: { position: 'asc' }, include: { paper: true } } };

// Replace a series' member papers with the given ordered list of paper ids.
async function setSeriesPapers(seriesId, paperIds) {
  await prisma.testSeriesPaper.deleteMany({ where: { seriesId } });
  if (Array.isArray(paperIds) && paperIds.length) {
    // De-dupe while preserving order.
    const seen = new Set();
    const ordered = paperIds.filter((id) => (seen.has(id) ? false : seen.add(id)));
    await prisma.testSeriesPaper.createMany({
      data: ordered.map((paperId, i) => ({ seriesId, paperId, position: i })),
      skipDuplicates: true,
    });
  }
}

// List all series (incl inactive), paginated + searchable + filterable.
router.get(
  '/series',
  asyncHandler(async (req, res) => {
    const { q, status, featured, from, to } = req.query;
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    const where = {};
    if (q && q.trim()) where.OR = [{ title: containsInsensitive(q.trim()) }, { subject: containsInsensitive(q.trim()) }];
    if (status === 'active') where.isActive = true;
    else if (status === 'hidden') where.isActive = false;
    if (featured === 'featured') where.isFeatured = true;
    else if (featured === 'plain') where.isFeatured = false;
    applyDateRange(where, from, to);
    const [series, total] = await Promise.all([
      prisma.testSeries.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: seriesWithPapers }),
      prisma.testSeries.count({ where }),
    ]);
    res.json(paginate(series.map((s) => serializeTestSeries(s)), total, page, pageSize));
  })
);

const seriesSchema = z.object({
  title: z.string().min(2).max(120),
  description: z.string().max(2000).optional().nullable(),
  subject: z.string().max(80).optional().nullable(),
  coverImage: z.string().max(500).optional().nullable(),
  price: z.number().nonnegative().optional().nullable(),
  salePrice: z.number().nonnegative().optional().nullable(),
  discountPct: z.number().int().min(0).max(90).optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  paperIds: z.array(z.string()).optional(),
});

router.post(
  '/series',
  validate(seriesSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const slug = await uniqueSlug(b.title, async (s) => Boolean(await prisma.testSeries.findUnique({ where: { slug: s } })));
    const series = await prisma.testSeries.create({
      data: {
        title: b.title,
        slug,
        description: b.description ?? null,
        subject: b.subject ?? null,
        coverImage: b.coverImage ?? null,
        price: b.price ?? null,
        salePrice: b.salePrice ?? null,
        discountPct: b.discountPct ?? 10,
        isActive: b.isActive ?? true,
        isFeatured: b.isFeatured ?? false,
      },
    });
    if (b.paperIds) await setSeriesPapers(series.id, b.paperIds);
    const full = await prisma.testSeries.findUnique({ where: { id: series.id }, include: seriesWithPapers });
    res.status(201).json({ data: serializeTestSeries(full) });
  })
);

router.patch(
  '/series/:id',
  validate(seriesSchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.testSeries.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Test series not found');
    const b = req.body;
    const data = {};
    for (const k of ['title', 'description', 'subject', 'coverImage', 'isActive', 'isFeatured', 'discountPct']) {
      if (b[k] !== undefined) data[k] = b[k];
    }
    if (b.price !== undefined) data.price = b.price;
    if (b.salePrice !== undefined) data.salePrice = b.salePrice;
    await prisma.testSeries.update({ where: { id: existing.id }, data });
    if (b.paperIds !== undefined) await setSeriesPapers(existing.id, b.paperIds);
    const full = await prisma.testSeries.findUnique({ where: { id: existing.id }, include: seriesWithPapers });
    res.json({ data: serializeTestSeries(full) });
  })
);

router.delete(
  '/series/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.testSeries.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Test series not found');
    await prisma.testSeries.delete({ where: { id: existing.id } }); // cascade removes join rows
    res.json({ deleted: true });
  })
);

/* ============================== COUPONS ============================== */
const couponSchema = z.object({
  code: z.string().min(2).max(30),
  description: z.string().max(200).optional(),
  type: z.enum(['PERCENT', 'FLAT']),
  value: z.number().positive(),
  maxDiscount: z.number().positive().optional().nullable(),
  minOrder: z.number().nonnegative().optional().nullable(),
  startsAt: z.string().datetime().optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  usageLimit: z.number().int().positive().optional().nullable(),
  isActive: z.boolean().optional(),
});

router.get(
  '/coupons',
  asyncHandler(async (req, res) => {
    const { q, status, type, from, to } = req.query;
    const where = {};
    const and = [];
    if (q && q.trim()) {
      const term = q.trim();
      and.push({ OR: [{ code: containsInsensitive(term) }, { description: containsInsensitive(term) }] });
    }
    if (type) where.type = type;
    const now = new Date();
    if (status === 'active') {
      where.isActive = true;
      and.push({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    } else if (status === 'inactive') {
      where.isActive = false;
    } else if (status === 'expired') {
      and.push({ expiresAt: { lt: now } });
    }
    if (and.length) where.AND = and;
    applyDateRange(where, from, to);
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    const [coupons, total] = await Promise.all([
      prisma.coupon.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.coupon.count({ where }),
    ]);
    const data = coupons.map((c) => ({ ...c, value: Number(c.value), maxDiscount: c.maxDiscount != null ? Number(c.maxDiscount) : null, minOrder: c.minOrder != null ? Number(c.minOrder) : null }));
    res.json(paginate(data, total, page, pageSize));
  })
);

router.post(
  '/coupons',
  validate(couponSchema),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const coupon = await prisma.coupon.create({
      data: {
        code: b.code.toUpperCase(),
        description: b.description,
        type: b.type,
        value: b.value,
        maxDiscount: b.maxDiscount ?? null,
        minOrder: b.minOrder ?? null,
        startsAt: b.startsAt ? new Date(b.startsAt) : null,
        expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
        usageLimit: b.usageLimit ?? null,
        isActive: b.isActive ?? true,
      },
    });
    res.status(201).json({ data: coupon });
  })
);

router.patch(
  '/coupons/:id',
  validate(couponSchema.partial()),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const data = { ...b };
    if (b.code) data.code = b.code.toUpperCase();
    if (b.startsAt !== undefined) data.startsAt = b.startsAt ? new Date(b.startsAt) : null;
    if (b.expiresAt !== undefined) data.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    const coupon = await prisma.coupon.update({ where: { id: req.params.id }, data });
    res.json({ data: coupon });
  })
);

router.delete(
  '/coupons/:id',
  asyncHandler(async (req, res) => {
    await prisma.coupon.delete({ where: { id: req.params.id } });
    res.json({ deleted: true });
  })
);

/* ============================== PRINT CONFIG (read-only for admin) ==========
 * Print pricing is owned by the store's primary manager. The admin can only
 * VIEW it and SEND a change request (a message that shows up as a notification
 * on the manager's Print Pricing page).
 */
function serializeRequest(r) {
  return {
    id: r.id,
    message: r.message,
    status: r.status,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name } : undefined,
  };
}

// GET /api/admin/print-config -> current pricing (read-only) + the single open request
router.get(
  '/print-config',
  asyncHandler(async (req, res) => {
    const cfg = await getPrintConfig();
    const open = await prisma.priceChangeRequest.findFirst({
      where: { status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    res.json({
      data: {
        perPageBW: Number(cfg.perPageBW),
        perPageColor: Number(cfg.perPageColor),
        bindingCost: Number(cfg.bindingCost),
        minCharge: Number(cfg.minCharge),
        doubleSidedDiscountPct: Number(cfg.doubleSidedDiscountPct),
        currency: cfg.currency,
      },
      // The single pending request (if any). While one is open, no new request
      // may be created — it can only be edited or must be acknowledged first.
      openRequest: open ? serializeRequest(open) : null,
    });
  })
);

// GET /api/admin/print-config/requests -> paginated request history (newest first),
// searchable by message/sender and filterable by status.
router.get(
  '/print-config/requests',
  asyncHandler(async (req, res) => {
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 5 });
    const q = (req.query.q || '').trim();
    const { status, from, to } = req.query;
    const where = {};
    if (status === 'OPEN' || status === 'RESOLVED') where.status = status;
    if (q) {
      where.OR = [
        { message: containsInsensitive(q) },
        { createdBy: { name: containsInsensitive(q) } },
      ];
    }
    applyDateRange(where, from, to);
    const [requests, total] = await Promise.all([
      prisma.priceChangeRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { createdBy: { select: { id: true, name: true } } },
      }),
      prisma.priceChangeRequest.count({ where }),
    ]);
    res.json(paginate(requests.map(serializeRequest), total, page, pageSize));
  })
);

// POST /api/admin/print-config/requests { message } -> ask the primary manager to change pricing.
// Only ONE open request may exist at a time.
router.post(
  '/print-config/requests',
  validate(z.object({ message: z.string().min(3).max(500) })),
  asyncHandler(async (req, res) => {
    const openExists = await prisma.priceChangeRequest.findFirst({ where: { status: 'OPEN' } });
    if (openExists) {
      throw new ApiError(409, 'A pricing change request is already pending. Edit it or wait until the store acknowledges it.');
    }
    const request = await prisma.priceChangeRequest.create({
      data: { message: req.body.message, createdById: req.user.id },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    res.status(201).json({ data: serializeRequest(request) });
  })
);

// PATCH /api/admin/print-config/requests/:id { message } -> edit a still-open request.
// Once the store acknowledges it (RESOLVED), it can no longer be edited.
router.patch(
  '/print-config/requests/:id',
  validate(z.object({ message: z.string().min(3).max(500) })),
  asyncHandler(async (req, res) => {
    const existing = await prisma.priceChangeRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Request not found');
    if (existing.status !== 'OPEN') throw new ApiError(409, 'This request was already acknowledged and can no longer be edited.');
    const request = await prisma.priceChangeRequest.update({
      where: { id: req.params.id },
      data: { message: req.body.message },
      include: { createdBy: { select: { id: true, name: true } } },
    });
    res.json({ data: serializeRequest(request) });
  })
);

/* ============================== ORDERS ============================== */
// The ACTIVE fulfilment queue excludes DELIVERED (done) — delivered orders drop off
// the queue and are reviewed via the Orders list / a Delivered status filter.
const ACTIVE_FULFILMENT = ['PLACED', 'PROCESSING', 'PRINTED', 'SHIPPED'];

// Apply a created-date range (yyyy-mm-dd, inclusive) to a WHERE clause.
function applyDateRange(where, from, to, field = 'createdAt') {
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const range = {};
  if (isDay(from)) range.gte = new Date(from + 'T00:00:00');
  if (isDay(to)) { const t = new Date(to + 'T00:00:00'); t.setDate(t.getDate() + 1); range.lt = t; }
  if (range.gte || range.lt) where[field] = range;
}

// Build an order WHERE clause from status/type/stage/date/search query params.
function buildOrderWhere({ status, type, stage, q, from, to }) {
  const where = {};
  if (status) where.status = status;
  if (type) where.type = type;
  // stage=fulfilment -> paid orders still actively moving through the print/ship pipeline
  if (stage === 'fulfilment') {
    where.paymentStatus = { in: ['PAID', 'BYPASSED'] };
    if (!status) where.status = { in: ACTIVE_FULFILMENT };
  }
  applyDateRange(where, from, to);
  applyOrderSearch(where, q);
  return where;
}

// A broad order search: order #, customer name/email/phone, shipping name/email/phone,
// coupon code — and a date (a `YYYY-MM-DD` or otherwise parseable term matches that day).
function applyOrderSearch(where, q) {
  if (!q || !q.trim()) return;
  const term = q.trim();
  const or = [
    { orderNumber: containsInsensitive(term) },
    { couponCode: containsInsensitive(term) },
    { shipName: containsInsensitive(term) },
    { shipEmail: containsInsensitive(term) },
    { shipPhone: containsInsensitive(term) },
    { user: { is: { name: containsInsensitive(term) } } },
    { user: { is: { email: containsInsensitive(term) } } },
    { user: { is: { phone: containsInsensitive(term) } } },
    // Content: match an order by any of its item titles (paper / print / series).
    { items: { some: { title: containsInsensitive(term) } } },
  ];
  // Date term → match orders created that calendar day.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(term) ? new Date(term + 'T00:00:00') : null;
  if (day && !isNaN(day)) {
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    or.push({ createdAt: { gte: day, lt: next } });
  }
  where.OR = or;
}

router.get(
  '/orders',
  asyncHandler(async (req, res) => {
    const { status, type, stage, q, from, to } = req.query;
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    const where = buildOrderWhere({ status, type, stage, q, from, to });
    const [orders, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, include: { items: true, user: true } }),
      prisma.order.count({ where }),
    ]);
    res.json(paginate(orders.map((o) => serializeOrder(o)), total, page, pageSize));
  })
);

router.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true, user: true },
    });
    if (!order) throw new ApiError(404, 'Order not found');
    res.json({ data: serializeOrder(order) });
  })
);

router.patch(
  '/orders/:id/status',
  validate(
    z.object({
      status: z.enum(['PLACED', 'PROCESSING', 'PRINTED', 'SHIPPED', 'DELIVERED', 'CANCELLED']),
    })
  ),
  asyncHandler(async (req, res) => {
    const existing = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!existing) throw new ApiError(404, 'Order not found');
    const order = await changeOrderStatus({
      order: existing,
      status: req.body.status,
      include: { items: true, user: true },
    });
    res.json({ data: serializeOrder(order) });
  })
);

/* ============================== REFUNDS ============================== */
// List every order with a refund in any state (newest first) — searchable + paginated.
router.get(
  '/refunds',
  asyncHandler(async (req, res) => {
    const { q, status, from, to } = req.query;
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    const where = { refundStatus: status ? status : { not: 'NONE' } };
    applyDateRange(where, from, to, 'refundInitiatedAt');
    applyOrderSearch(where, q);
    const [orders, total] = await Promise.all([
      prisma.order.findMany({ where, orderBy: { refundInitiatedAt: 'desc' }, skip, take, include: { items: true, user: true } }),
      prisma.order.count({ where }),
    ]);
    res.json(paginate(orders.map((o) => serializeOrder(o)), total, page, pageSize));
  })
);

// Advance an in-progress refund: complete (=> payment REFUNDED) or fail.
router.patch(
  '/orders/:id/refund',
  validate(z.object({ action: z.enum(['complete', 'fail']) })),
  asyncHandler(async (req, res) => {
    const order = await resolveRefund({
      orderId: req.params.id,
      action: req.body.action,
      include: { items: true, user: true },
    });
    res.json({ data: serializeOrder(order) });
  })
);

/* ============================== USERS ==============================
 * Admin manages CUSTOMERS and fellow ADMINS only. Store managers are owned by
 * the store's primary manager (admin has no authority over managers).
 */
const userSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  role: true,
  isActive: true,
  isPrimaryManager: true,
  createdAt: true,
};

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const { role, q, from, to } = req.query;
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 10 });
    const where = {};
    if (role) where.role = role;
    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [
        { name: containsInsensitive(term) },
        { email: containsInsensitive(term) },
        { phone: containsInsensitive(term) },
      ];
    }
    applyDateRange(where, from, to);
    const [users, total] = await Promise.all([
      prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take, select: userSelect }),
      prisma.user.count({ where }),
    ]);
    res.json(paginate(users, total, page, pageSize));
  })
);

// Create an ADMIN account. (Managers are created by the primary manager; normal
// users self-register — so admin creation is limited to fellow admins.)
router.post(
  '/users',
  validate(
    z.object({
      name: z.string().min(2),
      email: z.string().email(),
      phone: z.string().optional(),
      password: z.string().min(6),
      role: z.literal('ADMIN'),
    })
  ),
  asyncHandler(async (req, res) => {
    const bcrypt = (await import('bcryptjs')).default;
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    const user = await prisma.user.create({
      data: {
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
        passwordHash,
        role: 'ADMIN',
      },
      select: userSelect,
    });
    res.status(201).json({ data: user });
  })
);

// Toggle a customer's (or admin's) active state. Managers are off-limits to admin.
router.patch(
  '/users/:id',
  validate(z.object({ isActive: z.boolean() })),
  asyncHandler(async (req, res) => {
    const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { role: true } });
    if (!target) throw new ApiError(404, 'User not found');
    if (target.role === 'MANAGER') {
      throw new ApiError(403, 'Managers are managed by the store’s primary manager.');
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: req.body.isActive },
      select: userSelect,
    });
    res.json({ data: user });
  })
);

export default router;
