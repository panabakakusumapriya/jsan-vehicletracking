const mongoose = require('mongoose');

const STATUSES = ['in_stock', 'assigned', 'repair', 'lost', 'retired'];

/**
 * A physical handset, as a thing in its own right.
 *
 * These fields used to live directly on the driver (User.imei, User.phoneModel, …), which
 * meant a phone could not exist unless someone was holding it: no in-stock pool, no way to
 * ask "where is this IMEI now?", nothing stopping two drivers being given the same one, and
 * the record vanished when the driver left. Custody over time lives in `Assignment`, not
 * here — see docs/asset-custody-design.md.
 */
const mobileDeviceSchema = new mongoose.Schema(
  {
    driverName: { type: String, trim: true, default: null },
    workMail: { type: String, trim: true, default: null },
    imei: { type: String, trim: true, default: null },
    // Dual-SIM handsets carry a second IMEI. Not uniqueness-checked: it is a property of the
    // same physical device, and `imei` is already the identity.
    secondaryImei: { type: String, trim: true, default: null },
    serial: { type: String, trim: true, default: null },
    // Human handle for the shelf: 'Ops phone 07'. Falls back to model + IMEI tail in the UI.
    label: { type: String, trim: true, default: null },

    phoneModel: { type: String, trim: true, default: null },
    androidVersion: { type: String, trim: true, default: null },
    workPhone: { type: String, trim: true, default: null }, // the SIM's number
    phoneCase: { type: String, trim: true, default: null },
    phoneScreenguard: { type: String, trim: true, default: null },

    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    country: { type: String, trim: true, default: null },

    status: { type: String, enum: STATUSES, default: 'in_stock', index: true },
    // CACHE of the open Assignment, so listing the inventory doesn't need a join.
    // The ledger is the source of truth; this is rebuilt from it by the repair script.
    currentDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    active: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

// IMEI is unique when present. Partial rather than sparse: `default: null` means the field
// always exists, and a sparse unique index only skips MISSING fields — every null would
// collide. Same pattern as Trip.clientTripId.
mobileDeviceSchema.index(
  { imei: 1 },
  { unique: true, partialFilterExpression: { imei: { $type: 'string' } } }
);

/** The label the UI shows, and what gets snapshotted onto an assignment row. */
mobileDeviceSchema.methods.displayLabel = function displayLabel() {
  if (this.label) return this.label;
  const tail = this.imei ? `…${String(this.imei).slice(-5)}` : null;
  return [this.phoneModel, tail].filter(Boolean).join(' · ') || `Device ${String(this._id).slice(-6)}`;
};

const MobileDevice = mongoose.model('MobileDevice', mobileDeviceSchema);
MobileDevice.STATUSES = STATUSES;
module.exports = MobileDevice;
