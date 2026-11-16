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
    /**
     * Why the spot was flagged, as the driver gave it: one of the reasons listed under the
     * marker's colour (MarkerCategory.description — "Tunnel", "Private Road"…) or, for "Other",
     * their own words. The app asks for it on every drop since 1.0.28; older drops have none.
     */
    reason: { type: String, trim: true, default: null },
    /** Anything more the driver typed about the spot. */
    note: { type: String, trim: true, default: null },
    /**
     * Photos of the spot, in the S3 bucket (config/s3.js), never in Mongo. The phone uploads each
     * straight to the bucket with a signed link (POST /api/markers/photo-uploads) and then sends
     * the keys with the marker. Keys always live under markers/<driverId>/<clientId>/, which is
     * how the server knows a key it is handed is this driver's own upload.
     */
    photos: {
      type: [
        new mongoose.Schema(
          {
            key: { type: String, required: true },
            width: { type: Number, default: null },
            height: { type: Number, default: null },
            bytes: { type: Number, default: null },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    driverName: { type: String, default: null },
    vehiclePlate: { type: String, default: null },
    /**
     * Client-generated id. Markers are dropped exactly where connectivity is worst, so the app
     * queues them offline and retries — the unique sparse index turns every retry of the same
     * press into the same marker, never a second one.
     */
    // No default: a sparse index skips a MISSING field but indexes null, so a null default made
    // every second marker without a client id a duplicate-key error.
    clientId: { type: String },
    /** When the driver actually pressed the button (device clock); createdAt is upload time. */
    recordedAt: { type: Date, required: true },
    /** Set on markers brought in from another system (seed/importVtsMarkers.js) — what --revert removes. */
    importBatchId: { type: String, default: null },
    /**
     * Taken off the map by the driver who dropped it (a pin in the wrong place, a flag no longer
     * true). Kept, not deleted: who removed it and when stays on record, and an admin can put it
     * back. Every read for the map, the Trips page and Coverage leaves removed markers out
     * (`removedAt: null` matches markers from before this field too).
     */
    removedAt: { type: Date, default: null },
    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

markerSchema.index({ clientId: 1 }, { unique: true, sparse: true });
markerSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Marker', markerSchema);
