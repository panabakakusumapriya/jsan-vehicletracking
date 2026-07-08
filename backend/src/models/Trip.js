const mongoose = require('mongoose');

const coordSchema = new mongoose.Schema(
  { lat: Number, lon: Number },
  { _id: false }
);

const tripSchema = new mongoose.Schema(
  {
    // uuid generated on the device when a trip starts. Makes offline sync idempotent:
    // re-sending the same clientTripId maps to the same server Trip.
    clientTripId: { type: String, default: null },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    status: {
      type: String,
      enum: ['active', 'completed', 'timed_out'],
      default: 'active',
      index: true,
    },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    startLocation: { type: coordSchema, default: null },
    endLocation: { type: coordSchema, default: null },
    lastLocation: {
      type: new mongoose.Schema(
        {
          lat: Number,
          lon: Number,
          speed: Number,
          heading: Number,
          recordedAt: Date,
        },
        { _id: false }
      ),
      default: null,
    },
    distanceMeters: { type: Number, default: 0 },
    maxSpeedKmh: { type: Number, default: 0 },
    pointCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One server-side trip per (clientTripId, driver). Partial so trips without a
// clientTripId (e.g. created server-side) are not forced unique on null.
tripSchema.index(
  { clientTripId: 1, driverId: 1 },
  { unique: true, partialFilterExpression: { clientTripId: { $type: 'string' } } }
);
tripSchema.index({ driverId: 1, startedAt: -1 });

module.exports = mongoose.model('Trip', tripSchema);
