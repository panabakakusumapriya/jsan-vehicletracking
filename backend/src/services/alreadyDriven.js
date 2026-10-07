const Trip = require('../models/Trip');
const User = require('../models/User');
const LinkCoverage = require('../models/LinkCoverage');
const CoverageSegment = require('../models/CoverageSegment');
const { analyseTrip } = require('./linkCoverage');
const { walkTrip, unionWithinTrip, eligibility } = require('./globalUkm');
const { scopeForTrip } = require('./coverageScope');

/**
 * "Already driven before" — the road a trip covered that it does NOT get UKM for, and who had it.
 *
 * UKM is first-cover-wins: a trip earns only road nobody reached before it. Everything else it
 * drove was somebody's already, and the Trips page shows that on hover — "4.1 km already driven on
 * 3 Oct by Ravi, not counted here" — so a low UKM explains itself instead of looking like a bug.
 *
 * Grouped by the trip that got there first: one row per earlier drive, with its date and driver,
 * split into inside / outside the areas THIS trip's driver held — the same split as the trip's
 * Assigned UKM and Outside UKM columns.
 *
 * Measured on the customer's road links (LinkCoverage) wherever the trip was attributed against a
 * network, which is what both UKM columns are measured on. A trip with no network to measure
 * against falls back to the fleet-wide road ledger (CoverageSegment), so it still gets an answer.
 *
 * Read-only: it re-reads the trip's geometry and the ledgers and writes nothing.
 */

const CHUNK = 1000;
/** Earlier drives listed individually; the rest are summed into one "and N more" line. */
const MAX_ROWS = 12;

const TRIP_FIELDS =
  '_id driverId projectId startedAt endedAt status cleanedRouteShapes cleanedMatchedRatio ' +
  'mapMatchStatus cleanedDistanceMeters parkedJitter coverageScopeId coverageCycleId';

async function findChunked(Model, filter, key, values, select) {
  const out = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await Model.find({ ...filter, [key]: { $in: values.slice(i, i + CHUNK) } }).select(select).lean()));
  }
  return out;
}

/** Name the earlier drives: their driver, and when each one started. */
async function describe(groups, tripDriverId) {
  const tripIds = [...groups.keys()];
  const [trips, users] = await Promise.all([
    Trip.find({ _id: { $in: tripIds } }).select('startedAt driverId').lean(),
    User.find({ _id: { $in: [...new Set([...groups.values()].map((g) => String(g.driverId)))] } })
      .select('name')
      .lean(),
  ]);
  const startOf = new Map(trips.map((t) => [String(t._id), t.startedAt]));
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));

  const rows = [...groups.values()]
    .map((g) => ({
      tripId: g.tripId,
      driverId: String(g.driverId),
      driverName: nameOf.get(String(g.driverId)) || 'Unknown driver',
      // When that earlier drive reached this road — what "already driven on" means.
      at: g.firstAt,
      tripStartedAt: startOf.get(g.tripId) || null,
      meters: g.meters,
      insideMeters: g.insideMeters,
      outsideMeters: g.outsideMeters,
      // Re-driving your own road is route planning; someone else's is crew coordination.
      self: String(g.driverId) === String(tripDriverId),
    }))
    .sort((a, b) => b.meters - a.meters);

  const shown = rows.slice(0, MAX_ROWS);
  const rest = rows.slice(MAX_ROWS);
  return {
    rows: shown,
    moreTrips: rest.length,
    moreMeters: rest.reduce((n, r) => n + r.meters, 0),
  };
}

function addTo(groups, owner, meters, inside) {
  const key = String(owner.firstTripId);
  let g = groups.get(key);
  if (!g) {
    g = { tripId: key, driverId: owner.firstDriverId, firstAt: owner.firstAt, meters: 0, insideMeters: 0, outsideMeters: 0 };
    groups.set(key, g);
  }
  g.meters += meters;
  if (inside) g.insideMeters += meters;
  else g.outsideMeters += meters;
  if (owner.firstAt < g.firstAt) g.firstAt = owner.firstAt;
}

async function alreadyDriven(tripId) {
  const trip = await Trip.findById(tripId).select(TRIP_FIELDS).lean();
  if (!trip) return null;
  const { eligible, status } = eligibility(trip);
  if (!eligible) return { computed: false, reason: status };

  const a = await analyseTrip(trip);

  /* ---- measured on the customer's road network: the basis of both UKM columns ---- */
  if (a.ctx && a.steps && a.steps.length) {
    const held = new Map(
      (
        await findChunked(
          LinkCoverage,
          { networkVersionId: a.ctx.networkVersionId },
          'linkId',
          [...a.covered.keys()],
          'linkId firstTripId firstDriverId firstAt -_id'
        )
      ).map((r) => [r.linkId, r])
    );
    const mine = new Set(a.ctx.areas.map((x) => String(x._id)));
    const groups = new Map();
    let ownInside = 0;
    let ownOutside = 0;
    let repeatMeters = 0;
    let clearedMeters = 0;
    for (const [linkId, hit] of a.covered) {
      const meters = hit.link.lengthMeters || 0;
      const inside = mine.size > 0 && mine.has(String(hit.link.areaId));
      const owner = held.get(linkId);
      if (!owner) {
        // Driven, but owned by nobody: its area's driven data was cleared after this trip, and a
        // clear is permanent (models/CoverageReset.js). Not this trip's, and not anyone's.
        clearedMeters += meters;
      } else if (String(owner.firstTripId) === String(trip._id)) {
        if (inside) ownInside += meters;
        else ownOutside += meters;
      } else {
        repeatMeters += meters;
        addTo(groups, owner, meters, inside);
      }
    }
    return {
      computed: true,
      basis: 'network',
      hasAreas: mine.size > 0,
      ownInsideMeters: ownInside,
      ownOutsideMeters: ownOutside,
      repeatMeters,
      clearedMeters,
      ...(await describe(groups, trip.driverId)),
    };
  }

  /* ---- no network to measure against: the fleet-wide road ledger ---- */
  const { segments } = unionWithinTrip(walkTrip(trip));
  const scope = await scopeForTrip(trip);
  const held = await findChunked(
    CoverageSegment,
    { coverageScopeId: scope.coverageScopeId, coverageCycleId: scope.coverageCycleId },
    'segmentKey',
    [...segments.keys()],
    'segmentKey firstTripId firstDriverId firstAt -_id'
  );
  const byKey = new Map(held.map((r) => [r.segmentKey, r]));
  const groups = new Map();
  let ownMeters = 0;
  let repeatMeters = 0;
  for (const [key, seg] of segments) {
    const owner = byKey.get(key);
    if (!owner) continue;
    if (String(owner.firstTripId) === String(trip._id)) ownMeters += seg.meters;
    else {
      repeatMeters += seg.meters;
      addTo(groups, owner, seg.meters, false);
    }
  }
  return {
    computed: true,
    basis: 'global',
    hasAreas: false,
    ownInsideMeters: 0,
    ownOutsideMeters: ownMeters,
    repeatMeters,
    clearedMeters: 0,
    ...(await describe(groups, trip.driverId)),
  };
}

module.exports = { alreadyDriven };
