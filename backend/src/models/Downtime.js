const mongoose = require('mongoose');

/**
 * Time a driver was working but not driving, with a reason: a weather stop between two trips, a
 * vehicle change-over before the first one. Working hours are each trip's start-to-end added up
 * (utils/workHours.js), so without this a 30-minute storm stop simply vanished from the day.
 *
 * The driver reports it from the app and it counts toward working hours straight away (status
 * 'approved' = counted; 'pending' / 'rejected' only exist on entries from before approval was
 * dropped). Rules for when an entry may be made live in services/downtime.js.
 */
const REASONS = ['weather', 'vehicle_changeover', 'vehicle_issue', 'road_closed', 'waiting_instructions', 'fuel', 'other'];

const downtimeSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    driverName: { type: String, default: null },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    reason: { type: String, enum: REASONS, required: true },
    note: { type: String, trim: true, maxlength: 300, default: null },
    /** The driver's local zone when it was reported, and the day it belongs to in that zone. */
    timezone: { type: String, default: 'UTC' },
    date: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedByName: { type: String, default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, maxlength: 300, default: null },
    /** Set by the phone so a resend after a dropped connection cannot make a second entry. */
    clientId: { type: String, default: null },
  },
  { timestamps: true }
);

downtimeSchema.index({ driverId: 1, startAt: 1 });
downtimeSchema.index({ driverId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

module.exports = mongoose.model('Downtime', downtimeSchema);
module.exports.REASONS = REASONS;
