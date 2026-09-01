const Trip = require('../models/Trip');
const RoadLink = require('../models/RoadLink');
const LinkCoverage = require('../models/LinkCoverage');
const NetworkVersion = require('../models/NetworkVersion');
const User = require('../models/User');
const env = require('../config/env');
const { bboxOf, bboxPad, bearing, bearingDelta, haversine, Grid } = require('../utils/geo');
const { encodePolyline6 } = require('./valhalla');
const { walkTrip, eligibility } = require('./globalUkm');
const { assignedAreasForTrip, makeAreaTester } = require('./assignedAreas');
const { syncEffectiveUkm } = require('./ukmBasis');

/**
 * ASSIGNED-NETWORK COVERAGE — the writer LinkCoverage never had.
 *
 * Two questions the global engine cannot answer, because it only knows about other driving:
 *
 *   1. Of the road links the CUSTOMER asked us to drive, which did this trip cover, and was it the
 *      first trip in the network to do so? That is the ledger the driver's phone paints blue from
 *      and the Coverage tab reports % complete from — and until this module existed nothing wrote
 *      it, so every assigned street stayed red forever.
 *   2. How much of the driving happened INSIDE the polygons this driver was assigned, and how much
 *      outside? (README EC-25.) Outside driving may still be globally new road; it is not the job.
 *
 * And from them, the driver-facing rule: a driver holding polygons is measured on the links inside
 * them ("assigned-route UKM"); a driver holding none is measured on global UKM. See ukmBasis.js.
 *
 * Road identity here is the customer's LINK_ID, not a snapped-vertex pair — the "canonical road
 * attribution" the end-goal document asks for, applied to the assigned case. Matching is geometric
 * with a buffer: a link is covered when enough of it lies within LINK_COVER_BUFFER_METERS of the
 * snapped route, in a compatible direction of travel. Whole-link granularity with the covered
 * fraction stored is the documented tolerance; along-link intervals are the next phase.
 *
 * Ownership, takeovers and passes follow globalUkm.claimTrip exactly, keyed (networkVersionId,
 * linkId), with the unique index as the lock. Everything written is derivable from trip geometry
 * plus the ledger, so rebuildNetworkCoverage() can clear and replay a version at any time.
 */

// Candidate links are fetched per stretch of route this long. The alternative — one query over the
// whole trip's bbox — pulls tens of thousands of links for a rural trip that only drove a few
// hundred of them.
const WINDOW_METERS = 3000;
// Sample spacing along a link when measuring how much of it the route touched. Links average 94 m,
// so this is ~12 samples each — fine enough that the 60 % threshold means what it says.
const SAMPLE_METERS = 8;
// ~111 m cells. The buffer is 15 m, so the containing cell plus its ring always covers it.
const GRID_CELL_DEG = 0.001;
const MAX_LINKS_PER_WINDOW = 30000;
const BULK_CHUNK = 1000;
const D = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

/**
 * The route as an in-memory spatial index. Each step from walkTrip becomes an item carrying its
 * projected endpoints and bearing, registered in a Grid by bbox so a sample point can ask for the
 * handful of steps near it instead of scanning thousands.
 */
function routeIndex(steps) {
  const grid = new Grid(GRID_CELL_DEG);
  const mx = 111320 * Math.cos(steps[0].a.lat * D);
  const my = 110574;
  const items = steps.map((s, i) => {
    const p = [s.a.lon, s.a.lat];
    const q = [s.b.lon, s.b.lat];
    const it = {
      i,
      p,
      q,
      ax: p[0] * mx,
      ay: p[1] * my,
      bx: q[0] * mx,
      by: q[1] * my,
      brg: bearing(p, q),
      meters: s.meters,
      observedAt: s.observedAt,
      shapeIndex: s.shapeIndex,
    };
    grid.insert(bboxOf([p, q]), it);
    return it;
  });
  return { grid, mx, my, items };
}

