const WorkArea = require('../models/WorkArea');
const RoadLink = require('../models/RoadLink');
const LinkCoverage = require('../models/LinkCoverage');
const AreaAssignment = require('../models/AreaAssignment');
const AreaCompletion = require('../models/AreaCompletion');
const AreaSplit = require('../models/AreaSplit');
const NetworkVersion = require('../models/NetworkVersion');
const Project = require('../models/Project');
const areaSplit = require('./areaSplit');
const osmPlaces = require('./osmPlaces');
const polygonClipping = require('polygon-clipping');
const { liveNetworkVersions } = require('./liveNetworks');
const { bboxOf, bboxUnion, midpointOf, pointInPolygon, simplifyGeometry } = require('../utils/geo');

/**
 * Putting areaSplit to work on areas that are in the database.
 *
 * areaSplit itself is arithmetic — links and place names in, zones out. This file is everything
 * around it:
 *
 *  - splitCommittedArea: a manager picked an area and a zone size. Work the zones out (preview),
 *    or write them: the zones replace the area inside its network version, its road links and the
 *    coverage already earned on them move across, and the area itself goes.
 *  - joinSplitArea: the way back — the zones go and the area returns exactly as it was, so it can
 *    be split again at a different size.
 *  - carrySplitsForward: a later delivery of the same ground arrives with the area whole again.
 *    The zones people have already assigned and signed off are kept, codes and all.
 *
 * A zone is one polygon, in one place: the ground its own roads are on (see areaSplit.js for
 * what happens to a customer polygon that is really 154 pieces of land).
 *
 * A zone is an ordinary WorkArea. Its code is the parent's with a number ("23061376-07"), its
 * `parentName` is the parent's name and `props.splitFrom` says where it came from; nothing else
 * in the system treats it differently.
 */

/** Display-simplification tolerance for work-area outlines, metres — as networkImport. */
const OUTLINE_TOLERANCE_M = 25;
const UPDATE_CHUNK = 5000;

const polygonsOf = (geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);

const piecesBbox = (pieces) => pieces.reduce((box, poly) => (box ? bboxUnion(box, bboxOf(poly[0])) : bboxOf(poly[0])), null);
const boxesOverlap = (a, b) => Boolean(a && b) && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/**
 * How much ground two sets of polygons really share, in m² — measured, not guessed.
 *
 * Two earlier answers were wrong in ways that mattered:
 *  - an exact boolean (polygon-clipping) took ~20 s per pair between a Voronoi zone cut from a
 *    country outline and a 7,000-vertex city polygon: far too slow for a dialog;
 *  - "does a sampled corner of one fall inside the other" was fast, but once a zone had been cut
 *    around another delivery the hole's edge IS that delivery's outline, vertex for vertex, so its
 *    corners lie exactly on the other's border and the ray test called about half of them inside.
 *    Every cut zone in Vietnam was listed as still overlapping, with 0 m² actually shared. It could
 *    also miss a real overlap where two outlines cross without a corner of either inside the other.
 *
 * A grid of points over the box the two have in common answers both: a point counts when it is
 * inside both. Points sit at cell centres, not on vertices, so outlines that only touch share
 * nothing; and any overlap bigger than a cell is found however the outlines cross. At most
 * GRID_CELLS² points (never more than GRID_MAX_SIDE along one side), cells never finer than 10 m.
 *
 * @returns { sqm, cellSqm }  shared ground, and the size of one grid cell (the measuring step)
 */
const GRID_CELLS = 60;
const GRID_MAX_SIDE = 240;
/** Less shared ground than this is two outlines drawn a hair apart, not an overlap: 1,000 m². */
const MIN_SHARED_SQM = 1000;

function insideAny(pt, pieces, boxes) {
  for (let i = 0; i < pieces.length; i++) {
    const b = boxes[i];
    if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
    if (pointInPolygon(pt, pieces[i])) return true;
  }
  return false;
}

function sharedGround(aPieces, bPieces) {
  const aBoxes = aPieces.map((p) => bboxOf(p[0]));
  const bBoxes = bPieces.map((p) => bboxOf(p[0]));
  const aBox = aBoxes.reduce((b, x) => bboxUnion(b, x), null);
  const bBox = bBoxes.reduce((b, x) => bboxUnion(b, x), null);
  if (!aBox || !bBox || !boxesOverlap(aBox, bBox)) return { sqm: 0, cellSqm: 0 };
  const box = [Math.max(aBox[0], bBox[0]), Math.max(aBox[1], bBox[1]), Math.min(aBox[2], bBox[2]), Math.min(aBox[3], bBox[3])];
  if (box[0] >= box[2] || box[1] >= box[3]) return { sqm: 0, cellSqm: 0 };

  const kx = 111320 * Math.cos((((box[1] + box[3]) / 2) * Math.PI) / 180);
  const ky = 110540;
  const wM = (box[2] - box[0]) * kx;
  const hM = (box[3] - box[1]) * ky;
  const cellM = Math.max(10, Math.sqrt((wM * hM) / (GRID_CELLS * GRID_CELLS)), wM / GRID_MAX_SIDE, hM / GRID_MAX_SIDE);
  const nx = Math.max(1, Math.ceil(wM / cellM));
  const ny = Math.max(1, Math.ceil(hM / cellM));
  const dx = (box[2] - box[0]) / nx;
  const dy = (box[3] - box[1]) / ny;
  const cellSqm = (wM / nx) * (hM / ny);

  // Only the pieces that reach into the shared box take part.
  const near = (pieces, boxes) => {
    const keep = pieces.map((_, i) => i).filter((i) => boxesOverlap(boxes[i], box));
    return [keep.map((i) => pieces[i]), keep.map((i) => boxes[i])];
  };
  const [aNear, aNearBoxes] = near(aPieces, aBoxes);
  const [bNear, bNearBoxes] = near(bPieces, bBoxes);
  if (!aNear.length || !bNear.length) return { sqm: 0, cellSqm };

  let hits = 0;
  for (let i = 0; i < nx; i++) {
    const x = box[0] + (i + 0.5) * dx;
    for (let j = 0; j < ny; j++) {
      const pt = [x, box[1] + (j + 0.5) * dy];
      if (insideAny(pt, bNear, bNearBoxes) && insideAny(pt, aNear, aNearBoxes)) hits++;
    }
  }
  return { sqm: hits * cellSqm, cellSqm };
}

/**
 * The other deliveries whose ground this area sits on top of.
 *
 * Vietnam is three PRIORITIES on the same ground: FC3 in two city polygons, FC4-5 in seven TPA
 * sites, FC1-2 countrywide. The countrywide polygon encloses the other two sets, so splitting it
 * cut zones straight across the seven TPA sites as if nothing were there. The roads never collide —
 * each delivery carries its own road class — but the ground does, and a manager assigning a TPA
 * site does not expect the countrywide delivery to have a zone drawn over it.
 *
 * Nothing is decided here. The panel lists what was found, per delivery, with how much of this
 * area's road lies inside it, and the manager ticks which deliveries to cut around (see
 * `cutAround` in splitCommittedArea).
 */
