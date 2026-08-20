import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { getFile } from '../lib/storage.js';

const router = Router();

const PAID = ['PAID', 'BYPASSED'];

// GET /api/download/asset?provider=&key=  -> public marketing assets (paper covers only)
router.get(
  '/asset',
  asyncHandler(async (req, res) => {
    const { provider = 'LOCAL', key } = req.query;
    if (!key || !String(key).startsWith('papers/covers/')) throw new ApiError(404, 'Asset not found');
    const { buffer, contentType } = await getFile({ provider, key: String(key) });
    res.setHeader('Content-Type', contentType || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  })
);

async function streamStored(res, { provider, key, fileName, download = true }) {
  const { buffer, contentType } = await getFile({ provider, key });
  const type = fileName?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : contentType;
  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${(fileName || 'file').replace(/"/g, '')}"`
  );
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}

// GET /api/download/paper/:paperId
// Bought papers are READ-ONLY for buyers — they can only be previewed in-browser
// as watermarked page images (see /api/view). Only ADMIN may fetch the raw file.
router.get(
  '/paper/:paperId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const paper = await prisma.paper.findUnique({ where: { id: req.params.paperId } });
    if (!paper) throw new ApiError(404, 'Paper not found');
    if (req.user.role !== 'ADMIN') {
      throw new ApiError(403, 'Purchased papers are view-only. Open the reader to view your paper.');
    }
    await streamStored(res, { provider: paper.storageProvider, key: paper.fileKey, fileName: paper.fileName });
  })
);

// GET /api/download/document/:documentId
// Owner (the uploading user), a MANAGER (to print), or ADMIN.
router.get(
  '/document/:documentId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const doc = await prisma.document.findUnique({ where: { id: req.params.documentId } });
    if (!doc) throw new ApiError(404, 'Document not found');
    const isPrivileged = req.user.role === 'ADMIN' || req.user.role === 'MANAGER';
    if (!isPrivileged && doc.userId !== req.user.id) throw new ApiError(403, 'Forbidden');
    await streamStored(res, { provider: doc.storageProvider, key: doc.fileKey, fileName: doc.fileName });
  })
);

// GET /api/download/order-item/:itemId
// Fetch the printable file behind an order item. MANAGER/ADMIN always; owner if paid.
router.get(
  '/order-item/:itemId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const item = await prisma.orderItem.findUnique({
      where: { id: req.params.itemId },
      include: { order: true, paper: true, document: true },
    });
    if (!item) throw new ApiError(404, 'Order item not found');

    const isPrivileged = req.user.role === 'ADMIN' || req.user.role === 'MANAGER';
    if (!isPrivileged) {
      if (item.order.userId !== req.user.id) throw new ApiError(403, 'Forbidden');
      if (!PAID.includes(item.order.paymentStatus)) throw new ApiError(403, 'Order is not paid');
      // Buyers may re-download only their OWN uploaded documents. Papers (bought or
      // printed) are never downloadable by the buyer — they are view-only.
      if (item.paperId) throw new ApiError(403, 'Papers are view-only. Open the reader to view this paper.');
    }

    if (item.paper) {
      return streamStored(res, {
        provider: item.paper.storageProvider,
        key: item.paper.fileKey,
        fileName: item.paper.fileName,
      });
    }
    if (item.document) {
      return streamStored(res, {
        provider: item.document.storageProvider,
        key: item.document.fileKey,
        fileName: item.document.fileName,
      });
    }
    throw new ApiError(404, 'No file attached to this item');
  })
);

export default router;
