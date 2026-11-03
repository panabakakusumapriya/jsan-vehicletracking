const { verifyToken, issuedBeforePasswordChange } = require('../utils/jwt');
const User = require('../models/User');

/**
 * The driver app sends its version (X-App-Version) on every request. Kept on the account, so
 * "my assigned areas do not show" can be answered with which build the phone runs — the app
 * had a 20,000-road ceiling before 1.0.21. Written at most hourly, and never awaited.
 */
function noteAppVersion(req, user) {
  const v = String(req.headers['x-app-version'] || '').trim().slice(0, 32);
  if (!v) return;
  const fresh = user.appVersionAt && Date.now() - new Date(user.appVersionAt).getTime() < 3600e3;
  if (user.appVersion === v && fresh) return;
  User.updateOne({ _id: user._id }, { $set: { appVersion: v, appVersionAt: new Date() } }).catch(() => {});
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    const payload = verifyToken(token);
    const user = await User.findById(payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'Invalid or inactive user' });

    // A password change signs the account out everywhere: any token from before it is refused.
    // This is not a single-session lock — every phone signed in with the CURRENT password stays
    // signed in. See User.passwordChangedAt.
    if (issuedBeforePasswordChange(payload, user)) {
      return res.status(401).json({
        error: 'PASSWORD_CHANGED',
        message: 'The password for this account was changed. Sign in again with the new one.',
      });
    }

    // No single-session check: a driver may be signed in on several phones at once, and a
    // new login must not invalidate the others. See auth.controller.js login.

    req.user = user;
    noteAppVersion(req, user);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    // A superadmin is an admin everywhere an admin is allowed.
    const role = req.user && req.user.role === 'superadmin' && roles.includes('admin') ? 'admin' : req.user?.role;
    if (!req.user || !roles.includes(role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    return next();
  };
}

module.exports = { authenticate, requireRole };
