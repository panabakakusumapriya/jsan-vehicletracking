const mongoose = require('mongoose');

/**
 * One road segment the customer requires us to drive — a HERE NAVSTREETS link, split
 * intersection to intersection. In the first delivery: 654,447 of them, averaging 94 m, totalling
 * 61,563 km. That total is the whole point — it is the denominator that turns "how far did we
 * drive" into "how much of the job is done".
 *
 * Immutable. A link is written once at import and never updated; whether it has been driven lives
 * in LinkCoverage. That split is what lets a re-drive reset progress without rewriting geometry,
 * and it keeps this collection free of the write contention that a per-trip update would cause.
 */
const roadLinkSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    networkVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NetworkVersion',
      required: true,
    },

    // The customer's LINK_ID. Stable across HERE releases, which is what makes a v1 -> v2 diff
    // cheap: match by this and coverage carries forward on everything whose geometry did not move.
    // Stored as a string because "identifier that happens to be digits" is not a number — it is
    // never summed, and a leading zero in a future delivery must not be eaten.
    linkId: { type: String, required: true },

    // ST_NAME. Blank on 26.8% of the first delivery (service roads, unnamed lanes), so the UI has
    // to be able to identify a link without one.
    name: { type: String, default: null, trim: true },

    // HERE functional class, 1 = motorway .. 5 = local. The first delivery contains only 3/4/5 —
    // no motorways at all — which is either a deliberate exclusion or an upstream clipping
    // accident, and materially changes the route plan either way.
    funcClass: { type: Number, default: null },

    // B = both directions, F = along the digitised direction, T = against it. 7.6% of the first
    // delivery (4,665 km) is one-way, which is exactly the dual-carriageway and slip-lane
    // population — the case where nearest-link snapping picks the wrong carriageway unless the
    // trace heading is checked against this.
    dirTravel: { type: String, enum: ['B', 'F', 'T'], default: 'B' },

    // AR_AUTO. Everything in the first delivery is Y (already filtered upstream), but a future
    // delivery may include tracks and paths a survey vehicle cannot use.
    autoAccess: { type: Boolean, default: true },

    // Resolved once at import by the spatial join, then stored. Null means the link fell outside
    // every polygon — 999 of them (490 km, 0.8%) in the first delivery, boundary slivers.
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkArea', default: null },
    areaCode: { type: String, default: null },
    priority: { type: Number, default: null },

    geometry: {
      type: { type: String, enum: ['LineString'], required: true },
      coordinates: { type: [[Number]], required: true },
    },
    lengthMeters: { type: Number, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One row per link per version. Also the lookup attribution uses to resolve a matched link.
roadLinkSchema.index({ networkVersionId: 1, linkId: 1 }, { unique: true });
// The attribution hot path: one $geoIntersects over the trip's bounding box per trip, rather than
// a $near per sample point (~6,000 round trips for a single trip — the N+1 shape already removed
// from the trip and report endpoints).
roadLinkSchema.index({ geometry: '2dsphere' });
// Serving one area's links to the map overlay, and the per-area rollups at import time.
roadLinkSchema.index({ networkVersionId: 1, areaId: 1 });

module.exports = mongoose.model('RoadLink', roadLinkSchema);
