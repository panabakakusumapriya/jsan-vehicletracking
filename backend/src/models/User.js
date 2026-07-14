const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'manager', 'user']; // 'user' == driver

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, default: null },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'user', index: true },
    // For a driver ('user') this is the manager who owns them.
    // For a manager this is null (managers report to admins collectively).
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    // Single-active-session enforcement (drivers). `activeSessionId` is the jti embedded
    // in the currently valid token; `sessionLastSeenAt` is refreshed on each authed request
    // so a killed app frees the account after an idle window.
    activeSessionId: { type: String, default: null },
    sessionLastSeenAt: { type: Date, default: null },
  },
  { timestamps: true }
);

userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.activeSessionId; // never leak the session secret to clients
  delete obj.sessionLastSeenAt;
  delete obj.__v;
  return obj;
};

const User = mongoose.model('User', userSchema);
User.ROLES = ROLES;
module.exports = User;
