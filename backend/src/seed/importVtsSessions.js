/**
 * Import driving sessions from the old VTS app (jsanvtsnew) as trips on HE Drive.
 *
 * What this is for
 * ----------------
 * Before this app, the Australian fleet recorded on VTS (project "projaustralia"). Those sessions
 * are real GPS recordings — timestamped fixes with speed and accuracy — so unlike the GIS import
 * (importCoveredRoads.js) they can go through the SAME pipeline as a phone trip: they are written
 * as completed trips with their points and `mapMatchStatus: 'pending'`, and the background worker
 * snaps them to roads and works out km, UKM and coverage exactly as it does for a live recording.
 *
 * Each trip is put through that pipeline right here, one at a time, as soon as it is written
 * (mapMatcher.processTrip — the worker's own function, which claims the trip atomically). Leaving
 * hundreds of imported trips for the worker instead would queue today's live trips behind them
 * for hours: it takes 5 per tick, in no particular order, through a shared free road server.
 * `--no-process` writes them pending and leaves them to the worker.
 *
 * Only the gaps are filled
 * ------------------------
 * A VTS session is imported only when its driver has NO trip on this platform on that day (in the
 * driver's time zone). A day this app already recorded is left alone entirely, so nothing is
 * counted twice and nothing already on a driver's record is replaced. Parked-jitter and 0 km
 * trips do not count as "data for that day".
 *
 * Drivers are matched by email, exactly. A VTS driver with no account here is created on the
 * project only with --create-missing-drivers, with a random password (nobody can sign in as them
 * until an admin sets one). Test accounts are never imported.
 *
 * Safety
 * ------
 *   - DRY RUN unless `--apply` is passed. The dry run reads both sides and writes nothing.
 *   - Every trip carries one `importBatchId` ("vts-…") and `importSourceId` ("vts:<sessionId>"),
 *     and every point a clientId "vts:<pointId>", so a re-run skips what is already in and
 *     `--revert=<importBatchId>` removes exactly this import's trips and points.
 *   - Reverting removes trips and points only. Coverage they won is recomputed by the normal
 *     backfill (src/seed/backfillLinkCoverage.js) afterwards.
 *
 * Input: a dump of the VTS API (sessions_all.json, drivers.json) in --dump, and a VTS bearer token
 * in --token-file, used read-only to fetch each session's raw points (cached to <dump>/points).
 *
 * Usage
 * -----
 *   node src/seed/importVtsSessions.js --dump=<dir> --token-file=<file>
 *   node src/seed/importVtsSessions.js --dump=<dir> --token-file=<file> --apply [--limit=1] [--only=<sessionId>]
 *   node src/seed/importVtsSessions.js --revert=<importBatchId>
 *
 * Options: --project="PRJ-025-HE-DRIVE-AUSGNZ"  --vts-project=6a3233e935b68ccdc47a9785
 *          --create-missing-drivers  --no-process
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { connectDB } = require('../config/db');
const { haversineMeters } = require('../utils/geo');
const { timezoneFromCoords } = require('../utils/tzFromCoords');
const { formatDateInZone } = require('../utils/timezone');
const { scopeForProject } = require('../services/coverageScope');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const VTS_PROJECT = String(args.get('vts-project') || '6a3233e935b68ccdc47a9785'); // "projaustralia"
const VTS_API = 'https://jsanvtsnew-production.up.railway.app/api';
const APPLY = args.get('apply') === true;
const CREATE_MISSING = args.get('create-missing-drivers') === true;
const LIMIT = args.has('limit') ? Number(args.get('limit')) : Infinity;
const ONLY = args.has('only') ? String(args.get('only')) : null;
const PROCESS = args.get('no-process') !== true;
const REVERT = args.has('revert') ? String(args.get('revert')) : null;
const DEFAULT_ZONE = 'Australia/Melbourne';
// Test logins on VTS — never real driving.
const TEST_EMAILS = new Set(['autest@vts.com', 'projaus@gmail.com']);
// A fix this inaccurate, or a step this fast, is not counted toward distance (it still goes in).
const MAX_ACCURACY_M = 50;
const MAX_STEP_KMH = 250;

const log = (...a) => console.log(...a);
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const cleanName = (n) => String(n || '').replace(/\b(SMD|HTL|HT)\s*\d+\b/gi, '').replace(/\s+/g, ' ').trim();

async function vtsGet(token, p) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(VTS_API + p, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) return r.json();
      if (r.status === 401 || r.status === 403) throw new Error(`VTS refused the token (${r.status})`);
    } catch (e) {
      if (/refused/.test(e.message)) throw e;
    }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  throw new Error(`VTS ${p} failed`);
}

/** A session's raw fixes, oldest first, cached on disk so an apply is repeatable offline. */
async function rawPoints(dump, token, id) {
  const dir = path.join(dump, 'points');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  let list;
  if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    const r = await vtsGet(token, `/locations/session/${id}?raw=true`);
    list = Array.isArray(r) ? r : r.locations || [];
    fs.writeFileSync(file, JSON.stringify(list));
  }
  return list
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && p.timestamp)
    .map((p) => ({ ...p, at: new Date(p.timestamp) }))
    .filter((p) => !Number.isNaN(p.at.getTime()))
    .sort((a, b) => a.at - b.at);
}

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

