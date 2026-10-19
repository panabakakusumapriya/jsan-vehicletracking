const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signToken(user, sessionId) {
  // Drivers (role 'user') get the long-lived driver-portal expiry; every other role gets the
  // shorter admin-panel one. See env.js for why the two differ.
  const expiresIn = user.role === 'user' ? env.DRIVER_JWT_EXPIRES_IN : env.JWT_EXPIRES_IN;
  const opts = { expiresIn };
  // Bind the token to a specific session so a superseded login's token stops working.
  if (sessionId) opts.jwtid = sessionId; // sets the `jti` claim
  return jwt.sign({ sub: user._id.toString(), role: user.role }, env.JWT_SECRET, opts);
}

function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

/**
 * True when a verified token was issued before the account's password was last set — the
 * session must be refused. Shared by the REST middleware and the socket handshake so the two
 * cannot drift apart.
 *
 * JWT `iat` is whole seconds and passwordChangedAt is milliseconds, so the comparison is made
 * at second precision: a token issued in the same second as the change survives. That one-second
 * window is deliberate — a sign-in made right after a reset must not be refused by its own change.
 * A token with no `iat` at all is treated as older than any change.
 */
function issuedBeforePasswordChange(payload, user) {
  if (!user || !user.passwordChangedAt) return false;
  const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
  return issuedAt < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
}

module.exports = { signToken, verifyToken, issuedBeforePasswordChange };
