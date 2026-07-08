const mongoose = require('mongoose');

const pointSchema = new mongoose.Schema(
  {
    // uuid generated on the device per point. Unique => duplicate syncs are ignored,
    // so the mobile app can safely retry and then delete its local SQLite rows.
    clientId: { type: String, default: null },
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    speedKmh: { type: Number, default: 0 },
    heading: { type: Number, default: null },
    accuracy: { type: Number, default: null },
    altitude: { type: Number, default: null },
    batteryLevel: { type: Number, default: null },
    isMoving: { type: Boolean, default: true },
    recordedAt: { type: Date, required: true }, // device clock (when the fix was taken)
    receivedAt: { type: Date, default: Date.now }, // server clock (when it landed)
  },
  { timestamps: false }
);

pointSchema.index({ tripId: 1, recordedAt: 1 });
pointSchema.index(
  { clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

module.exports = mongoose.model('LocationPoint', pointSchema);
