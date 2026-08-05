const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'manager', 'team_lead', 'user']; // 'user' == driver

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, default: null },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: 'user', index: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    teamLeadId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    // Both of these are CACHES of the driver's open Assignment rows, kept in sync by
    // services/assetCustody.js. The ledger is the source of truth; these exist so the
    // Drivers screen can show and set the current allocation without a join.
    mobileDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'MobileDevice', default: null },
    country: { type: String, trim: true, default: null },
    timezone: { type: String, trim: true, default: null },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    activeSessionId: { type: String, default: null },
    sessionLastSeenAt: { type: Date, default: null },

    // The tenancy boundary(-ies) this account operates inside. Required for
    // manager/team_lead/user at creation time (enforced in user.controller.js, not here, so
    // legacy accounts created before this field existed can still be read and edited without
    // being force-migrated). A driver always holds exactly one; a manager/team lead can hold
    // several — real fleets have one manager running more than one project at once, so a
    // single ObjectId isn't enough. `project` below is a denormalized display copy (names
    // joined with ", "), kept in sync by the controller — the same "cache mirrors the source
    // of truth" pattern used for vehicleId/mobileDeviceId — so every existing screen that
    // reads the plain string keeps working untouched.
    projectIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Project' }], default: [], index: true },

    // Driver profile fields
    driverId: { type: String, trim: true, default: null },
    project: { type: String, trim: true, default: null },
    scope: { type: String, trim: true, default: null },
    region: { type: String, trim: true, default: null },
    drivingLocation: { type: String, trim: true, default: null },
    driverMode: { type: String, trim: true, default: null },
    poc: { type: String, trim: true, default: null },
    contact: { type: String, trim: true, default: null },
    personalMail: { type: String, trim: true, default: null },
    driverAddress: { type: String, trim: true, default: null },
    ctsMail: { type: String, trim: true, default: null },
    driverStatus: { type: String, trim: true, default: null },
    joiningDate: { type: Date, default: null },
    exitDate: { type: Date, default: null },
    pricePerHour: { type: Number, default: null },
    perDiem: { type: Number, default: null },
    currency: { type: String, trim: true, default: null },
    language: { type: String, trim: true, default: null },

    // Mobile/device fields
    workPhone: { type: String, trim: true, default: null },
    imei: { type: String, trim: true, default: null },
    secondaryImei: { type: String, trim: true, default: null },
    phoneModel: { type: String, trim: true, default: null },
    androidVersion: { type: String, trim: true, default: null },
    phoneCase: { type: String, trim: true, default: null },
    phoneScreenguard: { type: String, trim: true, default: null },
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
