import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { paymentMeta } from '../lib/razorpay.js';
import { googleMeta } from '../lib/google.js';

const router = Router();

async function getPrintConfig() {
  let cfg = await prisma.printConfig.findUnique({ where: { id: 'default' } });
  if (!cfg) cfg = await prisma.printConfig.create({ data: { id: 'default' } });
  return cfg;
}

// GET /api/config/print -> public print pricing model (for the upload/order UI)
router.get(
  '/print',
  asyncHandler(async (_req, res) => {
    const cfg = await getPrintConfig();
    res.json({
      perPageBW: Number(cfg.perPageBW),
      perPageColor: Number(cfg.perPageColor),
      bindingCost: Number(cfg.bindingCost),
      minCharge: Number(cfg.minCharge),
      doubleSidedDiscountPct: Number(cfg.doubleSidedDiscountPct),
      currency: cfg.currency,
    });
  })
);

// GET /api/config/payment -> payment mode (bypass/enabled + public key id)
router.get(
  '/payment',
  asyncHandler(async (_req, res) => {
    res.json(paymentMeta());
  })
);

// GET /api/config/auth -> which auth providers are enabled (for the login UI)
router.get(
  '/auth',
  asyncHandler(async (_req, res) => {
    res.json({ google: googleMeta() });
  })
);

export { getPrintConfig };
export default router;
