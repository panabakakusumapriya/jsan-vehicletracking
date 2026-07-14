const jwt = require('jsonwebtoken');
const env = require('../config/env');

function signToken(user, sessionId) {
  const opts = { expiresIn: env.JWT_EXPIRES_IN };
  // Bind the token to a specific session so a superseded login's token stops working.
  if (sessionId) opts.jwtid = sessionId; // sets the `jti` claim
  return jwt.sign({ sub: user._id.toString(), role: user.role }, env.JWT_SECRET, opts);
}

function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

module.exports = { signToken, verifyToken };
