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
 * Input, one of:
 *   --from-db   the VTS database itself (VTS_MONGODB_URI, read-only): drivers and sessions from
 *               `users`/`sessions`, raw fixes from `locationpoints`, VTS's cleaned route from the
 *               session's `cleanedRoute`. Both come in when VTS has both; a session whose raw fixes
 *               VTS no longer holds comes in on its cleaned route alone. --dump is then only a cache.
 *   --dump      a dump of the VTS API (sessions_all.json, drivers.json) plus a VTS bearer token in
 *               --token-file, used read-only to fetch each session's raw points and cleaned route.
 *
 * Usage
 * -----
 *   VTS_MONGODB_URI=… node src/seed/importVtsSessions.js --from-db [--apply] [--create-missing-drivers]
 *   node src/seed/importVtsSessions.js --dump=<dir> --token-file=<file>
 *   node src/seed/importVtsSessions.js --dump=<dir> --token-file=<file> --apply [--limit=1] [--only=<sessionId>]
 *   node src/seed/importVtsSessions.js --revert=<importBatchId>
 *
 * Options: --project="PRJ-025-HE-DRIVE-AUSGNZ"  --vts-project=6a3233e935b68ccdc47a9785
 *          --create-missing-drivers  --no-process  --concurrency=4
 *          --region=au|sg   where the drive is: the fix filter, the fallback time zone and a created
 *                           driver's country (au, the default: projaustralia; sg: VTS "Singapore",
 *                           --vts-project=6a2a9d42fb182e3c95de52e0)
 *          --sessions-file=<csv>   only the session ids in this file (a VTS export's sessions-index.csv,
 *                           its "Session id" column)
 */
