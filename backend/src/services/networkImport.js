const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ImportJob = require('../models/ImportJob');
const NetworkVersion = require('../models/NetworkVersion');
const WorkArea = require('../models/WorkArea');
const RoadLink = require('../models/RoadLink');

const { extract } = require('../utils/unzip');
const shapefile = require('../utils/shapefile');
const {
  lineLength,
  bboxOf,
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

function sniffBoundaryMapping(fields) {
  return {
    // SA2 before SA3/SA4: the most specific level present is the unit of work.
    areaCode: pick(fields, [/^SA2.*CODE$/i, /^SA1.*CODE$/i, /CODE$/i, /^ID$/i]),
    areaName: pick(fields, [/^SA2.*NAME$/i, /^SA1.*NAME$/i, /^NAME$/i, /NAME$/i]),
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
  if (!file?.path) throw new Error(`No ${kind} file uploaded`);
  if (!fs.existsSync(file.path)) {
    throw new Error(`The uploaded ${kind} archive is no longer on disk — re-upload it`);
  }

  const target = path.join(jobDir(job._id), kind);
  const already = reuse && fs.existsSync(target) && shapefile.findShapefiles(target).length > 0;
  if (!already) {
    fs.rmSync(target, { recursive: true, force: true });
    await extract(file.path, target);
  }

  const bundles = shapefile.findShapefiles(target);
  if (!bundles.length) throw new Error(`The ${kind} archive contains no .shp file`);

  for (const required of ['shx', 'dbf']) {
    if (!fs.existsSync(bundles[0][required])) {
      throw new Error(`The ${kind} shapefile is missing its .${required} sibling`);
    }
  }

  // Largest wins when a zip carries several layers; the report names every one it saw so a wrong
  // pick is visible rather than mysterious.
  return { chosen: bundles[0], all: bundles.map((b) => b.name) };
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
  const layers = { boundary: await extractLayer(job, 'boundary'), network: null };
  if (job.files?.network?.path) layers.network = await extractLayer(job, 'network');
  return layers;
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
async function buildReport(job, layers, onProgress = () => {}) {
  const errors = [];
  const warnings = [];

  /* ---- boundary ---- */
  const boundaryInfo = shapefile.inspect(layers.boundary.chosen);
  const mapping = {
    ...sniffBoundaryMapping(boundaryInfo.fields),
    ...(layers.network ? sniffNetworkMapping(shapefile.inspect(layers.network.chosen).fields) : {}),
    ...Object.fromEntries(Object.entries(job.mapping || {}).filter(([, v]) => v)),
  };

  if (boundaryInfo.shapeType !== 5 && boundaryInfo.shapeType !== 15 && boundaryInfo.shapeType !== 25) {
    errors.push({
      code: 'BOUNDARY_NOT_POLYGON',
      message: `Boundary layer is ${boundaryInfo.shapeTypeName}; work areas must be polygons.`,
    });
  }
  if (!mapping.areaCode) {
    errors.push({ code: 'NO_AREA_CODE', message: 'No area code column identified — choose one below.' });
  }

  const areas = [];
  const priorityTally = new Map();
  const seenCodes = new Set();
  const duplicateCodes = [];
  let emptyAreaGeometry = 0;

  shapefile.forEachFeature(
    layers.boundary.chosen,
    (attrs, parts) => {
      const geometry = polygonToGeoJson(parts);
      if (!geometry) {
        emptyAreaGeometry++;
        return;
      }
      const code = mapping.areaCode ? String(attrs[mapping.areaCode] ?? '').trim() : '';
      if (code && seenCodes.has(code)) duplicateCodes.push(code);
      if (code) seenCodes.add(code);

      const priority = mapping.priority ? Number(attrs[mapping.priority] ?? 0) || 0 : 0;
      const areaSqm = mapping.areaSqm ? Number(attrs[mapping.areaSqm] ?? 0) || null : null;
      const outer = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];

      const row = priorityTally.get(priority) || { areas: 0, areaSqm: 0 };
      row.areas++;
      row.areaSqm += areaSqm || 0;
      priorityTally.set(priority, row);

      areas.push({
        code,
        name: mapping.areaName ? String(attrs[mapping.areaName] ?? '').trim() : code,
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

  if (duplicateCodes.length) {
    errors.push({
      code: 'DUPLICATE_AREA_CODE',
      message: `${duplicateCodes.length} duplicate area code(s), e.g. ${duplicateCodes.slice(0, 3).join(', ')}. Each area must appear once or the denominator double-counts.`,
    });
  }
  if (emptyAreaGeometry) {
    warnings.push({
      code: 'EMPTY_AREA_GEOMETRY',
      message: `${emptyAreaGeometry} boundary feature(s) had no usable geometry and were skipped.`,
    });
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
  if (networkInfo && !mapping.linkId) {
    errors.push({ code: 'NO_LINK_ID', message: 'No link id column identified — choose one below.' });
  }

  const seenLinkIds = new Set();
  const duplicateLinkIds = [];
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
  let missingLinkId = 0;

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

    if (!parts.length || parts[0].length < 2) {
      zeroLengthLinks++;
      continue;
    }
    if (parts.length > 1) multiPartLinks++;

    const coords = parts[0];
    const metres = lineLength(coords);
    linkCount++;
    totalMeters += metres;
    if (metres === 0) zeroLengthLinks++;

    const id = mapping.linkId ? String(attrs[mapping.linkId] ?? '').trim() : '';
    if (!id) missingLinkId++;
    else if (seenLinkIds.has(id)) {
      if (duplicateLinkIds.length < 20) duplicateLinkIds.push(id);
    } else seenLinkIds.add(id);

    const name = mapping.linkName ? String(attrs[mapping.linkName] ?? '').trim() : '';
    if (!name) unnamedLinks++;

    const fc = mapping.funcClass ? Number(attrs[mapping.funcClass] ?? 0) || null : null;
    tally(funcClassTally, fc, 1, metres);
    const dir = mapping.dirTravel ? String(attrs[mapping.dirTravel] ?? 'B').trim().toUpperCase() : 'B';
    tally(dirTally, ['B', 'F', 'T'].includes(dir) ? dir : 'B', 1, metres);
    tally(bucketTally, lengthBucket(metres), 1, metres);

    const areaIndex = locate(midpointOf(coords));
    if (areaIndex < 0) {
      orphanLinks++;
      orphanMeters += metres;
    } else {
      areas[areaIndex].targetLinks++;
      areas[areaIndex].targetMeters += metres;
    }
  }

  if (multiPartLinks) {
    errors.push({
      code: 'MULTIPART_LINKS',
      message: `${multiPartLinks} link(s) have multi-part geometry. Only the first part would be imported, which would silently understate the target — split them upstream and re-deliver.`,
    });
  }
  if (duplicateLinkIds.length) {
    errors.push({
      code: 'DUPLICATE_LINK_ID',
      message: `Duplicate link id(s) found, e.g. ${duplicateLinkIds.slice(0, 3).join(', ')}. Link ids are the ledger's primary key and must be unique.`,
    });
  }
  if (missingLinkId) {
    errors.push({
      code: 'MISSING_LINK_ID',
      message: `${missingLinkId} link(s) have a blank id in "${mapping.linkId}".`,
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
  const boundaryCrs = { ...boundaryInfo.prj, ...shapefile.datumOffsetNote(boundaryInfo.prj.datum) };
  const networkCrs = networkInfo
    ? { ...networkInfo.prj, ...shapefile.datumOffsetNote(networkInfo.prj.datum) }
    : null;
  const crsPairs = networkCrs
    ? [['boundary', boundaryCrs], ['network', networkCrs]]
    : [['boundary', boundaryCrs]];
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
  if (networkCrs && boundaryCrs.datum && networkCrs.datum && boundaryCrs.datum !== networkCrs.datum) {
    warnings.push({
      code: 'DATUM_MISMATCH',
      message: `The two layers use different datums (${boundaryCrs.datum} vs ${networkCrs.datum}). Both are WGS84-compatible so coordinates are used as-is, but the mismatch is recorded on the version.`,
    });
  }

  const byPriority = [...priorityTally.entries()]
    .map(([priority, row]) => {
      const inBand = areas.filter((a) => a.priority === priority);
      return {
        priority,
        areas: row.areas,
        areaSqKm: row.areaSqm / 1e6,
        links: inBand.reduce((s, a) => s + a.targetLinks, 0),
        meters: inBand.reduce((s, a) => s + a.targetMeters, 0),
      };
    })
    .sort((a, b) => a.priority - b.priority);

  const report = {
    generatedAt: new Date(),
    mapping,
    boundary: {
      file: layers.boundary.chosen.name,
      otherLayersInZip: layers.boundary.all.filter((n) => n !== layers.boundary.chosen.name),
      shapeTypeName: boundaryInfo.shapeTypeName,
      recordCount: areas.length,
      bbox: boundaryInfo.bbox,
      crs: boundaryCrs,
      fields: boundaryInfo.fields,
      sample: boundaryInfo.sample,
      byPriority,
    },
    // Null rather than a shape full of zeroes: "no road layer was supplied" and "a road layer
    // supplied zero roads" are different facts and the UI must be able to tell them apart.
    network: !layers.network ? null : {
      file: layers.network.chosen.name,
      otherLayersInZip: layers.network.all.filter((n) => n !== layers.network.chosen.name),
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
  const boundaryInfo = shapefile.inspect(layers.boundary.chosen);
  const networkInfo = layers.network ? shapefile.inspect(layers.network.chosen) : null;

  const version = await NetworkVersion.create({
    projectId: job.projectId,
    label: job.label,
    status: 'building',
    sourceCRS: { boundary: boundaryInfo.prj.wkt, network: networkInfo ? networkInfo.prj.wkt : null },
    sourceHash: {
      boundary: job.files?.boundary?.sha256 || null,
      network: job.files?.network?.sha256 || null,
    },
    importJobId: job._id,
    createdBy: job.requestedBy,
  });

  try {
    /* ---- areas ---- */
    const areaDocs = await WorkArea.insertMany(
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
    for (const { attrs, parts } of layers.network ? shapefile.features(layers.network.chosen) : []) {
      if (!parts.length || parts[0].length < 2) continue;
      const coords = parts[0];
      const metres = lineLength(coords);
      const area = locate(midpointOf(coords));
      const dirRaw = mapping.dirTravel
        ? String(attrs[mapping.dirTravel] ?? 'B').trim().toUpperCase()
        : 'B';
      const funcClass = mapping.funcClass ? Number(attrs[mapping.funcClass] ?? 0) || null : null;

      totalMeters += metres;
      tally(funcClassTally, funcClass, 1, metres);
      if (!area) {
        orphanLinks++;
        orphanMeters += metres;
      }

      batch.push({
        projectId: job.projectId,
        networkVersionId: version._id,
        linkId: String(attrs[mapping.linkId] ?? '').trim(),
        name: (mapping.linkName ? String(attrs[mapping.linkName] ?? '').trim() : '') || null,
        funcClass,
        dirTravel: ['B', 'F', 'T'].includes(dirRaw) ? dirRaw : 'B',
        autoAccess: mapping.autoAccess
          ? !/^N/i.test(String(attrs[mapping.autoAccess] ?? 'Y').trim())
          : true,
        areaId: area?._id || null,
        areaCode: area?.areaCode || null,
        priority: area ? area.priority : null,
        geometry: { type: 'LineString', coordinates: coords },
        lengthMeters: metres,
      });

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

    version.status = 'ready';
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
    await Promise.all([
      RoadLink.deleteMany({ networkVersionId: version._id }),
      WorkArea.deleteMany({ networkVersionId: version._id }),
    ]).catch(() => {});
    await NetworkVersion.deleteOne({ _id: version._id }).catch(() => {});
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
  polygonToGeoJson,
};
