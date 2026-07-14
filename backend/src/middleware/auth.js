const { verifyToken } = require('../utils/jwt');
const User = require('../models/User');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid or inactive user' });

    // Single-session enforcement: once a user has claimed a session, only the token bound
    // to that session (matching jti) is accepted. Superseded/old tokens are rejected.
    if (user.activeSessionId && payload.jti !== user.activeSessionId) {
      return res.status(401).json({
        error: 'SESSION_SUPERSEDED',
        message: 'This account was signed in on another device.',
      });
    }

    // Keep the session alive (throttled to avoid a write per request).
    if (user.activeSessionId) {
      const last = user.sessionLastSeenAt ? user.sessionLastSeenAt.getTime() : 0;
      if (Date.now() - last > 20000) {
        User.updateOne({ _id: user._id }, { $set: { sessionLastSeenAt: new Date() } }).catch(() => {});
      }
    }

    req.user = user;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    return next();
  };
}

module.exports = { authenticate, requireRole };
