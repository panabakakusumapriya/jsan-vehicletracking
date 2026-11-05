const Trip = require('../models/Trip');
const User = require('../models/User');
const WorkArea = require('../models/WorkArea');
const LinkCoverage = require('../models/LinkCoverage');
const AreaAssignment = require('../models/AreaAssignment');
const env = require('../config/env');

/**
 * Where each of a project's drivers last STOPPED — for the coverage map.
 *
 * The map already says WHAT is driven (blue roads) and WHO holds an area. This adds where the work
 * stopped, per driver, so tomorrow can be planned from the map: the end of their most recent
 * FINISHED drive on this project's ground (its last GPS fix), and only when that stop was recent —
 * within the last day by default (`withinHours`).
 *
 * It used to be the last fix of the last drive of anyone who had ever been near the project: live
 * moving positions mixed with stops weeks old, and drivers who had long left the project — four of
 * twenty-four pins were deactivated accounts last seen up to three months before. Now:
 *
 *  - Who: the project's drivers today — on the project, account active. Not whoever once drove
 *    its road or still has an assignment row.
 *  - Where: where a drive ENDED. A drive still under way has no stop yet; the driver's pin stays at
 *    their previous stop, marked `drivingNow` (the live map is the place for a moving dot).
 *  - When: the stop is at most `withinHours` old; an older one gets no pin at all.
 *
 * Three more decisions worth knowing about:
 *
 *  - "Last real drive" excludes parked-GPS-jitter sessions (services/tripNoise.js), exactly as the
 *    Driven tracks layer on the same map does. The vehicle is in the same place either way, but
 *    the time would be wrong: "stopped at 17:40" must not become "22:10" because the phone sat
 *    reporting in a car park.
 *
 *  - Which trips are this project's. A trip is stamped with its project at start, but only when
 *    the driver held exactly one (see tracking.controller.js) — a driver on two projects records
 *    unstamped trips. Those are placed by geography: an unstamped trip counts here when its last
 *    fix is on, or within GROUND_PAD_DEG of, this project's work areas. A stamped trip counts
 *    wherever it ended; the driver going home 40 km away is still where they are.
 *
 *  - Imported history has no position. Those trips were rebuilt from the customer's covered roads
 *    and carry no GPS fix, so they can never say where anybody stopped. Skipped, not guessed.
 */

const TRIP_FIELDS =
  'driverId projectId status startedAt endedAt lastLocation distanceMeters cleanedDistanceMeters mapMatchStatus ' +
  'assignedNetworkVersionId';
/** Unstamped trips looked at per driver, newest first, when placing them by geography. */
const UNSTAMPED_LOOKBACK = 12;
/** How far outside the project's work areas an unstamped trip may end and still count. ~25 km. */
const GROUND_PAD_DEG = 0.25;
/** Drivers resolved at once — each costs three small indexed reads. */
const PARALLEL = 8;
/** "Recently stopped": the last day, unless the caller asks for more (the map offers 1 / 3 / 7 days). */
const DEFAULT_WITHIN_HOURS = 24;
const MAX_WITHIN_HOURS = 24 * 7;
/**
 * A drive that STOPPED inside the window may have STARTED before it (trips are capped at 8 h, and a
 * timed-out one closes after its last fix). Lets the lookups ride the { driverId, startedAt } index.
 */
const START_SLACK_MS = 12 * 3600 * 1000;

/** A finished, real drive with a GPS fix to place it by. */
const HAS_FIX = {
  'lastLocation.lat': { $type: 'number' },
  'lastLocation.lon': { $type: 'number' },
  parkedJitter: { $ne: true },
  status: { $ne: 'active' },
};

/** When the vehicle actually stood still: the last fix, not the (possibly much later) close. */
const stopTime = (trip) => new Date(trip.lastLocation.recordedAt || trip.endedAt || trip.startedAt);

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** The project's drivers today: on the project, account active. Only they get a pin. */
async function currentDrivers(scope) {
  return User.find({ projectIds: scope.projectId, role: 'user', active: { $ne: false } })
    .select('_id name')
    .lean();
}

/**
 * Everyone whose drives belong to this project, past drivers included: its drivers today, whoever
 * holds one of its areas, and whoever has driven road on it. Decides who may have a ROUTE read
 * (lastDriveRoute) — not who gets a pin, which is currentDrivers.
 */
