const RoadLink = require('../models/RoadLink');
const LinkCoverage = require('../models/LinkCoverage');
const AreaAssignment = require('../models/AreaAssignment');
const NetworkVersion = require('../models/NetworkVersion');
const { simplifyPath } = require('../utils/geo');

/**
 * The roads one driver is meant to drive inside one work area, ready to draw on a phone.
 *
 * Why this is derived and never stored
 * ------------------------------------
 * A driver is assigned POLYGONS, not roads. "The roads inside the polygon" is resolved here, at
 * read time, from RoadLink.areaId — which the import already fixed once by spatial join. The
 * alternative, materialising an assignment row per link, is up to 654,447 rows per driver, all of
 * it re-derivable from two fields. It would also have to be rewritten every time a polygon changes
 * hands, which is the sort of bulk write that turns a roster edit into an outage.
 *
 * Why the payload is positional tuples instead of GeoJSON
 * ------------------------------------------------------
 * This is served over mobile data to a fleet that once produced a 25 GB month (see the ingest
 * comments in tracking.controller.js). GeoJSON spends more bytes on repeated key names than on
 * coordinates at this scale. [linkId, funcClass, covered, coords] carries the same information
 * with no field names at all, and the client knows the positions.
 *
 * The whole design assumes the CLIENT CACHES the result against `version` and only re-fetches when
 * that string moves. Fetching this on every map pan would be indefensible whatever the encoding.
 *
 * Measured, worst case (20,000 links): ~1.7-2.5 MB of JSON, ~230 KB on the wire. That second
 * number only exists because myRoads in tracking.controller.js gzips it explicitly — this app has
 * no compression middleware, so nothing here is compressed by default. If that call is ever
 * reverted to a plain res.json, every driver silently starts paying ten times the mobile data.
 */

// The worst real area in the first delivery holds ~21,500 links, so this cap does bite — which is
// exactly why `truncated` is in the contract rather than the cap being silently generous. A phone
// that is handed a partial network must be able to say so, rather than showing a driver a map with
// streets quietly missing from it.
const MAX_LINKS = 20000;

// Display only. At ~4 m a 94 m link keeps its shape at every zoom a driver actually uses, and the
// vertices that survive are the corners rather than the wobble between them. The full geometry
// stays in Mongo: coverage attribution must never be decided against a smoothed line.
const SIMPLIFY_TOLERANCE_METERS = 4;

// ~1.1 m at Victorian latitudes. Finer than the road is wide, so nothing visible is lost, and it
// caps each number at 8 characters instead of the 17 a raw double serialises to — roughly a third
// of the payload, for free.
const COORD_DP = 5;
const COORD_SCALE = 10 ** COORD_DP;

const round5 = (v) => Math.round(v * COORD_SCALE) / COORD_SCALE;

/**
 * Simplify then round one link's line, dropping vertices that collapse onto their neighbour.
 *
 * The dedupe matters more than it looks: rounding to ~1 m turns any pair of vertices closer than
 * that into the identical pair of numbers, and a dense urban link can carry several. Leaving them
 * in ships duplicate points that draw nothing.
 */
function compactLine(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return null;

  const simplified = simplifyPath(coords, SIMPLIFY_TOLERANCE_METERS);
  const out = [];
  for (const c of simplified) {
    const lon = round5(c[0]);
    const lat = round5(c[1]);
    const prev = out[out.length - 1];
    if (prev && prev[0] === lon && prev[1] === lat) continue;
    out.push([lon, lat]);
  }

  // A link whose every vertex rounded onto one point is shorter than the rounding grid. It cannot
  // be drawn as a line, so it is dropped rather than shipped as a degenerate one-point "line" the
  // client would then have to defend itself against.
  return out.length >= 2 ? out : null;
}

/**
 * Is this driver actually holding this area right now, on the version in force, for a project they
 * are still a member of?
 *
 * All three halves are load-bearing. `releasedAt: null` alone would let a driver keep pulling an
 * area they handed over months ago, because AreaAssignment is append-only history and the old row
 * never disappears. The active-version check alone would not know who is holding it. And an
 * assignment written against a version that has since been superseded is history too — the geometry
 * it points at is no longer today's job, so this fails closed rather than serving a superseded
 * network as if it were current.
 *
 * The project-membership check exists because nothing releases an AreaAssignment when a driver is
 * moved between projects — PATCH /api/users rewrites `projectIds` and leaves the assignment rows
 * alone. GET /my-areas already filters by project membership, so without the same filter here the
 * two endpoints disagree about the same resource: the app would stop listing a former customer's
 * area while this endpoint kept serving its entire road network to a driver who no longer works on
 * it. Membership is read from the NetworkVersion rather than the assignment's own `projectId`
 * snapshot, because a snapshot written at assignment time is exactly the kind of stale copy this
 * check is meant to catch.
 *
 * Returns the network version id to read against, or null when the driver is not entitled.
 */
async function authoriseArea(driverId, projectIds, areaId) {
  // The HTTP handler already rejects a malformed areaId with a 400, but this is a shared service
  // and a caller that skips that check would otherwise get a Mongoose CastError thrown from inside
  // a query — surfacing as a 500 rather than "not authorised". Treat unparseable input as simply
  // not entitled.
  if (!/^[a-f\d]{24}$/i.test(String(areaId || ''))) return null;

  const assignment = await AreaAssignment.findOne({
    driverId,
    areaId,
    releasedAt: null,
  })
    .select('networkVersionId')
    .lean();
  if (!assignment) return null;

  const version = await NetworkVersion.findOne({
    _id: assignment.networkVersionId,
    status: 'active',
  })
    .select('_id projectId')
    .lean();
  if (!version) return null;

  // Compared as strings: projectIds arrives off a Mongoose document as ObjectIds, and `includes`
  // on ObjectIds compares by reference, which is silently always false.
  const member = new Set((projectIds || []).map(String));
  if (!member.has(String(version.projectId))) return null;

  return version._id;
}