const fs = require('fs');
const os = require('os');
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
// Route source: VTS's own cleaned route (default), or --snap to road-match through Valhalla here.
const SNAP = args.get('snap') === true;
const CONCURRENCY = Math.max(1, Math.min(8, Number(args.get('concurrency')) || 1));
const REVERT = args.has('revert') ? String(args.get('revert')) : null;
const REPAIR_POINTS = args.has('repair-points') ? String(args.get('repair-points')) : null;
const FROM_DB = args.get('from-db') === true;
// With --from-db, the open read-only connection to the VTS database (see loadFromVtsDb).
let vtsDb = null;
// Where the project's driving is. A fix outside the region's box is not part of the drive (see below).
const REGIONS = {
  au: { label: 'Australia', zone: 'Australia/Melbourne', country: 'Australia', inside: (p) => p.latitude < -9 && p.latitude > -44.5 && p.longitude > 112 && p.longitude < 154.5 },
  sg: { label: 'Singapore', zone: 'Asia/Singapore', country: 'Singapore', inside: (p) => p.latitude > 1.1 && p.latitude < 1.55 && p.longitude > 103.5 && p.longitude < 104.15 },
};
const REGION = REGIONS[String(args.get('region') || 'au').toLowerCase()];
if (!REGION) throw new Error(`--region must be one of ${Object.keys(REGIONS).join(', ')}`);
const DEFAULT_ZONE = REGION.zone;
const SESSIONS_FILE = args.has('sessions-file') ? String(args.get('sessions-file')) : null;
// Test logins on VTS — never real driving.
const TEST_EMAILS = new Set(['autest@vts.com', 'projaus@gmail.com']);
// A fix this inaccurate, or a step this fast, is not counted toward distance (it still goes in).
const MAX_ACCURACY_M = 50;
const MAX_STEP_KMH = 250;
// Some VTS sessions carry fixes from a second phone in Hyderabad recording under the same session
// (a whole session, or a few hundred fixes mid-drive). Snapped together with the real drive they
// made a 28,000 km "route" and claimed roads in India. A fix outside the --region (Australia by
// default) is not part of the drive and is dropped; a session with nothing left is skipped.
const inAustralia = (p) => REGION.inside(p);

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
  // A list cached before the fix below has no point ids; with the database at hand, fetch it again.
  if (list && vtsDb && list.length && !list[0]._id) list = null;
  if (list) {
    // cached
  } else if (vtsDb) {
    // _id kept: it is each point's clientId here ("vts:<id>"). Projected away, every point came out
    // "vts:undefined" — the unique index then refused all but the first, and the duplicate-tolerant
    // insert below swallowed it: --from-db imports stored no raw GPS (fixed 2026-10-29).
    list = await vtsDb.collection('locationpoints')
      .find({ session: new vtsDb.ObjectId(String(id)) }, { projection: { latitude: 1, longitude: 1, speed: 1, accuracy: 1, heading: 1, timestamp: 1 } })
      .sort({ timestamp: 1 })
      .toArray();
    fs.writeFileSync(file, JSON.stringify(list));
  } else {
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

/**
 * VTS's own cleaned route for a session: `/locations/session/:id` without `raw` is the road-snapped
 * trace VTS made (its length is the session's `cleanedDistance`). Used as the trip's route, so the
 * import needs no road-matching of its own. Cut wherever it jumps more than ROUTE_GAP_M in one step —
 * across a recording gap the trace is a straight line, and a straight line must not be drawn or
 * credited as road.
 */
const ROUTE_GAP_M = 3000;
async function cleanedRoute(dump, token, id) {
  const dir = path.join(dump, 'clean');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  let list;
  if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8'));
  else if (vtsDb) {
    const doc = await vtsDb.collection('sessions').findOne({ _id: new vtsDb.ObjectId(String(id)) }, { projection: { cleanedRoute: 1 } });
    list = (doc && doc.cleanedRoute) || [];
    fs.writeFileSync(file, JSON.stringify(list));
  } else {
    const r = await vtsGet(token, `/locations/session/${id}`);
    list = Array.isArray(r) ? r : r.locations || [];
    fs.writeFileSync(file, JSON.stringify(list));
  }
  const pts = list
    .filter((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && inAustralia(p))
    .map((p) => ({ lat: p.latitude, lon: p.longitude }));
  const runs = [];
  let run = [];
  let meters = 0;
  for (const p of pts) {
    const prev = run[run.length - 1];
    const d = prev ? haversineMeters(prev, p) : 0;
    if (prev && d > ROUTE_GAP_M) { runs.push(run); run = []; }
    else meters += d;
    run.push(p);
  }
  runs.push(run);
  const kept = runs.filter((r) => r.length >= 2);
  return { runs: kept, meters: Math.round(meters), count: kept.reduce((n, r) => n + r.length, 0) };
}

/** A VTS cleaned route already fetched to <dump>/clean/<id>.json with at least two points. */
function hasCachedRoute(dump, id) {
  try {
    const f = path.join(dump, 'clean', `${id}.json`);
    return fs.existsSync(f) && fs.statSync(f).size > 60;
  } catch { return false; }
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

/**
 * --from-db: drivers and sessions read from the VTS database, shaped as the API dump is, so
 * everything after this point is the same code path. Read-only: queries only.
 */
async function loadFromVtsDb() {
  if (!process.env.VTS_MONGODB_URI) throw new Error('--from-db needs VTS_MONGODB_URI (the VTS database, read-only)');
  const { MongoClient, ObjectId } = require('mongoose').mongo;
  const client = new MongoClient(process.env.VTS_MONGODB_URI, { readPreference: 'secondaryPreferred' });
  await client.connect();
  vtsDb = client.db();
  vtsDb.ObjectId = ObjectId;
  vtsDb.client = client;
  const users = await vtsDb.collection('users').find({}, { projection: { name: 1, email: 1, project: 1 } }).toArray();
  const drivers = users.map((u) => ({ _id: String(u._id), name: u.name, email: u.email, project: u.project ? { _id: String(u.project) } : null }));
  const byId = new Map(drivers.map((d) => [d._id, d]));
  const docs = await vtsDb.collection('sessions').aggregate([
    { $match: { driver: { $in: users.filter((u) => String(u.project) === VTS_PROJECT).map((u) => u._id) } } },
    { $project: {
      driver: 1, startTime: 1, endTime: 1, isActive: 1, lastHeartbeat: 1, totalLocations: 1, cleanedDistance: 1, licensePlate: 1,
      cleanedRouteCount: { $size: { $ifNull: ['$cleanedRoute', []] } },
    } },
  ]).toArray();
  const sessions = docs.map((d) => {
    const drv = byId.get(String(d.driver)) || { _id: String(d.driver) };
    return {
      ...d,
      _id: String(d._id),
      driver: { _id: drv._id, name: drv.name, email: drv.email },
      startTime: d.startTime && new Date(d.startTime).toISOString(),
      endTime: d.endTime ? new Date(d.endTime).toISOString() : null,
      lastHeartbeat: d.lastHeartbeat ? new Date(d.lastHeartbeat).toISOString() : null,
    };
  });
  log(`VTS database: ${drivers.length} users, ${sessions.length} sessions of VTS project ${VTS_PROJECT} (${REGION.label})`);
  return { drivers, sessions };
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

/**
 * --repair-points=<batch>[,<batch>] (with --from-db): store the raw GPS an earlier --from-db import
 * left out (see rawPoints). Only LocationPoints are written — each trip's km, route, UKM and
 * coverage were worked out from the fixes in memory and are right as they are. A trip that already
 * holds its points is left alone; the stray "vts:undefined" point is replaced by the real ones.
 */
async function repairPoints(batches) {
  if (!vtsDb) throw new Error('--repair-points needs --from-db');
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  const dump = String(args.get('dump') || path.join(os.tmpdir(), 'vts-sync-cache'));
  let fixed = 0; let added = 0; let left = 0;
  for (const batch of batches) {
    if (!/^vts-/.test(batch)) throw new Error(`${batch} is not a vts-… batch`);
    const trips = await Trip.find({ importBatchId: batch }).select('importSourceId driverId vehicleId pointCount').lean();
    for (const t of trips) {
      const have = await LocationPoint.countDocuments({ tripId: t._id, clientId: { $ne: 'vts:undefined' } });
      if (have >= (t.pointCount || 0)) { left++; continue; }
      const pts = (await rawPoints(dump, null, String(t.importSourceId).replace(/^vts:/, ''))).filter(inAustralia);
      if (pts.some((p) => !p._id)) throw new Error(`trip ${t._id}: VTS points without ids`);
      log(`${batch} trip ${t._id}: ${have} of ${t.pointCount} points stored, ${pts.length} in VTS${APPLY ? '' : ' (dry run)'}`);
      if (!APPLY) continue;
      await LocationPoint.deleteMany({ tripId: t._id, clientId: 'vts:undefined' });
      const now = new Date();
      for (let i = 0; i < pts.length; i += 5000) {
        const docs = pts.slice(i, i + 5000).map((p) => ({
          clientId: `vts:${p._id}`, tripId: t._id, driverId: t.driverId, vehicleId: t.vehicleId || null,
          lat: p.latitude, lon: p.longitude, speedKmh: p.speed > 0 ? p.speed : 0, heading: p.heading ?? null,
          accuracy: p.accuracy ?? null, altitude: p.altitude ?? null, isMoving: (p.speed || 0) > 2,
          recordedAt: p.at, receivedAt: now,
        }));
        try {
          await LocationPoint.insertMany(docs, { ordered: false });
          added += docs.length;
        } catch (e) {
          if (e.code !== 11000 && !e.writeErrors?.every((w) => w.code === 11000)) throw e;
          added += e.insertedDocs?.length ?? 0;
        }
      }
      fixed++;
    }
  }
  log(`Repair: ${fixed} trip(s) given their raw GPS (${added} points)${APPLY ? '' : ' — dry run, add --apply'}, ${left} already complete.`);
}

async function main() {
  await connectDB();
  if (REVERT) return revert(REVERT);

  // --from-db reads VTS directly; the dump dir is then only a cache of fetched fixes and routes.
  const dump = FROM_DB ? String(args.get('dump') || path.join(os.tmpdir(), 'vts-sync-cache')) : args.get('dump');
  const tokenFile = args.get('token-file');
  if (!FROM_DB && (!dump || !tokenFile)) throw new Error('--dump=<dir> and --token-file=<file> are required (or --from-db)');
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : null;
  const fromDb = FROM_DB ? await loadFromVtsDb() : null;
  if (REPAIR_POINTS) return repairPoints(REPAIR_POINTS.split(','));

  const User = require('../models/User');
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');
  const Project = require('../models/Project');
  const Vehicle = require('../models/Vehicle');

  const project = await Project.findOne({ name: PROJECT_NAME }).lean();
  if (!project) throw new Error(`No project named ${PROJECT_NAME}`);

  const vtsDrivers = new Map((fromDb ? fromDb.drivers : read(dump, 'drivers.json')).map((d) => [d._id, d]));
  // --sessions-file: just the sessions a VTS export lists (its "Session id" column).
  let listed = null;
  if (SESSIONS_FILE) {
    const rows = fs.readFileSync(SESSIONS_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    const col = rows[0].split(',').findIndex((h) => /^session id$/i.test(h.trim()));
    if (col < 0) throw new Error(`${SESSIONS_FILE} has no "Session id" column`);
    listed = new Set(rows.slice(1).map((r) => r.split(',')[col].trim()).filter((id) => /^[0-9a-f]{24}$/i.test(id)));
    log(`${listed.size} sessions listed in ${path.basename(SESSIONS_FILE)}`);
  }
  const sessions = (fromDb ? fromDb.sessions : read(dump, 'sessions_all.json'))
    .filter((s) => s.driver && vtsDrivers.get(s.driver._id)?.project?._id === VTS_PROJECT)
    .filter((s) => !ONLY || s._id === ONLY)
    .filter((s) => !listed || listed.has(s._id))
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  const users = await User.find({ role: 'user' }).select('name email timezone managerId projectIds').lean();
  const byEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));

  // Each driver's zone: their own, else that of their latest trip here, else the region's.
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
    // VTS's counters are zero on some sessions that still carry a cleaned route (190 of 196 on
    // projaustralia, Apr–Sep 2026): the planning stage used to drop them here, before the route-only
    // path could see them, and 21,000 km went missing. A session with a cached VTS route is kept.
    if (!s.totalLocations && !(s.cleanedDistance > 0) && !(s.cleanedRouteCount >= 2) && !hasCachedRoute(dump, s._id)) { stats.noPoints++; continue; }
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
        name: m.name, email: m.email, role: 'user', projectIds: [project._id], country: REGION.country,
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
  const { attributeTrip } = require('../services/globalUkm');
  const { attributeTripLinks } = require('../services/linkCoverage');
  const { recomputeDriverUkm } = require('../services/roadSegments');
  const { featuresFromPoints, verdictFields } = require('../services/tripNoise');
  const { encodePolyline6 } = require('../services/valhalla');
  const env = require('../config/env');
  const outcomes = { matched: 0, skipped: 0, failed: 0, byWorker: 0, leftForWorker: 0 };
  const touchedDrivers = new Set();

  /**
   * What the map-matcher does with a trip, minus the matching: VTS's route stands in for Valhalla's.
   * Same parked-jitter verdict from the raw fixes, same three attributions, same order.
   */
  const settleWithVtsRoute = async (trip, raw, route) => {
    const verdict = verdictFields(featuresFromPoints(raw.map((p) => ({ lat: p.latitude, lon: p.longitude, recordedAt: p.at, accuracy: p.accuracy }))));
    if (verdict && verdict.parkedJitter) {
      await Trip.updateOne({ _id: trip._id }, { $set: { ...verdict, mapMatchStatus: 'skipped', ukmStatus: 'skipped', linkCoverageStatus: 'skipped' } });
      return 'skipped';
    }
    await Trip.updateOne({ _id: trip._id }, {
      $set: {
        ...(verdict || {}),
        cleanedRouteShapes: route.runs.map((r) => encodePolyline6(r)),
        cleanedDistanceMeters: route.meters,
        cleanedPointCount: route.count,
        cleanedMatchedRatio: 1, // snapped by VTS
        mapMatchStatus: 'matched',
        mapMatchedAt: new Date(),
        mapMatchError: null,
      },
    });
    touchedDrivers.add(String(trip.driverId));
    try {
      await attributeTrip(trip._id);
    } catch (e) { console.error(`global UKM failed for ${trip._id}: ${e.message}`); }
    if (env.LINK_COVERAGE_ENABLED) {
      try {
        await attributeTripLinks(trip._id);
      } catch (e) { console.error(`link coverage failed for ${trip._id}: ${e.message}`); }
    }
    return 'matched';
  };
  let trips = 0, points = 0, skipped = 0, abroad = 0, routeOnlyCount = 0;
  const errors = [];
  const partial = new Map();
  // Several sessions at once: the database work overlaps, while road-matching requests still go
  // out one at a time, spaced as the shared server is owed (valhalla.js politeDelay).
  const importOne = async ({ s, email }) => {
    const u = byEmail.get(email);
    const all = await rawPoints(dump, token, s._id);
    const pts = all.filter(inAustralia);
    abroad += all.length - pts.length;
    const route = PROCESS && !SNAP ? await cleanedRoute(dump, token, s._id) : null;
    // VTS no longer holds raw fixes for its older sessions (30 Jun – 25 Aug 2026 came back empty)
    // but still has their cleaned route. Such a session comes in on the route alone: times from the
    // session, km and route from VTS, no LocationPoints — there is no raw GPS left to store.
    const routeOnly = pts.length < 2 && route && route.count >= 2;
    if (pts.length < 2 && !routeOnly) { skipped++; return; }
    if (routeOnly) routeOnlyCount++;
    const ends = routeOnly ? [route.runs[0][0], route.runs[route.runs.length - 1].slice(-1)[0]] : null;
    const first = routeOnly
      ? { latitude: ends[0].lat, longitude: ends[0].lon, at: new Date(s.startTime), speed: 0 }
      : pts[0];
    const last = routeOnly
      ? { latitude: ends[1].lat, longitude: ends[1].lon, at: new Date(s.endTime || s.lastHeartbeat || s.startTime), speed: 0 }
      : pts[pts.length - 1];
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
      // VTS kept only part of some sessions' raw fixes; measured from what is left the drive comes out
      // short, so VTS's own figure stands in when under 90% of the recorded fixes remain.
      distanceMeters: routeOnly
        ? Math.round(s.stats?.totalDistance || route.meters)
        : pts.length < 0.9 * (s.totalLocations || 0)
          ? Math.max(distanceOf(pts), Math.round(s.stats?.totalDistance || 0))
          : distanceOf(pts),
      maxSpeedKmh: routeOnly
        ? Math.round(Math.min(MAX_STEP_KMH, s.stats?.maxSpeed || 0))
        : Math.round(Math.max(0, ...pts.map((p) => (p.speed > 0 && p.speed < MAX_STEP_KMH ? p.speed : 0)))),
      pointCount: pts.length,
      // Written as already claimed, and released to 'pending' only once every point is in: the
      // worker polls for pending trips, and one that caught a trip with no points yet marked it
      // skipped for having fewer than 2 fixes.
      mapMatchStatus: 'matching',
      ukmStatus: 'pending',
      linkCoverageStatus: 'pending',
    });
    // Remembered until the session is fully in: a failure part-way (a dropped connection) removes
    // the half-written trip again, so a re-run redoes the session instead of skipping it as done.
    partial.set(s._id, trip._id);
    const now = new Date();
    if (pts.some((p) => !p._id)) throw new Error(`session ${s._id}: a VTS point without an id — refusing to write "vts:undefined"`);
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
    if (route && route.count >= 2) {
      trips++;
      outcomes[await settleWithVtsRoute(trip, pts, route)]++;
      if (trips % 10 === 0) log(`  ${trips}/${todo.length} trips, ${points} points ${JSON.stringify(outcomes)}`);
      return;
    }
    // No VTS route (or --snap / --no-process): pending, for road-matching.
    await Trip.updateOne({ _id: trip._id }, { $set: { mapMatchStatus: 'pending' } });
    if (route) { trips++; outcomes.leftForWorker++; return; }
    trips++;
    if (PROCESS) outcomes[(await processTrip(trip._id)) || 'byWorker']++;
    if (trips % 10 === 0) log(`  ${trips}/${todo.length} trips, ${points} points${PROCESS ? ` ${JSON.stringify(outcomes)}` : ''}`);
  };
  const queue = todo.slice();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift();
      // One session failing (a dropped connection to Atlas) must not take the other hundreds with
      // it. A re-run picks up whatever did not make it in.
      try {
        await importOne(item);
        partial.delete(item.s._id);
      } catch (e) {
        errors.push(item.s._id);
        console.error(`session ${item.s._id} failed: ${e.message}`);
        const tripId = partial.get(item.s._id);
        if (tripId) {
          try {
            await LocationPoint.deleteMany({ tripId });
            await Trip.deleteOne({ _id: tripId });
            partial.delete(item.s._id);
          } catch (e2) {
            console.error(`  could not remove the half-written trip ${tripId}: ${e2.message} — remove it before re-running`);
          }
        }
      }
    }
  }));
  if (errors.length) log(`\n${errors.length} sessions failed and were left out — re-run to retry them: ${errors.join(', ')}`);
  // The per-driver figure the matcher recomputes after each trip: once per driver is enough here.
  for (const d of touchedDrivers) {
    try { await recomputeDriverUkm(d); } catch (e) { console.error(`driver UKM failed for ${d}: ${e.message}`); }
  }
  log(`\nDone: ${trips} trips (${routeOnlyCount} on VTS's route alone, no raw GPS left on VTS), ${points} points, ${skipped} skipped (under 2 fixes in ${REGION.label}), ${abroad} fixes outside ${REGION.label} dropped. Batch ${batch}.`);
  log(PROCESS
    ? `Processed: ${JSON.stringify(outcomes)} (byWorker = the worker claimed it first; it finishes it the same way).`
    : 'Left pending: the map-match worker picks them up — route, km, UKM and coverage follow on their own.');
  log(`Undo: node src/seed/importVtsSessions.js --revert=${batch} --apply`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