function headingCompatible(stepBrg, linkBrg, dirTravel) {
  const max = env.LINK_COVER_HEADING_MAX_DELTA_DEG;
  const along = bearingDelta(stepBrg, linkBrg) <= max;
  const against = bearingDelta(stepBrg, (linkBrg + 180) % 360) <= max;
  if (dirTravel === 'F') return along;
  if (dirTravel === 'T') return against;
  return along || against;
}

/** The nearest route step within `buffer` metres of `pt` whose heading suits the link, or null. */
function nearestCompatibleStep(index, pt, linkBrg, dirTravel, buffer) {
  const px = pt[0] * index.mx;
  const py = pt[1] * index.my;
  let best = null;
  let bestD2 = buffer * buffer;
  for (const it of index.grid.near(pt, 1)) {
    if (!headingCompatible(it.brg, linkBrg, dirTravel)) continue;
    const dx = it.bx - it.ax;
    const dy = it.by - it.ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - it.ax) * dx + (py - it.ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (it.ax + t * dx);
    const ey = py - (it.ay + t * dy);
    const d2 = ex * ex + ey * ey;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = it;
    }
  }
  return best;
}

/** Points every SAMPLE_METERS along a [lon, lat][] line, each with the bearing of its segment. */
function sampleLink(coords) {
  const samples = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const len = haversine(a, b);
    if (len <= 0) continue;
    const brg = bearing(a, b);
    const n = Math.max(1, Math.ceil(len / SAMPLE_METERS));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      samples.push({ pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], brg });
    }
    if (i === coords.length - 1) samples.push({ pt: b, brg });
  }
  return samples;
}

/**
 * Every link of the version that the route passes near. Windowed by route length: each window's
 * padded bbox is one $geoIntersects on the 2dsphere index, and a window never spans a gap between
 * two separately-matched shapes (the bbox across a gap would be all countryside).
 */
async function candidateLinks(networkVersionId, items) {
  const links = new Map();
  let pts = [];
  let acc = 0;
  let shape = -1;

  const flush = async () => {
    if (!pts.length) return;
    const [w, s, e, n] = bboxPad(bboxOf(pts), env.LINK_COVER_BUFFER_METERS + 5);
    const rows = await RoadLink.find({
      networkVersionId,
      geometry: {
        $geoIntersects: {
          $geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        },
      },
    })
      .select('linkId funcClass dirTravel areaId priority lengthMeters geometry.coordinates')
      .limit(MAX_LINKS_PER_WINDOW)
      .lean();
    for (const r of rows) if (!links.has(r.linkId)) links.set(r.linkId, r);
    pts = [];
    acc = 0;
  };

  for (const it of items) {
    if (shape !== -1 && it.shapeIndex !== shape) await flush();
    shape = it.shapeIndex;
    pts.push(it.p, it.q);
    acc += it.meters;
    if (acc >= WINDOW_METERS) await flush();
  }
  await flush();
  return links;
}

/**
 * Which candidate links the route covered: Map(linkId -> { link, fraction, observedAt }).
 *
 * A link is covered when at least LINK_COVER_MIN_FRACTION of its samples have a route step within
 * the buffer in a compatible direction. Its observation time is the earliest such step's — the
 * moment the vehicle reached it — which is what ownership is decided on.
 */
function matchLinks(index, links) {
  const covered = new Map();
  const buffer = env.LINK_COVER_BUFFER_METERS;
  for (const link of links.values()) {
    const coords = link.geometry && link.geometry.coordinates;
    if (!coords || coords.length < 2) continue;
    const samples = sampleLink(coords);
    if (!samples.length) continue;
    let hits = 0;
    let firstAt = null;
    for (const s of samples) {
      const it = nearestCompatibleStep(index, s.pt, s.brg, link.dirTravel || 'B', buffer);
      if (!it) continue;
      hits += 1;
      if (!firstAt || it.observedAt < firstAt) firstAt = it.observedAt;
    }
    const fraction = hits / samples.length;
    if (fraction >= env.LINK_COVER_MIN_FRACTION) {
      covered.set(link.linkId, { link, fraction, observedAt: firstAt });
    }
  }
  return covered;
}

