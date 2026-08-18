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
// Serves both reads in tracking.controller.js#ukm: the per-driver total and the fleet-wide dedup.
// Both $match on driverId then work with edgeKey and distanceMeters, so holding all three in the
// index lets Mongo answer from the index alone instead of fetching 2.7M documents.
//
// Measured: per-driver total 2367ms -> 1362ms. The fleet dedup only improved 17.8s -> 15.4s,
// because its cost is building a hash of ~2.7M distinct edgeKeys, not reading them — that one
// cannot be indexed away and needs a fleet-level dedup collection (or the per-trip UKM figures on
// Trip) to actually get fast. Costs ~104 MB.
//
// Replaces a plain { driverId: 1 } index, which was a strict prefix of this one and therefore
// redundant — see src/seed/dropRedundantIndexes.js to remove it from an existing database.
ukmEdgeSchema.index({ driverId: 1, edgeKey: 1, distanceMeters: 1 }, { name: 'ukm_driver_edge_dist' });

module.exports = mongoose.model('UkmEdge', ukmEdgeSchema);
