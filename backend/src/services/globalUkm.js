const Trip = require('../models/Trip');
const CoverageSegment = require('../models/CoverageSegment');
const env = require('../config/env');
const { haversineMeters } = require('../utils/geo');
const { encodePolyline6 } = require('./valhalla');
const { segmentKey, decodePolyline6 } = require('./roadSegments');
const { scopeForTrip } = require('./coverageScope');
const { syncEffectiveUkm } = require('./ukmBasis');

/**
 * GLOBAL UKM — road counted once for the whole coverage programme, not once per driver.
 *
 * The question this answers, and the one nothing else in the repository answered:
 *
 *   For this trip, how many metres of road had NEVER been covered by any earlier eligible
 *   traversal in the same coverage scope — by any driver, in any project, including this
 *   driver's own earlier trips — after removing everything the trip drove twice itself?
 *
 * Why the previous implementations get a different answer
 * -------------------------------------------------------
 * roadSegments.js builds its `seen` set from `Trip.find({ driverId })`, so Driver 101 covering a
 * street leaves Driver 201's copy of that street untouched and Driver 201 is paid for it again.
 * UkmEdge is keyed (edgeKey, driverId), which says the same thing in an index. Both are correct
 * answers to "am I repeating myself" and wrong answers to "did the fleet already drive this".
 * Here there is one ledger row per piece of road per scope (models/CoverageSegment.js), so the
 * second driver over a street cannot find it unclaimed.
 *
 * Why overlaps are unioned and never added
 * ----------------------------------------
 * The tempting shape — overlap with D101 (12 km) + overlap with D201 (4 km) = 16 km duplicate —
 * is wrong whenever those two drivers overlapped EACH OTHER, and they do constantly. If D201's
 * 4 km sits inside D101's 12 km, history contains 12 km of road, not 16. The ledger enforces this
 * structurally rather than arithmetically: a piece of road is one row, so it can be subtracted at
 * most once no matter how many previous drivers passed over it. See test/globalUkm.test.js, which
 * pins the 30 km / 3 km self-repeat / 12 km + nested 4 km case at exactly 15 km.
 *
 * Ownership follows OBSERVATION time, not upload time or trip start
 * ----------------------------------------------------------------
 * Two things that both used to be wrong. A trip that syncs eight hours late still owns the road it
 * drove first, so a late arrival TAKES ownership back from the trip that provisionally claimed it
 * and that trip's figures are recomputed (`displacedTripIds` below). And a trip that started at
 * 08:00 does not own a road it did not reach until 11:00, so each segment carries its own
 * observation time rather than inheriting the trip's start.
 *
 * That per-segment time is interpolated along the snapped route between startedAt and endedAt.
 * It is an estimate — an honest one, and enormously better than trip-start ordering — but it
 * assumes roughly even progress through the trip. Carrying true per-vertex times needs the matcher
 * to keep the point-to-vertex correspondence it currently discards; until then this is the
 * documented approximation, and it is the only approximation in the ownership decision.
 *
 * What this module deliberately does NOT do
 * -----------------------------------------
 * Road identity is still the snapped-polyline endpoint pair from roadSegments.js#segmentKey, not a
 * canonical RoadLink id plus along-link measures. Snapped vertices are stable enough that a second
 * pass over a street returns the same key (which is why the per-trip figures have held up), but
 * they cannot express "Driver 101 covered metres 0-600 of this link and Driver 201 later covered
 * 400-1000". Moving to RoadLink identity is the next phase; `segmentKey` is an opaque string in
 * the ledger precisely so that change needs no schema migration here.
 */

// One bulkWrite per this many ops. A dense urban trip produces a few thousand segments; sending
// them as one operation risks the 100k-op server limit and makes a partial failure unreadable.
const BULK_CHUNK = 1000;

/**
 * Walk a trip's snapped route once and return every step it took, in the order it was driven.
 *
 * Each step is one polyline edge: {key, meters, observedAt, a, b, shapeIndex}. Everything else in
 * this module is derived from this list, so the geometry is decoded exactly once per pass and the
 * numbers and the map colours can never be computed from different inputs.
 */