async function overlappingDeliveries({ versionId, parent }) {
  const live = await liveNetworkVersions([parent.projectId]);
  const others = live.filter((v) => String(v._id) !== String(versionId));
  if (!others.length) return [];

  const labels = new Map(
    (await NetworkVersion.find({ _id: { $in: others.map((v) => v._id) } }).select('label').lean())
      .map((v) => [String(v._id), v.label || 'Untitled delivery'])
  );
  // Asking for every area of every live delivery costs 90 MB and ~20 s of transfer on a project
  // with 3,907 areas — the whole thing is Australian ground next to Vietnam. The stored bbox is
  // written with every area, so narrow to the ones whose box could touch this one: 70 ms.
  const parentPieces = polygonsOf(parent.geometry);
  const parentBox = Array.isArray(parent.bbox) && parent.bbox.length === 4
    ? parent.bbox
    : piecesBbox(parentPieces);
  const areas = await WorkArea.find({
    networkVersionId: { $in: others.map((v) => v._id) },
    'bbox.0': { $lte: parentBox[2] },
    'bbox.2': { $gte: parentBox[0] },
    'bbox.1': { $lte: parentBox[3] },
    'bbox.3': { $gte: parentBox[1] },
  })
    .select('areaCode name geometry areaSqm networkVersionId')
    .lean();

  const parentBoxes = parentPieces.map((p) => bboxOf(p[0]));
  const found = new Map();
  for (const area of areas) {
    const pieces = polygonsOf(area.geometry);
    const box = piecesBbox(pieces);
    if (!boxesOverlap(box, parentBox)) continue;
    // Only the parent's own pieces that could touch: the country is 1,411 province rings and a TPA
    // site sits inside one or two of them.
    const near = parentPieces.filter((p, i) => boxesOverlap(parentBoxes[i], box));
    if (!near.length) continue;
    // Measured, so an outline that only touches this one — the edge of a hole cut around it — is
    // not reported as sitting on it (see sharedGround).
    const shared = sharedGround(near, pieces);
    if (shared.sqm < MIN_SHARED_SQM) continue;

    const key = String(area.networkVersionId);
    if (!found.has(key)) {
      found.set(key, { versionId: area.networkVersionId, label: labels.get(key) || 'Untitled delivery', areas: [], pieces: [], sqm: 0 });
    }
    const row = found.get(key);
    const ownSqm = area.areaSqm || areaSplit.geometryAreaSqm(area.geometry);
    row.areas.push({ areaCode: area.areaCode, name: area.name, sqm: shared.sqm, share: ownSqm ? Math.min(1, shared.sqm / ownSqm) : null });
    row.pieces.push(...pieces);
    row.sqm += shared.sqm;
  }
  // Most shared ground first, and within a delivery the areas it overlaps most.
  for (const row of found.values()) row.areas.sort((a, b) => b.sqm - a.sqm);
  return [...found.values()].sort((a, b) => b.sqm - a.sqm);
}

/** One overlapping delivery as the API reports it: what is shared, area by area, in km². */
function overlapRow(row) {
  return {
    versionId: String(row.versionId),
    label: row.label,
    areas: row.areas.length,
    sqKm: row.sqm / 1e6,
    names: row.areas.slice(0, 6).map((a) => a.name || a.areaCode),
    list: row.areas.slice(0, 12).map((a) => ({ code: a.areaCode, name: a.name || a.areaCode, sqKm: a.sqm / 1e6, share: a.share })),
  };
}

/**
 * After a cut: which pieces of ground still sit on the deliveries they were cut around. Should be
 * none. A zone that lay wholly inside another delivery could not be cut (nothing would have been
 * left of it) and is drawn whole — that is exactly the overlap a manager must be told about rather
 * than discover on the map, so it is measured and listed instead of passing in silence.
 *
 * @param shapes  [{ code, name, geometry }]
 * @param cut     overlappingDeliveries rows that were cut around
 */
function remainingOverlaps(shapes, cut) {
  const out = [];
  const others = cut.map((row) => ({ label: row.label, pieces: row.pieces, box: piecesBbox(row.pieces) }));
  for (const shape of shapes) {
    const pieces = polygonsOf(shape.geometry);
    const box = piecesBbox(pieces);
    let sqm = 0;
    const withLabels = [];
    for (const other of others) {
      if (!boxesOverlap(box, other.box)) continue;
      const shared = sharedGround(pieces, other.pieces);
      if (shared.sqm < MIN_SHARED_SQM) continue;
      sqm += shared.sqm;
      withLabels.push(other.label);
    }
    if (withLabels.length) out.push({ code: shape.code, name: shape.name, sqKm: sqm / 1e6, with: withLabels });
  }
  return out;
}

/** How much of `links` runs inside `pieces` — the road a cut around it would move. */
function roadInside(links, pieces, boxes = pieces.map((p) => bboxOf(p[0]))) {
  const inside = (pt) => {
    for (let i = 0; i < pieces.length; i++) {
      const b = boxes[i];
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      if (pointInPolygon(pt, pieces[i])) return true;
    }
    return false;
  };
  let count = 0;
  let meters = 0;
  for (const link of links) {
    if (!inside(midpointOf(link.coords))) continue;
    count++;
    meters += Number(link.meters) || 0;
  }
  return { links: count, meters };
}


/** Sizes as typed into the panel -> options for areaSplit. Throws a readable message if unusable. */
function optionsFrom(input = {}) {
  const minKm = Number(input.minKm);
  const maxKm = Number(input.maxKm);
  if (!Number.isFinite(minKm) || !Number.isFinite(maxKm) || minKm <= 0 || maxKm <= 0) {
    throw Object.assign(new Error('Enter the size a zone should be, in km — for example 250 to 300'), { status: 400 });
  }
  if (minKm < 5) throw Object.assign(new Error('A zone of under 5 km is too small to be worth assigning'), { status: 400 });
  return areaSplit.resolveOptions({
    minKm: Math.min(minKm, maxKm),
    maxKm: Math.max(minKm, maxKm),
    absorbRemainder: input.absorbRemainder !== false,
  });
}

/** Which of `zones` holds `pt`, by the rule the import assigns links with; -1 if none. */
function zoneLocator(zones) {
  const boxes = zones.map((zone) => zone.bbox);
  const polys = zones.map((zone) => polygonsOf(zone.geometry));
  return (pt) => {
    for (let z = 0; z < zones.length; z++) {
      const b = boxes[z];
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      for (const polygon of polys[z]) if (pointInPolygon(pt, polygon)) return z;
    }
    return -1;
  };
}

const refuse = (message) => Object.assign(new Error(message), { status: 409 });

