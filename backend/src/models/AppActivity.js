const mongoose = require('mongoose');

/**
 * Tracks driver sign-in / sign-out events from the mobile app.
 * One row per event — the full history lives here, never overwritten.
 */
const appActivitySchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, enum: ['sign_in', 'sign_out', 'heartbeat'], required: true },
    timestamp: { type: Date, required: true, default: Date.now },
    // Snapshot fields so reports still read correctly after a driver is renamed / deleted.
    driverName: { type: String, trim: true, default: null },
    driverEmail: { type: String, trim: true, default: null },
    country: { type: String, trim: true, default: null },
    project: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

appActivitySchema.index({ timestamp: -1 });
appActivitySchema.index({ driverId: 1, timestamp: -1 });

module.exports = mongoose.model('AppActivity', appActivitySchema);