/** Contiguous runs of steps matching `predicate` (never joined across shapes), as polyline6. */
function runsToShapes(items, predicate) {
  const shapes = [];
  let run = null;
  let runShape = -1;
  const flush = () => {
    if (run && run.length > 1) shapes.push(encodePolyline6(run.map(([lon, lat]) => ({ lat, lon }))));
    run = null;
  };
  for (const it of items) {
    const hit = predicate(it);
    if (!hit || it.shapeIndex !== runShape) flush();
    if (!hit) continue;
    if (!run) {
      run = [it.p, it.q];
      runShape = it.shapeIndex;
    } else {
      run.push(it.q);
    }
  }
  flush();
  return shapes;
}

/** In/out split over the route steps, by midpoint, against the assigned polygons. */
function splitByArea(items, areas) {
  const inside = makeAreaTester(areas, env.AREA_BOUNDARY_BUFFER_METERS);
  let inMeters = 0;
  let outMeters = 0;
  for (const it of items) {
    it.inside = inside([(it.p[0] + it.q[0]) / 2, (it.p[1] + it.q[1]) / 2]);
    if (it.inside) inMeters += it.meters;
    else outMeters += it.meters;
  }
  return { inMeters, outMeters, outShapes: runsToShapes(items, (it) => !it.inside) };
}

// ---------------------------------------------------------------------------------------------
// Analysis: everything derivable from the trip alone, before the ledger is consulted
// ---------------------------------------------------------------------------------------------

const TRIP_FIELDS =
  '_id driverId projectId startedAt endedAt status cleanedRouteShapes cleanedMatchedRatio ' +
  'mapMatchStatus cleanedDistanceMeters';

/**
 * Resolve the assignment, walk the route, split it by area and match it to links. Returns
 * { ctx: null } when the project has no active network, { ctx, steps: [] } when the trip has no
 * usable geometry, and the full picture otherwise. Nothing here writes.
 */
async function analyseTrip(trip) {
  const ctx = await assignedAreasForTrip(trip);
  if (!ctx) return { ctx: null };

  const steps = walkTrip(trip);
  if (!steps.length) return { ctx, steps, index: null, covered: new Map(), split: null };

  const index = routeIndex(steps);
  const split = ctx.areas.length ? splitByArea(index.items, ctx.areas) : null;
  const links = await candidateLinks(ctx.networkVersionId, index.items);
  const covered = matchLinks(index, links);
  return { ctx, steps, index, covered, split };
}

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

async function bulkChunked(ops) {
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    await LinkCoverage.bulkWrite(ops.slice(i, i + BULK_CHUNK), { ordered: false });
  }
}

async function ledgerFor(networkVersionId, linkIds) {
  const found = new Map();
  const list = [...linkIds];
  for (let i = 0; i < list.length; i += BULK_CHUNK) {
    const rows = await LinkCoverage.find({ networkVersionId, linkId: { $in: list.slice(i, i + BULK_CHUNK) } })
      .select('linkId lengthMeters areaId firstTripId firstAt lastTripId')
      .lean();
    for (const r of rows) found.set(r.linkId, r);
  }
  return found;
}

/** Is (aAt, aTrip) strictly earlier than (bAt, bTrip)? Same tie-break as globalUkm. */
function earlierThan(aAt, aTrip, bAt, bTrip) {
  const d = new Date(aAt).getTime() - new Date(bAt).getTime();
  if (d !== 0) return d < 0;
  return String(aTrip) < String(bTrip);
}

