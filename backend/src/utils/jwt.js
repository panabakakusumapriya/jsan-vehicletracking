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

module.exports = { signToken, verifyToken };