function walkTrip(trip) {
  const shapes = trip.cleanedRouteShapes || [];
  const steps = [];
  if (!shapes.length) return steps;

  // First pass: geometry only, so cumulative length is known before times are assigned.
  let total = 0;
  for (let s = 0; s < shapes.length; s++) {
    let vertices;
    try {
      vertices = decodePolyline6(shapes[s]);
    } catch {
      continue; // an unreadable shape contributes nothing rather than failing the whole trip
    }
    for (let i = 1; i < vertices.length; i++) {
      const a = vertices[i - 1];
      const b = vertices[i];
      const meters = haversineMeters(a, b);
      // Zero-length steps appear where two separately-matched shapes are stitched at the same
      // coordinate. They have no length and no identity.
      if (meters <= 0) continue;
      total += meters;
      steps.push({ key: segmentKey(a, b), meters, a, b, shapeIndex: s, cumulative: total });
    }
  }

  // Second pass: spread the trip's clock along its distance. A trip with no end time (still open,
  // or closed without one) puts every segment at its start — the honest reading of "we know when
  // this began and nothing more".
  const startMs = trip.startedAt ? new Date(trip.startedAt).getTime() : Date.now();
  const endMs = trip.endedAt ? new Date(trip.endedAt).getTime() : startMs;
  const span = Math.max(0, endMs - startMs);
  for (const step of steps) {
    const fraction = total > 0 ? step.cumulative / total : 0;
    step.observedAt = new Date(startMs + span * fraction);
  }
  return steps;
}

/**
 * Collapse a trip's steps into the distinct road it covered — the current-trip UNION.
 *
 * A street driven three times in one trip appears once, holding the EARLIEST time the trip reached
 * it, because that is when the driver actually got there and ownership is decided on arrival.
 *
 * Returns { segments: Map(key -> {meters, observedAt}), distinctMeters, travelledMeters }.
 * travelledMeters is every step including the repeats: the difference between the two is real
 * distance the vehicle covered that earns nothing, which the trip page has to be able to show.
 */
function unionWithinTrip(steps) {
  const segments = new Map();
  let travelledMeters = 0;
  for (const step of steps) {
    travelledMeters += step.meters;
    const existing = segments.get(step.key);
    if (!existing) {
      segments.set(step.key, { meters: step.meters, observedAt: step.observedAt });
    } else if (step.observedAt < existing.observedAt) {
      existing.observedAt = step.observedAt;
    }
  }
  let distinctMeters = 0;
  for (const v of segments.values()) distinctMeters += v.meters;
  return { segments, distinctMeters, travelledMeters };
}

/** Is (aAt, aTrip) strictly earlier than (bAt, bTrip)? The tie-break that decides disputes. */
function earlierThan(aAt, aTrip, bAt, bTrip) {
  const d = new Date(aAt).getTime() - new Date(bAt).getTime();
  if (d !== 0) return d < 0;
  // Same instant to the millisecond. Fall back to trip id, which is stable and total — anything
  // less and whichever Mongo write happened to land first would decide who gets paid.
  return String(aTrip) < String(bTrip);
}

/** Whether this trip may take part in coverage attribution at all, and why not if it may not. */
function eligibility(trip) {
  if (!trip.cleanedRouteShapes || !trip.cleanedRouteShapes.length) {
    return { eligible: false, status: trip.mapMatchStatus === 'failed' ? 'failed' : 'pending' };
  }
  const ratio = trip.cleanedMatchedRatio;
  // Ratio null means the trip was matched before the field existed; treat it as matched rather
  // than sending the entire pre-feature history to review.
  const suspect = ratio != null && ratio < env.UKM_REVIEW_MATCHED_RATIO;
  if (!suspect) return { eligible: true, status: 'computed' };
  return { eligible: env.UKM_REVIEW_CLAIMS_COVERAGE, status: 'review' };
}

async function bulkChunked(ops) {
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    await CoverageSegment.bulkWrite(ops.slice(i, i + BULK_CHUNK), { ordered: false });
  }
}

