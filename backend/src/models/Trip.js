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
    // Which project this trip's driving counts toward. Stamped when the trip starts rather than
    // derived later from the driver, because User.projectIds is an ARRAY — a driver can be on
    // several projects at once, so "the driver's project" is not a question with one answer at
    // read time. Without this, a trip's coverage cannot be attributed to a customer's network at
    // all; see models/LinkCoverage.js. Null on trips recorded before this field existed, and on
    // drivers who genuinely have no project.
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
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
    timezone: { type: String, default: null },
    distanceMeters: { type: Number, default: 0 },
    maxSpeedKmh: { type: Number, default: 0 },
    pointCount: { type: Number, default: 0 },
    // ---- Map-matched ("cleaned") layer — see services/mapMatcher.js + services/valhalla.js ----
    // Additive only: distanceMeters above stays the raw live-accumulated haversine total
    // forever, even once a trip is matched. cleanedDistanceMeters is the Valhalla-snapped
    // total, populated asynchronously after the trip completes; reports/UI fall back to the
    // raw figure when this is still null (pending) or the match failed.
    cleanedDistanceMeters: { type: Number, default: null },
    // Encoded polyline6 per chunk (long traces are matched in pieces — see MAP_MATCH_CHUNK_SIZE).
    // Kept as separate per-chunk strings rather than one merged polyline so the worker never has
    // to decode+re-encode to stitch chunks together; the frontend decodes and concatenates them.
    cleanedRouteShapes: { type: [String], default: undefined },
    mapMatchStatus: {
      type: String,
      enum: ['pending', 'matching', 'matched', 'failed', 'skipped'],
      default: 'pending',
    },
    mapMatchedAt: { type: Date, default: null },
    mapMatchError: { type: String, default: null },
    // Fraction of the trace Valhalla actually snapped to roads, 0..1. Below 1 means some stretch
    // could not be matched at any chunk size and kept its raw GPS geometry instead — see
    // matchSegment() in services/valhalla.js. Stored because a partly-raw route is otherwise
    // indistinguishable from a fully-snapped one: both just look like a line on the map.
    cleanedMatchedRatio: { type: Number, default: null },
    // ---- UKM (unique kilometers) for this trip — see services/roadSegments.js ----
    // Road in this trip that no EARLIER trip by the same driver covered. Drive a route on Monday
    // and it counts here; drive the same route Tuesday and Tuesday's trip earns nothing. Derived
    // from the snapped route, because raw fixes cannot identify "the same road" reliably — GPS
    // error here (~15 m) exceeds the ~11 m grid the fleet /ukm tab buckets raw points into.
    // Independent of that tab's UkmEdge collection: this is per trip, that one is per driver.
    ukmMeters: { type: Number, default: null },
    // UKM counting only this trip against itself, ignoring history: a road driven three times in
    // one trip counts once. Kept alongside the figure above so a trip that only repeated old
    // ground still has something meaningful to show instead of a bare zero.
    ukmWithinTripMeters: { type: Number, default: null },
    // The UKM stretches as encoded polyline6, so the trip map can highlight road that was new to
    // this trip and mute road the driver had already covered. Produced by the same pass that
    // computes ukmMeters, so the colouring and the number can never disagree.
    ukmNewShapes: { type: [String], default: undefined },
    ukmComputedAt: { type: Date, default: null },
    // Set when the watchdog raised a "driver offline" alert for this trip, cleared when the
    // device starts reporting again. Doubles as the de-dupe lock: the watchdog only alerts
    // on a conditional update from null, so a restart (or a second server instance) can
    // never send the same alert twice. See services/driverWatchdog.js.
    offlineNotifiedAt: { type: Date, default: null },
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
// The watchdog sweeps active trips by last-heartbeat every WATCHDOG_INTERVAL_SECONDS.
tripSchema.index({ status: 1, 'lastLocation.recordedAt': 1 });
// The map-matcher worker sweeps completed/timed_out trips awaiting a Valhalla match every
// MAP_MATCH_INTERVAL_SECONDS.
tripSchema.index({ status: 1, mapMatchStatus: 1 });
// Every date-ranged report filters closed trips by startedAt: the Trips list, mergedSummary, the
// bulk export, and buildUkmTripFilter in tracking.controller.js. Without this they scanned the
// whole collection and sorted in memory; { driverId, startedAt } only helped when a driver filter
// happened to be present, which on the fleet-wide views it is not.
tripSchema.index({ status: 1, startedAt: -1 });
// Coverage attribution sweeps matched trips for one project in start order. Partial because the
// overwhelming majority of historical trips have no projectId and would otherwise bloat an index
// that only the coverage pipeline reads.
tripSchema.index(
  { projectId: 1, startedAt: 1 },
  { partialFilterExpression: { projectId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Trip', tripSchema);