/**
 * Stake the trip's claim on every link it covered. Three outcomes per link — unheld: claim it;
 * held by a later observation: take it (their trip is now stale); held by an earlier one: record a
 * pass. Plus one this ledger needs that the global one does not: links this trip USED to own but
 * no longer covers (its route was re-matched) are released. Returns the displaced trip ids.
 */
async function claimLinks(trip, ctx, covered) {
  const displaced = new Set();
  const base = (linkId) => ({ networkVersionId: ctx.networkVersionId, linkId });

  const settle = (linkId, hit, held, takeovers, passes) => {
    if (String(held.firstTripId) === String(trip._id)) return;
    if (earlierThan(hit.observedAt, trip._id, held.firstAt, held.firstTripId)) {
      displaced.add(String(held.firstTripId));
      takeovers.push({
        updateOne: {
          filter: {
            ...base(linkId),
            $or: [
              { firstAt: { $gt: hit.observedAt } },
              { firstAt: hit.observedAt, firstTripId: { $gt: trip._id } },
            ],
          },
          update: {
            $set: {
              firstTripId: trip._id,
              firstDriverId: trip.driverId,
              firstAt: hit.observedAt,
              firstFraction: hit.fraction,
            },
          },
        },
      });
    } else {
      passes.push({
        updateOne: {
          filter: { ...base(linkId), firstTripId: { $ne: trip._id }, lastTripId: { $ne: trip._id } },
          update: { $inc: { passes: 1 }, $set: { lastTripId: trip._id, lastAt: hit.observedAt } },
        },
      });
    }
  };

  const existing = await ledgerFor(ctx.networkVersionId, covered.keys());
  const inserts = [];
  const takeovers = [];
  const passes = [];
  const attempted = [];

  for (const [linkId, hit] of covered) {
    const held = existing.get(linkId);
    if (!held) {
      attempted.push(linkId);
      const l = hit.link;
      inserts.push({
        updateOne: {
          filter: base(linkId),
          update: {
            $setOnInsert: {
              ...base(linkId),
              projectId: ctx.projectId,
              lengthMeters: l.lengthMeters,
              areaId: l.areaId || null,
              priority: l.priority ?? null,
              funcClass: l.funcClass ?? null,
              firstTripId: trip._id,
              firstDriverId: trip.driverId,
              firstAt: hit.observedAt,
              firstFraction: hit.fraction,
              passes: 1,
              lastTripId: trip._id,
              lastAt: hit.observedAt,
            },
          },
          upsert: true,
        },
      });
      continue;
    }
    settle(linkId, hit, held, takeovers, passes);
  }

  await bulkChunked(inserts);
  // Re-read what we tried to insert: an upsert that lost a race to another worker no-ops silently,
  // and that link still has to be settled one way or the other. See globalUkm.claimTrip.
  if (attempted.length) {
    const settled = await ledgerFor(ctx.networkVersionId, attempted);
    for (const linkId of attempted) {
      const held = settled.get(linkId);
      if (held) settle(linkId, covered.get(linkId), held, takeovers, passes);
    }
  }
  await bulkChunked(takeovers);
  await bulkChunked(passes);

  // Release. A row this trip owns for a link it no longer covers describes a route that no longer
  // exists. It goes unclaimed rather than to the next pass — the ledger only remembers the LAST
  // pass, not every one, so "next earliest" is a rebuildNetworkCoverage question.
  await LinkCoverage.deleteMany({
    networkVersionId: ctx.networkVersionId,
    firstTripId: trip._id,
    linkId: { $nin: [...covered.keys()] },
  });

  return displaced;
}

// ---------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------

const NULL_METRICS = {
  inAreaMeters: null,
  outAreaMeters: null,
  linkUkmMeters: null,
  linkUkmNetworkMeters: null,
  linkCoveredCount: null,
};

/**
 * Work out one trip's figures from the ledger as it stands, and persist them. A trip's numbers are
 * a pure function of (its geometry, its assignment, the ledger): assigned-route UKM is exactly the
 * assigned links whose ledger row names this trip first. `analysis` may be passed by attribution
 * to skip re-walking a route it just walked.
 */
