const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ImportJob = require('../models/ImportJob');
const NetworkVersion = require('../models/NetworkVersion');
const WorkArea = require('../models/WorkArea');
const RoadLink = require('../models/RoadLink');

const { extract } = require('../utils/unzip');
const fileStore = require('../utils/fileStore');
const shapefile = require('../utils/shapefile');
const workAreaSplit = require('./workAreaSplit');
const { createFootprint } = require('./roadFootprint');
const {
  lineLength,
  bboxOf,
  bboxUnion,
  midpointOf,
  pointInPolygon,
  simplifyGeometry,
  Grid,
} = require('../utils/geo');

/**
 * Turning a customer shapefile delivery into a committed NetworkVersion.
 *
 * Two passes over the data, deliberately:
 *
 *   1. `buildReport` reads everything and writes nothing. It answers the questions that are cheap
 *      now and expensive in three months — is the datum what we think, are the IDs unique, how
 *      much of the network falls outside the boundary, which column is the priority. A human
 *      approves that report before anything reaches the live collections.
 *   2. `commit` runs the same traversal again and inserts.
 *
 * Reading twice costs about a minute. Committing a boundary file that was subtly wrong costs a
 * re-import plus every coverage number reported against it in the meantime.
 */

const IMPORT_DIR = path.join(os.tmpdir(), 'jsan-imports');

/** Links are inserted in batches; large enough to amortise the round trip, small enough to hold. */
const INSERT_BATCH = 2000;

/** Cell size for the polygon lookup grid, in degrees. ~5 km at this latitude. */
const AREA_GRID_CELL = 0.05;

/** Display-simplification tolerance for work-area outlines, metres. See WorkArea.outline. */
const OUTLINE_TOLERANCE_M = 25;

/** Features processed between yields back to the event loop. See the network loop in buildReport. */
const YIELD_EVERY = 10000;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function jobDir(jobId) {
  return path.join(IMPORT_DIR, String(jobId));
}

/** Streamed rather than readFileSync — these archives are 80 MB and up. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/* ------------------------------------------------------------------ column sniffing */

/**
 * Guess which .dbf column means what, in preference order.
 *
 * Only ever a default. The operator can override every one of these before commit, because the
 * next delivery will not use the same column names — the first one happens to be ABS ASGS
 * (SA2_21CODE, SA2_21NAME) plus a customer-added `Priority`, and HERE NAVSTREETS (LINK_ID,
 * ST_NAME, FUNC_CLASS, DIR_TRAVEL, AR_AUTO).
 */
function pick(fields, patterns) {
  const names = fields.map((f) => f.name);
  for (const pattern of patterns) {
    const hit = names.find((n) => pattern.test(n));
    if (hit) return hit;
  }
  return null;
}

/**
 * HERE's Admin layers (Admin4 = towns/suburbs, the New Zealand deliveries): one row per PIECE of a
 * place, POLYGON_ID per piece and AREA_ID per place, the name in POLYGON_NM. AREA_ID is the area —
 * POLYGON_ID would make every island and harbour sliver its own work area.
 */
const isHereAdmin = (fields) =>
  fields.some((f) => /^AREA_ID$/i.test(f.name)) && fields.some((f) => /^POLYGON_ID$/i.test(f.name));

function sniffBoundaryMapping(fields) {
  return {
    // SA2 before SA3/SA4: the most specific level present is the unit of work. Then HERE Admin's
    // AREA_ID (see isHereAdmin), then anything that looks like a code or an id.
    // POLYGON_ID only where there is no AREA_ID: HERE's Admin layer exported one row per place
    // (the 2026-11 VIC suburbs: POLYGON_ID + POLYGON_NM and nothing else, each row already a
    // MultiPolygon). With no column at all the code is made from the shape — see areaCodeFromShape.
    areaCode: pick(fields, [/^SA2.*CODE$/i, /^SA1.*CODE$/i, /^AREA_?ID$/i, /CODE$/i, /^POLYGON_?ID$/i, /_ID$/i, /^ID$/i]),
    areaName: pick(fields, [/^SA2.*NAME$/i, /^SA1.*NAME$/i, /^NAME$/i, /^POLYGON_?NM$/i, /NAME$/i, /_NM$/i]),
    areaParent: pick(fields, [/^SA3.*NAME$/i, /^SA4.*NAME$/i, /^GCC.*NAME$/i, /REGION/i]),
    priority: pick(fields, [/^PRIORITY$/i, /PRIOR/i, /^RANK$/i, /^P$/i]),
    areaSqm: pick(fields, [/AREA_?SQM/i, /AREA_?SQ/i, /^AREA$/i, /SHAPE_?AREA/i]),
  };
}

function sniffNetworkMapping(fields) {
  return {
    linkId: pick(fields, [/^LINK_?ID$/i, /LINK_?ID/i, /^ID$/i, /^OBJECTID$/i, /^FID$/i]),
    linkName: pick(fields, [/^ST_?NAME$/i, /STREET/i, /^NAME$/i, /NAME$/i]),
    funcClass: pick(fields, [/^FUNC_?CLASS$/i, /FUNC/i, /^FC$/i, /CLASS$/i]),
    dirTravel: pick(fields, [/^DIR_?TRAVEL$/i, /^DIR$/i, /ONEWAY/i, /DIRECT/i]),
    autoAccess: pick(fields, [/^AR_?AUTO$/i, /AUTO/i, /^CAR$/i]),
  };
}

/**
 * An id made from a road's shape, for a road file that has no id column.
 *
 * The 2026-11 VIC delivery (VIC_FC345_NAV) came with ST_NAME, FUNC_CLASS, DIR_TRAVEL and friends
 * but no LINK_ID at all, and every one of its 410,558 links stopped the import as "blank id". The
 * link id is only the ledger's key, so any id works as long as it is (a) unique within the version
 * and (b) the same for the same road next time. A hash of the rounded coordinates is both: an
 * unchanged road in the next delivery gets the same id, so coverage still carries forward by id,
 * and two rows with exactly the same geometry ARE the same road and collapse like a repeated id.
 * 7 decimals is ~1 cm — well inside the precision a re-export keeps.
 */
function linkIdFromShape(coords) {
  const hash = crypto.createHash('sha1');
  for (const [x, y] of coords) hash.update(`${Number(x).toFixed(7)},${Number(y).toFixed(7)};`);
  return `s${hash.digest('hex').slice(0, 20)}`;
}

/** The same idea for a work-area file with no code column: the code is the outline's hash. */
function areaCodeFromShape(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const hash = crypto.createHash('sha1');
  for (const ring of polygons.map((p) => p[0])) {
    for (const [x, y] of ring) hash.update(`${Number(x).toFixed(7)},${Number(y).toFixed(7)};`);
    hash.update('|');
  }
  return `A${hash.digest('hex').slice(0, 12).toUpperCase()}`;
}

/**
 * The links one road feature becomes. Every pass that reads the road file (preflight, the zone
 * re-read, the commit) goes through this, so what is measured is exactly what is written.
 *
 * - The id is the mapped column's value; blank, or no column mapped, and it is made from the shape.
 * - A multi-part feature is one link per part. Keeping only the first part used to block the
 *   import (it would understate the target); now nothing is lost: part 1 keeps the id, so it still
 *   matches the same road in an earlier version, and parts 2.. are `<id>~2`, `<id>~3`.
 *   A part with fewer than 2 points has no length and is dropped.
 */
function linksOfFeature(attrs, parts, mapping) {
  const raw = mapping.linkId ? String(attrs[mapping.linkId] ?? '').trim() : '';
  return parts
    .filter((coords) => coords.length >= 2)
    .map((coords, i) => ({
      coords,
      id: raw ? (i === 0 ? raw : `${raw}~${i + 1}`) : linkIdFromShape(coords),
      fromShape: !raw,
    }));
}

/**
 * Whether rows sharing an area code are joined into one area. true can only have been ticked;
 * false is also the default, so it counts as a choice only once the operator has touched the box
 * (joinAreaPartsChosenAt). Until then: on for a HERE Admin layer keyed by AREA_ID, else off.
 */
function joinPartsFor(job, boundaryFields, mapping) {
  if (job.joinAreaParts === true || job.joinAreaPartsChosenAt) return Boolean(job.joinAreaParts);
  return Boolean(boundaryFields && isHereAdmin(boundaryFields) && /^AREA_?ID$/i.test(mapping.areaCode || ''));
}

