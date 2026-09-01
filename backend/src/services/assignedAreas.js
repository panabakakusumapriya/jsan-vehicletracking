const AreaAssignment = require('../models/AreaAssignment');
const WorkArea = require('../models/WorkArea');
const NetworkVersion = require('../models/NetworkVersion');
const User = require('../models/User');
const { bboxOf, bboxUnion, bboxPad, pointInPolygon } = require('../utils/geo');

/**
 * Which polygons a driver held WHILE A TRIP WAS DRIVEN, with geometry ready for point tests.
 *
 * Resolved against the assignment ledger's time range rather than "who holds it now": an area
 * released the morning after still counted on the day, and a trip measured against today's roster
 * would change its numbers every time the roster changed. AreaAssignment is append-only precisely
 * so this question stays answerable.
 *
 * Areas are matched by areaCode against the ACTIVE network version, the same rule myAreas and
 * authoriseArea use — a re-import mints new WorkArea ids and would otherwise strand every
 * assignment (see the comments on those two).
 */

const D = Math.PI / 180;

/** Active network version(s) the trip could be measured against. */
async function activeVersionsForTrip(trip) {
  const projectIds = [];
  if (trip.projectId) projectIds.push(String(trip.projectId));
  else {
    // Trips predating the projectId stamp: fall back to what the driver is on today. Documented
    // approximation for legacy rows only; new trips always carry their project.
    const driver = await User.findById(trip.driverId).select('projectIds').lean();
    for (const p of driver?.projectIds || []) projectIds.push(String(p));
  }
  if (!projectIds.length) return [];
  return NetworkVersion.find({ projectId: { $in: projectIds }, status: 'active' })
    .select('_id projectId')
    .lean();
}

/** Full geometry as a list of polygons, each a list of rings (outer first), plus a bbox. */
function prepareArea(a) {
  const g = a.geometry;
  const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let bbox = Array.isArray(a.bbox) && a.bbox.length === 4 ? a.bbox : null;
  if (!bbox) for (const rings of polygons) bbox = bboxUnion(bbox, bboxOf(rings[0]));
  return { _id: a._id, areaCode: a.areaCode, name: a.name, polygons, bbox };
}

/**
 * Returns { networkVersionId, projectId, areas } or null when the trip's project has no active
 * network at all. `areas` is empty when the driver held no polygon during the trip — the caller
 * treats the two cases differently (no_network vs. unassigned), so they are kept apart here.
 */
async function assignedAreasForTrip(trip) {
  const versions = await activeVersionsForTrip(trip);
  if (!versions.length) return null;

  const startedAt = new Date(trip.startedAt);
  const endedAt = trip.endedAt ? new Date(trip.endedAt) : new Date();
  const assignments = await AreaAssignment.find({
    driverId: trip.driverId,
    assignedAt: { $lte: endedAt },
    $or: [{ releasedAt: null }, { releasedAt: { $gte: startedAt } }],
  })
    .select('areaId areaCode')
    .lean();

  let areas = [];
  if (assignments.length) {
    const codes = [...new Set(assignments.map((a) => a.areaCode).filter(Boolean))];
    const legacyIds = assignments.filter((a) => !a.areaCode).map((a) => a.areaId);
    areas = await WorkArea.find({
      networkVersionId: { $in: versions.map((v) => v._id) },
      $or: [{ areaCode: { $in: codes } }, { _id: { $in: legacyIds } }],
    })
      .select('_id areaCode name networkVersionId geometry bbox')
      .lean();
  }

  // A driver on several projects with no project stamped on the trip: measure against the network
  // their assignments live in, and only fall back to the first active version when they hold none.
  let version = versions[0];
  if (versions.length > 1) {
    const holding = versions.find((v) => areas.some((a) => String(a.networkVersionId) === String(v._id)));
    if (holding) version = holding;
  }

  return {
    networkVersionId: version._id,
    projectId: version.projectId,
    areas: areas
      .filter((a) => String(a.networkVersionId) === String(version._id))
      .map(prepareArea),
  };
}

/**
 * Distance in metres from a [lon, lat] point to the nearest point on a ring. Local equirectangular
 * projection, like simplifyPath — accurate to well under a metre at the scale of a buffer test.
 * Returns early the moment a segment inside `limit` is found; the exact figure is not needed then.
 */
function distanceToRingMeters(pt, ring, limit) {
  const mx = 111320 * Math.cos(pt[1] * D);
  const my = 110574;
  const px = pt[0] * mx;
  const py = pt[1] * my;
  const limit2 = limit * limit;
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const ax = ring[i - 1][0] * mx;
    const ay = ring[i - 1][1] * my;
    const dx = ring[i][0] * mx - ax;
    const dy = ring[i][1] * my - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (ax + t * dx);
    const ey = py - (ay + t * dy);
    const d2 = ex * ex + ey * ey;
    if (d2 < best) {
      best = d2;
      if (best <= limit2) return Math.sqrt(best);
    }
  }
  return Math.sqrt(best);
}

/**
 * A predicate: is this [lon, lat] inside any of the areas, counting a point within `bufferMeters`
 * of a boundary as inside. Holes are respected by pointInPolygon; the buffer test walks every ring
 * (holes included — near a hole's edge is near the boundary too).
 *
 * Point-in-polygon first, then the buffer walk only for points that failed it. Rings run to several
 * thousand vertices, so the order matters: the common case (well inside the patch) never pays for
 * the distance scan.
 */
function makeAreaTester(areas, bufferMeters) {
  const prepared = areas.map((a) => ({ ...a, pbox: bboxPad(a.bbox, Math.max(0, bufferMeters)) }));
  const inBox = (pt, [w, s, e, n]) => pt[0] >= w && pt[0] <= e && pt[1] >= s && pt[1] <= n;

  return (pt) => {
    for (const a of prepared) {
      if (!inBox(pt, a.pbox)) continue;
      for (const rings of a.polygons) if (pointInPolygon(pt, rings)) return true;
    }
    if (bufferMeters <= 0) return false;
    for (const a of prepared) {
      if (!inBox(pt, a.pbox)) continue;
      for (const rings of a.polygons) {
        for (const ring of rings) {
          if (distanceToRingMeters(pt, ring, bufferMeters) <= bufferMeters) return true;
        }
      }
    }
    return false;
  };
}

module.exports = { assignedAreasForTrip, makeAreaTester, distanceToRingMeters, prepareArea };
