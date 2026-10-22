/**
 * Where the old VTS app recorded a fuller day than this one, VTS becomes the record for that day.
 *
 * During the hand-over most drivers kept VTS as their main app and opened this one only sometimes,
 * so for the same day Atlas often holds a fragment and VTS the whole shift. The VTS import leaves
 * such days alone ("only days with no Atlas data"). This settles them, per DRIVER-DAY — never per
 * trip, because this app cuts one shift into several trips while VTS keeps one session:
 *
 *   VTS day km  >  Atlas day km × (1 + MARGIN)  and  the difference > MIN_GAIN_M
 *     → the Atlas trips of that day are ARCHIVED and the VTS sessions imported in their place;
 *   otherwise the Atlas day stays (native raw GPS wins a tie).
 *
 * Both sides are measured as MATCHED route km — Atlas cleanedDistanceMeters, VTS cleanedDistance or
 * its cleaned route's length — never raw km, which GPS jumps inflate (see utils/rawDistance.js).
 *
 * Archived, not deleted: every trip and every one of its points is copied to `archivedtrips` /
 * `archivedlocationpoints` under one batch id before it is removed, and --undo=<batch> puts them
 * back. The archived trips' road claims (CoverageSegment, LinkCoverage) are released so the
 * imported VTS trips can take them.
 *
 * Steps
 *   With --from-db (VTS_MONGODB_URI, read-only) VTS sessions are read from the VTS database itself
 *   instead of a dump; --margin=0.10 and --min-gain-km=3 set the rule above.
 *   1. node src/seed/replaceDaysWithVts.js --dump=<dir>            # dry run: the day list
 *   2. node src/seed/replaceDaysWithVts.js --dump=<dir> --apply    # archive the losing Atlas days
 *   3. node src/seed/importVtsSessions.js --dump=<dir> --token-file=<f> --apply
 *      (those days now have no Atlas data, so the importer's own rule admits them)
 *   4. node src/seed/replaceDaysWithVts.js --settle=<batch> --apply
 *      (re-attribute the same drivers' neighbouring trips and refresh their UKM)
 *   Undo: node src/seed/replaceDaysWithVts.js --undo=<batch> --apply, then importer --revert.
 *
 * Built to be interrupted: each day is copied, removed and its claims released as one unit, with a
 * retry on a dropped connection, and the batch file grows a day at a time. A run that dies can be
 * continued with --batch=<id>; days already archived have no Atlas data left and simply fall out
 * of the plan. Every run first releases any claim still held by an already-archived trip.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { connectDB } = require('../config/db');
const { formatDateInZone } = require('../utils/timezone');
const { haversineMeters } = require('../utils/geo');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const APPLY = args.get('apply') === true;
const withRetry = async (what, fn) => { for (let i = 1; ; i++) { try { return await fn(); } catch (e) { if (i >= 5) throw e; console.log(`  ${what}: retry ${i} after ${e.message}`); await new Promise((r) => setTimeout(r, 5000 * i)); } } };
const insertIgnoringDuplicates = async (coll, docs) => { for (let i = 0; i < docs.length; i += 2000) { try { await coll.insertMany(docs.slice(i, i + 2000), { ordered: false }); } catch (e) { if (e.code !== 11000 && !(e.writeErrors && e.writeErrors.every((w) => w.code === 11000))) throw e; } } };
const VTS_PROJECT = String(args.get('vts-project') || '6a3233e935b68ccdc47a9785');
const MARGIN = args.has('margin') ? Number(args.get('margin')) : 0.10;
const MIN_GAIN_M = args.has('min-gain-km') ? Number(args.get('min-gain-km')) * 1000 : 3000;
const FROM_DB = args.get('from-db') === true;
const SETTLE_DAYS = 7;
const TEST_EMAILS = new Set(['autest@vts.com', 'projaus@gmail.com']);
const log = (...a) => console.log(...a);
const km = (m) => (m / 1000).toFixed(1);

function routeLength(dump, id) {
  const f = path.join(dump, 'clean', `${id}.json`);
  if (!fs.existsSync(f)) return 0;
  const pts = JSON.parse(fs.readFileSync(f, 'utf8'));
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversineMeters({ lat: pts[i - 1].latitude, lon: pts[i - 1].longitude }, { lat: pts[i].latitude, lon: pts[i].longitude });
    if (d < 3000) m += d;
  }
  return m;
}

/** Length of a VTS cleaned route ([{latitude, longitude}]), ignoring jumps over 3 km. */
function lengthOf(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversineMeters({ lat: pts[i - 1].latitude, lon: pts[i - 1].longitude }, { lat: pts[i].latitude, lon: pts[i].longitude });
    if (d < 3000) m += d;
  }
  return m;
}

