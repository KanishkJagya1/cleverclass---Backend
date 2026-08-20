import { Router } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { evaluateCoupon, money } from '../utils/pricing.js';

const router = Router();

// POST /api/coupons/validate  { code, subtotal } -> discount preview
router.post(
  '/validate',
  requireAuth,
  validate(z.object({ code: z.string().min(1), subtotal: z.number().nonnegative() })),
  asyncHandler(async (req, res) => {
    const { code, subtotal } = req.body;
    const coupon = await prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
    const result = evaluateCoupon(coupon, subtotal);
    if (!result.valid) {
      return res.status(200).json({ valid: false, reason: result.reason, discount: 0 });
    }
    res.json({
      valid: true,
      code: coupon.code,
      discount: result.discount,
      total: money(subtotal - result.discount),
      description: coupon.description,
    });
  })
);

export default router;