async function projectDriverIds(scope) {
  const [members, holders, drove] = await Promise.all([
    User.find({ projectIds: scope.projectId, role: 'user' }).select('_id').lean(),
    AreaAssignment.distinct('driverId', { projectId: scope.projectId, releasedAt: null }),
    // Rides the { networkVersionId, firstDriverId } index — no ledger rows are read.
    LinkCoverage.distinct('firstDriverId', { networkVersionId: { $in: scope.versionIds } }),
  ]);
  return new Set(
    [...members.map((m) => m._id), ...holders, ...drove].filter(Boolean).map(String)
  );
}

/** A lazy test: is this [lon, lat] on or near the project's work areas? */
function groundTester(scope) {
  let boxes = null;
  return async (lon, lat) => {
    if (!boxes) {
      boxes = WorkArea.find({ networkVersionId: { $in: scope.versionIds } })
        .select('bbox -_id')
        .lean()
        .then((rows) => rows.map((r) => r.bbox).filter((b) => Array.isArray(b) && b.length === 4));
    }
    for (const [w, s, e, n] of await boxes) {
      if (
        lon >= w - GROUND_PAD_DEG && lon <= e + GROUND_PAD_DEG &&
        lat >= s - GROUND_PAD_DEG && lat <= n + GROUND_PAD_DEG
      ) return true;
    }
    return false;
  };
}

/**
 * Narrowed to some of the project's deliveries (the coverage page's region filter): the newest
 * drive measured against one of them, or — not measured yet, or never — that ended on their
 * ground. A driver who has since moved to the other side of the Tasman is still shown here at
 * where they last worked here.
 */
async function lastDriveIn(driverId, scope, onGround, since) {
  const ours = new Set(scope.versionIds.map(String));
  const recent = await Trip.find({ ...HAS_FIX, driverId, projectId: { $in: [scope.projectId, null] }, startedAt: { $gte: since } })
    .sort({ startedAt: -1 })
    .limit(UNSTAMPED_LOOKBACK)
    .select(TRIP_FIELDS)
    .lean();
  for (const trip of recent) {
    if (trip.assignedNetworkVersionId) {
      if (ours.has(String(trip.assignedNetworkVersionId))) return trip;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await onGround(trip.lastLocation.lon, trip.lastLocation.lat)) return trip;
  }
  return null;
}

/** The driver's last finished real drive on this project that started after `since`, or null. */
async function lastDrive(driverId, scope, onGround, since) {
  if (!scope.isProject) return lastDriveIn(driverId, scope, onGround, since);
  const [stamped, unstamped] = await Promise.all([
    Trip.findOne({ ...HAS_FIX, driverId, projectId: scope.projectId, startedAt: { $gte: since } })
      .sort({ startedAt: -1 })
      .select(TRIP_FIELDS)
      .lean(),
    Trip.find({ ...HAS_FIX, driverId, projectId: null, startedAt: { $gte: since } })
      .sort({ startedAt: -1 })
      .limit(UNSTAMPED_LOOKBACK)
      .select(TRIP_FIELDS)
      .lean(),
  ]);

  let placed = null;
  for (const trip of unstamped) {
    // Nothing older than the stamped trip can win, so stop looking once we are past it.
    if (stamped && trip.startedAt <= stamped.startedAt) break;
    // eslint-disable-next-line no-await-in-loop
    if (await onGround(trip.lastLocation.lon, trip.lastLocation.lat)) {
      placed = trip;
      break;
    }
  }
  return placed || stamped || null;
}

/**
 * The work area a point sits in. Asked of the full geometry through the 2dsphere index, so a
 * simplified outline can never put a driver in the wrong area. Where two live deliveries overlap,
 * the current one's copy of the area wins.
 */
async function areaAt(scope, lon, lat) {
  let hits;
  try {
    hits = await WorkArea.find({
      networkVersionId: { $in: scope.versionIds },
      geometry: { $geoIntersects: { $geometry: { type: 'Point', coordinates: [lon, lat] } } },
    })
      .select('areaCode name parentName networkVersionId')
      .lean();
  } catch {
    // A polygon the geo index could not take is a data problem for the import to report, not a
    // reason to lose every driver's position.
    return null;
  }
  if (!hits.length) return null;
  const primary = scope.primary ? String(scope.primary._id) : null;
  return hits.find((a) => String(a.networkVersionId) === primary) || hits[0];
}

/** The window asked for, in hours, kept to 1 h – 7 days. */
function windowHours(raw) {
  const h = Number(raw);
  if (!Number.isFinite(h) || h <= 0) return DEFAULT_WITHIN_HOURS;
  return Math.min(MAX_WITHIN_HOURS, Math.max(1, h));
}

/**
 * One pin per current driver who stopped within the window: where their latest finished drive
 * ended. @param opts.withinHours  how recent a stop must be (default 24, at most 168).
 */
