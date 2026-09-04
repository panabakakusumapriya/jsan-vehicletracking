const mongoose = require('mongoose');

/**
 * A driver-dropped map marker: "this spot needs a flag" — a road that cannot be driven, an
 * accident, a tunnel, private property. Dropped from the mobile map at the phone's current
 * position; reviewed in the admin portal with a straight link into Google Maps.
 *
 * driverName and vehiclePlate are stamped at creation, the same rule Trip applies to its
 * timezone: a marker is fixed history, and renaming a driver or reassigning a vehicle later
 * must not rewrite what the reviewer sees on last month's marker.
 */
const markerSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The active trip at drop time, when there was one — ties the flag to the drive. */
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'MarkerCategory', required: true, index: true },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    note: { type: String, trim: true, default: null },
    driverName: { type: String, default: null },
    vehiclePlate: { type: String, default: null },
    /**
     * Client-generated id. Markers are dropped exactly where connectivity is worst, so the app
     * queues them offline and retries — the unique sparse index turns every retry of the same
     * press into the same marker, never a second one.
     */
    clientId: { type: String, default: null },
    /** When the driver actually pressed the button (device clock); createdAt is upload time. */
    recordedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

markerSchema.index({ clientId: 1 }, { unique: true, sparse: true });
markerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Marker', markerSchema);