/**
 * Read the ledger rows for a set of segment keys, chunked so the $in never gets absurd.
 *
 * The default projection is deliberately narrow — attribution runs this over every segment of
 * every trip and only needs to know who owns each one. `extraFields` widens it for the overlap
 * breakdown, which also needs the owning driver and project.
 */
async function ledgerFor(scope, keys, { extraFields = '' } = {}) {
  const found = new Map();
  const list = [...keys];
  const projection = `segmentKey firstTripId firstAt lastTripId${extraFields ? ` ${extraFields}` : ''}`;
  for (let i = 0; i < list.length; i += BULK_CHUNK) {
    const rows = await CoverageSegment.find({
      coverageScopeId: scope.coverageScopeId,
      coverageCycleId: scope.coverageCycleId,
      segmentKey: { $in: list.slice(i, i + BULK_CHUNK) },
    })
      .select(projection)
      .lean();
    for (const r of rows) found.set(r.segmentKey, r);
  }
  return found;
}

/**
 * Stake this trip's claim on every piece of road it covered.
 *
 * Three kinds of outcome per segment, and the second one is the interesting case:
 *   - nobody holds it        -> we claim it (upsert)
 *   - somebody holds it, but we reached it earlier -> we TAKE IT (their trip is now stale)
 *   - somebody reached it first -> we record a pass and earn nothing
 *
 * Returns the trip ids whose figures the takeovers invalidated, so the caller can recompute them.
 * Every write carries its own condition, so running this twice for the same trip changes nothing
 * and two workers racing converge on the same owner.
 */
async function claimTrip(trip, scope, segments) {
  const displaced = new Set();

  const base = (key) => ({
    coverageScopeId: scope.coverageScopeId,
    coverageCycleId: scope.coverageCycleId,
    segmentKey: key,
  });

  /**
   * Turn "this segment is already held by someone" into the write that settles it.
   *
   * The filters restate in Mongo what was just decided in JS rather than trusting the read: the
   * row can move between the read and the write, and ownership of a road is not something to
   * decide on a stale copy.
   */
  const settle = (key, seg, held, takeovers, passes) => {
    if (String(held.firstTripId) === String(trip._id)) return; // already ours

    if (earlierThan(seg.observedAt, trip._id, held.firstAt, held.firstTripId)) {
      displaced.add(String(held.firstTripId));
      takeovers.push({
        updateOne: {
          filter: {
            ...base(key),
            $or: [
              { firstAt: { $gt: seg.observedAt } },
              { firstAt: seg.observedAt, firstTripId: { $gt: trip._id } },
            ],
          },
          update: {
            $set: {
              firstTripId: trip._id,
              firstDriverId: trip.driverId,
              firstProjectId: trip.projectId || null,
              firstAt: seg.observedAt,
            },
          },
        },
      });
    } else {
      passes.push({
        updateOne: {
          // lastTripId guards the counter against re-runs: attributing the same trip twice must
          // not invent a second pass over the same street.
          filter: { ...base(key), firstTripId: { $ne: trip._id }, lastTripId: { $ne: trip._id } },
          update: {
            $inc: { passes: 1 },
            $set: { lastTripId: trip._id, lastDriverId: trip.driverId, lastAt: seg.observedAt },
          },
        },
      });
    }
  };

  const existing = await ledgerFor(scope, segments.keys());
  const inserts = [];
  const takeovers = [];
  const passes = [];
  // Segments we believe nobody holds. Tracked because an upsert that loses a race silently
  // no-ops, and a segment we thought we had claimed but did not is the one way this could hand a
  // road to the wrong driver — see the re-check below.
  const attempted = [];

  for (const [key, seg] of segments) {
    const held = existing.get(key);
    if (!held) {
      attempted.push(key);
      inserts.push({
        updateOne: {
          filter: base(key),
          update: {
            $setOnInsert: {
              ...base(key),
              lengthMeters: seg.meters,
              firstTripId: trip._id,
              firstDriverId: trip.driverId,
              firstProjectId: trip.projectId || null,
              firstAt: seg.observedAt,
              passes: 1,
              lastTripId: trip._id,
              lastDriverId: trip.driverId,
              lastAt: seg.observedAt,
            },
          },
          upsert: true,
        },
      });
      continue;
    }
    settle(key, seg, held, takeovers, passes);
  }

  // Order matters: claim the empty rows, then settle disputes over held ones, then count passes —
  // so a segment we take over in step two is not also counted as a pass in step three.
  await bulkChunked(inserts);

  // Re-read what we tried to insert. On the ordinary path every one of them now names this trip
  // and this loop finds nothing to do. It exists for the case where another worker's upsert landed
  // first: without it that segment would be settled by nobody — we would not take it even having
  // reached it earlier, and would not record a pass having reached it later. A read of only the
  // segments we attempted is a small price for the guarantee that a concurrent attribution cannot
  // leave a road credited to the wrong driver.
  if (attempted.length) {
    const settled = await ledgerFor(scope, attempted);
    for (const key of attempted) {
      const held = settled.get(key);
      if (held) settle(key, segments.get(key), held, takeovers, passes);
    }
  }

  await bulkChunked(takeovers);
  await bulkChunked(passes);
  return displaced;
}

