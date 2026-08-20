import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { serializeTestSeries } from '../utils/serializers.js';
import { parsePagination, paginate, containsInsensitive } from '../utils/pagination.js';

const router = Router();

const withPapers = { papers: { orderBy: { position: 'asc' }, include: { paper: true } } };

// GET /api/series -> public list of active test series (search + pagination)
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, featured } = req.query;
    const { page, pageSize, skip, take } = parsePagination(req.query, { defaultPageSize: 12, maxPageSize: 60 });
    const where = { isActive: true };
    if (featured === 'true') where.isFeatured = true;
    if (q && q.trim()) {
      const term = q.trim();
      where.OR = [{ title: containsInsensitive(term) }, { description: containsInsensitive(term) }, { subject: containsInsensitive(term) }];
    }
    const [series, total] = await Promise.all([
      prisma.testSeries.findMany({ where, orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }], skip, take, include: withPapers }),
      prisma.testSeries.count({ where }),
    ]);
    res.json(paginate(series.map((s) => serializeTestSeries(s, { includePapers: false })), total, page, pageSize));
  })
);

// GET /api/series/:slug -> public detail with member papers
router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const series = await prisma.testSeries.findFirst({
      where: { OR: [{ slug: req.params.slug }, { id: req.params.slug }], isActive: true },
      include: withPapers,
    });
    if (!series) throw new ApiError(404, 'Test series not found');
    res.json({ data: serializeTestSeries(series) });
  })
);

export default router;