async function lastPositions(scope, opts = {}) {
  const hours = windowHours(opts.withinHours);
  const now = Date.now();
  const cutoff = new Date(now - hours * 3600 * 1000);
  const since = new Date(cutoff.getTime() - START_SLACK_MS);

  const users = await currentDrivers(scope);
  if (!users.length) return [];
  const ids = users.map((u) => String(u._id));

  const onGround = groundTester(scope);
  const [trips, held, driving] = await Promise.all([
    inBatches(ids, PARALLEL, (id) => lastDrive(id, scope, onGround, since)),
    AreaAssignment.find({ projectId: scope.projectId, releasedAt: null, driverId: { $in: ids } })
      .select('driverId areaCode')
      .lean(),
    // On the road again right now: an open drive with a fresh fix. Said on the pin, not drawn.
    Trip.distinct('driverId', {
      driverId: { $in: ids },
      status: 'active',
      'lastLocation.recordedAt': { $gte: new Date(now - env.STALE_AFTER_SECONDS * 1000) },
    }),
  ]);
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));
  const found = trips.filter((t) => t && nameById.has(String(t.driverId)) && stopTime(t) >= cutoff);
  if (!found.length) return [];

  const holds = new Set(held.map((a) => `${a.driverId}:${a.areaCode}`));
  const drivingNow = new Set(driving.map(String));
  const areas = await inBatches(found, PARALLEL, (t) => areaAt(scope, t.lastLocation.lon, t.lastLocation.lat));

  return found
    .map((trip, i) => {
      const driverId = String(trip.driverId);
      const area = areas[i];
      return {
        driverId,
        name: nameById.get(driverId),
        lat: trip.lastLocation.lat,
        lon: trip.lastLocation.lon,
        heading: Number.isFinite(trip.lastLocation.heading) ? trip.lastLocation.heading : null,
        speedKmh: Number.isFinite(trip.lastLocation.speed) ? trip.lastLocation.speed : null,
        // When the vehicle stopped there — the fix's own time, not the trip's close time: a
        // timed-out trip is closed minutes or hours after its last fix.
        at: stopTime(trip),
        // Always a finished drive now; kept for the panel, which still reads the field.
        state: 'ended',
        drivingNow: drivingNow.has(driverId),
        trip: {
          id: String(trip._id),
          status: trip.status,
          startedAt: trip.startedAt,
          endedAt: trip.endedAt,
          // Snapped distance once the matcher has been; the live GPS total until then.
          meters: trip.cleanedDistanceMeters ?? trip.distanceMeters ?? 0,
          snapped: trip.mapMatchStatus === 'matched',
        },
        area: area
          ? {
              _id: String(area._id),
              areaCode: area.areaCode,
              name: area.name,
              parentName: area.parentName || null,
              // Is it one of their own? A driver parked in somebody else's area is worth seeing.
              mine: holds.has(`${driverId}:${area.areaCode}`),
            }
          : null,
      };
    })
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

const refuse = (message, status) => Object.assign(new Error(message), { status });

/**
 * The snapped route of one of those last drives, so the map can draw the road leading up to the
 * pin. Snapped only, for the reason versionTracks gives: raw GPS over a road network reads as
 * coverage the ledger does not agree with. A drive still open, or still with the matcher, has no
 * route yet — said plainly (`pending`) rather than drawn approximately.
 */
async function lastDriveRoute(scope, tripId) {
  const trip = await Trip.findById(tripId)
    .select('driverId projectId status mapMatchStatus cleanedRouteShapes cleanedDistanceMeters startedAt endedAt')
    .lean();
  if (!trip) throw refuse('Trip not found', 404);
  // Only this project's trips: one stamped with it, or an unstamped one by one of its drivers.
  const ours = trip.projectId
    ? String(trip.projectId) === String(scope.projectId)
    : (await projectDriverIds(scope)).has(String(trip.driverId));
  if (!ours) throw refuse('Trip not found', 404);

  const shapes = trip.cleanedRouteShapes || [];
  return {
    tripId: String(trip._id),
    driverId: String(trip.driverId),
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    meters: trip.cleanedDistanceMeters || 0,
    snapped: shapes.length > 0,
    pending:
      !shapes.length && (trip.status === 'active' || ['pending', 'matching'].includes(trip.mapMatchStatus)),
    // polyline6, exactly as the matcher produced it — the client decodes, never derives.
    shapes,
  };
}

module.exports = { lastPositions, lastDriveRoute, projectDriverIds, DEFAULT_WITHIN_HOURS, MAX_WITHIN_HOURS };
