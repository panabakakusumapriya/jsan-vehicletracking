const mongoose = require('mongoose');

/**
 * Each document represents a unique ~11 m road segment driven by a specific driver.
 * Compound unique index on (edgeKey, driverId): the same road segment can appear for
 * multiple drivers, but each driver holds it only once — so if driver A drives a road
 * 3 times, it's stored once for driver A.
 */
const ukmEdgeSchema = new mongoose.Schema(
  {
    edgeKey: { type: String, required: true },
    distanceMeters: { type: Number, required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ukmEdgeSchema.index({ edgeKey: 1, driverId: 1 }, { unique: true });
ukmEdgeSchema.index({ driverId: 1 });

module.exports = mongoose.model('UkmEdge', ukmEdgeSchema);
