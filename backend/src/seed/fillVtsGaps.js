/**
 * Import the stretches of VTS driving that Atlas has no trip for — and only those.
 *
 * importVtsSessions.js fills whole DAYS: a VTS session is skipped when its driver has any trip in
 * Atlas that day, because most drivers ran both apps at once. But some days they did not, for part
 * of the day — the Atlas app signed in at 14:24 while VTS had been recording since 07:00 — and that
 * driving never reached Atlas (2026-11-02 audit: ~975 km over 7 drivers, Yann 151.7 km).
 *
 * This takes every VTS session not yet in Atlas, drops each fix recorded while ANY trip of that
 * driver was running in Atlas (± MARGIN), and cuts what is left into stretches at gaps over
 * BREAK_MIN. A stretch of at least MIN_FIXES fixes and MIN_KM becomes a trip of its own: raw GPS
 * only, `mapMatchStatus: 'pending'`, put through the map-matcher here (processTrip) so km, snapped
 * route, UKM and coverage are made the normal way. Nothing recorded while an Atlas trip ran is
 * imported, so no kilometre is counted twice.
 *
 * Read-only on VTS (VTS_MONGODB_URI). DRY RUN unless --apply. Every trip carries importBatchId
 * "vts-gap-…" and importSourceId "vts:<session>@<first fix>"; every point clientId "vts:<fix>", so
 * a re-run skips what is in. Undo: node src/seed/importVtsSessions.js --revert=<vts-gap-…> --apply
 *
 * Usage: VTS_MONGODB_URI=… node src/seed/fillVtsGaps.js [--apply] [--driver=<email>] [--no-process]
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');
const { haversineMeters } = require('../utils/geo');
const { timezoneFromCoords } = require('../utils/tzFromCoords');
const { scopeForProject } = require('../services/coverageScope');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const PROCESS = args.get('no-process') !== true;
const ONLY = args.has('driver') ? String(args.get('driver')).toLowerCase() : null;
const EXCLUDE = new Set(String(args.get('exclude') || '').toLowerCase().split(',').filter(Boolean));
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const VTS_PROJECT = String(args.get('vts-project') || '6a3233e935b68ccdc47a9785'); // projaustralia
const TEST_EMAILS = new Set(['autest@vts.com', 'projaus@gmail.com']);
const MARGIN_MS = 3 * 60 * 1000;
const BREAK_MIN = 10;
const MIN_FIXES = 30;
const MIN_KM = 1;
const MAX_ACCURACY_M = 50;
const MAX_STEP_KMH = 250;
const inAustralia = (p) => p.latitude < -9 && p.latitude > -44.5 && p.longitude > 112 && p.longitude < 154.5;
const log = (...a) => console.log(...a); // eslint-disable-line no-console

function distanceOf(points) {
  let meters = 0;
  let prev = null;
  for (const p of points) {
    if (p.accuracy != null && p.accuracy > MAX_ACCURACY_M) continue;
    const cur = { lat: p.latitude, lon: p.longitude, at: p.at };
    if (prev) {
      const d = haversineMeters(prev, cur);
      const hours = (cur.at - prev.at) / 3600000;
      if (!(hours > 0 && d / 1000 / hours > MAX_STEP_KMH)) meters += d;
    }
    prev = cur;
  }
  return Math.round(meters);
}

async function main() {
  if (!process.env.VTS_MONGODB_URI) throw new Error('VTS_MONGODB_URI is required (the VTS database, read-only)');
  await connectDB();
  const { MongoClient, ObjectId } = require('mongoose').mongo;
  const Project = require('../models/Project');
  const User = require('../models/User');
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  const { processTrip } = require('../services/mapMatcher');
  const { recomputeDriverUkm } = require('../services/roadSegments');

  const client = new MongoClient(process.env.VTS_MONGODB_URI, { readPreference: 'secondaryPreferred' });
  await client.connect();
  const vts = client.db();
  const project = await Project.findOne({ name: PROJECT_NAME }).lean();
  const scope = await scopeForProject(project._id);
  const vUsers = await vts.collection('users').find({ project: new ObjectId(VTS_PROJECT) }).project({ name: 1, email: 1 }).toArray();
  const imported = new Set((await Trip.distinct('importSourceId', { importSourceId: /^vts:/ })).map((x) => x.slice(4).split('@')[0]));
  const batch = `vts-gap-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  const plan = [];

  for (const vu of vUsers) {
    const email = String(vu.email || '').toLowerCase();
    if (TEST_EMAILS.has(email) || (ONLY && email !== ONLY) || EXCLUDE.has(email)) continue;
    const u = await User.findOne({ email, role: 'user' }).select('_id name managerId timezone').lean();
    if (!u) continue;
    const sessions = await vts.collection('sessions').find({ driver: vu._id, isActive: { $ne: true } }).project({ startTime: 1, licensePlate: 1 }).toArray();
    const todo = sessions.filter((s) => !imported.has(String(s._id)));
    if (!todo.length) continue;
    // Every trip of the driver in Atlas, whatever its source: while one ran, the driving is in.
    const windows = (await Trip.find({ driverId: u._id, parkedJitter: { $ne: true } }).select('startedAt endedAt lastLocation').lean())
      .map((t) => [t.startedAt.getTime() - MARGIN_MS, (t.endedAt || t.lastLocation?.recordedAt || t.startedAt).getTime() + MARGIN_MS]);
    const covered = (ms) => windows.some(([a, b]) => ms >= a && ms <= b);
    for (const s of todo) {
      const pts = (await vts.collection('locationpoints').find({ session: s._id })
        .project({ latitude: 1, longitude: 1, speed: 1, accuracy: 1, heading: 1, altitude: 1, timestamp: 1 }).sort({ timestamp: 1 }).toArray())
        .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && p.timestamp && inAustralia(p))
        .map((p) => ({ ...p, at: new Date(p.timestamp) }));
      let run = [];
      const flush = () => {
        if (run.length >= MIN_FIXES && distanceOf(run) >= MIN_KM * 1000) plan.push({ u, s, pts: run });
        run = [];
      };
      for (const p of pts) {
        if (covered(p.at.getTime())) { flush(); continue; }
        if (run.length && p.at - run[run.length - 1].at > BREAK_MIN * 60000) flush();
        run.push(p);
      }
      flush();
    }
  }

  const byDriver = {};
  for (const x of plan) {
    const k = x.u.name;
    byDriver[k] = byDriver[k] || { stretches: 0, km: 0 };
    byDriver[k].stretches++;
    byDriver[k].km += distanceOf(x.pts) / 1000;
  }
  log(`Stretches of VTS driving with no Atlas trip running: ${plan.length}, ${(plan.reduce((sum, x) => sum + distanceOf(x.pts), 0) / 1000).toFixed(1)} km`);
  for (const [k, v] of Object.entries(byDriver).sort((a, b) => b[1].km - a[1].km)) log(`  ${k.padEnd(32)} ${String(v.stretches).padStart(3)} stretches ${v.km.toFixed(1).padStart(8)} km`);
  if (!APPLY) { await client.close(); return log('\nDry run — nothing written. Add --apply.'); }

  log(`\nImporting as batch ${batch}`);
  const outcomes = {};
  const touched = new Set();
  let n = 0;
  for (const { u, s, pts } of plan) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    const trip = await Trip.create({
      importBatchId: batch,
      importSourceId: `vts:${s._id}@${first._id}`,
      driverId: u._id,
      managerId: u.managerId || null,
      projectId: project._id,
      ...scope,
      status: 'completed',
      startedAt: first.at,
      endedAt: last.at,
      startLocation: { lat: first.latitude, lon: first.longitude },
      endLocation: { lat: last.latitude, lon: last.longitude },
      lastLocation: { lat: last.latitude, lon: last.longitude, speed: last.speed || 0, heading: last.heading ?? null, recordedAt: last.at },
      timezone: timezoneFromCoords(first.latitude, first.longitude) || u.timezone || 'Australia/Melbourne',
      distanceMeters: distanceOf(pts),
      maxSpeedKmh: Math.round(Math.max(0, ...pts.map((p) => (p.speed > 0 && p.speed < MAX_STEP_KMH ? p.speed : 0)))),
      pointCount: pts.length,
      mapMatchStatus: 'matching',
      ukmStatus: 'pending',
      linkCoverageStatus: 'pending',
    });
    const now = new Date();
    for (let i = 0; i < pts.length; i += 5000) {
      await LocationPoint.insertMany(pts.slice(i, i + 5000).map((p) => ({
        clientId: `vts:${p._id}`, tripId: trip._id, driverId: u._id, vehicleId: null,
        lat: p.latitude, lon: p.longitude, speedKmh: p.speed > 0 ? p.speed : 0, heading: p.heading ?? null,
        accuracy: p.accuracy ?? null, altitude: p.altitude ?? null, isMoving: (p.speed || 0) > 2,
        recordedAt: p.at, receivedAt: now,
      })), { ordered: false });
    }
    await Trip.updateOne({ _id: trip._id }, { $set: { mapMatchStatus: 'pending' } });
    touched.add(String(u._id));
    if (PROCESS) {
      const o = (await processTrip(trip._id).catch((e) => { log(`  trip ${trip._id}: ${e.message}`); return 'failed'; })) || 'byWorker';
      outcomes[o] = (outcomes[o] || 0) + 1;
    }
    n++;
    if (n % 10 === 0) log(`  ${n}/${plan.length} ${JSON.stringify(outcomes)}`);
  }
  for (const d of touched) await recomputeDriverUkm(d).catch((e) => log(`driver UKM ${d}: ${e.message}`));
  log(`Done: ${n} trips ${JSON.stringify(outcomes)}. Batch ${batch}.`);
  log(`Undo: node src/seed/importVtsSessions.js --revert=${batch} --apply`);
  await client.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e); process.exit(1); }); // eslint-disable-line no-console