/** Nobody may be holding it, and it may not be signed off: both are keyed by a code about to change. */
async function assertFree(areas, verb, { allowHeld = false } = {}) {
  const held = allowHeld ? [] : await AreaAssignment.find({ areaId: { $in: areas.map((a) => a._id) }, releasedAt: null })
    .select('areaName driverName')
    .lean();
  if (held.length) {
    throw refuse(
      `${held[0].areaName || 'An area'} is assigned to ${held[0].driverName || 'a driver'}` +
      `${held.length > 1 ? ` (and ${held.length - 1} more)` : ''} — release it before ${verb}`
    );
  }
  // In the project's current coverage cycle: a sign-off from a cycle that has been closed no
  // longer holds anything.
  const project = await Project.findById(areas[0].projectId).select('coverageCycleId').lean();
  const done = await AreaCompletion.findOne({
    projectId: areas[0].projectId,
    coverageCycleId: (project && project.coverageCycleId) || '',
    areaCode: { $in: areas.map((a) => a.areaCode) },
    status: 'completed',
  })
    .select('areaName areaCode')
    .lean();
  if (done) throw refuse(`${done.areaName || done.areaCode} is marked completed — reopen it before ${verb}`);
}

/** Coverage rows follow their links: each row takes the area its road link is on now. */
async function repointCoverage(versionId, fromAreaIds) {
  const covered = await LinkCoverage.find({ networkVersionId: versionId, areaId: { $in: fromAreaIds } })
    .select('linkId')
    .lean();
  if (!covered.length) return 0;
  const linkArea = new Map();
  for (let at = 0; at < covered.length; at += UPDATE_CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await RoadLink.find({
      networkVersionId: versionId,
      linkId: { $in: covered.slice(at, at + UPDATE_CHUNK).map((row) => row.linkId) },
    })
      .select('linkId areaId')
      .lean();
    for (const row of rows) linkArea.set(row.linkId, row.areaId || null);
  }
  await LinkCoverage.bulkWrite(
    covered.map((row) => ({
      updateOne: { filter: { _id: row._id }, update: { $set: { areaId: linkArea.get(row.linkId) ?? null } } },
    })),
    { ordered: false }
  );
  return covered.length;
}