/**
 * Split a trip's route into the stretches it owns and the stretches it repeated, as encoded
 * polylines the map can draw directly.
 *
 * Produced from the same walk that produced the numbers, which is the whole point: the /ukm page
 * used to re-derive its green "unique" line in the browser from a different algorithm over a
 * different subset of the data, so the line and the total could disagree and there was no way to
 * tell which one was lying. A run breaks whenever the classification changes and at every shape
 * boundary, so a repeated middle section visibly splits the highlight in two.
 */
function classifyShapes(steps, ownedKeys) {
  const unique = [];
  const duplicate = [];
  let run = null;
  let runOwned = null;
  let runShape = -1;

  const flush = () => {
    if (run && run.length > 1) (runOwned ? unique : duplicate).push(encodePolyline6(run));
    run = null;
  };

  // A segment repeated inside the trip is drawn as unique on its FIRST traversal only, so the
  // green line covers each street once — matching the number instead of over-painting it.
  const drawn = new Set();
  for (const step of steps) {
    const owned = ownedKeys.has(step.key) && !drawn.has(step.key);
    if (owned) drawn.add(step.key);
    if (run && (owned !== runOwned || step.shapeIndex !== runShape)) flush();
    if (!run) {
      run = [step.a, step.b];
      runOwned = owned;
      runShape = step.shapeIndex;
    } else {
      run.push(step.b);
    }
  }
  flush();
  return { uniqueShapes: unique, duplicateShapes: duplicate };
}

/**
 * Work out one trip's figures from the ledger as it currently stands, and persist them.
 *
 * A trip's numbers are a pure function of (its geometry, the ledger) — unique is exactly the road
 * whose ledger row names this trip as the first owner. That is what makes reconciliation simple:
 * when a late trip steals a street, the loser does not need unpicking, it just needs asking again.
 */
