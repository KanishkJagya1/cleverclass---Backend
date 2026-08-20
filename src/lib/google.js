import env from '../config/env.js';

let _client = null;

async function getClient() {
  if (_client) return _client;
  const { OAuth2Client } = await import('google-auth-library');
  _client = new OAuth2Client(env.google.clientId);
  return _client;
}

/**
 * Verify a Google ID token (the `credential` from Google Identity Services)
 * and return the normalized profile. Throws (with .status) if unconfigured or invalid.
 */
export async function verifyGoogleIdToken(credential) {
  if (!env.google.enabled) {
    throw Object.assign(new Error('Google sign-in is not configured'), { status: 503 });
  }
  if (!credential) {
    throw Object.assign(new Error('Missing Google credential'), { status: 400 });
  }
  const client = await getClient();
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken: credential, audience: env.google.clientId });
  } catch {
    throw Object.assign(new Error('Invalid Google token'), { status: 401 });
  }
  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw Object.assign(new Error('Google token missing email'), { status: 401 });
  }
  return {
    googleId: payload.sub,
    email: String(payload.email).toLowerCase(),
    name: payload.name || payload.email,
    avatar: payload.picture || null,
    emailVerified: Boolean(payload.email_verified),
  };
}

export const googleMeta = () => ({ enabled: env.google.enabled, clientId: env.google.clientId });
