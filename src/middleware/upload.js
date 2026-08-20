import multer from 'multer';

// Store in memory; storage layer decides where bytes finally live.
const storage = multer.memoryStorage();

const pdfAndImages = (req, file, cb) => {
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(Object.assign(new Error('Only PDF or image files are allowed'), { status: 400 }));
};

const pdfOnly = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') return cb(null, true);
  cb(Object.assign(new Error('Only PDF files are allowed'), { status: 400 }));
};

export const uploadPdf = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: pdfOnly,
});

export const uploadPaperAssets = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: pdfAndImages,
});
