export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(_req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(422).json({
      error: 'Validation failed',
      details: err.errors?.map((e) => ({ path: e.path.join('.'), message: e.message })),
    });
  }
  // Multer file errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large' });
  }
  // Prisma unique constraint
  if (err.code === 'P2002') {
    return res.status(409).json({ error: `Duplicate value for ${err.meta?.target?.join(', ') || 'field'}` });
  }
  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Record not found' });
  }

  const status = err.status || 500;
  if (status >= 500) {
    // Persist server errors for the audit trail.
    import('../lib/logger.js')
      .then(({ logger }) => logger.error(err.message || 'Internal error', { stack: err.stack }))
      .catch(() => {});
    // eslint-disable-next-line no-console
    console.error('[ERROR]', err);
  }
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(err.details ? { details: err.details } : {}),
  });
}
