import { asyncHandler } from '../middleware/error.js';

/** Validate req[source] against a Zod schema, replacing it with parsed data. */
export const validate = (schema, source = 'body') =>
  asyncHandler(async (req, _res, next) => {
    const parsed = await schema.parseAsync(req[source]);
    req[source] = parsed;
    next();
  });