/** --from-db: drivers and sessions from the VTS database, shaped as the API dump is. Read-only. */
async function loadVtsDb() {
  if (!process.env.VTS_MONGODB_URI) throw new Error('--from-db needs VTS_MONGODB_URI (the VTS database, read-only)');
  const { MongoClient } = require('mongoose').mongo;
  const client = new MongoClient(process.env.VTS_MONGODB_URI, { readPreference: 'secondaryPreferred' });
  await client.connect();
  const vdb = client.db();
  const users = await vdb.collection('users').find({}, { projection: { name: 1, email: 1, project: 1 } }).toArray();
  const drivers = users.map((u) => ({ _id: String(u._id), name: u.name, email: u.email, project: u.project ? { _id: String(u.project) } : null }));
  const byId = new Map(drivers.map((d) => [d._id, d]));
  const docs = await vdb.collection('sessions')
    .find({ driver: { $in: users.filter((u) => String(u.project) === VTS_PROJECT).map((u) => u._id) } },
      { projection: { driver: 1, startTime: 1, isActive: 1, cleanedDistance: 1, 'stats.totalDistance': 1 } })
    .toArray();
  const sessions = docs.map((d) => {
    const drv = byId.get(String(d.driver)) || { _id: String(d.driver) };
    return { ...d, _id: String(d._id), driver: { _id: drv._id, name: drv.name, email: drv.email }, startTime: new Date(d.startTime).toISOString() };
  });
  // A cleaned route's length, for sessions VTS never stored a cleanedDistance for (fetched on demand).
  const routeMeters = async (id) => {
    const doc = await vdb.collection('sessions').findOne({ _id: new (require('mongoose').mongo.ObjectId)(String(id)) }, { projection: { cleanedRoute: 1 } });
    return lengthOf((doc && doc.cleanedRoute) || []);
  };
  return { drivers, sessions, routeMeters, close: () => client.close() };
}

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  const User = require('../models/User');
  const CoverageSegment = require('../models/CoverageSegment');
  const LinkCoverage = require('../models/LinkCoverage');

  if (args.has('undo')) return undo(String(args.get('undo')), { db, Trip, LocationPoint, CoverageSegment, LinkCoverage });
  if (args.has('settle')) return settle(String(args.get('settle')), { db, Trip, User });

  // Claims an archived trip still holds (a run that died before releasing them) are released first.
  const archivedIds = (await db.collection('archivedtrips').find({}).project({ _id: 1 }).toArray()).map((x) => x._id);
  if (archivedIds.length) {
    const held = await CoverageSegment.countDocuments({ firstTripId: { $in: archivedIds } }) + await LinkCoverage.countDocuments({ firstTripId: { $in: archivedIds } });
    if (held) {
      log(`${held} road claims still held by ${archivedIds.length} already-archived trips${APPLY ? ' — releasing' : ' (would be released)'}`);
      if (APPLY) { await CoverageSegment.deleteMany({ firstTripId: { $in: archivedIds } }); await LinkCoverage.deleteMany({ firstTripId: { $in: archivedIds } }); }
    }
  }

  const dump = FROM_DB ? String(args.get('dump') || path.join(os.tmpdir(), 'vts-sync-cache')) : args.get('dump');
  if (!dump) throw new Error('--dump=<dir> is required (or --from-db)');
  fs.mkdirSync(dump, { recursive: true });
  const vtsDb = FROM_DB ? await loadVtsDb() : null;
  const drivers = new Map((vtsDb ? vtsDb.drivers : JSON.parse(fs.readFileSync(path.join(dump, 'drivers.json'), 'utf8'))).map((d) => [d._id, d]));
  const sessions = (vtsDb ? vtsDb.sessions : JSON.parse(fs.readFileSync(path.join(dump, 'sessions_all.json'), 'utf8')))
    .filter((s) => s.driver && drivers.get(s.driver._id)?.project?._id === VTS_PROJECT && !s.isActive && !TEST_EMAILS.has(String(s.driver.email).toLowerCase()));
  const imported = new Set((await Trip.find({ importSourceId: /^vts:/ }).select('importSourceId').lean()).map((t) => t.importSourceId.slice(4)));
  const users = new Map((await User.find({ role: 'user' }).select('email name timezone').lean()).map((u) => [String(u.email).toLowerCase(), u]));

  // VTS km per driver-day, counting only days that still have un-imported sessions with something in them.
  const days = new Map();
  const dayOf = (s, u) => formatDateInZone(new Date(s.startTime), u.timezone || 'Australia/Brisbane');
  const openDays = new Set();
  for (const s of sessions) {
    const u = users.get(String(s.driver.email).toLowerCase());
    if (u && !imported.has(s._id)) openDays.add(`${u._id}|${dayOf(s, u)}`);
  }
  for (const s of sessions) {
    const u = users.get(String(s.driver.email).toLowerCase());
    if (!u) continue;
    const zone = u.timezone || 'Australia/Brisbane';
    const day = dayOf(s, u);
    let m = s.cleanedDistance > 0 ? s.cleanedDistance : routeLength(dump, s._id);
    if (!m && vtsDb && openDays.has(`${u._id}|${day}`)) m = await withRetry(`route ${s._id}`, () => vtsDb.routeMeters(s._id));
    m = m || (s.stats?.totalDistance || 0);
    const k = `${u._id}|${day}`;
    const o = days.get(k) || { uid: u._id, name: u.name, zone, day, vts: 0, sessions: [], pending: false };
    o.vts += m;
    o.sessions.push(s._id);
    if (!imported.has(s._id) && m > 500) o.pending = true;
    days.set(k, o);
  }

  const plan = [];
  let kept = 0;
  for (const o of days.values()) {
    if (!o.pending) continue;
    const start = new Date(`${o.day}T00:00:00Z`);
    const trips = await Trip.find({
      driverId: o.uid, importBatchId: null,
      startedAt: { $gte: new Date(start.getTime() - 14 * 3600e3), $lte: new Date(start.getTime() + 38 * 3600e3) },
    }).select('startedAt timezone distanceMeters cleanedDistanceMeters parkedJitter pointCount status').lean();
    const same = trips.filter((t) => formatDateInZone(t.startedAt, t.timezone || o.zone) === o.day);
    if (!same.length) continue; // no Atlas data that day: the importer takes it on its own
    if (same.some((t) => t.status === 'active')) continue; // never touch a day still being driven
    const atlas = same.filter((t) => !t.parkedJitter).reduce((s, t) => s + (t.cleanedDistanceMeters ?? t.distanceMeters ?? 0), 0);
    if (o.vts > atlas * (1 + MARGIN) && o.vts - atlas > MIN_GAIN_M) plan.push({ ...o, atlas, trips: same });
    else kept++;
  }
  plan.sort((a, b) => a.name.localeCompare(b.name) || a.day.localeCompare(b.day));

  log(`Driver-days with VTS sessions still to import and Atlas data too: ${plan.length + kept}`);
  log(`  VTS fuller (replace): ${plan.length}   Atlas fuller or about the same (keep): ${kept}\n`);
  log('DAY         DRIVER                      VTS km   Atlas km  Atlas trips → archived');
  let gain = 0, nTrips = 0;
  for (const p of plan) { gain += p.vts - p.atlas; nTrips += p.trips.length; log(`${p.day}  ${p.name.padEnd(26)} ${km(p.vts).padStart(7)}  ${km(p.atlas).padStart(8)}  ${p.trips.length}`); }
  log(`\n${plan.length} days, ${nTrips} Atlas trips to archive, VTS holds ${km(gain)} km more on them.`);
  if (!APPLY) return log('Dry run — nothing written. Add --apply to archive these days, then run the importer.');

  const batch = args.has('batch') ? String(args.get('batch')) : `vtsday-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const archivedTrips = db.collection('archivedtrips');
  const archivedPoints = db.collection('archivedlocationpoints');
  const batchFile = path.join(dump, `${batch}.json`);
  const record = fs.existsSync(batchFile) ? JSON.parse(fs.readFileSync(batchFile, 'utf8')) : { batch, plan: [] };
  let tripsDone = 0, pointsDone = 0, segDone = 0, lnkDone = 0, daysDone = 0;
  for (const p of plan) {
    const ids = p.trips.map((t) => t._id);
    await withRetry(`${p.name} ${p.day}`, async () => {
      const full = await Trip.find({ _id: { $in: ids } }).lean();
      const pts = await LocationPoint.find({ tripId: { $in: ids } }).lean();
      const meta = { batch, archivedAt: new Date(), reason: 'VTS day fuller', day: p.day, driverId: p.uid, atlasKm: p.atlas / 1000, vtsKm: p.vts / 1000, vtsSessions: p.sessions };
      if (full.length) await insertIgnoringDuplicates(archivedTrips, full.map((t) => ({ ...t, archive: meta })));
      if (pts.length) await insertIgnoringDuplicates(archivedPoints, pts.map((x) => ({ ...x, archiveBatch: batch })));
      await LocationPoint.deleteMany({ tripId: { $in: ids } });
      await Trip.deleteMany({ _id: { $in: ids } });
      const seg = await CoverageSegment.deleteMany({ firstTripId: { $in: ids } });
      const lnk = await LinkCoverage.deleteMany({ firstTripId: { $in: ids } });
      tripsDone += full.length; pointsDone += pts.length; segDone += seg.deletedCount; lnkDone += lnk.deletedCount;
    });
    record.plan.push({ uid: String(p.uid), day: p.day, trips: ids.map(String), sessions: p.sessions });
    fs.writeFileSync(batchFile, JSON.stringify(record));
    daysDone++;
    log(`  ${daysDone}/${plan.length} ${p.day} ${p.name}: ${ids.length} trips archived`);
  }
  log(`
