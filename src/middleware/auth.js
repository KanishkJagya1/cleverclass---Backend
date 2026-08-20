import { verifyToken } from '../lib/jwt.js';
import prisma from '../lib/prisma.js';
import { ApiError } from './error.js';

/** Extract bearer token from header or cookie. */
function getToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.cookies && req.cookies.token) return req.cookies.token;
  return null;
}

/** Require a valid, active user. Attaches req.user. */
export async function requireAuth(req, _res, next) {
  try {
    const token = getToken(req);
    if (!token) throw new ApiError(401, 'Authentication required');
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      throw new ApiError(401, 'Invalid or expired token');
    }
    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (!user || !user.isActive) throw new ApiError(401, 'Account not found or disabled');
    req.user = {
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      storeId: user.storeId,
      isPrimaryManager: user.isPrimaryManager,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** Require one of the given roles. Use after requireAuth. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'Authentication required'));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'You do not have permission to perform this action'));
    }
    next();
  };
}

/**
 * Require a PRIMARY store manager. Use after requireAuth. Primary managers own
 * print pricing, manager staff, and the priced print-order record — capabilities
 * that ordinary managers and admins do not have.
 */
export function requirePrimaryManager(req, _res, next) {
  if (!req.user) return next(new ApiError(401, 'Authentication required'));
  if (req.user.role !== 'MANAGER' || !req.user.isPrimaryManager) {
    return next(new ApiError(403, 'Only the store’s primary manager can do this'));
  }
  next();
}

/** Optional auth: attaches req.user if a valid token is present, else continues. */
export async function optionalAuth(req, _res, next) {
  try {
    const token = getToken(req);
    if (!token) return next();
    const decoded = verifyToken(token);
    const user = await prisma.user.findUnique({ where: { id: decoded.sub } });
    if (user && user.isActive) {
      req.user = { id: user.id, role: user.role, name: user.name, email: user.email };
    }
  } catch {
    // ignore
  }
  next();
}
