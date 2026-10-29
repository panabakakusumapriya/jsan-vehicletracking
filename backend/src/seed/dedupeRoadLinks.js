/**
 * Remove duplicate road links from one delivery, then rebuild its coverage.
 *
 * Why: the Singapore delivery (28 Oct 2026) came with each road up to ten times over — 404,357
 * links of which 286,219 were exact copies of another link's geometry, no names, no road class.
 * Every copy was credited when its road was driven, so both the target (29,256 km where the roads
 * are ~8,700 km) and "driven" were about three times too high.
 *
 * What it does, for --version=<id> (or --label=<label> of the active delivery):
 *   1. Groups the links by geometry — the same vertices to 1e-6°, in either direction — and keeps
 *      one per group: one that is in a work area if any is, else the oldest.
 *   2. With --apply: writes every removed link (whole document) to --archive=<file.json.gz>, then
 *      deletes them. Restoring is inserting that file back (see --restore).
 *   3. Recounts each area's targetMeters / targetLinks and the delivery's counts, target, orphans,
 *      byPriority and byFuncClass from what is left.
 *   4. Clears the delivery's coverage ledger and re-credits it from the trips that drive there,
 *      oldest first (linkCoverage.attributeTripLinks, the pipeline's own step), then measures each
 *      trip again — the two passes rebuildNetworkCoverage makes, without replaying the whole
 *      project. Trips are picked by --trips-bbox=w,s,e,n (default: the delivery's area bbox).
 *
 * DRY RUN unless --apply. Nothing but this delivery's RoadLinks, WorkArea rollups, NetworkVersion
 * counts and LinkCoverage rows (and its trips' per-delivery figures) is written.
 *
 * Usage:
 *   node src/seed/dedupeRoadLinks.js --label=Singapore
 *   node src/seed/dedupeRoadLinks.js --label=Singapore --apply --archive=C:\path\removed.json.gz
 *   node src/seed/dedupeRoadLinks.js --restore=C:\path\removed.json.gz --apply
 */
const fs = require('fs');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const log = (...a) => console.log(...a); // eslint-disable-line no-console