/** Which mapping fields belong to which layer. */
const BOUNDARY_KEYS = ['areaCode', 'areaName', 'areaParent', 'priority', 'areaSqm'];
const NETWORK_KEYS = ['linkId', 'linkName', 'funcClass', 'dirTravel', 'autoAccess'];

/**
 * The columns this project's most recent successful import used, kept only where the same column
 * exists in the file now being checked. So the second delivery in a format needs no choosing at
 * all, and a delivery in a different format falls through to the guess instead of inheriting
 * columns it does not have.
 */
async function rememberedMapping(job, boundaryFields, networkFields) {
  if (!job.projectId) return {};
  const ImportJob = require('../models/ImportJob');
  const last = await ImportJob.findOne({
    projectId: job.projectId,
    _id: { $ne: job._id },
    status: 'ready',
    networkVersionId: { $ne: null },
  })
    .sort({ createdAt: -1 })
    .select('mapping')
    .lean();
  if (!last || !last.mapping) return {};
  const has = (fields, name) => Boolean(fields && fields.some((f) => f.name === name));
  const out = {};
  for (const key of BOUNDARY_KEYS) if (last.mapping[key] && has(boundaryFields, last.mapping[key])) out[key] = last.mapping[key];
  for (const key of NETWORK_KEYS) if (last.mapping[key] && has(networkFields, last.mapping[key])) out[key] = last.mapping[key];
  return out;
}

/* ------------------------------------------------------------------ geometry conversion */

/** Shoelace signed area; positive means counter-clockwise in lon/lat space. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/**
 * Shapefile polygon parts -> GeoJSON Polygon or MultiPolygon.
 *
 * Two conversions happen here, and both matter to MongoDB:
 *
 *   - Grouping. A shapefile "Polygon" may hold several outer rings, i.e. a multipolygon. Outer
 *     rings are clockwise and holes counter-clockwise, so winding is what separates them; a new
 *     clockwise ring starts a new polygon and counter-clockwise rings attach to the current one.
 *   - Winding. GeoJSON (RFC 7946) is the opposite convention — exterior counter-clockwise, holes
 *     clockwise — so every ring is reversed. Getting this backwards does not throw: a 2dsphere
 *     index quietly treats the polygon as the entire globe minus the area you meant, and every
 *     containment query returns almost everything.
 */
/**
 * Vertex count of a Polygon or MultiPolygon — a cheap shape fingerprint.
 *
 * Used only to tell "the same area delivered twice" from "the same code on two different shapes".
 * It is not a geometric comparison and does not need to be: two features with the same code and
 * the same vertex count are, in a merged delivery, the same polygon copied.
 */
function countVertices(geometry) {
  if (!geometry || !geometry.coordinates) return 0;
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  let n = 0;
  for (const ring of rings) n += ring.length;
  return n;
}

/* ------------------------------------------------------------------ outlines MongoDB will index */

/**
 * WorkArea.geometry has a 2dsphere index (which area is this driver in), and MongoDB refuses to
 * store an outline its S2 engine finds invalid — the whole insert fails, and with it the import.
 * The 2026-11 VIC suburbs had two of 2,655: Tamleugh North, a flat 2 km sliver whose edges cross
 * only on the sphere (an S2 edge is a great circle, which bows ~6 cm off the straight line drawn
 * in the shapefile), and Kimbolton, one 9-point crumb of a few m² that really crosses itself.
 *
 * So every outline from a boundary file is checked by MongoDB itself before anything is measured
 * against it: a $geoIntersects with an invalid shape fails exactly as the insert would (checked on
 * all 2,655 VIC areas: same two, no disagreement). Only a rejected area is repaired, piece by piece.
 */
const GEO_CHECK_BATCH_VERTICES = 200000;
const DENSIFY_DEG = 0.0005; // ~50 m: a great circle that short bows < 0.1 mm off the straight line
const DROP_PIECE_MAX_SQM = 10000;

const isInvalidGeometryError = (err) =>
  Boolean(err) && (err.code === 2 || err.code === 16755 || /Loop is not valid|Edges \d+ and \d+ cross|Duplicate vertices|Can't extract geo keys|malformed|invalid/i.test(err.message || ''));

/** Does MongoDB accept every one of these shapes? Throws only for a non-geometry failure. */
async function mongoAcceptsAll(geometries) {
  try {
    await WorkArea.collection.findOne(
      { _id: null, $or: geometries.map((g) => ({ geometry: { $geoIntersects: { $geometry: g } } })) },
      { projection: { _id: 1 } }
    );
    return true;
  } catch (err) {
    if (isInvalidGeometryError(err)) return false;
    throw err;
  }
}

/** The indices MongoDB rejects, found in batches and narrowed down by halving a failing batch. */
async function rejectedIndices(geometries, acceptsAll) {
  const bad = [];
  const probe = async (indices) => {
    if (!indices.length || (await acceptsAll(indices.map((i) => geometries[i])))) return;
    if (indices.length === 1) {
      bad.push(indices[0]);
      return;
    }
    const mid = Math.ceil(indices.length / 2);
    await probe(indices.slice(0, mid));
    await probe(indices.slice(mid));
  };
  let batch = [];
  let vertices = 0;
  for (let i = 0; i < geometries.length; i++) {
    batch.push(i);
    vertices += countVertices(geometries[i]);
    if (vertices >= GEO_CHECK_BATCH_VERTICES) {
      // eslint-disable-next-line no-await-in-loop
      await probe(batch);
      batch = [];
      vertices = 0;
    }
  }
  await probe(batch);
  return bad.sort((a, b) => a - b);
}

function densifyRing(ring, maxDeg = DENSIFY_DEG) {
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const [a, b] = [ring[i - 1], ring[i]];
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxDeg);
    for (let k = 1; k < steps; k++) out.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
    out.push(b);
  }
  return out;
}

