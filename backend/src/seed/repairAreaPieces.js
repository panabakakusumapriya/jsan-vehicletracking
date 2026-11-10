/**
 * Give back the pieces of work areas the import dropped.
 *
 * A customer boundary file sometimes lists one area as several rows with the same code — the
 * mainland, then its islands. Before "join area parts" existed the import kept only the FIRST row
 * (warning DUPLICATE_AREA_CODE). Where that first row was an islet, Atlas ended up with a polygon of
 * a few hundred square metres and every road of the real area in no polygon at all: QLD-P1 / QLD-P2
 * had 11 such areas (Bribie Island, Beerwah, Gladstone Hinterland, …) and 5,660 km of orphan road.
 *
 * This reads the customer's ORIGINAL boundary file (kept in GridFS by the import job), and for each
 * area whose polygon in Atlas is still exactly the file's first row:
 *   - the area's polygon becomes all of its rows (a MultiPolygon), same _id, same code;
 *   - road links of that delivery that are in NO area and whose midpoint is in the added pieces
 *     join the area (the import's own rule), and the coverage already earned on them follows;
 *   - the area's and the delivery's totals are re-counted, and the map's road file is dropped so it
 *     is rebuilt with the roads in their area.
 * A road that already belongs to another area is never moved.
 *
 * Assignments on a repaired area: one held by a DEACTIVATED driver is released; a live driver keeps
 * the area and their earlier driving inside it becomes assigned UKM (recomputeForAssignment).
 *
 * DRY RUN unless --apply. Everything written carries the batch "areapieces-<date>-<hex>" and each
 * area's former state is kept in the `areapiecerepairs` collection:
 *   node src/seed/repairAreaPieces.js [--apply]
 *   node src/seed/repairAreaPieces.js --undo=<batch> [--apply]
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const UNDO = args.has('undo') ? String(args.get('undo')) : null;
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const CHUNK = 5000;
const log = (...a) => console.log(...a); // eslint-disable-line no-console
const km = (m) => (m / 1000).toFixed(1);

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  const WorkArea = require('../models/WorkArea');
  const RoadLink = require('../models/RoadLink');
  const LinkCoverage = require('../models/LinkCoverage');
  const NetworkVersion = require('../models/NetworkVersion');
  const ImportJob = require('../models/ImportJob');
  const User = require('../models/User');
  const shapefile = require('../utils/shapefile');
  const unzip = require('../utils/unzip');
  const fileStore = require('../utils/fileStore');
  const { midpointOf, pointInPolygon, bboxOf, bboxUnion, simplifyGeometry } = require('../utils/geo');
  const { polygonToGeoJson, repairAreaGeometries, OUTLINE_TOLERANCE_M } = require('../services/networkImport');
  const { geometryAreaSqm } = require('../services/areaSplit');
  const { liveNetworkVersions } = require('../services/liveNetworks');
  const { recomputeForAssignment } = require('../services/linkCoverage');
  const repairs = db.collection('areapiecerepairs');
  const blobFiles = db.collection('roadBlobs.files');
  const blobBucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'roadBlobs' });

  const project = await db.collection('projects').findOne({ name: PROJECT_NAME });
  if (!project) throw new Error(`No project named ${PROJECT_NAME}`);

  /** The delivery's totals, from what is in the collections now (as the import and a split do). */
  const recount = async (versionId) => {
    const version = await NetworkVersion.findById(versionId);
    const areas = await WorkArea.find({ networkVersionId: versionId }).select('priority targetMeters targetLinks').lean();
    const [orphans] = await RoadLink.aggregate([
      { $match: { networkVersionId: version._id, areaId: null } },
      { $group: { _id: null, meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
    ]);
    const [all] = await RoadLink.aggregate([
      { $match: { networkVersionId: version._id } },
      { $group: { _id: null, meters: { $sum: '$lengthMeters' } } },
    ]);
    const orphanMeters = orphans?.meters || 0;
    const total = all?.meters || 0;
    // A target that left orphans out (the import's default) keeps leaving them out.
    if (Math.abs(version.targetMeters + (version.orphanMeters || 0) - total) < 1) version.targetMeters = total - orphanMeters;
    version.orphanMeters = orphanMeters;
    version.counts.orphanLinks = orphans?.links || 0;
    version.byPriority = [...new Set(areas.map((a) => a.priority))].sort((a, b) => a - b).map((priority) => {
      const band = areas.filter((a) => a.priority === priority);
      return { priority, areas: band.length, links: band.reduce((s, a) => s + (a.targetLinks || 0), 0), meters: band.reduce((s, a) => s + (a.targetMeters || 0), 0) };
    });
    version.markModified('counts');
    version.markModified('byPriority');
    await version.save();
    // The map's road file says which area each road is in; its name does not change with this, so
    // it has to go for the next request to rebuild it.
    const stale = await blobFiles.find({ 'metadata.versionId': String(versionId) }).toArray();
    for (const f of stale) await blobBucket.delete(f._id).catch(() => {});
    return { targetKm: km(version.targetMeters), orphanKm: km(orphanMeters), blobs: stale.length };
  };

  /* ------------------------------------------------------------------ undo */
  if (UNDO) {
    const rows = await repairs.find({ batch: UNDO, undoneAt: null }).toArray();
    log(`Batch ${UNDO}: ${rows.length} repaired area(s) to put back`);
    rows.forEach((r) => log(`  ${r.areaName} [${r.areaCode}]: ${r.linkIds.length} links back to no area`));
    const released = await db.collection('areaassignments').countDocuments({ releaseBatchId: UNDO });
    log(`Assignments it released, to restore: ${released}`);
    if (!APPLY) return log('Dry run — add --apply to undo.');
    for (const r of rows) {
      for (let at = 0; at < r.linkIds.length; at += CHUNK) {
        const ids = r.linkIds.slice(at, at + CHUNK);
        const links = await RoadLink.find({ _id: { $in: ids }, areaId: r.areaId }).select('linkId').lean();
        await RoadLink.updateMany({ _id: { $in: links.map((l) => l._id) } }, { $set: { areaId: null, areaCode: null, priority: null } });
        await LinkCoverage.updateMany({ networkVersionId: r.networkVersionId, linkId: { $in: links.map((l) => l.linkId) }, areaId: r.areaId }, { $set: { areaId: null, priority: null } });
      }
      await WorkArea.collection.updateOne({ _id: r.areaId }, { $set: { ...r.before, updatedAt: new Date() }, $unset: { 'props.pieceRepair': '' } });
      await repairs.updateOne({ _id: r._id }, { $set: { undoneAt: new Date() } });
    }
    await db.collection('areaassignments').updateMany({ releaseBatchId: UNDO }, { $set: { releasedAt: null, releasedBy: null }, $unset: { releaseBatchId: '', releaseReason: '' } });
    for (const v of new Set(rows.map((r) => String(r.networkVersionId)))) log(`  delivery ${v}:`, await recount(v));
    return log('Undone.');
  }

  /* ------------------------------------------------------------------ what the files say */
  const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
  const verts = (g) => polysOf(g).reduce((s, p) => s + p.reduce((n, r) => n + r.length, 0), 0);
  const sig = (g) => `${verts(g)}:${bboxOf(polysOf(g)[0][0]).map((n) => n.toFixed(6)).join(',')}`;

  const live = (await liveNetworkVersions([project._id])).filter((v) => String(v.projectId) === String(project._id));
  const plans = [];
  for (const v of live) {
    const version = await NetworkVersion.findById(v._id).select('label name importJobId').lean();
    const job = version.importJobId && (await ImportJob.findById(version.importJobId).select('files mapping').lean());
    const file = job?.files?.boundary;
    if (!file?.fileId || !job.mapping?.areaCode || !(await fileStore.exists(file.fileId))) continue;
    const dir = path.join(os.tmpdir(), 'jsan-areapieces', String(job._id));
    fs.rmSync(dir, { recursive: true, force: true });
    await fileStore.downloadTo(file.fileId, path.join(dir, 'boundary.zip'));
    await unzip.extract(path.join(dir, 'boundary.zip'), path.join(dir, 'x'));
    const bundles = shapefile.findShapefiles(path.join(dir, 'x'));
    if (bundles.length !== 1) { log(`${version.label || version.name}: ${bundles.length} shapefiles in ${file.name} — skipped`); continue; }
    const byCode = new Map();
    shapefile.forEachFeature(bundles[0], (attrs, parts) => {
      const g = polygonToGeoJson(parts);
      if (!g) return;
      const code = String(attrs[job.mapping.areaCode] ?? '').trim();
      if (!code) return;
      if (!byCode.has(code)) byCode.set(code, { shapes: [], sigs: new Set() });
      const e = byCode.get(code);
      const s = sig(g);
      if (e.sigs.has(s)) return; // a true copy of a row already seen
      e.sigs.add(s);
      e.shapes.push(g);
    });
    for (const [code, e] of byCode) {
      if (e.shapes.length < 2) continue;
      const area = await WorkArea.findOne({ networkVersionId: v._id, areaCode: code }).lean();
      if (!area || area.props?.pieceRepair) continue; // split into zones, or repaired already
      if (sig(area.geometry) !== sig(e.shapes[0])) { log(`  ${area.name} [${code}]: its polygon is no longer the file's first row — left alone`); continue; }
      const extra = e.shapes.slice(1).flatMap(polysOf);
      const fixed = { name: area.name, code, geometry: { type: 'MultiPolygon', coordinates: [...polysOf(area.geometry), ...extra] } };
      const how = await repairAreaGeometries([fixed]);
      if (how.broken.length) { log(`  ${area.name} [${code}]: the full outline cannot be stored — left alone`); continue; }
      const added = polysOf(fixed.geometry).slice(polysOf(area.geometry).length).map((p) => ({ p, bbox: bboxOf(p[0]) }));
      const inside = (pt) => added.some((x) => pt[0] >= x.bbox[0] && pt[0] <= x.bbox[2] && pt[1] >= x.bbox[1] && pt[1] <= x.bbox[3] && pointInPolygon(pt, x.p));
      const box = added.reduce((b, x) => bboxUnion(b, x.bbox), added[0].bbox);
      const cursor = RoadLink.find({
        networkVersionId: v._id, areaId: null,
        geometry: { $geoIntersects: { $geometry: { type: 'Polygon', coordinates: [[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]]] } } },
      }).select('linkId lengthMeters geometry.coordinates').lean().cursor();
      const ids = []; const linkIds = []; let meters = 0;
      for await (const l of cursor) {
        if (!inside(midpointOf(l.geometry.coordinates))) continue;
        ids.push(l._id); linkIds.push(l.linkId); meters += l.lengthMeters;
      }
      const held = await db.collection('areaassignments').find({ projectId: project._id, areaCode: code, releasedAt: null }).toArray();
      const drivers = await User.find({ _id: { $in: held.map((h) => h.driverId) } }).select('name active').lean();
      const state = new Map(drivers.map((d) => [String(d._id), d]));
      plans.push({ version, area, fixed, pieces: e.shapes.length, ids, linkIds, meters, held: held.map((h) => ({ ...h, gone: state.get(String(h.driverId))?.active === false })) });
    }
  }

  log(`\nAreas to repair: ${plans.length}`);
  for (const p of plans.sort((a, b) => b.meters - a.meters)) {
    const who = p.held.map((h) => `${h.driverName}${h.gone ? ' (deactivated — released)' : ' (keeps it)'}`).join(' + ') || 'nobody';
    log(`  ${p.area.name} [${p.area.areaCode}] ${p.version.label || p.version.name}: ${p.pieces} pieces, ${(geometryAreaSqm(p.area.geometry) / 1e6).toFixed(2)} -> ${(geometryAreaSqm(p.fixed.geometry) / 1e6).toFixed(1)} km2, +${km(p.meters)} km (${p.ids.length} links) | ${who}`);
  }
  log(`Total: ${plans.reduce((s, p) => s + p.ids.length, 0)} links, ${km(plans.reduce((s, p) => s + p.meters, 0))} km`);
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');
  if (!plans.length) return log('Nothing to change.');

  /* ------------------------------------------------------------------ apply */
  const batch = `areapieces-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date();
  log(`\nApplying as ${batch}`);
  const refigure = [];
  for (const p of plans) {
    const { area } = p;
    const geometry = p.fixed.geometry;
    const bbox = polysOf(geometry).reduce((b, poly) => bboxUnion(b, bboxOf(poly[0])), bboxOf(polysOf(geometry)[0][0]));
    // The way back first: the area as it is now, and exactly which roads are about to join it.
    await repairs.insertOne({
      batch, projectId: project._id, networkVersionId: area.networkVersionId, areaId: area._id, areaCode: area.areaCode, areaName: area.name,
      before: { geometry: area.geometry, outline: area.outline, bbox: area.bbox, areaSqm: area.areaSqm, targetMeters: area.targetMeters, targetLinks: area.targetLinks },
      linkIds: p.ids, createdAt: now, undoneAt: null,
    });
    await WorkArea.updateOne({ _id: area._id }, { $set: {
      geometry, outline: simplifyGeometry(geometry, OUTLINE_TOLERANCE_M), bbox, areaSqm: Math.round(geometryAreaSqm(geometry)),
      'props.pieceRepair': { batch, pieces: p.pieces, at: now },
    } });
    for (let at = 0; at < p.ids.length; at += CHUNK) {
      await RoadLink.updateMany({ _id: { $in: p.ids.slice(at, at + CHUNK) }, areaId: null }, { $set: { areaId: area._id, areaCode: area.areaCode, priority: area.priority } });
      await LinkCoverage.updateMany({ networkVersionId: area.networkVersionId, linkId: { $in: p.linkIds.slice(at, at + CHUNK) }, areaId: null }, { $set: { areaId: area._id, priority: area.priority } });
    }
    const [rollup] = await RoadLink.aggregate([
      { $match: { networkVersionId: area.networkVersionId, areaId: area._id } },
      { $group: { _id: null, meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
    ]);
    await WorkArea.updateOne({ _id: area._id }, { $set: { targetMeters: rollup?.meters || 0, targetLinks: rollup?.links || 0 } });
    const gone = p.held.filter((h) => h.gone);
    if (gone.length) {
      await db.collection('areaassignments').updateMany({ _id: { $in: gone.map((h) => h._id) }, releasedAt: null },
        { $set: { releasedAt: now, releasedBy: null, releaseBatchId: batch, releaseReason: 'driver account deactivated' } });
    }
    for (const h of p.held.filter((x) => !x.gone)) refigure.push({ driverId: h.driverId, areaCode: area.areaCode });
    log(`  ${area.name}: ${rollup?.links || 0} links, ${km(rollup?.meters || 0)} km${gone.length ? `, released ${gone.map((h) => h.driverName).join(' + ')}` : ''}`);
  }
  for (const v of new Set(plans.map((p) => String(p.area.networkVersionId)))) log(`  delivery ${v}:`, await recount(v));
  if (refigure.length) {
    log(`Re-figuring assigned UKM for ${refigure.length} held area(s)…`);
    await recomputeForAssignment(project._id, refigure);
  }
  log(`Done. Undo: node src/seed/repairAreaPieces.js --undo=${batch} --apply`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