async function revert(batch) {
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  if (!/^vts-/.test(batch)) throw new Error('Only a vts-… batch can be reverted by this script');
  const ids = (await Trip.find({ importBatchId: batch }).select('_id').lean()).map((t) => t._id);
  log(`Batch ${batch}: ${ids.length} trips`);
  if (!APPLY) return log('Dry run — add --apply to delete them and their points.');
  const pts = await LocationPoint.deleteMany({ tripId: { $in: ids } });
  const trips = await Trip.deleteMany({ _id: { $in: ids } });
  log(`Deleted ${trips.deletedCount} trips, ${pts.deletedCount} points. Now rebuild coverage: node src/seed/backfillLinkCoverage.js`);
}

async function main() {
  await connectDB();
  if (REVERT) return revert(REVERT);

  const dump = args.get('dump');
  const tokenFile = args.get('token-file');
  if (!dump || !tokenFile) throw new Error('--dump=<dir> and --token-file=<file> are required');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();

  const User = require('../models/User');
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  const Project = require('../models/Project');
  const Vehicle = require('../models/Vehicle');

  const project = await Project.findOne({ name: PROJECT_NAME }).lean();
  if (!project) throw new Error(`No project named ${PROJECT_NAME}`);

  const vtsDrivers = new Map(read(dump, 'drivers.json').map((d) => [d._id, d]));
  const sessions = read(dump, 'sessions_all.json')
    .filter((s) => s.driver && vtsDrivers.get(s.driver._id)?.project?._id === VTS_PROJECT)
    .filter((s) => !ONLY || s._id === ONLY)
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  const users = await User.find({ role: 'user' }).select('name email timezone managerId projectIds').lean();
  const byEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));

  // Each driver's zone: their own, else that of their latest trip here, else Melbourne.
  const zoneCache = new Map();
  const zoneOf = async (u) => {
    if (!u) return DEFAULT_ZONE;
    if (!zoneCache.has(String(u._id))) {
      const last = await Trip.findOne({ driverId: u._id, timezone: { $ne: null } }).sort({ startedAt: -1 }).select('timezone').lean();
      zoneCache.set(String(u._id), u.timezone || last?.timezone || DEFAULT_ZONE);
    }
    return zoneCache.get(String(u._id));
  };
  // The days each driver already has real driving on here.
  const dayCache = new Map();
  const daysOf = async (u) => {
    if (!dayCache.has(String(u._id))) {
      const zone = await zoneOf(u);
      const trips = await Trip.find({ driverId: u._id, parkedJitter: { $ne: true }, distanceMeters: { $gt: 0 }, importBatchId: { $not: /^vts-/ } })
        .select('startedAt timezone').lean();
      dayCache.set(String(u._id), new Set(trips.map((t) => formatDateInZone(t.startedAt, t.timezone || zone))));
    }
    return dayCache.get(String(u._id));
  };
  const already = new Set(
    (await Trip.find({ importSourceId: { $in: sessions.map((s) => `vts:${s._id}`) } }).select('importSourceId').lean())
      .map((t) => t.importSourceId)
  );

  const stats = { sessions: sessions.length, active: 0, noPoints: 0, testAccount: 0, alreadyImported: 0, dayHasData: 0, noAccount: 0, toImport: 0 };
  const plan = [];
  const missing = new Map();
  for (const s of sessions) {
    const email = String(s.driver.email || '').toLowerCase();
    if (s.isActive) { stats.active++; continue; }
    if (!s.totalLocations) { stats.noPoints++; continue; }
    if (TEST_EMAILS.has(email)) { stats.testAccount++; continue; }
    if (already.has(`vts:${s._id}`)) { stats.alreadyImported++; continue; }
    const u = byEmail.get(email);
    if (!u) {
      stats.noAccount++;
      if (!missing.has(email)) missing.set(email, { name: cleanName(vtsDrivers.get(s.driver._id)?.name || s.driver.name), email, sessions: 0 });
      missing.get(email).sessions++;
      if (!CREATE_MISSING) continue;
      plan.push({ s, email, day: formatDateInZone(new Date(s.startTime), DEFAULT_ZONE) });
      stats.toImport++;
      continue;
    }
    const day = formatDateInZone(new Date(s.startTime), await zoneOf(u));
    if ((await daysOf(u)).has(day)) { stats.dayHasData++; continue; }
    plan.push({ s, email, day });
    stats.toImport++;
  }
  log(stats);
  if (missing.size) {
    log(`VTS drivers with no account here${CREATE_MISSING ? ' (will be created)' : ' (skipped — pass --create-missing-drivers)'}:`);
    for (const m of missing.values()) log(`  ${m.name} <${m.email}>  ${m.sessions} sessions`);
  }
  const perDriver = {};
  for (const p of plan) perDriver[p.email] = (perDriver[p.email] || 0) + 1;
  log('To import per driver:', perDriver);
  const days = plan.map((p) => p.day).sort();
  log(`Days ${days[0]} → ${days[days.length - 1]}`);

  const todo = plan.slice(0, LIMIT);
  if (!APPLY) return log(`\nDry run — nothing written. ${todo.length} sessions would be imported. Add --apply.`);

  // Missing drivers: on the project, with a password nobody knows.
  if (CREATE_MISSING) {
    for (const m of missing.values()) {
      if (!todo.some((p) => p.email === m.email)) continue;
      const u = new User({
        name: m.name, email: m.email, role: 'user', projectIds: [project._id], country: 'AU',
        passwordHash: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10),
      });
      await u.save();
      byEmail.set(m.email, u.toObject());
      log(`Created driver ${m.name} <${m.email}>`);
    }
  }

  const vehicles = new Map((await Vehicle.find({}).select('plateNumber').lean()).map((v) => [v.plateNumber, v._id]));
  const scope = await scopeForProject(project._id);
  const batch = `vts-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  log(`\nImporting ${todo.length} sessions as batch ${batch}`);

  const { processTrip } = PROCESS ? require('../services/mapMatcher') : {};
  const outcomes = { matched: 0, skipped: 0, failed: 0, byWorker: 0 };
  let trips = 0, points = 0, skipped = 0;
  for (const { s, email } of todo) {
    const u = byEmail.get(email);
    const pts = await rawPoints(dump, token, s._id);
    if (pts.length < 2) { skipped++; continue; }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const vehicleId = vehicles.get(String(s.licensePlate || '').trim().toUpperCase()) || null;
    const trip = await Trip.create({
      importBatchId: batch,
      importSourceId: `vts:${s._id}`,
      driverId: u._id,
      managerId: u.managerId || null,
      vehicleId,
      projectId: project._id,
      ...scope,
      status: 'completed',
      startedAt: first.at,
      endedAt: s.endTime && new Date(s.endTime) > last.at ? new Date(s.endTime) : last.at,
      startLocation: { lat: first.latitude, lon: first.longitude },
      endLocation: { lat: last.latitude, lon: last.longitude },
      lastLocation: { lat: last.latitude, lon: last.longitude, speed: last.speed || 0, heading: last.heading ?? null, recordedAt: last.at },
      timezone: timezoneFromCoords(first.latitude, first.longitude) || (await zoneOf(u)),
      distanceMeters: distanceOf(pts),
      maxSpeedKmh: Math.round(Math.max(0, ...pts.map((p) => (p.speed > 0 && p.speed < MAX_STEP_KMH ? p.speed : 0)))),
      pointCount: pts.length,
      mapMatchStatus: 'pending',
      ukmStatus: 'pending',
      linkCoverageStatus: 'pending',
    });
    const now = new Date();
    for (let i = 0; i < pts.length; i += 5000) {
      const docs = pts.slice(i, i + 5000).map((p) => ({
        clientId: `vts:${p._id}`,
        tripId: trip._id,
        driverId: u._id,
        vehicleId,
        lat: p.latitude,
        lon: p.longitude,
        speedKmh: p.speed > 0 ? p.speed : 0,
        heading: p.heading ?? null,
        accuracy: p.accuracy ?? null,
        altitude: p.altitude ?? null,
        isMoving: (p.speed || 0) > 2,
        recordedAt: p.at,
        receivedAt: now,
      }));
      try {
        await LocationPoint.insertMany(docs, { ordered: false });
        points += docs.length;
      } catch (e) {
        // A duplicate clientId is a point already in (a re-run); anything else is real.
        if (e.code !== 11000 && !e.writeErrors?.every((w) => w.code === 11000)) throw e;
        points += e.insertedDocs?.length ?? 0;
      }
    }
    trips++;
    if (PROCESS) outcomes[(await processTrip(trip._id)) || 'byWorker']++;
    if (trips % 10 === 0) log(`  ${trips}/${todo.length} trips, ${points} points${PROCESS ? ` ${JSON.stringify(outcomes)}` : ''}`);
  }
  log(`\nDone: ${trips} trips, ${points} points, ${skipped} skipped (under 2 fixes). Batch ${batch}.`);
  log(PROCESS
    ? `Processed: ${JSON.stringify(outcomes)} (byWorker = the worker claimed it first; it finishes it the same way).`
    : 'Left pending: the map-match worker picks them up — route, km, UKM and coverage follow on their own.');
  log(`Undo: node src/seed/importVtsSessions.js --revert=${batch} --apply`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