async function computeTripLinkMetrics(tripId, analysis = null) {
  const trip = await Trip.findById(tripId).select(TRIP_FIELDS).lean();
  if (!trip) return null;
  const now = new Date();
  const finish = async (set, unsetShapes = true) => {
    await Trip.updateOne(
      { _id: trip._id },
      {
        $set: { ...set, linkCoverageComputedAt: now },
        ...(unsetShapes ? { $unset: { outAreaShapes: 1, linkUkmShapes: 1 } } : {}),
      }
    );
    const eff = await syncEffectiveUkm(trip._id);
    return { tripId: trip._id, ...set, ...eff };
  };

  const a = analysis || (await analyseTrip(trip));
  if (!a.ctx) {
    return finish({
      ...NULL_METRICS,
      assignedAreaIds: [],
      assignedNetworkVersionId: null,
      linkCoverageStatus: 'no_network',
      ukmBasis: 'global',
    });
  }

  const assignedIds = a.ctx.areas.map((x) => x._id);
  const basis = assignedIds.length ? 'assigned' : 'global';
  const { eligible, status } = eligibility(trip);
  if (!eligible || !a.steps.length) {
    return finish({
      ...NULL_METRICS,
      assignedAreaIds: assignedIds,
      assignedNetworkVersionId: a.ctx.networkVersionId,
      // The eligibility verdict verbatim — 'review' under a no-claim policy and 'failed' are both
      // final answers, not a 'pending' that something might still resolve.
      linkCoverageStatus: eligible ? 'pending' : status,
      ukmBasis: basis,
    });
  }

  const held = await ledgerFor(a.ctx.networkVersionId, a.covered.keys());
  const assigned = new Set(assignedIds.map(String));
  let ukmMeters = 0;
  let networkMeters = 0;
  const shapes = [];
  for (const [linkId, hit] of a.covered) {
    const row = held.get(linkId);
    if (!row || String(row.firstTripId) !== String(trip._id)) continue;
    networkMeters += hit.link.lengthMeters;
    if (hit.link.areaId && assigned.has(String(hit.link.areaId))) {
      ukmMeters += hit.link.lengthMeters;
      const coords = hit.link.geometry.coordinates;
      shapes.push(encodePolyline6(coords.map(([lon, lat]) => ({ lat, lon }))));
    }
  }

  const set = {
    assignedAreaIds: assignedIds,
    assignedNetworkVersionId: a.ctx.networkVersionId,
    inAreaMeters: a.split ? a.split.inMeters : null,
    outAreaMeters: a.split ? a.split.outMeters : null,
    outAreaShapes: a.split ? a.split.outShapes : [],
    linkUkmMeters: basis === 'assigned' ? ukmMeters : null,
    linkUkmNetworkMeters: networkMeters,
    linkUkmShapes: shapes,
    linkCoveredCount: a.covered.size,
    linkCoverageStatus: status, // 'computed' or 'review'
    ukmBasis: basis,
  };
  return finish(set, false);
}

/**
 * Attribute one trip: claim its links, then recompute its figures and those of anything it
 * displaced. The incremental path, called by the map-matcher once snapped geometry exists.
 */
