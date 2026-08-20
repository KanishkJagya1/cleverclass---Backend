import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { serializePaper } from '../utils/serializers.js';

const router = Router();

// GET /api/papers  -> public catalog with filters/search/pagination
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, subject, board, grade, featured, sort = 'newest', page = '1', limit = '12' } = req.query;
    const take = Math.min(parseInt(limit, 10) || 12, 60);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

    const where = { isActive: true };
    if (subject) where.subject = subject;
    if (board) where.board = board;
    if (grade) where.grade = grade;
    if (featured === 'true') where.isFeatured = true;
    if (q) {
      where.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { description: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orderBy =
      sort === 'price_asc'
        ? { price: 'asc' }
        : sort === 'price_desc'
        ? { price: 'desc' }
        : sort === 'title'
        ? { title: 'asc' }
        : { createdAt: 'desc' };

    const [total, papers] = await Promise.all([
      prisma.paper.count({ where }),
      prisma.paper.findMany({ where, orderBy, take, skip }),
    ]);

    res.json({
      data: papers.map((p) => serializePaper(p)),
      pagination: { total, page: Math.max(parseInt(page, 10) || 1, 1), limit: take, pages: Math.ceil(total / take) },
    });
  })
);

// GET /api/papers/facets -> distinct filter values for the storefront
router.get(
  '/facets',
  asyncHandler(async (_req, res) => {
    const papers = await prisma.paper.findMany({
      where: { isActive: true },
      select: { subject: true, board: true, grade: true },
    });
    const uniq = (key) => [...new Set(papers.map((p) => p[key]).filter(Boolean))].sort();
    res.json({ subjects: uniq('subject'), boards: uniq('board'), grades: uniq('grade') });
  })
);

// GET /api/papers/:slug -> public detail
router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const paper = await prisma.paper.findFirst({
      where: { OR: [{ slug: req.params.slug }, { id: req.params.slug }], isActive: true },
    });
    if (!paper) throw new ApiError(404, 'Paper not found');
    res.json({ data: serializePaper(paper) });
  })
);

export default router;
