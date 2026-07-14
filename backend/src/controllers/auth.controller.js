const crypto = require('crypto');
const User = require('../models/User');
const { signToken } = require('../utils/jwt');
const asyncHandler = require('../utils/asyncHandler');

// A driver session is considered dead once no authed request has arrived for this long,
// which frees the account if the app was killed without logging out. The tracker pushes
// location every ~10s, so an active session stays well within this window.
const SESSION_IDLE_MS = 2 * 60 * 1000;

// POST /api/auth/login  { email, password }
exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+passwordHash');
  if (!user || !user.active) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await user.verifyPassword(password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  // Single active session for drivers: reject a second concurrent login.
  if (user.role === 'user') {
    const lastSeen = user.sessionLastSeenAt ? user.sessionLastSeenAt.getTime() : 0;
    const sessionAlive = user.activeSessionId && (Date.now() - lastSeen) < SESSION_IDLE_MS;
    if (sessionAlive) {
      return res.status(409).json({
        error: 'ALREADY_LOGGED_IN',
        message: 'This account is already logged in on another device. Log out there first.',
      });
    }
    // Claim the session — this new token becomes the only valid one for this user.
    const sessionId = crypto.randomUUID();
    user.activeSessionId = sessionId;
    user.sessionLastSeenAt = new Date();
    user.lastLoginAt = new Date();
    await user.save();
    return res.json({ token: signToken(user, sessionId), user: user.toSafeJSON() });
  }

  // Admins / managers may sign in from multiple places (web panel, etc.).
  user.lastLoginAt = new Date();
  await user.save();
  return res.json({ token: signToken(user), user: user.toSafeJSON() });
});

// POST /api/auth/logout — clears the active session so the driver can sign in again.
exports.logout = asyncHandler(async (req, res) => {
  if (req.user) {
    req.user.activeSessionId = null;
    req.user.sessionLastSeenAt = null;
    await req.user.save();
  }
  return res.json({ ok: true });
});

// GET /api/auth/me
exports.me = asyncHandler(async (req, res) => {
  res.json({ user: req.user.toSafeJSON() });
});