/**
 * Order-independent 32-bit checksum of the covered link ids.
 *
 * FNV-1a per id, summed. Summing rather than XOR-ing so that a *pair* of ids swapping cannot
 * cancel out, and order-independent because the coverage query has no sort and Mongo is free to
 * return the same rows in a different order on the next read — an order-dependent digest would
 * bust the cache at random and force a quarter-megabyte refetch for nothing.
 */
function coverageChecksum(linkIds) {
  let sum = 0;
  for (const id of linkIds) {
    let h = 0x811c9dc5;
    const s = String(id);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      // Math.imul keeps the multiply in 32-bit; a plain `h * 16777619` loses the low bits to
      // float64 rounding well before it wraps, which collapses the hash space.
      h = Math.imul(h, 16777619);
    }
    sum = (sum + (h >>> 0)) % 4294967296;
  }
  return sum;
}

/**
 * Build the driver's road layer for one area.
 *
 * Returns null when the caller is not entitled to the area — the caller turns that into a 403.
 * Deliberately no distinction between "no such area", "not yours" and "version superseded": a
 * driver probing area ids should not be able to map the customer's network out of the error codes.
 *
 * Four queries, flat — the count does not grow with the number of links:
 *   1. the assignment          2. the active version
 *   3. the area's links        4. the area's coverage ledger
 * (3) and (4) do not depend on each other, so they run together. Marking coverage per link with a
 * lookup per link would be up to 20,000 round trips for one map draw; instead the whole area's
 * ledger arrives once and the join happens in memory against a Set.
 */
async function getDriverRoads({ driverId, projectIds, areaId }) {
  const networkVersionId = await authoriseArea(driverId, projectIds, areaId);
  if (!networkVersionId) return null;

  const [rows, coverage] = await Promise.all([
    // MAX_LINKS + 1 rather than a separate countDocuments: one extra document is all it takes to
    // learn the area overflowed, and counting is not free on a collection of 654k links.
    //
    // -_id because nothing downstream uses it; at 20,000 rows that alone is ~240 KB of ObjectId
    // moved out of Mongo for no reason. Served by the {networkVersionId, areaId} index.
    RoadLink.find({ networkVersionId, areaId })
      .select('linkId funcClass geometry.coordinates -_id')
      .limit(MAX_LINKS + 1)
      .lean(),

    // The whole area's ledger in one query, on the cov_version_area_len index. firstAt comes along
    // because `version` below is computed from it — asking for it separately would be a second
    // pass over the same rows.
    LinkCoverage.find({ networkVersionId, areaId })
      .select('linkId firstAt -_id')
      .lean(),
  ]);

  const coveredIds = new Set();
  let newestCoverMs = 0;
  for (const c of coverage) {
    coveredIds.add(c.linkId);
    const ms = c.firstAt ? new Date(c.firstAt).getTime() : 0;
    if (ms > newestCoverMs) newestCoverMs = ms;
  }

  const truncated = rows.length > MAX_LINKS;
  const page = truncated ? rows.slice(0, MAX_LINKS) : rows;

  const links = [];
  for (const l of page) {
    const line = compactLine(l.geometry && l.geometry.coordinates);
    if (!line) continue;
    links.push([l.linkId, l.funcClass, coveredIds.has(l.linkId) ? 1 : 0, line]);
  }

  /**
   * Cache key. The client refetches only when this string changes.
   *
   * Four parts, each covering a way the picture can go stale:
   *   - networkVersionId : a new delivery was activated, so the geometry itself is different. Two
   *                        versions could easily agree on the counts below, so identity has to be
   *                        in here or a re-import would be served from stale cache forever.
   *   - covered count    : a link was claimed (or an attribution re-run released one).
   *   - newest firstAt   : catches the case the count cannot — one row released and another
   *                        claimed between two reads leaves the count identical.
   *   - id checksum      : catches the case NEITHER of those can. `firstAt` is the time the trip
   *                        was driven, not the time the row was written, so re-running attribution
   *                        over an old trip can swap which links it claims while leaving both the
   *                        count and the newest `firstAt` (owned by some later trip) untouched.
   *                        Without this the driver keeps a cached map showing the wrong streets
   *                        red, permanently, because nothing will ever move the key again.
   *
   * Costs nothing extra: every part falls out of the coverage query that was already needed to
   * colour the links, so nothing is scanned twice and the 654k-link collection is never touched to
   * compute it. Note it deliberately ignores repeat passes (`passes` / `lastAt`) — driving an
   * already-covered road again does not change what the driver sees, so it must not bust the cache
   * and force a quarter-megabyte refetch.
   */
  const version = [
    networkVersionId,
    coverage.length,
    newestCoverMs,
    coverageChecksum(coveredIds),
  ].join('.');

  return {
    areaId: String(areaId),
    version,
    truncated,
    count: links.length,
    links,
  };
}

module.exports = { getDriverRoads, MAX_LINKS, SIMPLIFY_TOLERANCE_METERS };
