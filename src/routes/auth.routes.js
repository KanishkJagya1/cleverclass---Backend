import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { signToken } from '../lib/jwt.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../utils/validate.js';
import { verifyGoogleIdToken } from '../lib/google.js';
import { logger } from '../lib/logger.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email(),
  phone: z.string().min(6).max(20).optional(),
  password: z.string().min(6).max(72),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    avatar: u.avatar || null,
    // Manager tier drives what the manager portal shows. Store is intentionally
    // not surfaced — the app runs a single default store.
    isPrimaryManager: u.role === 'MANAGER' ? Boolean(u.isPrimaryManager) : false,
  };
}

// POST /api/auth/register  (always creates a normal USER)
router.post(
  '/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, phone, password } = req.body;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ApiError(409, 'An account with this email already exists');
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { name, email, phone, passwordHash, role: 'USER' },
    });
    const token = signToken({ sub: user.id, role: user.role });
    logger.event('auth.register', { userId: user.id, method: 'password' });
    res.status(201).json({ token, user: publicUser(user) });
  })
);

// POST /api/auth/login
router.post(
  '/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email }, include: { store: true } });
    if (!user || !user.isActive) throw new ApiError(401, 'Invalid credentials');
    // Accounts created via Google have no password set.
    if (!user.passwordHash) throw new ApiError(401, 'This account uses Google sign-in. Please continue with Google.');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new ApiError(401, 'Invalid credentials');
    const token = signToken({ sub: user.id, role: user.role });
    logger.event('auth.login', { userId: user.id, method: 'password' });
    res.json({ token, user: publicUser(user) });
  })
);

// POST /api/auth/google  { credential }  -> sign in / sign up with a Google ID token
router.post(
  '/google',
  validate(z.object({ credential: z.string().min(10) })),
  asyncHandler(async (req, res) => {
    const profile = await verifyGoogleIdToken(req.body.credential);

    // Match by googleId first, then by email (link the Google identity to an
    // existing local account with the same email).
    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId: profile.googleId }, { email: profile.email }] },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          name: profile.name,
          email: profile.email,
          googleId: profile.googleId,
          avatar: profile.avatar,
          role: 'USER',
          // passwordHash intentionally left null
        },
      });
      logger.event('auth.register', { userId: user.id, method: 'google' });
    } else if (!user.googleId) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleId: profile.googleId, avatar: user.avatar || profile.avatar },
      });
    }

    if (!user.isActive) throw new ApiError(403, 'This account is disabled');

    const token = signToken({ sub: user.id, role: user.role });
    logger.event('auth.login', { userId: user.id, method: 'google' });
    res.json({ token, user: publicUser(user) });
  })
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id }, include: { store: true } });
    res.json({ user: publicUser(user) });
  })
);

// PATCH /api/auth/me  (update own profile)
router.patch(
  '/me',
  requireAuth,
  validate(
    z.object({
      name: z.string().min(2).max(80).optional(),
      phone: z.string().min(6).max(20).optional(),
    })
  ),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.update({ where: { id: req.user.id }, data: req.body });
    res.json({ user: publicUser(user) });
  })
);

export default router;