Archived ${tripsDone} trips and ${pointsDone} points as batch ${batch}; released ${segDone} road segments and ${lnkDone} network links.`);
  log(`Now: node src/seed/importVtsSessions.js ${FROM_DB ? '--from-db' : '--dump=... --token-file=...'} --apply   then   node src/seed/replaceDaysWithVts.js --settle=${batch} --apply`);
  log(`Undo: node src/seed/replaceDaysWithVts.js --undo=${batch} --apply`);
}

/** After the import: the same drivers' trips around each replaced day re-claim what the archived trips held, and their UKM is refreshed. */
async function settle(batch, { db, Trip, User }) {
  const { attributeTrip } = require('../services/globalUkm');
  const { attributeTripLinks } = require('../services/linkCoverage');
  const { recomputeDriverUkm } = require('../services/roadSegments');
  const meta = await db.collection('archivedtrips').find({ 'archive.batch': batch }).project({ 'archive.driverId': 1, 'archive.day': 1, 'archive.archivedAt': 1 }).toArray();
  if (!meta.length) throw new Error(`No archived trips for batch ${batch}`);
  // Resumable: a trip whose figures were already re-made after the archive is skipped, so a run
  // that was interrupted (a dropped connection, the machine out of memory) picks up where it stopped.
  const archivedAt = new Date(Math.min(...meta.map((m) => new Date(m.archive.archivedAt).getTime())));
  const todo = new Map();
  let already = 0;
  for (const m of meta) {
    const d0 = new Date(`${m.archive.day}T00:00:00Z`);
    const near = await Trip.find({ driverId: m.archive.driverId, status: { $in: ['completed', 'timed_out'] }, startedAt: { $gte: new Date(d0.getTime() - SETTLE_DAYS * 86400e3), $lte: new Date(d0.getTime() + (SETTLE_DAYS + 1) * 86400e3) } }).select('_id driverId globalUkmComputedAt linkCoverageComputedAt ukmStatus linkCoverageStatus').sort({ startedAt: 1 }).lean();
    for (const t of near) {
      const done = t.globalUkmComputedAt >= archivedAt && t.linkCoverageComputedAt >= archivedAt && t.ukmStatus !== 'pending' && t.linkCoverageStatus !== 'pending';
      if (done) { if (!todo.has(String(t._id))) already++; continue; }
      todo.set(String(t._id), t);
    }
  }
  log(`${todo.size} trips to re-attribute around ${new Set(meta.map((m) => m.archive.day)).size} replaced days (${already} already done since the archive)${APPLY ? '' : ' (dry run)'}`);
  if (!APPLY) return;
  let n = 0;
  for (const t of todo.values()) {
    await attributeTrip(t._id).catch((e) => log(`  global UKM failed ${t._id}: ${e.message}`));
    await attributeTripLinks(t._id).catch((e) => log(`  link coverage failed ${t._id}: ${e.message}`));
    if (++n % 20 === 0) log(`  ${n}/${todo.size}`);
  }
  for (const d of new Set([...todo.values()].map((t) => String(t.driverId)))) await recomputeDriverUkm(d).catch(() => {});
  log(`Settled ${n} trips.`);
}

async function undo(batch, { db, Trip, LocationPoint, CoverageSegment, LinkCoverage }) {
  const trips = await db.collection('archivedtrips').find({ 'archive.batch': batch }).toArray();
  const points = await db.collection('archivedlocationpoints').find({ archiveBatch: batch }).toArray();
  log(`Batch ${batch}: ${trips.length} trips, ${points.length} points to restore`);
  if (!APPLY) return log('Dry run — add --apply.');
  for (const t of trips) { const { archive, ...doc } = t; await Trip.collection.insertOne(doc).catch((e) => { if (e.code !== 11000) throw e; }); }
  for (let i = 0; i < points.length; i += 5000) {
    await LocationPoint.collection.insertMany(points.slice(i, i + 5000).map(({ archiveBatch, ...p }) => p), { ordered: false }).catch((e) => { if (e.code !== 11000) throw e; });
  }
  await db.collection('archivedtrips').deleteMany({ 'archive.batch': batch });
  await db.collection('archivedlocationpoints').deleteMany({ archiveBatch: batch });
  log(`Restored. Their road claims were released at archive time — re-run attribution for them (replaceDaysWithVts.js --settle, or backfillLinkCoverage.js) if the VTS trips that replaced them have been reverted.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