async function attributeTripLinks(tripId) {
  if (!env.LINK_COVERAGE_ENABLED) return null;
  const trip = await Trip.findById(tripId).select(TRIP_FIELDS).lean();
  if (!trip) return null;
  // Closed rides only, for the reason given in globalUkm.attributeTrip: a claim decides who is
  // paid for a street and must not be made on a drive that is still changing.
  if (trip.status !== 'completed' && trip.status !== 'timed_out') return null;

  try {
    const analysis = await analyseTrip(trip);
    if (!analysis.ctx || !analysis.steps.length || !eligibility(trip).eligible) {
      // A trip that can no longer claim anything must not keep what it claimed before. A re-match
      // that lost its geometry, or a drop to review under a no-claim policy, would otherwise leave
      // its streets blue on every phone and unclaimable by the next driver over them.
      if (analysis.ctx) await releaseLinks(trip._id, analysis.ctx.networkVersionId);
      return await computeTripLinkMetrics(trip._id, analysis);
    }

    const displaced = await claimLinks(trip, analysis.ctx, analysis.covered);
    const result = await computeTripLinkMetrics(trip._id, analysis);
    for (const other of displaced) {
      if (String(other) === String(trip._id)) continue;
      await computeTripLinkMetrics(other);
    }
    return result;
  } catch (err) {
    // Stamped as failed so one trip with a persistent error cannot sit at the head of every
    // catch-up batch and starve everything behind it. Rethrown so the caller can log it.
    await Trip.updateOne(
      { _id: trip._id },
      { $set: { linkCoverageStatus: 'failed', linkCoverageComputedAt: new Date() } }
    ).catch(() => {});
    throw err;
  }
}

/** Drop every claim this trip holds in one version's ledger. */
function releaseLinks(tripId, networkVersionId) {
  return LinkCoverage.deleteMany({ networkVersionId, firstTripId: tripId });
}

/**
 * Rebuild one ACTIVE version's ledger from scratch: clear it, let every matched trip on the
 * project claim in observation order, then measure each. Two passes for the reason rebuildScope
 * gives — a figure must not depend on the order trips were visited.
 *
 * Which trips: those stamped with the project, plus legacy trips with no project whose driver is
 * on it today. Only LinkCoverage rows for this version are deleted; nothing else is touched.
 */
async function rebuildNetworkCoverage(networkVersionId, { onProgress } = {}) {
  const version = await NetworkVersion.findById(networkVersionId).select('_id projectId status').lean();
  if (!version) throw new Error('Network version not found');
  if (version.status !== 'active') throw new Error('Only the active version can be attributed against');

  await LinkCoverage.deleteMany({ networkVersionId: version._id });

  const members = await User.find({ projectIds: version.projectId }).select('_id').lean();
  const trips = await Trip.find({
    status: { $in: ['completed', 'timed_out'] },
    mapMatchStatus: 'matched',
    cleanedRouteShapes: { $exists: true, $ne: [] },
    $or: [
      { projectId: version.projectId },
      { projectId: null, driverId: { $in: members.map((m) => m._id) } },
    ],
  })
    .select(TRIP_FIELDS)
    .sort({ startedAt: 1, _id: 1 })
    .lean();

  let claimed = 0;
  for (const trip of trips) {
    if (!eligibility(trip).eligible) continue;
    const analysis = await analyseTrip(trip);
    if (!analysis.ctx || String(analysis.ctx.networkVersionId) !== String(version._id)) continue;
    if (!analysis.steps.length) continue;
    await claimLinks(trip, analysis.ctx, analysis.covered);
    claimed += 1;
    if (onProgress && claimed % 25 === 0) onProgress({ phase: 'claim', done: claimed, total: trips.length });
  }

  let measured = 0;
  for (const trip of trips) {
    await computeTripLinkMetrics(trip._id);
    measured += 1;
    if (onProgress && measured % 25 === 0) onProgress({ phase: 'measure', done: measured, total: trips.length });
  }

  const total = await LinkCoverage.aggregate([
    { $match: { networkVersionId: version._id } },
    { $group: { _id: null, meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
  ]);
  return {
    networkVersionId: version._id,
    trips: trips.length,
    attributed: claimed,
    coveredLinks: total[0]?.links ?? 0,
    coveredMeters: total[0]?.meters ?? 0,
  };
}

module.exports = {
  attributeTripLinks,
  computeTripLinkMetrics,
  rebuildNetworkCoverage,
  releaseLinks,
  // exported for the tests
  analyseTrip,
  matchLinks,
  sampleLink,
  routeIndex,
};
