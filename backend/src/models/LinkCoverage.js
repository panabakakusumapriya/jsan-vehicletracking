const mongoose = require('mongoose');

/**
 * The ledger: one document per customer road link that has actually been driven.
 *
 * Deliberately keyed (networkVersionId, linkId) and NOT by driver — which is the one real
 * difference from the existing UkmEdge model. UkmEdge is keyed (edgeKey, driverId) because it
 * answers "did this driver repeat themselves", so each driver holds their own copy of a road.
 * That is the wrong shape for a delivery contract: the customer does not pay twice because two
 * crews drove the same street. Here a link is claimed once, by whoever got there first, and
 * per-driver credit is a filter on `firstDriverId` — one ledger, both views, no double counting.
 *
 * The denormalised columns (lengthMeters, areaId, priority, funcClass) are copied from RoadLink
 * on first cover on purpose. Coverage rollups group by area and priority constantly; without them
 * every dashboard would have to join 654k links to answer a question that is really just a sum.
 */
const linkCoverageSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    networkVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NetworkVersion',
      required: true,
    },
    linkId: { type: String, required: true },

    // --- denormalised from RoadLink, written once on first cover ---
    lengthMeters: { type: Number, required: true },
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkArea', default: null },
    priority: { type: Number, default: null },
    funcClass: { type: Number, default: null },

    // --- who got there first: this is what counts toward the project ---
    firstTripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true },
    firstDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    firstAt: { type: Date, required: true },

    // How much of the link the winning pass actually covered, 0..1. Kept because a link accepted
    // at the threshold is not the same evidence as one covered end to end, and a customer dispute
    // about a specific street should be answerable without re-running the match.
    firstFraction: { type: Number, default: null },

    // --- repeat passes: no project credit, but they are the raw material for "we are driving
    // the same streets twice" productivity questions ---
    passes: { type: Number, default: 1 },
    lastTripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },
    lastAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The claim. A unique index rather than a find-then-insert is what makes "first cover wins" safe
// when two trips finish attribution at the same moment: the loser's insert fails and falls
// through to incrementing `passes`.
linkCoverageSchema.index({ networkVersionId: 1, linkId: 1 }, { unique: true });
// Coverage per area — the headline number on the areas table. Holds lengthMeters so the sum can
// be answered from the index without touching documents.
linkCoverageSchema.index(
  { networkVersionId: 1, areaId: 1, lengthMeters: 1 },
  { name: 'cov_version_area_len' }
);
// Per-driver credit, and the coverage-over-time chart.
linkCoverageSchema.index({ networkVersionId: 1, firstDriverId: 1 });
linkCoverageSchema.index({ networkVersionId: 1, firstAt: 1 });
// Lets a re-run of one trip's attribution find and undo exactly what that trip claimed.
linkCoverageSchema.index({ firstTripId: 1 });

module.exports = mongoose.model('LinkCoverage', linkCoverageSchema);
