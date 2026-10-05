const bcrypt = require('bcryptjs');

// Simple in-memory brute-force guard: 5 failed attempts locks that IP out
// for 5 minutes. Resets on server restart - fine for a single-user app;
// swap for a real store (Redis, DB) if this ever needs to survive restarts
// or scale past one instance.
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const attempts = new Map(); // ip -> { count, lockedUntil }

function isLockedOut(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    attempts.delete(ip); // lockout expired, reset
    return false;
  }
  return false;
}

function recordFailedAttempt(ip) {
  const entry = attempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
  }
  attempts.set(ip, entry);
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

/** Checks a submitted username/password against the configured credentials. */
function verifyCredentials(username, password) {
  const expectedUsername = process.env.AUTH_USERNAME;
  const expectedHash = process.env.AUTH_PASSWORD_HASH;

  if (!expectedUsername || !expectedHash) {
    // Auth isn't configured yet - fail closed rather than letting anyone in.
    return { ok: false, reason: 'AUTH_USERNAME / AUTH_PASSWORD_HASH not set in .env' };
  }
  if (username !== expectedUsername) {
    return { ok: false, reason: 'Invalid username or password.' };
  }
  const matches = bcrypt.compareSync(password || '', expectedHash);
  if (!matches) {
    return { ok: false, reason: 'Invalid username or password.' };
  }
  return { ok: true };
}

/** Express middleware: blocks any route unless the session is authenticated. */
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/') || req.path === '/command') {
    return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  }
  return res.redirect('/login.html');
}

module.exports = {
  verifyCredentials,
  requireAuth,
  isLockedOut,
  recordFailedAttempt,
  clearAttempts,
  LOCKOUT_MS,
};
