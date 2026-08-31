const mongoose = require('mongoose');

/**
 * The global coverage ledger: one document per piece of road that anyone in a coverage scope has
 * ever driven, owned by whoever got there FIRST.
 *
 * This is the model the whole global-UKM feature turns on, and the one thing that makes it
 * different from everything that came before it in this repository:
 *
 *   UkmEdge        is keyed (edgeKey, driverId)             -> a road is new once PER DRIVER
 *   roadSegments   builds its `seen` set per driver          -> a road is new once PER DRIVER
 *   LinkCoverage   is keyed (networkVersionId, linkId)       -> a road is new once PER NETWORK
 *   CoverageSegment is keyed (coverageScopeId, cycle, segmentKey) -> a road is new ONCE. Full stop.
 *
 * Driver 101 covering a street under Project A means Driver 201 earns nothing for that street
 * under Project B, because both projects resolve to the same coverageScopeId and there is exactly
 * one row here for that piece of road. That is the requirement the older models cannot express,
 * no matter how their indexes are tuned.
 *
 * Derived, never authoritative
 * ----------------------------
 * Every document here is recomputable from Trip.cleanedRouteShapes plus the trip's timestamps.
 * Nothing is stored here that is not derivable, which is what makes `rebuildScope()` safe to run:
 * it clears and replays this collection and touches no trip geometry, no location points and no
 * UkmEdge row. Raw evidence lives in LocationPoint and stays there forever.
 *
 * Ownership is decided by OBSERVATION time, not upload time
 * ---------------------------------------------------------
 * `firstAt` is when the vehicle actually reached this piece of road, not when the phone managed
 * to sync. A driver whose trip uploads eight hours late still owns the road they drove first, and
 * a late arrival takes ownership away from the trip that had provisionally claimed it (see
 * services/globalUkm.js). Ties break on firstAt, then tripId — deterministic, so two workers
 * racing cannot produce two different answers.
 */
const coverageSegmentSchema = new mongoose.Schema(
  {
    // The dedup universe. Resolved from Project.coverageScopeId, falling back to
    // env.UKM_DEFAULT_COVERAGE_SCOPE — see services/coverageScope.js.
    coverageScopeId: { type: String, required: true },
    // Optional uniqueness reset inside a scope. Stored as a string with '' for "no cycle" rather
    // than null, because a null in a unique compound index matches every other null in some
    // Mongo configurations and this index is the claim itself — it cannot afford ambiguity.
    coverageCycleId: { type: String, required: true, default: '' },

    // Identity of the piece of road. Today: the two snapped polyline endpoints, rounded and
    // sorted, so A->B and B->A are the same key (services/roadSegments.js#segmentKey). Kept as an
    // opaque string on purpose — replacing this with a canonical `roadLinkId:startM-endM` identity
    // is the next phase and must not require a schema change here.
    segmentKey: { type: String, required: true },

    // Length of that piece of road. Written by the first claim and never revised: two traversals
    // of the same segment differ by centimetres of float noise, and letting a later pass rewrite
    // the number would make the scope total drift every time anything is recomputed.
    lengthMeters: { type: Number, required: true },

    // --- who got there first: this, and only this, earns UKM ---
    firstTripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', required: true },
    firstDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    firstProjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    firstAt: { type: Date, required: true },

    // --- repeat passes: no UKM, but this is the raw material for "are we driving the same
    // streets twice" productivity questions. Approximate by design: the incremental path counts a
    // pass once per (segment, trip), a full rebuild recounts them exactly. Never a billing input.
    passes: { type: Number, default: 1 },
    lastTripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip', default: null },
    lastDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The claim. Unique rather than find-then-insert so that two trips finishing attribution at the
// same instant cannot both become the first owner — the loser's upsert collides and falls through
// to the earliest-wins takeover update instead.
coverageSegmentSchema.index(
  { coverageScopeId: 1, coverageCycleId: 1, segmentKey: 1 },
  { unique: true, name: 'coverage_claim' }
);
// "Which segments does this trip own" — the per-trip UKM figure is exactly this question, asked
// once per trip whenever its metrics are (re)computed.
coverageSegmentSchema.index({ firstTripId: 1 });
// Per-driver credit and the coverage-over-time chart, both scoped.
coverageSegmentSchema.index({ coverageScopeId: 1, coverageCycleId: 1, firstDriverId: 1 });
coverageSegmentSchema.index({ coverageScopeId: 1, coverageCycleId: 1, firstAt: 1 });

module.exports = mongoose.model('CoverageSegment', coverageSegmentSchema);
