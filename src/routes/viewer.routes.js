import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { getFile } from '../lib/storage.js';
import { renderPreviewPage, renderOwnerPage } from '../lib/pdfRender.js';
import { logger } from '../lib/logger.js';

const router = Router();
const PAID = ['PAID', 'BYPASSED'];

// A buyer OWNS a paper if they have a paid PAPER (digital-buy) item for it.
async function ownsPaper(userId, paperId) {
  const hit = await prisma.order.findFirst({
    where: { userId, paymentStatus: { in: PAID }, items: { some: { paperId, kind: 'PAPER' } } },
    select: { id: true },
  });
  return Boolean(hit);
}

// Load a paper the caller may READ in full: the owner (bought it) or an admin.
async function loadReadable(req, paperId) {
  const paper = await prisma.paper.findUnique({ where: { id: paperId } });
  if (!paper || !paper.isActive) throw new ApiError(404, 'Paper not found');
  if (req.user.role !== 'ADMIN' && !(await ownsPaper(req.user.id, paper.id))) {
    throw new ApiError(403, 'You have not purchased this paper');
  }
  return paper;
}

/**
 * GET /api/view/paper/:paperId/preview -> watermarked first-page teaser PNG.
 * Public (no purchase needed): the top 40% of page 1 is shown, the rest is
 * blurred + veiled. This is the mandatory "see before you buy" preview shown
 * for every active paper. If the shopper is signed in, their email goes into
 * the watermark.
 */
router.get(
  '/paper/:paperId/preview',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const paper = await prisma.paper.findUnique({ where: { id: req.params.paperId } });
    if (!paper || !paper.isActive) throw new ApiError(404, 'Paper not found');

    const { buffer } = await getFile({ provider: paper.storageProvider, key: paper.fileKey });
    const who = req.user?.email || 'preview';
    const watermark = `CleverClass · ${who} · ${new Date().toISOString().slice(0, 10)}`;
    const { png } = await renderPreviewPage(buffer, watermark, { scale: 2, clearRatio: 0.4, blur: 14 });
    logger.event('paper.preview', { userId: req.user?.id || null, paperId: paper.id });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(png);
  })
);

/**
 * GET /api/view/paper/:paperId/meta -> { pages, title } for an OWNER.
 * Used by the in-browser reader to know how many pages to request.
 */
router.get(
  '/paper/:paperId/meta',
  requireAuth,
  asyncHandler(async (req, res) => {
    const paper = await loadReadable(req, req.params.paperId);
    const { buffer } = await getFile({ provider: paper.storageProvider, key: paper.fileKey });
    // Render page 1 to learn the page count without shipping the PDF.
    const who = req.user.email || 'reader';
    const watermark = `CleverClass · ${who} · ${new Date().toISOString().slice(0, 10)}`;
    const { pages } = await renderOwnerPage(buffer, 1, watermark, { scale: 1 });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ pages, title: paper.title });
  })
);

/**
 * GET /api/view/paper/:paperId/page/:n -> full watermarked PNG of page n for an
 * OWNER. The raw PDF is never served — only per-viewer watermarked images.
 */
router.get(
  '/paper/:paperId/page/:n',
  requireAuth,
  asyncHandler(async (req, res) => {
    const paper = await loadReadable(req, req.params.paperId);
    const n = Math.max(1, parseInt(req.params.n, 10) || 1);
    const { buffer } = await getFile({ provider: paper.storageProvider, key: paper.fileKey });
    const who = req.user.email || 'reader';
    const watermark = `CleverClass · ${who} · ${new Date().toISOString().slice(0, 10)}`;
    const { png } = await renderOwnerPage(buffer, n, watermark, { scale: 2 });
    logger.event('paper.read', { userId: req.user.id, paperId: paper.id, page: n });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(png);
  })
);

export default router;