async function computeTripMetrics(tripId) {
  const trip = await Trip.findById(tripId)
    .select(
      '_id driverId projectId startedAt endedAt status coverageScopeId coverageCycleId ' +
        'cleanedRouteShapes cleanedDistanceMeters distanceMeters cleanedMatchedRatio mapMatchStatus'
    )
    .lean();
  if (!trip) return null;

  const { eligible, status } = eligibility(trip);
  const now = new Date();

  if (!eligible) {
    // Everything stays null. `null` means "not established"; `0` means "established, and none of
    // it was new road". Collapsing the two would let a failed match read as a driver who found
    // nothing, which is a very different conversation to have with a driver.
    await Trip.updateOne(
      { _id: trip._id },
      {
        $set: {
          ukmStatus: status,
          distinctRoadMeters: null,
          sameTripRepeatMeters: null,
          historicalDuplicateMeters: null,
          globalUniqueMeters: null,
          globalUkmComputedAt: now,
          ukmAlgorithmVersion: env.UKM_ALGORITHM_VERSION,
        },
        $unset: { ukmUniqueShapes: 1, ukmDuplicateShapes: 1 },
      }
    );
    await syncEffectiveUkm(trip._id);
    return { tripId: trip._id, status, globalUniqueMeters: null };
  }

  const scope = await scopeForTrip(trip);
  const steps = walkTrip(trip);
  const { segments, distinctMeters, travelledMeters } = unionWithinTrip(steps);
  const held = await ledgerFor(scope, segments.keys());

  const ownedKeys = new Set();
  let uniqueMeters = 0;
  let duplicateMeters = 0;
  for (const [key, seg] of segments) {
    const row = held.get(key);
    if (row && String(row.firstTripId) === String(trip._id)) {
      ownedKeys.add(key);
      uniqueMeters += seg.meters;
    } else {
      duplicateMeters += seg.meters;
    }
  }

  const { uniqueShapes, duplicateShapes } = classifyShapes(steps, ownedKeys);

  // The unmatched estimate. cleanedMatchedRatio is a trip-level figure, so this is the trip-level
  // share of its distance that was raw GPS fallback rather than snapped road — enough to keep the
  // questionable kilometres visible and out of the headline, not enough to say WHERE they were.
  const cleaned = trip.cleanedDistanceMeters ?? travelledMeters;
  const ratio = trip.cleanedMatchedRatio;
  const unmatched = ratio != null && ratio < 1 ? cleaned * (1 - ratio) : 0;

  await Trip.updateOne(
    { _id: trip._id },
    {
      $set: {
        coverageScopeId: trip.coverageScopeId || scope.coverageScopeId,
        coverageCycleId: trip.coverageCycleId || scope.coverageCycleId,
        ukmStatus: status,
        distinctRoadMeters: distinctMeters,
        sameTripRepeatMeters: Math.max(0, travelledMeters - distinctMeters),
        historicalDuplicateMeters: duplicateMeters,
        globalUniqueMeters: uniqueMeters,
        unmatchedReviewMeters: unmatched,
        ukmUniqueShapes: uniqueShapes,
        ukmDuplicateShapes: duplicateShapes,
        globalUkmComputedAt: now,
        ukmAlgorithmVersion: env.UKM_ALGORITHM_VERSION,
      },
    }
  );
  // The driver-facing figure follows this number for unassigned drivers — see ukmBasis.js.
  await syncEffectiveUkm(trip._id);

  return {
    tripId: trip._id,
    status,
    distinctMeters,
    duplicateMeters,
    globalUniqueMeters: uniqueMeters,
  };
}

/**
 * Who already had the road this trip covered — the breakdown behind the "Already covered" figure.
 *
 * For every piece of road this trip drove but does NOT own, the ledger names the trip, driver and
 * project that got there first. Grouping that by driver answers the question a supervisor actually
 * asks when a trip earns less UKM than expected: *who was here before me, and how much of my shift
 * did they already have?*
 *
 * Why these rows are safe to add up, when the spec warns they are not
 * ------------------------------------------------------------------
 * The specification is emphatic that per-driver overlap figures must never be summed to produce a
 * duplicate total — overlap with D101 (12 km) plus overlap with D201 (4 km) is 16 km only if those
 * two drivers never overlapped each other, and they do constantly.
 *
 * That warning is about a DIFFERENT calculation: measuring the current route against each previous
 * driver's coverage separately. This function does not do that. Each segment has exactly one first
 * owner, so assigning it to that one driver PARTITIONS the duplicate road — every metre appears in
 * exactly one row, and the rows therefore sum to `historicalDuplicateMeters` precisely. The
 * `totalMeters` returned alongside is the reconciliation: if the rows ever stop summing to it,
 * something is wrong.
 *
 * Read-only. Nothing here writes.
 */