/** Area and orphan counts on the version, from what is actually in the collections now. */
async function refreshVersionCounts(version, priorities) {
  const areaCount = await WorkArea.countDocuments({ networkVersionId: version._id });
  const [orphans] = await RoadLink.aggregate([
    { $match: { networkVersionId: version._id, areaId: null } },
    { $group: { _id: null, meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
  ]);
  const orphanMeters = orphans?.meters || 0;
  // Links left in no zone are orphans now. If the version's target left orphans out (the import's
  // default), it must leave these out too.
  if (Math.abs(orphanMeters - (version.orphanMeters || 0)) > 0.5) {
    const [all] = await RoadLink.aggregate([
      { $match: { networkVersionId: version._id } },
      { $group: { _id: null, meters: { $sum: '$lengthMeters' } } },
    ]);
    const total = all?.meters || 0;
    if (Math.abs(version.targetMeters + (version.orphanMeters || 0) - total) < 1) {
      version.targetMeters = total - orphanMeters;
    }
  }
  version.counts.areas = areaCount;
  version.counts.orphanLinks = orphans?.links || 0;
  version.orphanMeters = orphanMeters;
  for (const priority of new Set(priorities)) {
    const band = version.byPriority.find((row) => row.priority === priority);
    // eslint-disable-next-line no-await-in-loop
    if (band) band.areas = await WorkArea.countDocuments({ networkVersionId: version._id, priority });
  }
  version.markModified('counts');
  version.markModified('byPriority');
  await version.save();
}

const zoneRow = (doc) => ({
  _id: doc._id,
  code: doc.areaCode,
  name: doc.name,
  km: (doc.targetMeters || 0) / 1000,
  links: doc.targetLinks || 0,
});

/**
 * Split an area that is committed, in place.
 *
 * `apply: false` works the zones out and writes nothing but the place names it looked up — the
 * preview a manager sees before saying yes. `apply: true` writes them.
 *
 * Refused while the area is in a driver's hands or signed off.
 *
 * Safe to run twice. The zones are written first and the parent removed last, so a run that died
 * half way leaves both in place; the next run finds the zones, moves whatever links are still on
 * the parent across (by the import's own rule: midpoint in polygon), and finishes.
 *
 * @param areaId | areaCode  which area (one of them)
 * @param options            { minKm, maxKm, absorbRemainder } — see areaSplit.zonePlan
 * @param places             supply to skip the OpenStreetMap lookup (tests, scripts)
 */
async function splitCommittedArea({
  versionId, areaId = null, areaCode = null, options = {}, apply = false, userId = null, places = null, deps = {},
  cutAround = [],
}) {
  const fetchPlaces = deps.fetchPlaces || osmPlaces.fetchPlaces;
  const opt = areaSplit.resolveOptions(options);

  const version = await NetworkVersion.findById(versionId);
  if (!version) throw Object.assign(new Error('Network version not found'), { status: 404 });
  const parent = await WorkArea.findOne(
    areaId ? { _id: areaId, networkVersionId: versionId } : { networkVersionId: versionId, areaCode }
  ).lean();
  const code = parent ? parent.areaCode : areaCode;
  let zoneDocs = code
    ? await WorkArea.find({ networkVersionId: versionId, 'props.splitFrom.code': code }).sort({ areaCode: 1 }).lean()
    : [];
  if (!parent) {
    if (zoneDocs.length) return { alreadySplit: true, applied: false, zones: zoneDocs.map(zoneRow) };
    throw Object.assign(new Error('Work area not found in this network version'), { status: 404 });
  }
  if (parent.props?.splitFrom) {
    throw refuse(`${parent.name} is already a zone of ${parent.props.splitFrom.name} — join the zones back first to cut it differently`);
  }
  await assertFree([parent], 'splitting');

  const linkDocs = await RoadLink.find({ networkVersionId: versionId, areaId: parent._id })
    .select('linkId geometry lengthMeters')
    .sort({ linkId: 1 })
    .lean();
  const totalKm = linkDocs.reduce((sum, l) => sum + l.lengthMeters, 0) / 1000;

  /**
   * Ground other deliveries already cover. Listed whether or not it is cut around: a manager cannot
   * decide about an overlap nobody told them about. `km` is this area's own road that lies inside —
   * for Vietnam P3 that is 76 km inside the seven TPA sites, 1,279 km inside the two cities.
   */
  const linksForTests = linkDocs.map((l) => ({ coords: l.geometry.coordinates, meters: l.lengthMeters }));
  const overlaps = await overlappingDeliveries({ versionId, parent });
  for (const row of overlaps) {
    const road = roadInside(linksForTests, row.pieces);
    row.links = road.links;
    row.km = road.meters / 1000;
  }

  const cutIds = (Array.isArray(cutAround) ? cutAround : []).map(String).filter(Boolean);
  const cut = cutIds.length ? overlaps.filter((row) => cutIds.includes(String(row.versionId))) : [];
  if (cutIds.length && !cut.length) {
    throw refuse('None of the deliveries picked to cut around overlap this area — untick them, or pick one of the deliveries the preview lists');
  }
  const cutRoad = new Map();
  for (const row of cut) {
    const road = roadInside(linksForTests, row.pieces);
    cutRoad.set(String(row.versionId), { links: road.links, km: road.meters / 1000 });
  }

  let record = await AreaSplit.findOne({ networkVersionId: versionId, areaCode: code });
  let stats = null;
  let namesFrom = null;
  /** linkDocs[i] -> index into the zones */
  let linkZone = null;
  let planZones = null;

  if (zoneDocs.length) {
    // An earlier run got as far as writing the zones. Finish the job with those.
    namesFrom = 'an earlier run';
    const locate = zoneLocator(zoneDocs);
    linkZone = Int32Array.from(linkDocs, (l) => locate(midpointOf(l.geometry.coordinates)));
  } else {
    if (!areaSplit.shouldSplit(totalKm, opt)) {
      const size = opt.minKm === opt.maxKm ? `${opt.minKm}` : `${opt.minKm}–${opt.maxKm}`;
      throw refuse(
        `${parent.name} has ${totalKm.toFixed(0)} km of road — not enough to make two zones of ${size} km.` +
        (opt.absorbRemainder && totalKm > opt.maxKm
          ? ' Untick "add the leftover to neighbouring zones" to get one zone and a smaller leftover, or ask for smaller zones.'
          : ' Ask for smaller zones.')
      );
    }
    let found = places;
    let source = 'supplied';
    if (!found && record?.places?.length) {
      found = record.places;
      source = record.placesSource || 'osm';
    }
    if (!found) {
      const looked = await fetchPlaces(parent.bbox);
      found = looked.places;
      source = looked.source;
    }
    namesFrom = found.length ? source : `none — ${source}`;
    if (!record) {
      record = new AreaSplit({ projectId: parent.projectId, networkVersionId: versionId, areaCode: code });
    }
    record.areaName = parent.name;
    record.places = found;
    record.placesSource = source;
    record.options = { minKm: opt.minKm, maxKm: opt.maxKm, absorbRemainder: opt.absorbRemainder };
    if (record.status !== 'applied') record.status = 'preview';
    await record.save();

    await areaSplit.ready; // the triangulation library, on a Node that has to import() it
    const result = areaSplit.splitArea({
      area: {
        code: parent.areaCode,
        name: parent.name,
        geometry: parent.geometry,
        priority: parent.priority,
        props: parent.props,
      },
      links: linkDocs.map((l) => ({ coords: l.geometry.coordinates, meters: l.lengthMeters })),
      places: found,
      options: opt,
    });
    stats = result.stats;
    planZones = result.zones;
    linkZone = result.linkZone;
  }

  /* ---- cut around the ground another delivery already covers ---- */
  let zonesCutAround = 0;
  if (cut.length && planZones) {
    // polygon-clipping takes polygons as separate arguments, not as one array of them.
    const hole = polygonClipping.union(...cut.flatMap((row) => row.pieces));
    for (const zone of planZones) {
      const subject = zone.geometry.type === 'Polygon' ? [zone.geometry.coordinates] : zone.geometry.coordinates;
      const before = areaSplit.geometryAreaSqm(zone.geometry);
      const kept = polygonClipping.difference(subject, hole);
      // Nothing left means a zone lay entirely inside another delivery; leave it whole rather than
      // delete ground this area's own roads are on.
      if (!kept.length) continue;
      const geometry = kept.length === 1
        ? { type: 'Polygon', coordinates: kept[0] }
        : { type: 'MultiPolygon', coordinates: kept };
      const after = areaSplit.geometryAreaSqm(geometry);
      // Only count and rewrite the zones a hole actually bites into — a zone far from the other
      // delivery comes back identical, and all 68 of them must not report as cut.
      if (before - after < 1) continue;
      zone.geometry = geometry;
      zone.bbox = piecesBbox(kept);
      zone.areaSqm = after;
      zonesCutAround++;
    }
  }
  // Check the result instead of trusting it: whatever still sits on a delivery that was cut around.
  const remaining = cut.length && planZones ? remainingOverlaps(planZones, cut) : [];

  const zoneList = planZones || zoneDocs.map((d) => ({ code: d.areaCode, name: d.name }));
  const perZone = zoneList.map(() => ({ meters: 0, links: 0 }));
  let unplaced = 0;
  let unplacedMeters = 0;
  linkDocs.forEach((l, i) => {
    if (linkZone[i] < 0) {
      unplaced++;
      unplacedMeters += l.lengthMeters;
      return;
    }
    perZone[linkZone[i]].meters += l.lengthMeters;
    perZone[linkZone[i]].links++;
  });
  const summary = {
    parent: { _id: parent._id, code: parent.areaCode, name: parent.name, km: totalKm, links: linkDocs.length },
    options: { minKm: opt.minKm, maxKm: opt.maxKm, absorbRemainder: opt.absorbRemainder },
    namesFrom,
    stats,
    // Roads given to no zone: on a detached scrap of the area too small to be a zone (an islet
    // with one wharf road). They sit outside every area while the split stands.
    unplacedLinks: unplaced,
    unplacedKm: unplacedMeters / 1000,
    zones: zoneList.map((zone, z) => ({
      code: zone.code,
      name: zone.name,
      km: perZone[z].meters / 1000,
      links: perZone[z].links,
    })),
    // What this area sits on top of, and what cutting around it did. `excluded` is the road that
    // stays with the zone surrounding the hole — this delivery's own road, whose class the delivery
    // it is cut around does not hold.
    overlaps: overlaps.map((row) => ({
      ...overlapRow(row),
      links: row.links,
      km: row.km,
      cutAround: cut.some((c) => String(c.versionId) === String(row.versionId)),
    })),
    zonesCutAround,
    // Zones that would still sit on a delivery they were cut around — should be none (see
    // remainingOverlaps). The panel shows them in red before anything is written.
    remaining,
    excluded: [...cutRoad.entries()].map(([versionId, road]) => {
      const row = cut.find((c) => String(c.versionId) === versionId);
      return { versionId, label: row.label, links: road.links, km: road.km };
    }),
    applied: false,
  };
  if (!apply) return summary;

  /* ---- 0. keep the area as it was, for the way back ---- */
  if (!record) record = new AreaSplit({ projectId: parent.projectId, networkVersionId: versionId, areaCode: code });
  record.areaName = parent.name;
  record.parent = parent;
  record.status = 'applied';
  record.splitBy = userId;
  record.splitAt = new Date();
  record.zoneCodes = zoneList.map((zone) => zone.code);
  // Kept across a re-run: a second attempt only sees the links the first one left behind.
  record.strandedLinkIds = [...new Set([
    ...(record.strandedLinkIds || []),
    ...linkDocs.filter((_, i) => linkZone[i] < 0).map((l) => l.linkId),
  ])];
  record.markModified('parent');
  await record.save();

  /* ---- 1. the zones ---- */
  if (planZones) {
    const docs = planZones.map((zone) => ({
      projectId: parent.projectId,
      networkVersionId: versionId,
      areaCode: zone.code,
      name: zone.name,
      parentName: zone.parentName,
      priority: zone.priority,
      geometry: zone.geometry,
      outline: simplifyGeometry(zone.geometry, OUTLINE_TOLERANCE_M),
      bbox: zone.bbox,
      areaSqm: zone.areaSqm,
      targetMeters: zone.targetMeters,
      targetLinks: zone.targetLinks,
      props: zone.props,
    }));
    try {
      // Ordered, and all or nothing: a zone the geo index refuses must not leave half a set behind.
      zoneDocs = (await WorkArea.insertMany(docs, { ordered: true })).map((d) => d.toObject());
    } catch (err) {
      await WorkArea.deleteMany({ networkVersionId: versionId, 'props.splitFrom.code': code });
      throw err;
    }
  }

  /* ---- 2. the road links ---- */
  for (let z = 0; z < zoneDocs.length; z++) {
    const ids = [];
    linkDocs.forEach((l, i) => {
      if (linkZone[i] === z) ids.push(l._id);
    });
    for (let at = 0; at < ids.length; at += UPDATE_CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      await RoadLink.updateMany(
        { _id: { $in: ids.slice(at, at + UPDATE_CHUNK) } },
        { $set: { areaId: zoneDocs[z]._id, areaCode: zoneDocs[z].areaCode } }
      );
    }
  }
  // A link in no zone — on a far scrap of the area too small for one — becomes an orphan rather
  // than staying attached to an area that is about to be deleted.
  if (unplaced) {
    const ids = linkDocs.filter((_, i) => linkZone[i] < 0).map((l) => l._id);
    await RoadLink.updateMany({ _id: { $in: ids } }, { $set: { areaId: null, areaCode: null, priority: null } });
  }

  /* ---- 3. the coverage already earned on those links ---- */
  await repointCoverage(versionId, [parent._id]);

  /* ---- 4. the zones' own totals, from what is actually on them now ---- */
  const rollup = await RoadLink.aggregate([
    { $match: { networkVersionId: version._id, areaId: { $in: zoneDocs.map((d) => d._id) } } },
    { $group: { _id: '$areaId', meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
  ]);
  const byId = new Map(rollup.map((r) => [String(r._id), r]));
  await WorkArea.bulkWrite(
    zoneDocs.map((d) => ({
      updateOne: {
        filter: { _id: d._id },
        update: {
          $set: {
            targetMeters: byId.get(String(d._id))?.meters || 0,
            targetLinks: byId.get(String(d._id))?.links || 0,
          },
        },
      },
    })),
    { ordered: false }
  );

  /* ---- 5. the parent goes, and the version's counts follow ---- */
  await WorkArea.deleteOne({ _id: parent._id });
  await refreshVersionCounts(version, [parent.priority]);

  summary.applied = true;
  summary.zones = zoneDocs.map((d) => ({
    _id: d._id,
    code: d.areaCode,
    name: d.name,
    km: (byId.get(String(d._id))?.meters || 0) / 1000,
    links: byId.get(String(d._id))?.links || 0,
  }));
  return summary;
}

/**
 * Put a split area back together: its zones go, and the area returns exactly as it was — same
 * _id, same code, same polygon — with its road links and coverage back on it.
 *
 * For changing one's mind about the zone size: join, then split again. Refused while any zone is
 * in a driver's hands or signed off.
 *
 * Safe to run twice: the area is restored first and the zones removed last.
 *
 * @param areaCode  the split area's code, or the code / id of any one of its zones
 */
async function joinSplitArea({ versionId, areaId = null, areaCode = null, userId = null }) {
  const version = await NetworkVersion.findById(versionId);
  if (!version) throw Object.assign(new Error('Network version not found'), { status: 404 });

  let code = areaCode;
  if (areaId) {
    const picked = await WorkArea.findOne({ _id: areaId, networkVersionId: versionId }).select('areaCode props.splitFrom').lean();
    if (!picked) throw Object.assign(new Error('Work area not found in this network version'), { status: 404 });
    code = picked.props?.splitFrom?.code || picked.areaCode;
  } else {
    const asZone = await WorkArea.findOne({ networkVersionId: versionId, areaCode }).select('props.splitFrom').lean();
    if (asZone?.props?.splitFrom?.code) code = asZone.props.splitFrom.code;
  }

  const record = await AreaSplit.findOne({ networkVersionId: versionId, areaCode: code });
  const zones = await WorkArea.find({ networkVersionId: versionId, 'props.splitFrom.code': code }).lean();
  if (!record || !record.parent) {
    throw refuse(
      zones.length
        ? 'These zones came with the delivery (or from before joins were recorded), so there is no original area on file to put back'
        : 'This area has not been split'
    );
  }
  if (!zones.length) {
    if (record.status === 'joined') return { alreadyJoined: true, area: { code, name: record.areaName } };
    throw refuse('This area has no zones to join');
  }
  await assertFree(zones, 'joining the zones back');

  /* ---- 1. the area, as it was ---- */
  const parent = { ...record.parent };
  const exists = await WorkArea.exists({ _id: parent._id });
  // Raw, so the document goes back byte for byte — the record holds real ObjectIds and dates.
  if (!exists) await WorkArea.collection.insertOne(parent);

  /* ---- 2. links and coverage back onto it ---- */
  const zoneIds = zones.map((zone) => zone._id);
  await RoadLink.updateMany(
    { networkVersionId: version._id, areaId: { $in: zoneIds } },
    { $set: { areaId: parent._id, areaCode: parent.areaCode } }
  );
  await repointCoverage(version._id, zoneIds);
  // …and the links the split left outside every area.
  const stranded = record.strandedLinkIds || [];
  for (let at = 0; at < stranded.length; at += UPDATE_CHUNK) {
    const ids = stranded.slice(at, at + UPDATE_CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await RoadLink.updateMany(
      { networkVersionId: version._id, linkId: { $in: ids }, areaId: null },
      { $set: { areaId: parent._id, areaCode: parent.areaCode, priority: parent.priority } }
    );
    // eslint-disable-next-line no-await-in-loop
    await LinkCoverage.updateMany(
      { networkVersionId: version._id, linkId: { $in: ids }, areaId: null },
      { $set: { areaId: parent._id } }
    );
  }
  const [rollup] = await RoadLink.aggregate([
    { $match: { networkVersionId: version._id, areaId: parent._id } },
    { $group: { _id: null, meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
  ]);
  // Its totals are already right unless a link went astray in between (a run that was finished
  // over changed ground) — and re-adding 64,526 floats in another order would change the last
  // digit of a figure that has been reported.
  if ((rollup?.links || 0) !== parent.targetLinks || Math.abs((rollup?.meters || 0) - parent.targetMeters) > 1) {
    await WorkArea.updateOne(
      { _id: parent._id },
      { $set: { targetMeters: rollup?.meters || 0, targetLinks: rollup?.links || 0 } }
    );
  }

  /* ---- 3. the zones go ---- */
  await WorkArea.deleteMany({ _id: { $in: zoneIds } });
  await refreshVersionCounts(version, [parent.priority]);

  record.status = 'joined';
  record.joinedBy = userId;
  record.joinedAt = new Date();
  record.zoneCodes = [];
  record.strandedLinkIds = [];
  await record.save();

  return {
    joined: true,
    removedZones: zones.length,
    area: {
      _id: parent._id,
      code: parent.areaCode,
      name: parent.name,
      km: (rollup?.meters || 0) / 1000,
      links: rollup?.links || 0,
    },
  };
}

/** Snap to ~1 cm, drop consecutive repeats and rings under a square metre; an outer ring that goes takes its holes. */
function tidyPolygons(polys) {
  const q = (v) => Math.round(v * 1e7) / 1e7;
  const out = [];
  for (const poly of polys) {
    const rings = [];
    for (let r = 0; r < poly.length; r++) {
      const pts = [];
      for (const [x, y] of poly[r]) {
        const p = [q(x), q(y)];
        const last = pts[pts.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
      }
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
      const ring = pts.length >= 3 ? [...pts, pts[0]] : null;
      const ok = ring && new Set(pts.map((p) => `${p[0]},${p[1]}`)).size >= 3 &&
        Math.abs(areaSplit.geometryAreaSqm({ type: 'Polygon', coordinates: [ring] })) >= 1;
      if (!ok) {
        if (r === 0) break; // no outer ring, no polygon
        continue;
      }
      rings.push(ring);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

/** Convex hull (monotone chain) of [lon, lat] points, as a closed ring. */
function convexHull(points) {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) {
    const [x, y] = pts[0] || [0, 0];
    const d = 0.00005; // ~5 m square round a lone road
    return [[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]];
  }
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (const p of pts.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) { // every point on one line: a thin box round it
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const d = 0.00005;
    const [w, s0, e, n] = [Math.min(...xs) - d, Math.min(...ys) - d, Math.max(...xs) + d, Math.max(...ys) + d];
    return [[w, s0], [e, s0], [e, n], [w, n], [w, s0]];
  }
  return [...hull, hull[0]];
}

/**
 * Cut an area in two along ground that is already decided: the road links in `linkIds` (by RoadLink
 * _id) become one zone, every other road of the area the second. Built for the areas VTS closed
 * inside a much bigger Atlas polygon (seed/exactVtsClosedAreas.js) — the closed part can then be
 * signed off without signing off the rest.
 *
 * The roads decide, not the outline: each link goes where it is told, so the totals are exact even
 * where the polygons cannot be intersected cleanly. The zones' outlines are the parent clipped to
 * `cutGeometry` and the parent minus it; if the polygons refuse to clip (self-crossing edges), the
 * cut zone takes `cutGeometry` and the rest keeps the parent's outline.
 *
 * Recorded like a split (AreaSplit, props.splitFrom), so joinSplitArea puts the area back exactly.
 * Refused while the area is signed off, and while a driver holds it — unless `allowHeld`, for a
 * caller that moves the driver's assignment onto the zone they keep (exactVtsClosedAreas --held:
 * the part VTS closed is signed off, the driver stays on the open rest).
 *
 * `dropEmptyPieces`: two systems' outlines never share an edge, so clipping one by the other leaves
 * crumbs all round the border (2,372 of them over 43 areas on 2026-11-10). With this, a piece of a
 * zone's outline that holds none of that zone's roads is dropped; the biggest piece always stays.
 *
 * @param names  { cut, rest } zone names; codes are the parent's + "-01" (cut) and "-02" (rest)
 * @param tag    stored on the AreaSplit record (placesSource) so a script can find its own cuts
 */
async function cutCommittedArea({ versionId, areaId, linkIds, cutGeometry, names = {}, tag = null, userId = null, apply = false, allowHeld = false, dropEmptyPieces = false }) {
  const pc = require('polygon-clipping');
  const version = await NetworkVersion.findById(versionId);
  if (!version) throw Object.assign(new Error('Network version not found'), { status: 404 });
  const parent = await WorkArea.findOne({ _id: areaId, networkVersionId: versionId }).lean();
  if (!parent) throw Object.assign(new Error('Work area not found in this network version'), { status: 404 });
  await assertFree([parent], 'cutting it', { allowHeld });

  const linkDocs = await RoadLink.find({ networkVersionId: versionId, areaId: parent._id })
    .select(dropEmptyPieces ? '_id lengthMeters geometry.coordinates' : '_id lengthMeters')
    .lean();
  const wanted = new Set(linkIds.map(String));
  const cutIds = [];
  const restIds = [];
  let cutMeters = 0;
  let restMeters = 0;
  for (const l of linkDocs) {
    if (wanted.has(String(l._id))) { cutIds.push(l._id); cutMeters += l.lengthMeters; } else { restIds.push(l._id); restMeters += l.lengthMeters; }
  }
  if (!cutIds.length || !restIds.length) {
    throw refuse(`${parent.name}: nothing to cut — ${cutIds.length ? 'every' : 'none'} of its roads are in the part asked for`);
  }

  const P = polygonsOf(parent.geometry);
  const C = polygonsOf(cutGeometry);
  let cutPolys = null;
  let restPolys = null;
  try {
    cutPolys = pc.intersection(P, C);
    restPolys = pc.difference(P, C);
  } catch (err) {
    cutPolys = null;
  }
  if (!cutPolys || !cutPolys.length) cutPolys = C;
  if (!restPolys || !restPolys.length) restPolys = P;
  // Clipping leaves hairline slivers and near-duplicate vertices that the 2dsphere index refuses
  // ("Can't extract geo keys"). Snap to ~1 cm, drop repeats and anything under a square metre.
  cutPolys = tidyPolygons(cutPolys);
  restPolys = tidyPolygons(restPolys);
  if (!cutPolys.length) cutPolys = tidyPolygons(C);
  if (!restPolys.length) restPolys = P;
  if (dropEmptyPieces) {
    const withRoads = (polys, mids) => {
      if (polys.length < 2) return polys;
      const boxes = polys.map((poly) => bboxOf(poly[0]));
      const used = polys.map(() => false);
      for (const pt of mids) {
        for (let i = 0; i < polys.length; i++) {
          const b = boxes[i];
          if (used[i] || pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
          if (pointInPolygon(pt, polys[i])) { used[i] = true; break; }
        }
      }
      const size = (poly) => Math.abs(areaSplit.geometryAreaSqm({ type: 'Polygon', coordinates: poly }));
      const biggest = polys.reduce((best, poly, i) => (size(poly) > size(polys[best]) ? i : best), 0);
      return polys.filter((poly, i) => used[i] || i === biggest);
    };
    const mids = (inCut) => linkDocs.filter((l) => wanted.has(String(l._id)) === inCut).map((l) => midpointOf(l.geometry.coordinates));
    cutPolys = withRoads(cutPolys, mids(true));
    restPolys = withRoads(restPolys, mids(false));
  }
  const asGeometry = (polys) => (polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys });
  const box = (polys) => {
    let b = [180, 90, -180, -90];
    for (const poly of polys) for (const [x, y] of poly[0]) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    return b;
  };
  const splitFrom = { code: parent.areaCode, name: parent.name, cut: true };
  const plan = [
    { code: `${parent.areaCode}-01`, name: names.cut || `${parent.name} (cut)`, polys: cutPolys, ids: cutIds, meters: cutMeters },
    { code: `${parent.areaCode}-02`, name: names.rest || `${parent.name} (rest)`, polys: restPolys, ids: restIds, meters: restMeters },
  ];
  const summary = {
    parent: { _id: parent._id, code: parent.areaCode, name: parent.name, km: (cutMeters + restMeters) / 1000, links: linkDocs.length },
    zones: plan.map((z) => ({ code: z.code, name: z.name, km: z.meters / 1000, links: z.ids.length })),
    applied: false,
  };
  if (!apply) return summary;

  /* ---- 0. keep the area as it was, for the way back ---- */
  let record = await AreaSplit.findOne({ networkVersionId: versionId, areaCode: parent.areaCode });
  const recordIsOurs = !record;
  if (!record) record = new AreaSplit({ projectId: parent.projectId, networkVersionId: versionId, areaCode: parent.areaCode });
  record.areaName = parent.name;
  record.parent = parent;
  record.status = 'applied';
  record.places = [];
  record.placesSource = tag;
  record.splitBy = userId;
  record.splitAt = new Date();
  record.zoneCodes = plan.map((z) => z.code);
  record.strandedLinkIds = [];
  record.markModified('parent');
  await record.save();

  /* ---- 1. the two zones ---- */
  let zoneDocs;
  const insertZones = async () => (await WorkArea.insertMany(plan.map((z) => {
      const geometry = asGeometry(z.polys);
      return {
        projectId: parent.projectId,
        networkVersionId: versionId,
        areaCode: z.code,
        name: z.name,
        parentName: parent.name,
        priority: parent.priority,
        geometry,
        outline: simplifyGeometry(geometry, OUTLINE_TOLERANCE_M),
        bbox: box(z.polys),
        areaSqm: Math.round(areaSplit.geometryAreaSqm(geometry)),
        targetMeters: z.meters,
        targetLinks: z.ids.length,
        props: { ...(parent.props || {}), splitFrom },
      };
    }), { ordered: true })).map((d) => d.toObject());
  const dropZones = () => WorkArea.deleteMany({ networkVersionId: versionId, 'props.splitFrom.code': parent.areaCode });
  try {
    zoneDocs = await insertZones();
  } catch (err) {
    await dropZones();
    try {
      if (!/geo keys/i.test(err.message)) throw err;
      // The index still refuses a clipped outline: draw each zone round its own roads instead
      // (a convex hull is always a valid polygon). Which roads are in which zone is unchanged.
      for (const z of plan) {
        // eslint-disable-next-line no-await-in-loop
        const pts = (await RoadLink.find({ _id: { $in: z.ids } }).select('geometry.coordinates -_id').lean())
          .flatMap((l) => l.geometry.coordinates);
        z.polys = [[convexHull(pts)]];
      }
      zoneDocs = await insertZones();
      summary.outlineFromRoads = true;
    } catch (again) {
      await dropZones();
      // Nothing moved yet: the area is as it was, and no record of a cut is left behind.
      if (recordIsOurs) await AreaSplit.deleteOne({ _id: record._id });
      throw again;
    }
  }

  /* ---- 2. the road links, then the coverage on them ---- */
  for (let z = 0; z < plan.length; z++) {
    for (let at = 0; at < plan[z].ids.length; at += UPDATE_CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      await RoadLink.updateMany(
        { _id: { $in: plan[z].ids.slice(at, at + UPDATE_CHUNK) } },
        { $set: { areaId: zoneDocs[z]._id, areaCode: zoneDocs[z].areaCode } }
      );
    }
  }
  await repointCoverage(versionId, [parent._id]);

  /* ---- 3. the parent goes, and the version's counts follow ---- */
  await WorkArea.deleteOne({ _id: parent._id });
  await refreshVersionCounts(version, [parent.priority]);

  summary.applied = true;
  summary.zones = zoneDocs.map((d, z) => ({ _id: d._id, code: d.areaCode, name: d.name, km: plan[z].meters / 1000, links: plan[z].ids.length }));
  return summary;
}

/** Zones an earlier delivery of this project already cut this area into (newest version wins). */
async function findExistingZones(projectId, parentCode) {
  if (!projectId) return [];
  const newest = await WorkArea.findOne({ projectId, 'props.splitFrom.code': parentCode })
    .sort({ createdAt: -1 })
    .select('networkVersionId')
    .lean();
  if (!newest) return [];
  const docs = await WorkArea.find({
    projectId,
    networkVersionId: newest.networkVersionId,
    'props.splitFrom.code': parentCode,
  })
    .select('areaCode name parentName priority areaSqm geometry bbox props')
    .sort({ areaCode: 1 })
    .lean();
  return docs.map((d) => ({
    code: d.areaCode,
    name: d.name,
    parentName: d.parentName,
    priority: d.priority,
    areaSqm: d.areaSqm,
    geometry: d.geometry,
    // Every part, not just the first: a zone cut from a country outline can be several pieces, and
    // a bbox that covers one of them is what made Vietnam's P3 import read 0 of 0 km.
    bbox: d.bbox && d.bbox.length === 4
      ? d.bbox
      : polygonsOf(d.geometry).reduce((box, p) => (box ? bboxUnion(box, bboxOf(p[0])) : bboxOf(p[0])), null),
    props: d.props || {},
    targetMeters: 0,
    targetLinks: 0,
  }));
}

/**
 * The import's part: a delivery brings an area this project has ALREADY split, whole again.
 *
 * Splitting is a manager's decision, made in the panel — an import never cuts an area up on its
 * own. But it must not undo the decision either. Assignments and sign-offs are keyed by area code,
 * so a re-delivery that turned sixteen zones back into one "Auckland" would strand every one of
 * them. The zones are carried into the new version as they are — same codes, same polygons —
 * with their totals re-counted against the new delivery's roads.
 *
 * Only when they still fit: if more than 1% of the area's road now falls outside its old zones,
 * the ground has changed and the area is left whole for a manager to split afresh.
 *
 * @param areas      parsed areas with targetMeters/targetLinks from the first join
 * @param linksOf    async (Set of area indexes) -> Map(index -> [{ coords, meters }])
 * @param deps       { findExistingZones } — replaceable in tests
 * @returns { areas, splits, unplacedLinks, unplacedMeters }
 */
async function carrySplitsForward({ areas, linksOf, projectId = null, deps = {} }) {
  const existingZones = deps.findExistingZones || findExistingZones;

  const earlier = new Map();
  for (let index = 0; index < areas.length; index++) {
    const area = areas[index];
    if (!area.code || area.props?.splitFrom) continue;
    // eslint-disable-next-line no-await-in-loop
    const zones = await existingZones(projectId, area.code);
    if (zones.length >= 2) earlier.set(index, zones);
  }
  if (!earlier.size) return { areas, splits: [], unplacedLinks: 0, unplacedMeters: 0 };

  const linksByArea = await linksOf(new Set(earlier.keys()));
  const replacement = new Map();
  const splits = [];
  let unplacedLinks = 0;
  let unplacedMeters = 0;

  for (const [index, zones] of earlier) {
    const area = areas[index];
    const links = linksByArea.get(index) || [];
    // Count every link into the zone its midpoint falls in — the rule the commit will use.
    const locate = zoneLocator(zones);
    let outside = 0;
    let outsideMeters = 0;
    for (const link of links) {
      const z = locate(midpointOf(link.coords));
      if (z < 0) {
        outside++;
        outsideMeters += link.meters;
      } else {
        zones[z].targetLinks++;
        zones[z].targetMeters += link.meters;
      }
    }
    const row = {
      code: area.code,
      name: area.name,
      meters: area.targetMeters,
      links: area.targetLinks,
      kept: outsideMeters <= 0.01 * (area.targetMeters || 1),
      zones: zones.map((zone) => ({ code: zone.code, name: zone.name, meters: zone.targetMeters, links: zone.targetLinks })),
    };
    splits.push(row);
    if (!row.kept) continue;
    unplacedLinks += outside;
    unplacedMeters += outsideMeters;
    replacement.set(index, zones);
  }

  const next = [];
  areas.forEach((area, index) => {
    if (replacement.has(index)) next.push(...replacement.get(index));
    else next.push(area);
  });
  return { areas: next, splits, unplacedLinks, unplacedMeters };
}

/**
 * Take other deliveries' ground out of ONE area, without splitting it.
 *
 * For an area that has to stay whole but was drawn over another delivery's areas: a small strip
 * (Vietnam's "P1 exception – Hanoi fringe" lay across two TPA sites, 2.1 km²), a zone that missed a
 * cut, a client's site. Same cut as "Cut around" in a split: the other delivery's polygons become
 * holes. Nothing else moves — the area keeps its code, its assignment and every one of its roads,
 * the ones that run inside a hole included (they are this delivery's road class, not the other's).
 * What was cut is recorded on the area (`props.cutAround`).
 *
 * Refused when nothing would be left: an area wholly inside the other delivery's ground cannot be
 * cut around it — that is a decision about the data, not something to do quietly.
 *
 * `apply: false` works it out and writes nothing.
 */
async function cutAreaAround({ versionId, areaId, cutAround = [], apply = false, userId = null }) {
  const area = await WorkArea.findOne({ _id: areaId, networkVersionId: versionId }).lean();
  if (!area) throw Object.assign(new Error('Work area not found in this network version'), { status: 404 });
  const cutIds = (Array.isArray(cutAround) ? cutAround : []).map(String).filter(Boolean);
  if (!cutIds.length) throw Object.assign(new Error('Tick at least one delivery to cut around'), { status: 400 });

  const overlaps = await overlappingDeliveries({ versionId, parent: area });
  const cut = overlaps.filter((row) => cutIds.includes(String(row.versionId)));
  if (!cut.length) {
    throw refuse(`${area.name} does not overlap the deliveries picked — there is nothing to cut around`);
  }

  const linkDocs = await RoadLink.find({ networkVersionId: versionId, areaId: area._id })
    .select('geometry lengthMeters')
    .lean();
  const links = linkDocs.map((l) => ({ coords: l.geometry.coordinates, meters: l.lengthMeters }));

  const pieces = polygonsOf(area.geometry);
  const hole = polygonClipping.union(...cut.flatMap((row) => row.pieces));
  const kept = polygonClipping.difference(pieces, hole);
  if (!kept.length) {
    throw refuse(
      `${area.name} lies entirely inside ${cut.map((row) => row.label).join(' and ')} — cutting around it would leave nothing. ` +
      'Decide which delivery that ground belongs to instead.'
    );
  }
  const geometry = kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
  const beforeSqm = areaSplit.geometryAreaSqm(area.geometry);
  const afterSqm = areaSplit.geometryAreaSqm(geometry);
  const remaining = remainingOverlaps([{ code: area.areaCode, name: area.name, geometry }], cut);

  const summary = {
    area: { _id: area._id, code: area.areaCode, name: area.name, km: (area.targetMeters || 0) / 1000, links: area.targetLinks || 0 },
    beforeSqKm: beforeSqm / 1e6,
    afterSqKm: afterSqm / 1e6,
    cutSqKm: Math.max(0, beforeSqm - afterSqm) / 1e6,
    overlaps: overlaps.map((row) => ({ ...overlapRow(row), cutAround: cutIds.includes(String(row.versionId)) })),
    // This area's own road inside the holes: it stays with the area.
    excluded: cut.map((row) => {
      const road = roadInside(links, row.pieces);
      return { versionId: String(row.versionId), label: row.label, links: road.links, km: road.meters / 1000 };
    }),
    remaining,
    applied: false,
  };
  if (!apply) return summary;
  if (remaining.length) {
    throw refuse(`${area.name} would still overlap ${remaining[0].with.join(', ')} after the cut — nothing was changed`);
  }

  const props = {
    ...(area.props || {}),
    cutAround: [
      ...((area.props && area.props.cutAround) || []),
      ...cut.map((row) => ({ versionId: row.versionId, label: row.label, sqKm: row.sqm / 1e6, at: new Date(), by: userId })),
    ],
  };
  try {
    await WorkArea.updateOne(
      { _id: area._id },
      {
        $set: {
          geometry,
          outline: simplifyGeometry(geometry, OUTLINE_TOLERANCE_M),
          bbox: piecesBbox(kept),
          areaSqm: afterSqm,
          props,
        },
      }
    );
  } catch (err) {
    // The 2dsphere index refuses an outline it cannot read: say so, and nothing has changed.
    throw refuse(`The cut outline of ${area.name} could not be stored (${err.message}) — nothing was changed`);
  }
  summary.applied = true;
  return summary;
}

module.exports = {
  optionsFrom,
  zoneLocator,
  findExistingZones,
  overlappingDeliveries,
  sharedGround,
  remainingOverlaps,
  cutAreaAround,
  splitCommittedArea,
  cutCommittedArea,
  joinSplitArea,
  carrySplitsForward,
};
