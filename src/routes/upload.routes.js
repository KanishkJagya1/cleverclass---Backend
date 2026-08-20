import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadPdf } from '../middleware/upload.js';
import { saveFile } from '../lib/storage.js';
import { countPdfPages } from '../utils/pdf.js';

const router = Router();

// POST /api/uploads/document  (multipart: file) -> stores a user PDF for printing
router.post(
  '/document',
  requireAuth,
  uploadPdf.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new ApiError(400, 'A PDF file is required (field name: file)');
    const pages = countPdfPages(req.file.buffer);
    const saved = await saveFile({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      folder: `documents/${req.user.id}`,
    });
    const doc = await prisma.document.create({
      data: {
        userId: req.user.id,
        storageProvider: saved.provider,
        fileKey: saved.key,
        fileName: saved.fileName,
        fileSize: saved.size,
        pages: pages || null,
      },
    });
    res.status(201).json({
      document: {
        id: doc.id,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        pages: doc.pages,
        createdAt: doc.createdAt,
      },
    });
  })
);

// GET /api/uploads/documents -> list current user's uploaded docs
router.get(
  '/documents',
  requireAuth,
  asyncHandler(async (req, res) => {
    const docs = await prisma.document.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, fileName: true, fileSize: true, pages: true, createdAt: true },
    });
    res.json({ data: docs });
  })
);

export default router;