async function overlapBreakdown(tripId) {
  const trip = await Trip.findById(tripId)
    .select(
      '_id driverId projectId startedAt endedAt status coverageScopeId coverageCycleId ' +
        'cleanedRouteShapes cleanedMatchedRatio mapMatchStatus historicalDuplicateMeters'
    )
    .lean();
  if (!trip) return null;

  const { eligible } = eligibility(trip);
  if (!eligible) return { tripId, rows: [], totalMeters: 0, unattributedMeters: 0, computed: false };

  const scope = await scopeForTrip(trip);
  const steps = walkTrip(trip);
  const { segments } = unionWithinTrip(steps);
  const held = await ledgerFor(scope, segments.keys(), {
    // The grouping keys, which the lean ledger read does not normally fetch.
    extraFields: 'firstDriverId firstProjectId firstAt',
  });

  // key: `${driverId}|${projectId}` — a driver who covered this road under two different projects
  // is two rows, because "which project already holds this street" is half the question.
  const groups = new Map();
  let totalMeters = 0;
  // Road this trip covered that the ledger has no row for at all. Should be zero: attribution
  // claims every eligible segment. Non-zero means the trip's geometry changed after it was
  // attributed and the figures are stale — surfaced rather than silently folded into a driver's row.
  let unattributedMeters = 0;

  for (const [key, seg] of segments) {
    const row = held.get(key);
    if (!row) {
      unattributedMeters += seg.meters;
      continue;
    }
    if (String(row.firstTripId) === String(trip._id)) continue; // ours: this is UKM, not overlap

    totalMeters += seg.meters;
    const gk = `${row.firstDriverId}|${row.firstProjectId || ''}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        driverId: row.firstDriverId,
        projectId: row.firstProjectId || null,
        meters: 0,
        segments: 0,
        trips: new Set(),
        firstAt: row.firstAt,
        lastAt: row.firstAt,
      };
      groups.set(gk, g);
    }
    g.meters += seg.meters;
    g.segments += 1;
    g.trips.add(String(row.firstTripId));
    if (row.firstAt < g.firstAt) g.firstAt = row.firstAt;
    if (row.firstAt > g.lastAt) g.lastAt = row.firstAt;
  }

  const rows = [...groups.values()]
    .map((g) => ({
      driverId: g.driverId,
      projectId: g.projectId,
      meters: g.meters,
      segments: g.segments,
      tripCount: g.trips.size,
      // One trip id is enough to open the evidence; more than one and the UI says "N trips".
      sampleTripId: [...g.trips][0],
      firstAt: g.firstAt,
      lastAt: g.lastAt,
      // The distinction that matters most on this fleet: re-covering your own ground is a route
      // planning problem, someone else covering it first is a crew coordination problem.
      selfOverlap: String(g.driverId) === String(trip.driverId),
    }))
    .sort((a, b) => b.meters - a.meters);

  return { tripId: trip._id, rows, totalMeters, unattributedMeters, computed: true };
}

/**
 * Attribute one trip: claim its road, then recompute its figures and those of anything it
 * displaced. This is the incremental path, called by the map-matcher the moment a trip's snapped
 * geometry exists.
 */
async function attributeTrip(tripId) {
  if (!env.GLOBAL_UKM_ENABLED) return null;

  const trip = await Trip.findById(tripId)
    .select(
      '_id driverId projectId startedAt endedAt status coverageScopeId coverageCycleId ' +
        'cleanedRouteShapes cleanedMatchedRatio mapMatchStatus'
    )
    .lean();
  if (!trip) return null;

  // COMPLETED RIDES ONLY. An in-progress trip is still growing, so any road it claimed would be a
  // claim on a drive that has not finished — and a claim is not a provisional thing: it decides
  // who gets paid for that street, and would have to be unpicked from other drivers' figures if
  // the rest of the trip changed the answer. Every caller already filters on status; this is here
  // so the guarantee lives with the code that depends on it rather than in three separate queries.
  // (Belt and braces: an active trip has no snapped geometry either, because the map-matcher only
  // touches closed trips — but that is a coincidence of another module's scheduling, not a rule
  // this one should rely on.)
  if (trip.status !== 'completed' && trip.status !== 'timed_out') return null;

  const { eligible } = eligibility(trip);
  if (!eligible) return computeTripMetrics(trip._id);

  const scope = await scopeForTrip(trip);
  // Stamp the scope now if the trip predates the field, so every later read is a lookup on the
  // trip rather than a join back through a project that may since have moved.
  if (!trip.coverageScopeId) {
    await Trip.updateOne(
      { _id: trip._id },
      { $set: { coverageScopeId: scope.coverageScopeId, coverageCycleId: scope.coverageCycleId } }
    );
    trip.coverageScopeId = scope.coverageScopeId;
    trip.coverageCycleId = scope.coverageCycleId;
  }

  const steps = walkTrip(trip);
  const { segments } = unionWithinTrip(steps);
  const displaced = await claimTrip(trip, scope, segments);

  const result = await computeTripMetrics(trip._id);
  for (const other of displaced) {
    if (String(other) === String(trip._id)) continue;
    await computeTripMetrics(other);
  }
  return result;
}

/**
 * Rebuild one coverage scope from scratch: the migration path, and the answer to every "the
 * numbers moved and I do not know why" question.
 *
 * Two passes, and they have to be two. Pass one lets every trip stake its claim, with takeovers
 * settling any case where a later-STARTING trip reached a road first. Only once the ledger has
 * stopped moving does pass two ask each trip what it ended up owning. Doing both in one pass would
 * make a trip's figure depend on the order trips happened to be visited, which is exactly the bug
 * this whole feature exists to remove.
 *
 * Deletes only CoverageSegment rows for this scope — a derived collection this engine owns and
 * can regenerate from trip geometry at any time. Trips, location points, raw and cleaned
 * distances, route geometry and the legacy UkmEdge collection are never touched.
 */
async function rebuildScope(scopeId, cycleId = '', { onProgress } = {}) {
  const scope = { coverageScopeId: scopeId, coverageCycleId: cycleId };

  await CoverageSegment.deleteMany({
    coverageScopeId: scopeId,
    coverageCycleId: cycleId,
  });

  const trips = await Trip.find({
    coverageScopeId: scopeId,
    // Exactly this cycle, never "this cycle or any other". A cycle is a deliberate uniqueness
    // reset, so folding two of them into one replay would silently merge histories the business
    // asked to keep apart. The default cycle is stored as null on trips and '' in the ledger, so
    // both spellings of "no cycle" have to be matched here.
    coverageCycleId: cycleId ? cycleId : { $in: [null, ''] },
    status: { $in: ['completed', 'timed_out'] },
  })
    .select(
      '_id driverId projectId startedAt endedAt coverageScopeId coverageCycleId ' +
        'cleanedRouteShapes cleanedMatchedRatio mapMatchStatus'
    )
    .sort({ startedAt: 1, _id: 1 })
    .lean();

  let claimed = 0;
  for (const trip of trips) {
    if (!eligibility(trip).eligible) continue;
    const steps = walkTrip(trip);
    const { segments } = unionWithinTrip(steps);
    await claimTrip(trip, scope, segments);
    claimed += 1;
    if (onProgress && claimed % 25 === 0) onProgress({ phase: 'claim', done: claimed, total: trips.length });
  }

  let measured = 0;
  for (const trip of trips) {
    await computeTripMetrics(trip._id);
    measured += 1;
    if (onProgress && measured % 25 === 0) onProgress({ phase: 'measure', done: measured, total: trips.length });
  }

  const total = await CoverageSegment.aggregate([
    { $match: { coverageScopeId: scopeId, coverageCycleId: cycleId } },
    { $group: { _id: null, meters: { $sum: '$lengthMeters' }, segments: { $sum: 1 } } },
  ]);

  return {
    scopeId,
    cycleId,
    trips: trips.length,
    attributed: claimed,
    scopeUniqueMeters: total[0]?.meters ?? 0,
    segments: total[0]?.segments ?? 0,
  };
}

module.exports = {
  attributeTrip,
  computeTripMetrics,
  rebuildScope,
  overlapBreakdown,
  // exported for the acceptance tests, which need to reason about the pieces individually
  walkTrip,
  unionWithinTrip,
  classifyShapes,
  eligibility,
};
