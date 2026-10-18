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
 *   1. node src/seed/replaceDaysWithVts.js --dump=<dir>            # dry run: the day list
 *   2. node src/seed/replaceDaysWithVts.js --dump=<dir> --apply    # archive the losing Atlas days
 *   3. node src/seed/importVtsSessions.js --dump=<dir> --token-file=<f> --apply
 *      (those days now have no Atlas data, so the importer's own rule admits them)
 *   4. node src/seed/replaceDaysWithVts.js --settle=<batch> --apply
 *      (re-attribute the same drivers' neighbouring trips and refresh their UKM)
 *   Undo: node src/seed/replaceDaysWithVts.js --undo=<batch> --apply, then importer --revert.
 */
const fs = require('fs');
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
const VTS_PROJECT = String(args.get('vts-project') || '6a3233e935b68ccdc47a9785');
const MARGIN = 0.10;
const MIN_GAIN_M = 3000;
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

  const dump = args.get('dump');
  if (!dump) throw new Error('--dump=<dir> is required');
  const drivers = new Map(JSON.parse(fs.readFileSync(path.join(dump, 'drivers.json'), 'utf8')).map((d) => [d._id, d]));
  const sessions = JSON.parse(fs.readFileSync(path.join(dump, 'sessions_all.json'), 'utf8'))
    .filter((s) => s.driver && drivers.get(s.driver._id)?.project?._id === VTS_PROJECT && !s.isActive && !TEST_EMAILS.has(String(s.driver.email).toLowerCase()));
  const imported = new Set((await Trip.find({ importSourceId: /^vts:/ }).select('importSourceId').lean()).map((t) => t.importSourceId.slice(4)));
  const users = new Map((await User.find({ role: 'user' }).select('email name timezone').lean()).map((u) => [String(u.email).toLowerCase(), u]));

  // VTS km per driver-day, counting only days that still have un-imported sessions with something in them.
  const days = new Map();
  for (const s of sessions) {
    const u = users.get(String(s.driver.email).toLowerCase());
    if (!u) continue;
    const zone = u.timezone || 'Australia/Brisbane';
    const day = formatDateInZone(new Date(s.startTime), zone);
    const m = s.cleanedDistance > 0 ? s.cleanedDistance : routeLength(dump, s._id) || (s.stats?.totalDistance || 0);
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

  const batch = `vtsday-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const archivedTrips = db.collection('archivedtrips');
  const archivedPoints = db.collection('archivedlocationpoints');
  let tripsDone = 0, pointsDone = 0;
  const allIds = [];
  for (const p of plan) {
    const ids = p.trips.map((t) => t._id);
    allIds.push(...ids);
    const full = await Trip.find({ _id: { $in: ids } }).lean();
    const pts = await LocationPoint.find({ tripId: { $in: ids } }).lean();
    const meta = { batch, archivedAt: new Date(), reason: 'VTS day fuller', day: p.day, driverId: p.uid, atlasKm: p.atlas / 1000, vtsKm: p.vts / 1000, vtsSessions: p.sessions };
    if (full.length) await archivedTrips.insertMany(full.map((t) => ({ ...t, archive: meta })), { ordered: false });
    if (pts.length) await archivedPoints.insertMany(pts.map((x) => ({ ...x, archiveBatch: batch })), { ordered: false });
    await LocationPoint.deleteMany({ tripId: { $in: ids } });
    await Trip.deleteMany({ _id: { $in: ids } });
    tripsDone += full.length; pointsDone += pts.length;
  }
  const seg = await CoverageSegment.deleteMany({ firstTripId: { $in: allIds } });
  const lnk = await LinkCoverage.deleteMany({ firstTripId: { $in: allIds } });
  fs.writeFileSync(path.join(dump, `${batch}.json`), JSON.stringify({ batch, plan: plan.map((p) => ({ uid: String(p.uid), day: p.day, trips: p.trips.map((t) => String(t._id)), sessions: p.sessions })) }));
  log(`\nArchived ${tripsDone} trips and ${pointsDone} points as batch ${batch}; released ${seg.deletedCount} road segments and ${lnk.deletedCount} network links.`);
  log(`Now: node src/seed/importVtsSessions.js --dump=... --token-file=... --apply   then   node src/seed/replaceDaysWithVts.js --settle=${batch} --apply`);
  log(`Undo: node src/seed/replaceDaysWithVts.js --undo=${batch} --apply`);
}

/** After the import: the same drivers' trips around each replaced day re-claim what the archived trips held, and their UKM is refreshed. */
async function settle(batch, { db, Trip, User }) {
  const { attributeTrip } = require('../services/globalUkm');
  const { attributeTripLinks } = require('../services/linkCoverage');
  const { recomputeDriverUkm } = require('../services/roadSegments');
  const meta = await db.collection('archivedtrips').find({ 'archive.batch': batch }).project({ 'archive.driverId': 1, 'archive.day': 1 }).toArray();
  if (!meta.length) throw new Error(`No archived trips for batch ${batch}`);
  const todo = new Map();
  for (const m of meta) {
    const d0 = new Date(`${m.archive.day}T00:00:00Z`);
    const near = await Trip.find({ driverId: m.archive.driverId, status: { $in: ['completed', 'timed_out'] }, startedAt: { $gte: new Date(d0.getTime() - SETTLE_DAYS * 86400e3), $lte: new Date(d0.getTime() + (SETTLE_DAYS + 1) * 86400e3) } }).select('_id driverId').sort({ startedAt: 1 }).lean();
    for (const t of near) todo.set(String(t._id), t);
  }
  log(`${todo.size} trips to re-attribute around ${new Set(meta.map((m) => m.archive.day)).size} replaced days${APPLY ? '' : ' (dry run)'}`);
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
