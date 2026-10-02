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
const { bboxOf, midpointOf, pointInPolygon, simplifyGeometry } = require('../utils/geo');

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
async function assertFree(areas, verb) {
  const held = await AreaAssignment.find({ areaId: { $in: areas.map((a) => a._id) }, releasedAt: null })
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
    bbox: d.bbox && d.bbox.length === 4 ? d.bbox : bboxOf(polygonsOf(d.geometry)[0][0]),
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

module.exports = {
  optionsFrom,
  zoneLocator,
  findExistingZones,
  splitCommittedArea,
  joinSplitArea,
  carrySplitsForward,
};