const geomKey = (coords) => {
  const f = coords.map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(' ');
  const r = coords.slice().reverse().map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`).join(' ');
  return f < r ? f : r;
};

async function restore(file) {
  const RoadLink = require('../models/RoadLink');
  const docs = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  log(`${docs.length} links in ${file}${APPLY ? '' : ' (dry run)'}`);
  if (!APPLY) return;
  for (let i = 0; i < docs.length; i += 5000) {
    const batch = docs.slice(i, i + 5000).map((d) => ({
      ...d,
      _id: new mongoose.Types.ObjectId(d._id),
      networkVersionId: new mongoose.Types.ObjectId(d.networkVersionId),
      areaId: d.areaId ? new mongoose.Types.ObjectId(d.areaId) : null,
      projectId: d.projectId ? new mongoose.Types.ObjectId(d.projectId) : d.projectId,
    }));
    // eslint-disable-next-line no-await-in-loop
    await RoadLink.collection.insertMany(batch, { ordered: false }).catch((e) => { if (e.code !== 11000 && !e.writeErrors) throw e; });
  }
  log('Restored. Recount and rebuild coverage again (run this script without --restore, which finds no duplicates to remove but redoes steps 3-4).');
}

async function main() {
  await connectDB();
  if (args.has('restore')) return restore(String(args.get('restore')));
  const NetworkVersion = require('../models/NetworkVersion');
  const WorkArea = require('../models/WorkArea');
  const RoadLink = require('../models/RoadLink');
  const LinkCoverage = require('../models/LinkCoverage');
  const Trip = require('../models/Trip');
  const linkCoverage = require('../services/linkCoverage');

  const version = args.has('version')
    ? await NetworkVersion.findById(String(args.get('version')))
    : await NetworkVersion.findOne({ label: String(args.get('label') || ''), status: 'active' });
  if (!version) throw new Error('No such delivery (--version=<id> or --label=<label of the active one>)');
  log(`Delivery ${version._id} "${version.label}" (${version.status}): ${version.counts.links} links, target ${(version.targetMeters / 1000).toFixed(1)} km`);

  /* 1. groups */
  const groups = new Map(); // key -> [{ _id, areaId, m }]
  const cursor = RoadLink.find({ networkVersionId: version._id }).select('_id areaId lengthMeters geometry.coordinates').lean().cursor({ batchSize: 5000 });
  for await (const l of cursor) {
    const coords = l.geometry && l.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const k = geomKey(coords);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ _id: l._id, areaId: l.areaId, m: l.lengthMeters || 0 });
  }
  const remove = [];
  let removeM = 0;
  let mixedAreas = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (a.areaId ? 0 : 1) - (b.areaId ? 0 : 1) || String(a._id).localeCompare(String(b._id)));
    if (new Set(g.map((x) => String(x.areaId))).size > 1) mixedAreas++;
    for (const x of g.slice(1)) { remove.push(x._id); removeM += x.m; }
  }
  log(`${groups.size} distinct roads; ${remove.length} duplicate links (${(removeM / 1000).toFixed(1)} km) to remove; ${mixedAreas} groups whose copies sit in different areas (the kept one is in an area)`);
  const covBefore = await LinkCoverage.aggregate([{ $match: { networkVersionId: version._id } }, { $group: { _id: null, m: { $sum: '$lengthMeters' }, n: { $sum: 1 } } }]);
  log(`Coverage now: ${((covBefore[0]?.m || 0) / 1000).toFixed(1)} km on ${covBefore[0]?.n || 0} links`);
  if (!APPLY) return log('\nDry run — nothing written. Add --apply --archive=<file.json.gz>.');

  /* 2. archive, then delete */
  const archive = args.get('archive');
  if (remove.length) {
    if (!archive || archive === true) throw new Error('--archive=<file.json.gz> is required with --apply');
    const docs = [];
    for (let i = 0; i < remove.length; i += 5000) {
      // eslint-disable-next-line no-await-in-loop
      docs.push(...await RoadLink.find({ _id: { $in: remove.slice(i, i + 5000) } }).lean());
    }
    fs.writeFileSync(String(archive), zlib.gzipSync(JSON.stringify(docs)));
    log(`Archived ${docs.length} links to ${archive} (${(fs.statSync(String(archive)).size / 1048576).toFixed(1)} MB)`);
    let deleted = 0;
    for (let i = 0; i < remove.length; i += 5000) {
      // eslint-disable-next-line no-await-in-loop
      deleted += (await RoadLink.deleteMany({ networkVersionId: version._id, _id: { $in: remove.slice(i, i + 5000) } })).deletedCount;
    }
    log(`Deleted ${deleted} duplicate links`);
  }

  /* 3. recount */
  const perArea = await RoadLink.aggregate([
    { $match: { networkVersionId: version._id } },
    { $group: { _id: '$areaId', m: { $sum: '$lengthMeters' }, n: { $sum: 1 } } },
  ]);
  const areaRoll = new Map(perArea.filter((r) => r._id).map((r) => [String(r._id), r]));
  const areas = await WorkArea.find({ networkVersionId: version._id }).select('_id priority').lean();
  await WorkArea.bulkWrite(areas.map((a) => ({
    updateOne: { filter: { _id: a._id }, update: { $set: { targetMeters: areaRoll.get(String(a._id))?.m || 0, targetLinks: areaRoll.get(String(a._id))?.n || 0 } } },
  })));
  const orphan = perArea.find((r) => !r._id) || { m: 0, n: 0 };
  const allM = perArea.reduce((s, r) => s + r.m, 0);
  const allN = perArea.reduce((s, r) => s + r.n, 0);
  // The target keeps the rule it was imported with: roads outside every area left out (the
  // default; then target = all roads − those) or counted.
  const allBefore = (version.byFuncClass || []).reduce((s, b) => s + (b.meters || 0), 0);
  const orphansOut = Math.abs(version.targetMeters - (allBefore - (version.orphanMeters || 0))) < 1;
  version.targetMeters = orphansOut ? allM - orphan.m : allM;
  version.counts.links = allN;
  version.counts.orphanLinks = orphan.n;
  version.orphanMeters = orphan.m;
  const byPri = new Map();
  for (const a of areas) {
    const r = areaRoll.get(String(a._id));
    const b = byPri.get(a.priority) || { priority: a.priority, areas: 0, links: 0, meters: 0 };
    b.areas += 1;
    b.links += r?.n || 0;
    b.meters += r?.m || 0;
    byPri.set(a.priority, b);
  }
  version.byPriority = [...byPri.values()].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  const byFc = await RoadLink.aggregate([
    { $match: { networkVersionId: version._id } },
    { $group: { _id: '$funcClass', links: { $sum: 1 }, meters: { $sum: '$lengthMeters' } } },
  ]);
  version.byFuncClass = byFc.map((r) => ({ funcClass: r._id ?? null, links: r.links, meters: r.meters })).sort((a, b) => (a.funcClass ?? 99) - (b.funcClass ?? 99));
  version.markModified('counts');
  version.markModified('byPriority');
  version.markModified('byFuncClass');
  await version.save();
  log(`Recounted: ${allN} links, target ${(version.targetMeters / 1000).toFixed(1)} km, ${orphan.n} links outside every area (${(orphan.m / 1000).toFixed(1)} km)`);

  /* 4. coverage */
  const bbox = args.has('trips-bbox')
    ? String(args.get('trips-bbox')).split(',').map(Number)
    : areas.length
      ? (await WorkArea.find({ networkVersionId: version._id }).select('bbox').lean()).reduce((b, a) => [Math.min(b[0], a.bbox[0]), Math.min(b[1], a.bbox[1]), Math.max(b[2], a.bbox[2]), Math.max(b[3], a.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity])
      : null;
  if (!bbox) throw new Error('No --trips-bbox and no areas to take it from');
  const trips = await Trip.find({
    projectId: version.projectId,
    status: { $in: ['completed', 'timed_out'] },
    mapMatchStatus: 'matched',
    'startLocation.lon': { $gte: bbox[0], $lte: bbox[2] },
    'startLocation.lat': { $gte: bbox[1], $lte: bbox[3] },
  }).select('_id').sort({ startedAt: 1, _id: 1 }).lean();
  log(`Rebuilding coverage from ${trips.length} trips starting inside [${bbox.map((v) => v.toFixed(3)).join(', ')}]`);
  await LinkCoverage.deleteMany({ networkVersionId: version._id });
  for (const t of trips) {
    // eslint-disable-next-line no-await-in-loop
    await linkCoverage.attributeTripLinks(t._id);
  }
  for (const t of trips) {
    // eslint-disable-next-line no-await-in-loop
    await linkCoverage.computeTripLinkMetrics(t._id);
  }
  const covAfter = await LinkCoverage.aggregate([{ $match: { networkVersionId: version._id } }, { $group: { _id: null, m: { $sum: '$lengthMeters' }, n: { $sum: 1 } } }]);
  log(`Coverage rebuilt: ${((covAfter[0]?.m || 0) / 1000).toFixed(1)} km on ${covAfter[0]?.n || 0} links (was ${((covBefore[0]?.m || 0) / 1000).toFixed(1)} km). Target ${(version.targetMeters / 1000).toFixed(1)} km.`);
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (e) => { console.error('FAILED', e); await mongoose.disconnect().catch(() => {}); process.exit(1); }); // eslint-disable-line no-console