/** Convex hull (monotone chain) of a ring, closed. Always a valid loop. */
function convexHullRing(ring) {
  const pts = [...new Map(ring.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return hull.length >= 3 ? [...hull, hull[0]] : null;
}

/** Rough m² of one polygon (outer minus holes) — only to tell a crumb from a real piece. */
function pieceSqm(polygon) {
  const ringArea = (r) => Math.abs(signedArea(r));
  const lat = polygon[0][0][1];
  const deg2 = ringArea(polygon[0]) - polygon.slice(1).reduce((s, r) => s + ringArea(r), 0);
  return deg2 * 111320 * 111320 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Make every area's outline one MongoDB will index, changing as little as possible. For each
 * rejected piece of a rejected area, in order:
 *   1. the same piece with extra points every ~50 m — the shape is unchanged, and the sphere's
 *      curved edges now follow the flat ones (Tamleugh North);
 *   2. dropped, when it is a crumb: under 1% of the area and under 1 ha (Kimbolton);
 *   3. its convex hull — a little more ground than drawn, but kept.
 * An area still rejected after that is reported as a blocking error by name, rather than failing
 * the commit halfway through.
 */
async function repairAreaGeometries(areas, acceptsAll = mongoAcceptsAll) {
  const result = { densified: [], dropped: [], hulled: [], broken: [] };
  const bad = await rejectedIndices(areas.map((a) => a.geometry), acceptsAll);
  for (const index of bad) {
    const area = areas[index];
    const pieces = area.geometry.type === 'Polygon' ? [area.geometry.coordinates] : area.geometry.coordinates;
    const total = pieces.reduce((s, p) => s + pieceSqm(p), 0);
    const kept = [];
    const how = new Set();
    const asPolygon = (coordinates) => ({ type: 'Polygon', coordinates });
    // The pieces are found the same way as the areas: Kimbolton is ~640 crumbs, one of them bad.
    // eslint-disable-next-line no-await-in-loop
    const badPieces = new Set(await rejectedIndices(pieces.map(asPolygon), acceptsAll));
    for (const [i, piece] of pieces.entries()) {
      if (!badPieces.has(i)) {
        kept.push(piece);
        continue;
      }
      const dense = piece.map((ring) => densifyRing(ring));
      // eslint-disable-next-line no-await-in-loop
      if (await acceptsAll([asPolygon(dense)])) {
        kept.push(dense);
        how.add('densified');
        continue;
      }
      // Measured by its hull: a self-crossing ring's own signed area can cancel out to ~0.
      const hull = convexHullRing(piece[0]);
      const sqm = pieceSqm([hull || piece[0]]);
      if (sqm < DROP_PIECE_MAX_SQM && sqm < total * 0.01) {
        how.add('dropped');
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (hull && (await acceptsAll([asPolygon([hull])]))) {
        kept.push([hull]);
        how.add('hulled');
        continue;
      }
      how.add('broken');
    }
    const geometry = kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
    // eslint-disable-next-line no-await-in-loop
    if (how.has('broken') || !kept.length || !(await acceptsAll([geometry]))) {
      result.broken.push(area.name || area.code);
      continue;
    }
    area.geometry = geometry;
    area.bbox = kept.reduce((box, p) => bboxUnion(box, bboxOf(p[0])), bboxOf(kept[0][0]));
    for (const key of ['densified', 'dropped', 'hulled']) if (how.has(key)) result[key].push(area.name || area.code);
  }
  return result;
}

function polygonToGeoJson(parts) {
  const polygons = [];
  for (const ring of parts) {
    if (ring.length < 4) continue;
    const reversed = ring.slice().reverse();
    if (signedArea(ring) < 0) polygons.push([reversed]); // clockwise in source = new exterior
    else if (polygons.length) polygons[polygons.length - 1].push(reversed);
    else polygons.push([reversed]); // a lone hole with no exterior: keep it rather than lose it
  }
  if (!polygons.length) return null;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
  return { type: 'MultiPolygon', coordinates: polygons };
}

/* ------------------------------------------------------------------ extraction */

/**
 * Unpack ONE uploaded layer and locate the shapefile bundle inside it.
 *
 * Split out from `extractJob` so the map preview can open the 2.7 MB boundary archive without
 * also re-inflating the 80 MB network archive it does not need.
 *
 * `reuse` keeps an already-extracted directory instead of unpacking again, which is what makes
 * repeated preview requests cheap. The parse and commit paths pass false, because they must never
 * read a directory some earlier run left in an unknown state.
 */
async function extractLayer(job, kind, { reuse = false } = {}) {
  const file = job.files?.[kind];
  if (!file?.name) throw new Error(`No ${kind} file uploaded`);

  /**
   * Derived locally, ALWAYS — never read back from the job document.
   *
   * `files.<kind>.path` records where the container that handled the upload happened to put it.
   * That is machine-specific and actively harmful anywhere else: an upload handled on Railway
   * stores a Linux path like `/tmp/jsan-imports/<id>-boundary.zip`, and reading that on Windows
   * resolves to `C:	mp\jsan-imports\...` — a directory that has never existed. The job is
   * portable across containers and machines precisely because GridFS holds the bytes; the local
   * path must be recomputed to match wherever the code is actually running.
   */
  const zipPath = path.join(IMPORT_DIR, `${job._id}-${kind}.zip`);

  /**
   * Re-materialise the archive if the cached copy has gone.
   *
   * It very often has: this runs on a container whose filesystem does not survive a redeploy, and
   * the upload may even have been handled by a different replica. Previously this threw
   * "no longer on disk — re-upload it", which asked the operator to re-send 80 MB to fix a problem
   * that was ours, not theirs. The durable copy is in GridFS; fetch it and carry on.
   */
  if (!fs.existsSync(zipPath)) {
    if (!file.fileId) {
      throw new Error(
        `The uploaded ${kind} archive is no longer available — it predates durable storage, so please re-upload it`
      );
    }
    ensureDir(IMPORT_DIR);
    await fileStore.downloadTo(file.fileId, zipPath);
  }

  const target = path.join(jobDir(job._id), kind);
  const already = reuse && fs.existsSync(target) && shapefile.findShapefiles(target).length > 0;
  if (!already) {
    fs.rmSync(target, { recursive: true, force: true });
    await extract(zipPath, target);
    await extractInnerZips(target);
  }

  const bundles = shapefile.findShapefiles(target);
  if (!bundles.length) throw new Error(`The ${kind} archive contains no .shp file`);

  for (const required of ['shx', 'dbf']) {
    if (!fs.existsSync(bundles[0][required])) {
      throw new Error(`The ${kind} shapefile is missing its .${required} sibling`);
    }
  }

  // Largest wins when a zip carries several layers; the report names every one it saw so a wrong
  // pick is visible rather than mysterious. Roads are the exception: see roadLayersOf.
  const chosen = kind === 'network' ? roadLayersOf(bundles) : bundles[0];
  return { chosen, all: bundles.map((b) => b.name) };
}

/**
 * A zip of zips: the panel wraps several road archives chosen together into one, and a folder of
 * zipped layers compressed as it is arrives the same way. Each inner zip is unpacked beside itself.
 */
async function extractInnerZips(dir, depth = 0) {
  if (depth > 2) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__MACOSX') await extractInnerZips(full, depth + 1);
    } else if (entry.name.toLowerCase().endsWith('.zip') && !entry.name.startsWith('.')) {
      const into = path.join(dir, entry.name.slice(0, -4));
      // eslint-disable-next-line no-await-in-loop
      await extract(full, into);
      fs.rmSync(full, { force: true });
      // eslint-disable-next-line no-await-in-loop
      await extractInnerZips(into, depth + 1);
    }
  }
}

/**
 * Every road layer in the archive, read as one. A network can come as one file per road class —
 * Wellington is FC1-2, FC3, FC4 and FC5 — and taking only the largest would quietly drop the rest.
 * A layer counts when it is lines with the same columns as the largest one; anything else (points,
 * a polygon layer, a table of something else) is left out and stays listed as another layer.
 */
function roadLayersOf(bundles) {
  const lines = (info) => [3, 13, 23].includes(info.shapeType);
  const head = shapefile.inspect(bundles[0]);
  if (!lines(head)) return bundles[0];
  const columns = (info) => info.fields.map((f) => f.name.toUpperCase()).sort().join('|');
  const want = columns(head);
  const roads = bundles.filter((b, i) => {
    if (i === 0) return true;
    if (!fs.existsSync(b.dbf) || !fs.existsSync(b.shx)) return false;
    const info = shapefile.inspect(b);
    return lines(info) && columns(info) === want;
  });
  return shapefile.combineBundles(roads);
}

/** Unpack both uploaded zips and locate the shapefile bundle inside each. */
/**
 * Unpack whichever layers were supplied.
 *
 * The road network is OPTIONAL. Work areas alone are a complete, useful import: they are what gets
 * allocated to drivers and what the driver's app draws. Roads only add the coverage denominator,
 * and a customer may well send the boundaries first — or only ever send boundaries. Requiring both
 * made a 402-polygon import cost 654,447 extra documents it did not need.
 */
async function extractJob(job) {
  ensureDir(jobDir(job._id));

  /**
   * Presence is `name`, NOT `path`.
   *
   * `path` is the on-disk cache location and is deliberately never persisted any more — an
   * uploading container's local path is meaningless on the machine that later runs the import.
   * This function still tested it, so `job.files.network.path` was always null and the ROAD LAYER
   * WAS SILENTLY SKIPPED: imports where both archives were uploaded committed 402 areas and zero
   * links, reported success, and gave no indication that 654,447 roads had been dropped.
   *
   * Both layers are optional individually — boundary-only creates a new version, roads-only adds
   * to the active one — but at least one has to be there.
   */
  const layers = { boundary: null, network: null };
  if (job.files?.boundary?.name) layers.boundary = await extractLayer(job, 'boundary');
  if (job.files?.network?.name) layers.network = await extractLayer(job, 'network');

  if (!layers.boundary && !layers.network) {
    throw new Error('No archive uploaded — add the work-area or road-network .zip');
  }
  return layers;
}

/** Roads alone, and zones to be drawn from them (job.drawZones) — see buildReport. */
function isDrawn(job, layers) {
  return Boolean(!layers.boundary && layers.network && job.drawZones);
}

/** The drawn area's code: fixed per road file, so the same file drawn again gets the same code. */
function drawnAreaCode(job) {
  const seed = job.files?.network?.sha256 || String(job._id);
  return `ROADS-${seed.slice(0, 8).toUpperCase()}`;
}

/**
 * A name for ground that came with none: what the road files have in common ("Wellington_FC3_Nav",
 * "Wellington_FC5_Nav" -> "Wellington"), else the import's label.
 */
function drawnAreaName(job, bundle) {
  const names = (bundle.parts || [bundle]).map((b) => b.name);
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  const tidy = (prefix.length >= 3 ? prefix : names[0])
    .replace(/[_\s-]*(fc\d*([_-]\d+)?)?[_\s-]*(nav|roads?|links?|network)?[_\s-]*$/i, '')
    .replace(/_/g, ' ')
    .trim();
  // The files' name first: the import's label is often only the default "<project> network".
  return tidy || (job.label && job.label.trim()) || 'Road network';
}

/**
 * Where a roads-only import should land.
 *
 * Uploading just the road layer is a real and reasonable thing to do: the work areas are already
 * loaded, and the customer has now sent the network that goes inside them. Before this, that upload
 * sat in `draft` forever saying "add the work-area archive", which meant re-uploading polygons that
 * were already in the database purely to satisfy the importer — and, because every import minted a
 * NEW version, silently orphaning every existing area assignment in the process.
 *
 * So a roads-only import is an IN-PLACE addition to the project's active version rather than a new
 * one. The areas keep their _ids, so assignments survive.
 *
 * Refuses when the target already has roads: replacing a live network is a destructive operation
 * wearing an upload's clothing, and this application is live.
 */
async function resolveRoadsOnlyTarget(job) {
  const version = await NetworkVersion.findOne({
    projectId: job.projectId,
    status: 'active',
  }).lean();

  if (!version) {
    throw new Error(
      'No active network for this project. Upload the work-area archive too, so the roads have areas to belong to — or, if the customer sent no polygons, tick "Draw zones from the roads".'
    );
  }
  const areaCount = await WorkArea.countDocuments({ networkVersionId: version._id });
  if (!areaCount) {
    throw new Error('The active network has no work areas, so road links would have nothing to attach to.');
  }
  const linkCount = await RoadLink.countDocuments({ networkVersionId: version._id });
  if (linkCount > 0) {
    throw new Error(
      `The active network already has ${linkCount.toLocaleString()} road links. Upload both archives to create a new version instead of replacing them — or, if the customer sent no polygons, tick "Draw zones from the roads".`
    );
  }
  return version;
}

/**
 * The existing work areas of a version, shaped exactly like the ones `buildReport` parses out of a
 * boundary shapefile, so the spatial join and the rollups downstream cannot tell the difference.
 */
async function areasFromVersion(versionId) {
  const docs = await WorkArea.find({ networkVersionId: versionId })
    .select('areaCode name parentName priority areaSqm geometry bbox props')
    .lean();

  return docs.map((d) => ({
    existingId: d._id,
    code: d.areaCode,
    name: d.name,
    parentName: d.parentName,
    priority: d.priority,
    areaSqm: d.areaSqm,
    geometry: d.geometry,
    bbox: d.bbox && d.bbox.length === 4 ? d.bbox : bboxOf(
      d.geometry.type === 'Polygon' ? d.geometry.coordinates[0] : d.geometry.coordinates[0][0]
    ),
    props: d.props || {},
    targetMeters: 0,
    targetLinks: 0,
  }));
}

/* ------------------------------------------------------------------ preflight */

/** Ordered shortest to longest, so the report renders as a distribution rather than a jumble. */
const LENGTH_BUCKETS = ['<25 m', '25–50 m', '50–100 m', '100–250 m', '250–500 m', '0.5–1 km', '>1 km'];

function lengthBucket(metres) {
  if (metres < 25) return LENGTH_BUCKETS[0];
  if (metres < 50) return LENGTH_BUCKETS[1];
  if (metres < 100) return LENGTH_BUCKETS[2];
  if (metres < 250) return LENGTH_BUCKETS[3];
  if (metres < 500) return LENGTH_BUCKETS[4];
  if (metres < 1000) return LENGTH_BUCKETS[5];
  return LENGTH_BUCKETS[6];
}

function tally(map, key, links, meters) {
  const row = map.get(key) || { links: 0, meters: 0 };
  row.links += links;
  row.meters += meters;
  map.set(key, row);
}

/**
 * Read both layers and produce the report the operator approves. Writes nothing.
 */
async function buildReport(job, layers, onProgress = () => {}, deps = {}) {
  const errors = [];
  const warnings = [];

  /* ---- boundary: a fresh shapefile, the areas already in the active version, or drawn ---- */
  // Drawn: roads with no polygons at all, and the operator asked for zones to be drawn from them.
  const drawn = isDrawn(job, layers);
  const roadsOnly = !layers.boundary && !drawn;
  const target = roadsOnly ? await resolveRoadsOnlyTarget(job) : null;

  const boundaryInfo = layers.boundary ? shapefile.inspect(layers.boundary.chosen) : null;
  const networkFields = layers.network ? shapefile.inspect(layers.network.chosen).fields : null;
  const remembered = await (deps.rememberedMapping || rememberedMapping)(job, boundaryInfo?.fields, networkFields);
  const mapping = {
    ...(boundaryInfo ? sniffBoundaryMapping(boundaryInfo.fields) : {}),
    ...(networkFields ? sniffNetworkMapping(networkFields) : {}),
    // A customer sends the same format every time: whatever was chosen for this project's last
    // import wins over the guess, wherever that column is present in this file too.
    ...remembered,
    ...Object.fromEntries(Object.entries(job.mapping || {}).filter(([, v]) => v)),
  };
  /**
   * Join the pieces of one area into one MultiPolygon? The operator's choice when they made one;
   * otherwise on for a HERE Admin layer keyed by AREA_ID, where repeated codes ARE pieces, and off
   * for anything else, where a repeat is a merged file's copy (see the ImportJob model).
   */
  const joinAreaParts = joinPartsFor(job, boundaryInfo && boundaryInfo.fields, mapping);

  if (boundaryInfo && ![5, 15, 25].includes(boundaryInfo.shapeType)) {
    errors.push({
      code: 'BOUNDARY_NOT_POLYGON',
      message: `Boundary layer is ${boundaryInfo.shapeTypeName}; work areas must be polygons.`,
    });
  }
  // No code column is no longer a stop: each area's code is made from its outline instead
  // (areaCodeFromShape), and the operator is told so — they can still pick a column below.
  let areaCodesFromShape = 0;

  const areas = [];
  const priorityTally = new Map();
  /**
   * code -> a fingerprint of the first feature that claimed it.
   *
   * A repeated area code is not a broken delivery, it is what a GIS merge produces: the QLD
   * boundaries arrived as QLD_P2 and QLD_P3 merged into one file, and 290 areas sit in both, 283
   * of them byte-identical. Rejecting the file gave the operator nowhere to go — the fix would
   * have been to re-do the merge in ArcGIS. So the repeat is DROPPED and reported instead, which
   * protects the denominator exactly as the old block did while leaving the import possible.
   *
   * The fingerprint exists to separate the harmless case from the one worth a human's attention:
   * the same area twice is fine, the same code with a different size or priority is a conflict.
   */
  const seenCodes = new Map();
  const duplicateCodes = [];
  const conflictingCodes = [];
  /** code -> how many rows were joined into it (joinAreaParts only). */
  const joinedParts = new Map();
  let emptyAreaGeometry = 0;

  // Reusing the active version's areas: pull them from the database instead of parsing.
  if (roadsOnly) areas.push(...(await areasFromVersion(target._id)));

  if (layers.boundary) shapefile.forEachFeature(
    layers.boundary.chosen,
    (attrs, parts) => {
      const geometry = polygonToGeoJson(parts);
      if (!geometry) {
        emptyAreaGeometry++;
        return;
      }
      let code = mapping.areaCode ? String(attrs[mapping.areaCode] ?? '').trim() : '';
      if (!code) {
        code = areaCodeFromShape(geometry);
        areaCodesFromShape++;
      }
      const priority = mapping.priority ? Number(attrs[mapping.priority] ?? 0) || 0 : 0;
      const areaSqm = mapping.areaSqm ? Number(attrs[mapping.areaSqm] ?? 0) || null : null;

      if (code && seenCodes.has(code)) {
        const first = seenCodes.get(code);
        const vertices = countVertices(geometry);
        const outerOf = (g) => (g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0]);
        const sameShape = first.vertices === vertices && first.bboxKey === JSON.stringify(bboxOf(outerOf(geometry)));

        /**
         * One area, delivered as several rows. HERE's Admin4 layer cuts a town into pieces — islands,
         * coastal slivers, parts split by a harbour — and gives every piece the town's AREA_ID:
         * Auckland's delivery is 693 rows for 58 places, and the city alone is 154. Keeping only the
         * first row, as for a merged file's copies below, would keep one piece of each town and turn
         * the roads in all the others into orphans. With joinAreaParts the pieces become one
         * MultiPolygon area. A true copy (same shape) is still just dropped.
         */
        if (joinAreaParts && !sameShape) {
          const target = areas[first.index];
          const parts = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
          target.geometry = { type: 'MultiPolygon', coordinates: [...parts(target.geometry), ...parts(geometry)] };
          for (const polygon of parts(geometry)) target.bbox = bboxUnion(target.bbox, bboxOf(polygon[0]));
          if (target.areaSqm != null && areaSqm != null) target.areaSqm += areaSqm;
          first.vertices += vertices;
          joinedParts.set(code, (joinedParts.get(code) || 1) + 1);
          return;
        }

        duplicateCodes.push(code);
        // Same code, different shape or different band: dropping one of these silently would
        // quietly pick a winner for something the customer needs to resolve.
        if (first.priority !== priority || first.areaSqm !== areaSqm || first.vertices !== vertices) {
          if (conflictingCodes.length < 20) conflictingCodes.push(code);
        }
        return; // first occurrence wins; the denominator counts this area once
      }
      const outer = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
      if (code) {
        seenCodes.set(code, {
          priority, areaSqm, vertices: countVertices(geometry),
          bboxKey: JSON.stringify(bboxOf(outer)), index: areas.length,
        });
      }

      const row = priorityTally.get(priority) || { areas: 0, areaSqm: 0 };
      row.areas++;
      row.areaSqm += areaSqm || 0;
      priorityTally.set(priority, row);

      areas.push({
        code,
        // A blank name is the code, so nothing on screen ever reads as an empty string.
        name: (mapping.areaName ? String(attrs[mapping.areaName] ?? '').trim() : '') || code,
        parentName: mapping.areaParent ? String(attrs[mapping.areaParent] ?? '').trim() || null : null,
        priority,
        areaSqm,
        geometry,
        bbox: bboxOf(outer),
        props: attrs,
        targetMeters: 0,
        targetLinks: 0,
      });
    },
    { onProgress: (n) => onProgress('boundary', n) }
  );

  if (joinedParts.size) {
    const biggest = [...joinedParts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const nameOf = (code) => areas.find((a) => a.code === code)?.name || code;
    warnings.push({
      code: 'JOINED_AREA_PARTS',
      message:
        `${joinedParts.size} area(s) arrived in several pieces and were joined into one area each, e.g. ` +
        `${biggest.map(([c, n]) => `${nameOf(c)} (${n} pieces)`).join(', ')}.`,
    });
  }
  if (duplicateCodes.length) {
    warnings.push({
      code: 'DUPLICATE_AREA_CODE',
      message:
        `${duplicateCodes.length} repeated area code(s) were collapsed to one area each, e.g. ` +
        `${[...new Set(duplicateCodes)].slice(0, 3).join(', ')}. The first occurrence of each was kept, ` +
        `so the denominator counts every area once. This is normal in a file merged from several ` +
        `source layers.`,
    });
  }
  if (conflictingCodes.length) {
    warnings.push({
      code: 'CONFLICTING_AREA_CODE',
      message:
        `${conflictingCodes.length} of those repeats disagree with each other on size, priority or ` +
        `shape, e.g. ${conflictingCodes.slice(0, 3).join(', ')}. The first was kept — check these ` +
        `against the source if the band or area matters.`,
    });
  }
  if (areaCodesFromShape) {
    warnings.push({
      code: 'AREA_CODES_FROM_SHAPE',
      message: mapping.areaCode
        ? `${areaCodesFromShape} work area(s) have a blank "${mapping.areaCode}", so their code was made from their outline.`
        : `The work-area file has no code column, so each area's code was made from its outline ` +
          `(the same outline gets the same code in a later delivery). Pick a column below if it has one.`,
    });
  }
  if (emptyAreaGeometry) {
    warnings.push({
      code: 'EMPTY_AREA_GEOMETRY',
      message: `${emptyAreaGeometry} boundary feature(s) had no usable geometry and were skipped.`,
    });
  }

  /* ---- every outline from the file must be one MongoDB will store (repairAreaGeometries) ---- */
  // Before the join, so the roads are measured against exactly the outlines that get written.
  // Without a database connection (a unit test with no Mongo) there is nothing to ask; skipped.
  const geoAcceptsAll =
    deps.geoAcceptsAll || (require('mongoose').connection.readyState === 1 ? mongoAcceptsAll : null);
  if (layers.boundary && areas.length && geoAcceptsAll) {
    const fixed = await repairAreaGeometries(areas, geoAcceptsAll);
    const list = (names) => `${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''}`;
    if (fixed.densified.length) {
      warnings.push({
        code: 'AREA_OUTLINE_DENSIFIED',
        message: `${fixed.densified.length} work area(s) had long straight edges that cross on the globe (${list(fixed.densified)}). Points were added along them; the shape is unchanged.`,
      });
    }
    if (fixed.dropped.length) {
      warnings.push({
        code: 'AREA_OUTLINE_CRUMB_DROPPED',
        message: `${fixed.dropped.length} work area(s) had a tiny self-crossing piece (under 1 ha) that cannot be stored, so it was left out: ${list(fixed.dropped)}.`,
      });
    }
    if (fixed.hulled.length) {
      warnings.push({
        code: 'AREA_OUTLINE_HULLED',
        message: `${fixed.hulled.length} work area(s) had a self-crossing piece that was replaced by its outer boundary (slightly more ground than drawn): ${list(fixed.hulled)}.`,
      });
    }
    if (fixed.broken.length) {
      errors.push({
        code: 'AREA_OUTLINE_INVALID',
        message: `${fixed.broken.length} work area(s) have an outline that cannot be stored or repaired: ${list(fixed.broken)}. Fix them in GIS and re-deliver.`,
      });
    }
  }

  /* ---- boundary index for the join ---- */
  const grid = new Grid(AREA_GRID_CELL);
  areas.forEach((area, i) => grid.insert(area.bbox, i));

  const locate = (pt) => {
    for (const i of grid.near(pt)) {
      const area = areas[i];
      if (pt[0] < area.bbox[0] || pt[0] > area.bbox[2] || pt[1] < area.bbox[1] || pt[1] > area.bbox[3]) {
        continue;
      }
      const rings =
        area.geometry.type === 'Polygon' ? [area.geometry.coordinates] : area.geometry.coordinates;
      for (const polygon of rings) if (pointInPolygon(pt, polygon)) return i;
    }
    return -1;
  };

  /* ---- network (optional) ---- */
  const networkInfo = layers.network ? shapefile.inspect(layers.network.chosen) : null;
  if (networkInfo && ![3, 13, 23].includes(networkInfo.shapeType)) {
    errors.push({
      code: 'NETWORK_NOT_POLYLINE',
      message: `Network layer is ${networkInfo.shapeTypeName}; road links must be polylines.`,
    });
  }

  /**
   * No polygons: one area is drawn round all of the roads (services/roadFootprint.js) and every
   * link belongs to it. After the commit the import runner cuts it into zones of the size asked
   * for (job.drawZones), and those are the areas drivers get.
   */
  let footprint = null;
  let drawnInfo = null;
  if (drawn) {
    footprint = createFootprint(networkInfo.bbox);
    areas.push({
      code: drawnAreaCode(job),
      name: drawnAreaName(job, layers.network.chosen),
      parentName: null,
      priority: 0,
      areaSqm: null,
      geometry: null,
      bbox: networkInfo.bbox,
      props: { drawnFromRoads: true },
      targetMeters: 0,
      targetLinks: 0,
    });
  }

  const seenLinkIds = new Set();
  const duplicateLinkIds = [];
  let duplicateLinkCount = 0;
  const funcClassTally = new Map();
  const dirTally = new Map();
  const bucketTally = new Map();

  let totalMeters = 0;
  let linkCount = 0;
  let multiPartLinks = 0;
  let zeroLengthLinks = 0;
  let unnamedLinks = 0;
  let orphanLinks = 0;
  let orphanMeters = 0;
  /** Links whose id was made from their shape (no column, or a blank value in it). */
  let shapeIdLinks = 0;
  /** Of the repeats above, the ones that were exact copies of another road's geometry. */
  let duplicateShapes = 0;

  let scanned = 0;
  // Skipped entirely when no road layer was supplied — the areas above are already a complete
  // import, and every road-derived figure below simply stays at zero.
  for (const { attrs, parts } of layers.network ? shapefile.features(layers.network.chosen) : []) {
    scanned++;

    // Hand the event loop back periodically. Reading 654,447 features is ~23 seconds of solid
    // synchronous work, and this runs in the same process that serves the API — without this the
    // panel stops responding and the platform health check can fail the container mid-import.
    // Measured: 10k features is a ~200 ms slice worst case, versus a 23 s freeze with no yield at all.
    if (scanned % YIELD_EVERY === 0) {
      onProgress('network', scanned);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }

    const links = linksOfFeature(attrs, parts, mapping);
    if (!links.length) {
      zeroLengthLinks++;
      continue;
    }
    if (links.length > 1) multiPartLinks++;

    const name = mapping.linkName ? String(attrs[mapping.linkName] ?? '').trim() : '';
    const fc = mapping.funcClass ? Number(attrs[mapping.funcClass] ?? 0) || null : null;
    const dir = mapping.dirTravel ? String(attrs[mapping.dirTravel] ?? 'B').trim().toUpperCase() : 'B';

    for (const { id, coords, fromShape } of links) {
      const metres = lineLength(coords);
      if (seenLinkIds.has(id)) {
        // A repeated id is one road: counting its length twice is precisely the double-counted
        // denominator this rule exists to prevent. The commit pass skips it as well, so what is
        // measured here is what gets written.
        duplicateLinkCount++;
        if (fromShape) duplicateShapes++;
        else if (duplicateLinkIds.length < 20) duplicateLinkIds.push(id);
        continue;
      }
      seenLinkIds.add(id);
      if (fromShape) shapeIdLinks++;

      linkCount++;
      totalMeters += metres;
      if (metres === 0) zeroLengthLinks++;
      if (!name) unnamedLinks++;

      tally(funcClassTally, fc, 1, metres);
      tally(dirTally, ['B', 'F', 'T'].includes(dir) ? dir : 'B', 1, metres);
      tally(bucketTally, lengthBucket(metres), 1, metres);
      if (footprint) footprint.addLine(coords);

      const areaIndex = drawn ? 0 : locate(midpointOf(coords));
      if (areaIndex < 0) {
        orphanLinks++;
        orphanMeters += metres;
      } else {
        areas[areaIndex].targetLinks++;
        areas[areaIndex].targetMeters += metres;
      }
    }
  }

  if (footprint) {
    const out = footprint.finish();
    if (!out) {
      errors.push({ code: 'NOTHING_TO_DRAW', message: 'The road file has no usable roads to draw zones from.' });
      areas.length = 0;
    } else {
      const area = areas[0];
      area.geometry = out.geometry;
      area.bbox = out.geometry.coordinates.reduce((box, polygon) => bboxUnion(box, bboxOf(polygon[0])), bboxOf(out.geometry.coordinates[0][0]));
      area.areaSqm = out.areaSqm;
      drawnInfo = {
        code: area.code,
        name: area.name,
        pieces: out.pieces,
        cellM: out.cellM,
        km: area.targetMeters / 1000,
        zones: job.drawZones ? { minKm: job.drawZones.minKm, maxKm: job.drawZones.maxKm, absorbRemainder: job.drawZones.absorbRemainder !== false } : null,
      };
    }
  }

  /* ---- areas this project has already split stay split ---- */
  /**
   * A manager can cut an area that is too big for one driver into zones (the panel's "Split into
   * zones"; services/workAreaSplit.js). The customer's next delivery knows nothing about that and
   * brings the area back whole. Left alone, that would undo the split and strand every assignment
   * and sign-off made on a zone — they are keyed by area code. So the zones are carried into this
   * version as they are, same codes and polygons, and from here on they ARE the areas.
   *
   * An import never splits anything by itself: the size of a zone is a manager's call.
   * Not for a roads-only import: its areas already exist, zones included.
   */
  let split = [];
  if (job.keepAreaSplits !== false && layers.network && layers.boundary && areas.length) {
    /** The links of the areas concerned, read again: the first pass kept no geometry. */
    const linksOf = async (wanted) => {
      const out = new Map([...wanted].map((index) => [index, []]));
      const seen = new Set();
      let read = 0;
      for (const { attrs, parts } of shapefile.features(layers.network.chosen)) {
        read++;
        if (read % YIELD_EVERY === 0) {
          onProgress('zones', read);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setImmediate(resolve));
        }
        // The same links the pass above counted: no empty geometry, no second copy of an id.
        for (const { id, coords } of linksOfFeature(attrs, parts, mapping)) {
          if (seen.has(id)) continue;
          seen.add(id);
          const index = locate(midpointOf(coords));
          if (wanted.has(index)) out.get(index).push({ coords, meters: lineLength(coords) });
        }
      }
      return out;
    };
    const result = await workAreaSplit.carrySplitsForward({ areas, linksOf, projectId: job.projectId, deps });
    split = result.splits;
    const kept = split.filter((row) => row.kept);
    if (kept.length) {
      areas.length = 0;
      areas.push(...result.areas);
      orphanLinks += result.unplacedLinks;
      orphanMeters += result.unplacedMeters;
      warnings.push({
        code: 'AREA_SPLITS_KEPT',
        message:
          `${kept.length} area(s) were split into zones earlier in this project and stay split: ` +
          `${kept.slice(0, 3).map((row) => `${row.name} (${row.zones.length} zones)`).join(', ')}` +
          `${kept.length > 3 ? ', …' : ''}. The zones keep their codes, so drivers and sign-offs stay attached.`,
      });
    }
    const changed = split.filter((row) => !row.kept);
    if (changed.length) {
      warnings.push({
        code: 'AREA_SPLITS_DROPPED',
        message:
          `${changed.map((row) => row.name).slice(0, 3).join(', ')} was split into zones earlier, but more ` +
          `than 1% of its roads now fall outside those zones, so it is imported whole. Split it again ` +
          `from the map after the import.`,
      });
    }
  }

  if (multiPartLinks) {
    warnings.push({
      code: 'MULTIPART_LINKS',
      message: `${multiPartLinks} link(s) arrived in several pieces. Each piece is imported as its own link, so the full length counts.`,
    });
  }
  const repeatedIds = duplicateLinkCount - duplicateShapes;
  if (repeatedIds) {
    warnings.push({
      code: 'DUPLICATE_LINK_ID',
      message:
        `${repeatedIds} repeated link id(s) were skipped, e.g. ` +
        `${duplicateLinkIds.slice(0, 3).join(', ')}. A link id is the ledger's key, so the first ` +
        `occurrence was kept and its length counted once. Where the repeats are different ` +
        `geometry — a road split in two upstream — only the first piece is in the target.`,
    });
  }
  if (duplicateShapes) {
    warnings.push({
      code: 'DUPLICATE_LINK_SHAPE',
      message: `${duplicateShapes} road(s) were exact copies of another road's line and were counted once.`,
    });
  }
  if (shapeIdLinks) {
    warnings.push({
      code: 'LINK_IDS_FROM_SHAPE',
      message: mapping.linkId
        ? `${shapeIdLinks} link(s) have a blank id in "${mapping.linkId}", so their id was made from their shape.`
        : `The road file has no link id column, so each link's id was made from its shape. The same ` +
          `road in a later delivery gets the same id as long as its line is unchanged. A customer ` +
          `list keyed by LINK_ID cannot be matched against this delivery.`,
    });
  }
  if (orphanLinks && totalMeters > 0) {
    warnings.push({
      code: 'ORPHAN_LINKS',
      message: `${orphanLinks} link(s) (${(orphanMeters / 1000).toFixed(1)} km, ${((orphanMeters / totalMeters) * 100).toFixed(1)}%) fall outside every work area — boundary-clipping slivers. They are imported either way; the toggle decides whether they count toward the project total.`,
    });
  }
  if (linkCount > 0 && unnamedLinks / linkCount > 0.1) {
    warnings.push({
      code: 'UNNAMED_LINKS',
      message: `${unnamedLinks} link(s) (${((unnamedLinks / linkCount) * 100).toFixed(1)}%) have no street name. Normal for service roads, but the UI must identify links by id rather than name.`,
    });
  }

  const emptyAreas = areas.filter((a) => a.targetLinks === 0);
  if (layers.network && emptyAreas.length) {
    warnings.push({
      code: 'AREAS_WITHOUT_LINKS',
      message: `${emptyAreas.length} work area(s) contain no road links, e.g. ${emptyAreas.slice(0, 3).map((a) => a.name).join(', ')}. They will always read 0% complete.`,
    });
  }

  /* ---- datum ---- */
  const boundaryCrs = boundaryInfo
    ? { ...boundaryInfo.prj, ...shapefile.datumOffsetNote(boundaryInfo.prj.datum) }
    : null;
  const networkCrs = networkInfo
    ? { ...networkInfo.prj, ...shapefile.datumOffsetNote(networkInfo.prj.datum) }
    : null;
  const crsPairs = [];
  if (boundaryCrs) crsPairs.push(['boundary', boundaryCrs]);
  if (networkCrs) crsPairs.push(['network', networkCrs]);
  for (const [kind, crs] of crsPairs) {
    if (crs.projected) {
      errors.push({
        code: 'PROJECTED_CRS',
        message: `The ${kind} layer is in a projected coordinate system (${crs.name}). Reproject it to geographic WGS84 degrees before importing.`,
      });
    } else if (!crs.compatible) {
      errors.push({ code: 'INCOMPATIBLE_DATUM', message: `${kind}: ${crs.note}` });
    } else if (crs.note) {
      warnings.push({ code: 'DATUM_NOTE', message: `${kind}: ${crs.note}` });
    }
  }
  if (boundaryCrs && networkCrs && boundaryCrs.datum && networkCrs.datum && boundaryCrs.datum !== networkCrs.datum) {
    warnings.push({
      code: 'DATUM_MISMATCH',
      message: `The two layers use different datums (${boundaryCrs.datum} vs ${networkCrs.datum}). Both are WGS84-compatible so coordinates are used as-is, but the mismatch is recorded on the version.`,
    });
  }

  // Derived from `areas` rather than the parse-time tally, because a roads-only import never runs
  // the parse loop — its areas come from the database.
  const byPriority = [...new Set(areas.map((a) => a.priority))]
    .sort((a, b) => a - b)
    .map((priority) => {
      const inBand = areas.filter((a) => a.priority === priority);
      return {
        priority,
        areas: inBand.length,
        areaSqKm: inBand.reduce((sum, a) => sum + (a.areaSqm || 0), 0) / 1e6,
        links: inBand.reduce((s, a) => s + a.targetLinks, 0),
        meters: inBand.reduce((s, a) => s + a.targetMeters, 0),
      };
    })
    .sort((a, b) => a.priority - b.priority);

  const report = {
    generatedAt: new Date(),
    mapping,
    // What was actually applied — the job's own setting, or the default for this kind of file.
    joinAreaParts,
    boundary: {
      // Reused from the active version rather than uploaded, for a roads-only import; or drawn.
      file: drawn ? '(drawn from the roads)' : roadsOnly ? '(existing work areas)' : layers.boundary.chosen.name,
      otherLayersInZip: layers.boundary
        ? layers.boundary.all.filter((n) => n !== layers.boundary.chosen.name)
        : [],
      shapeTypeName: boundaryInfo ? boundaryInfo.shapeTypeName : 'Polygon',
      recordCount: areas.length,
      bbox: boundaryInfo ? boundaryInfo.bbox : null,
      // Never null: the client's ImportReport type declares this non-nullable, and a null here is
      // exactly the shape that crashed ReportView when `network` became nullable.
      crs: boundaryCrs || {
        wkt: null,
        name: drawn ? 'Drawn from the roads' : 'Reused from the active network',
        datum: null,
        projected: false,
        compatible: true,
        note: drawn
          ? 'No boundary file: the work area was drawn round the roads, to be cut into zones.'
          : 'Work areas were reused from the active network version; no boundary file was uploaded.',
      },
      fields: boundaryInfo ? boundaryInfo.fields : [],
      sample: boundaryInfo ? boundaryInfo.sample : [],
      byPriority,
    },
    // Null rather than a shape full of zeroes: "no road layer was supplied" and "a road layer
    // supplied zero roads" are different facts and the UI must be able to tell them apart.
    network: !layers.network ? null : {
      file: layers.network.chosen.name,
      // The road files read together, when the network came as several (one per road class).
      layers: networkInfo.layers || null,
      otherLayersInZip: layers.network.all.filter(
        (n) => !(layers.network.chosen.parts || [layers.network.chosen]).some((b) => b.name === n)
      ),
      shapeTypeName: networkInfo.shapeTypeName,
      recordCount: linkCount,
      bbox: networkInfo.bbox,
      crs: networkCrs,
      fields: networkInfo.fields,
      sample: networkInfo.sample,
      totalMeters,
      avgMeters: linkCount ? totalMeters / linkCount : 0,
      unnamedLinks,
      zeroLengthLinks,
      multiPartLinks,
      byFuncClass: [...funcClassTally.entries()]
        .map(([funcClass, row]) => ({ funcClass, ...row }))
        .sort((a, b) => (a.funcClass ?? 99) - (b.funcClass ?? 99)),
      byDirTravel: [...dirTally.entries()].map(([dir, row]) => ({ dir, ...row })).sort((a, b) => a.dir.localeCompare(b.dir)),
      lengthBuckets: LENGTH_BUCKETS.filter((b) => bucketTally.has(b)).map((bucket) => ({
        bucket,
        links: bucketTally.get(bucket).links,
      })),
    },
    join: {
      orphanLinks,
      orphanMeters,
      areasWithoutLinks: emptyAreas.length,
      matchedAreas: areas.length - emptyAreas.length,
    },
    totals: {
      areas: areas.length,
      links: linkCount,
      // The headline denominator. Orphans are excluded unless the operator opts them in, and are
      // reported separately either way.
      targetMeters: job.includeOrphanLinks ? totalMeters : totalMeters - orphanMeters,
      orphanMeters,
    },
    // Areas that were cut into zones, and the zones each became. Empty when none were.
    split,
    // Set when the area was drawn round the roads (no boundary file): its size, and the zones asked for.
    drawn: drawnInfo,
    errors,
    warnings,
  };

  return { report, areas, mapping };
}

/* ------------------------------------------------------------------ commit */

/**
 * Write the approved delivery: a NetworkVersion, its work areas, and every road link with its
 * area already resolved.
 *
 * The areas carry their rollups from the report pass, so the second traversal only has to assign
 * and insert — no aggregation afterwards, and no dashboard query ever runs the spatial join.
 */
async function commit(job, layers, areas, mapping, onProgress = () => {}) {
  const drawn = isDrawn(job, layers);
  const roadsOnly = !layers.boundary && !drawn;
  const boundaryInfo = layers.boundary ? shapefile.inspect(layers.boundary.chosen) : null;
  const networkInfo = layers.network ? shapefile.inspect(layers.network.chosen) : null;

  /**
   * A roads-only import ADDS to the active version rather than minting a new one.
   *
   * That is the whole point: the work areas already exist and already have assignments pointing at
   * them. Creating a new version would duplicate all 402 areas under new _ids and silently orphan
   * every AreaAssignment — which is exactly how a real assignment got stranded on a superseded
   * version earlier.
   */
  const existing = roadsOnly ? await resolveRoadsOnlyTarget(job) : null;

  const version = existing
    ? await NetworkVersion.findById(existing._id)
    : await NetworkVersion.create({
        projectId: job.projectId,
        label: job.label,
        status: 'building',
        sourceCRS: {
          boundary: boundaryInfo ? boundaryInfo.prj.wkt : null,
          network: networkInfo ? networkInfo.prj.wkt : null,
        },
        sourceHash: {
          boundary: job.files?.boundary?.sha256 || null,
          network: job.files?.network?.sha256 || null,
        },
        importJobId: job._id,
        createdBy: job.requestedBy,
      });

  if (existing) {
    // Record where the roads came from without disturbing the boundary provenance.
    version.sourceCRS = {
      ...(version.sourceCRS || {}),
      network: networkInfo ? networkInfo.prj.wkt : null,
    };
    version.sourceHash = {
      ...(version.sourceHash || {}),
      network: job.files?.network?.sha256 || null,
    };
  }

  try {
    /* ---- areas ---- */
    // Reused in place when roads-only: the documents already exist and must keep their _ids.
    const areaDocs = existing
      ? areas.map((a) => ({ _id: a.existingId, areaCode: a.code, priority: a.priority }))
      : await WorkArea.insertMany(
      areas.map((a) => ({
        projectId: job.projectId,
        networkVersionId: version._id,
        areaCode: a.code,
        name: a.name || a.code,
        parentName: a.parentName,
        priority: a.priority,
        geometry: a.geometry,
        outline: simplifyGeometry(a.geometry, OUTLINE_TOLERANCE_M),
        bbox: a.bbox,
        areaSqm: a.areaSqm,
        targetMeters: a.targetMeters,
        targetLinks: a.targetLinks,
        props: a.props,
      })),
      { ordered: false }
    );
    onProgress('areas', areaDocs.length, areaDocs.length);

    /* ---- index the inserted areas for the assignment pass ---- */
    const grid = new Grid(AREA_GRID_CELL);
    const indexed = areaDocs.map((doc, i) => ({
      _id: doc._id,
      areaCode: doc.areaCode,
      priority: doc.priority,
      bbox: areas[i].bbox,
      geometry: areas[i].geometry,
    }));
    indexed.forEach((a, i) => grid.insert(a.bbox, i));

    const locate = (pt) => {
      for (const i of grid.near(pt)) {
        const area = indexed[i];
        if (pt[0] < area.bbox[0] || pt[0] > area.bbox[2] || pt[1] < area.bbox[1] || pt[1] > area.bbox[3]) {
          continue;
        }
        const rings =
          area.geometry.type === 'Polygon' ? [area.geometry.coordinates] : area.geometry.coordinates;
        for (const polygon of rings) if (pointInPolygon(pt, polygon)) return area;
      }
      return null;
    };

    /* ---- links ---- */
    const total = job.report?.totals?.links || 0;
    let batch = [];
    let written = 0;
    let orphanLinks = 0;
    let orphanMeters = 0;
    let totalMeters = 0;
    const funcClassTally = new Map();

    const flush = async () => {
      if (!batch.length) return;
      await RoadLink.insertMany(batch, { ordered: false });
      written += batch.length;
      batch = [];
      onProgress('links', written, total);
    };

    // A sync generator with an await in the body: each batch is inserted and released before the
    // next is built, so peak memory is one batch rather than all 654k documents.
    // No road layer: the version is areas-only. Assignment, the driver's map and the areas table
    // all work from these alone; only coverage needs links, and it stays at a zero denominator
    // until a road layer is added.
    /**
     * The same first-wins rule the preflight measured with.
     *
     * This pass re-reads the shapefile rather than reusing the validated list, so without its own
     * guard a repeated link id would be written twice — the figures shown to the operator would
     * say one thing and the ledger would hold another.
     */
    const writtenLinkIds = new Set();

    for (const { attrs, parts } of layers.network ? shapefile.features(layers.network.chosen) : []) {
      const dirRaw = mapping.dirTravel
        ? String(attrs[mapping.dirTravel] ?? 'B').trim().toUpperCase()
        : 'B';
      const funcClass = mapping.funcClass ? Number(attrs[mapping.funcClass] ?? 0) || null : null;
      const name = (mapping.linkName ? String(attrs[mapping.linkName] ?? '').trim() : '') || null;
      const autoAccess = mapping.autoAccess
        ? !/^N/i.test(String(attrs[mapping.autoAccess] ?? 'Y').trim())
        : true;

      for (const { id: linkId, coords } of linksOfFeature(attrs, parts, mapping)) {
        if (writtenLinkIds.has(linkId)) continue;
        writtenLinkIds.add(linkId);
        const metres = lineLength(coords);
        // Drawn: one area, round every road — no point testing which one a link is in.
        const area = drawn ? indexed[0] : locate(midpointOf(coords));

        totalMeters += metres;
        tally(funcClassTally, funcClass, 1, metres);
        if (!area) {
          orphanLinks++;
          orphanMeters += metres;
        }

        batch.push({
          projectId: job.projectId,
          networkVersionId: version._id,
          linkId,
          name,
          funcClass,
          dirTravel: ['B', 'F', 'T'].includes(dirRaw) ? dirRaw : 'B',
          autoAccess,
          areaId: area?._id || null,
          areaCode: area?.areaCode || null,
          priority: area ? area.priority : null,
          geometry: { type: 'LineString', coordinates: coords },
          lengthMeters: metres,
        });
      }

      if (batch.length >= INSERT_BATCH) {
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
    }
    await flush();

    /* ---- rollups ---- */
    const byPriority = [...new Set(indexed.map((a) => a.priority))]
      .sort((a, b) => a - b)
      .map((priority) => {
        const inBand = areas.filter((a) => a.priority === priority);
        return {
          priority,
          areas: inBand.length,
          links: inBand.reduce((s, a) => s + a.targetLinks, 0),
          meters: inBand.reduce((s, a) => s + a.targetMeters, 0),
        };
      });

    /**
     * Roads-only: the existing WorkArea documents were written with targetMeters/targetLinks of 0,
     * because at the time there were no roads to count. Now there are. Without this the areas table
     * and every "% complete" would divide by zero forever.
     */
    if (existing) {
      const ops = areas
        .filter((a) => a.existingId)
        .map((a) => ({
          updateOne: {
            filter: { _id: a.existingId },
            update: { $set: { targetMeters: a.targetMeters, targetLinks: a.targetLinks } },
          },
        }));
      if (ops.length) await WorkArea.bulkWrite(ops, { ordered: false });
      onProgress('areas', ops.length, ops.length);
    }

    // Keep whatever state the version was in: an in-place road addition must not knock an ACTIVE
    // network back to 'ready' and leave the project with nothing active.
    if (!existing) version.status = 'ready';
    version.counts = { areas: areaDocs.length, links: written, orphanLinks };
    version.targetMeters = job.includeOrphanLinks ? totalMeters : totalMeters - orphanMeters;
    version.orphanMeters = orphanMeters;
    version.byPriority = byPriority;
    version.byFuncClass = [...funcClassTally.entries()]
      .map(([funcClass, row]) => ({ funcClass, links: row.links, meters: row.meters }))
      .sort((a, b) => (a.funcClass ?? 99) - (b.funcClass ?? 99));
    await version.save();

    return version;
  } catch (err) {
    // A half-written version is worse than none: it would show up in the picker with a plausible
    // but wrong denominator. Roll the whole thing back and let the operator retry.
    if (existing) {
      /**
       * Roads-only rollback removes ONLY the links this run wrote. The version and its work areas
       * pre-date this import and are still referenced by live area assignments — deleting them
       * because a road import failed would destroy data this import never owned.
       */
      await RoadLink.deleteMany({ networkVersionId: version._id }).catch(() => {});
    } else {
      // A half-written NEW version is worse than none: it would show up in the picker with a
      // plausible but wrong denominator.
      await Promise.all([
        RoadLink.deleteMany({ networkVersionId: version._id }),
        WorkArea.deleteMany({ networkVersionId: version._id }),
      ]).catch(() => {});
      await NetworkVersion.deleteOne({ _id: version._id }).catch(() => {});
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ artifacts */

/**
 * Reclaim disk from finished imports — WITHOUT discarding the customer's delivery.
 *
 * Only the EXTRACTED directory is swept. That is a decompressed copy (160 MB for the first
 * delivery) which `extractLayer` regenerates from the zip on demand, so deleting it costs nothing
 * but disk churn.
 *
 * The uploaded .zip itself is kept indefinitely. It is the customer's original file and the only
 * thing that can reproduce a version exactly — including for an audit of what we were given
 * versus what we imported. An earlier version of this swept the zips too, which quietly made
 * every import older than seven days impossible to re-run or verify.
 */
async function cleanupArtifacts() {
  const stale = await ImportJob.find({
    artifactsExpireAt: { $lt: new Date() },
    status: { $in: ['ready', 'failed', 'cancelled'] },
  }).select('_id');

  for (const job of stale) {
    try {
      fs.rmSync(jobDir(job._id), { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}

module.exports = {
  isDrawn,
  drawnAreaName,
  IMPORT_DIR,
  jobDir,
  ensureDir,
  sha256File,
  extractJob,
  extractLayer,
  OUTLINE_TOLERANCE_M,
  buildReport,
  commit,
  cleanupArtifacts,
  sniffBoundaryMapping,
  sniffNetworkMapping,
  linksOfFeature,
  linkIdFromShape,
  areaCodeFromShape,
  repairAreaGeometries,
  mongoAcceptsAll,
  convexHullRing,
  densifyRing,
  rememberedMapping,
  joinPartsFor,
  polygonToGeoJson,
};
