// src/seed/importVtsSessions.js — VTS sessions in as HE Drive trips, only on days we have nothing.
//
// A session goes in only when its driver has no real trip here that day; active, point-less and
// test-account sessions never do; drivers match by email, missing ones are created only when asked;
// the trip lands as a pending completed trip with its points, so the normal pipeline takes it from
// there; a re-run adds nothing; --revert removes exactly the batch.
//
// No network: the dump and each session's points are files, which the script reads from its cache.
//
// Run: node test/importVts.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri('import_vts_test');
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = 'import_vts_test_secret_1234567890';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const LocationPoint = require('../src/models/LocationPoint');
  const Project = require('../src/models/Project');
  const Vehicle = require('../src/models/Vehicle');

  const he = await Project.create({ name: 'PRJ-025-HE-DRIVE-AUSGNZ' });
  const abbas = await User.create({ name: 'Abbas Ali', email: 'abbas@x.com', role: 'user', projectIds: [he._id], passwordHash: 'x', timezone: 'Australia/Melbourne' });
  const joel = await User.create({ name: 'Joel Howells', email: 'joel@x.com', role: 'user', projectIds: [he._id], passwordHash: 'x', timezone: 'Australia/Melbourne' });
  await Vehicle.create({ plateNumber: 'ABC123' });
  // Joel already drove here on 5 Sep (Melbourne) — that day is his, VTS stays out of it.
  await Trip.create({ driverId: joel._id, status: 'completed', startedAt: new Date('2026-09-04T23:00:00Z'), endedAt: new Date('2026-09-05T02:00:00Z'), distanceMeters: 40000, timezone: 'Australia/Melbourne' });
  // …but a parked-jitter session on 6 Sep is not driving, so VTS may fill 6 Sep.
  await Trip.create({ driverId: joel._id, status: 'completed', startedAt: new Date('2026-09-05T23:00:00Z'), distanceMeters: 300, parkedJitter: true, timezone: 'Australia/Melbourne' });

  const AU = '6a3233e935b68ccdc47a9785';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vts-'));
  fs.mkdirSync(path.join(dir, 'points'));
  const drv = (id, name, email, project = AU) => ({ _id: id, name, email, project: project && { _id: project } });
  fs.writeFileSync(path.join(dir, 'drivers.json'), JSON.stringify([
    drv('d1', 'Abbas Ali SMD007', 'Abbas@x.com'),
    drv('d2', 'Joel Howells HT480', 'joel@x.com'),
    drv('d3', 'Robert Falelua SMD020', 'robert@x.com'),
    drv('d4', 'Australia Test Driver', 'autest@vts.com'),
    drv('d5', 'Someone Else', 'else@x.com', 'other-project'),
  ]));
  const ses = (id, d, start, o = {}) => ({ _id: id, driver: { _id: d, name: 'n', email: { d1: 'Abbas@x.com', d2: 'joel@x.com', d3: 'robert@x.com', d4: 'autest@vts.com', d5: 'else@x.com' }[d] }, startTime: start, endTime: o.endTime ?? null, isActive: false, totalLocations: 3, licensePlate: '', ...o });
  const sessions = [
    ses('s1', 'd1', '2026-09-01T22:00:00Z', { licensePlate: 'abc123' }), // Abbas, nothing here that day → in, with the car
    ses('s2', 'd2', '2026-09-04T22:30:00Z'), // Joel, 5 Sep Melbourne: day has data → out
    ses('s3', 'd2', '2026-09-05T22:30:00Z'), // Joel, 6 Sep: only jitter here → in
    ses('s4', 'd3', '2026-09-02T22:00:00Z'), // Robert, no account → only with --create-missing-drivers
    ses('s5', 'd4', '2026-09-02T22:00:00Z'), // test account → never
    ses('s6', 'd1', '2026-09-03T22:00:00Z', { isActive: true }), // still running on VTS → never
    ses('s7', 'd1', '2026-09-04T22:00:00Z', { totalLocations: 0 }), // nothing recorded → never
    ses('s8', 'd5', '2026-09-02T22:00:00Z'), // another VTS project → never
    ses('s9', 'd1', '2026-09-07T22:00:00Z'), // Abbas, but every fix is a phone in Hyderabad → skipped at apply
  ];
  fs.writeFileSync(path.join(dir, 'sessions_all.json'), JSON.stringify(sessions));
  // Three fixes ~1.1 km apart each, 2 minutes apart, plus one 900 m-accuracy fix that must not count.
  const pts = (id, t0) => [
    { _id: `${id}-a`, latitude: -37.80, longitude: 144.96, speed: 30, accuracy: 5, timestamp: new Date(Date.parse(t0) + 60000).toISOString() },
    { _id: `${id}-x`, latitude: -37.70, longitude: 144.80, speed: 0, accuracy: 900, timestamp: new Date(Date.parse(t0) + 90000).toISOString() },
    { _id: `${id}-b`, latitude: -37.79, longitude: 144.96, speed: 40, accuracy: 5, timestamp: new Date(Date.parse(t0) + 180000).toISOString() },
    { _id: `${id}-c`, latitude: -37.78, longitude: 144.96, speed: 35, accuracy: 5, timestamp: new Date(Date.parse(t0) + 300000).toISOString() },
    // A second phone in Hyderabad recording into the same session: not part of this drive.
    { _id: `${id}-in`, latitude: 17.48, longitude: 78.55, speed: 0, accuracy: 9, timestamp: new Date(Date.parse(t0) + 240000).toISOString() },
  ];
  const india = (id, t0) => [0, 1, 2].map((i) => ({ _id: `${id}-${i}`, latitude: 17.45 + i / 1000, longitude: 78.36, speed: 20, accuracy: 5, timestamp: new Date(Date.parse(t0) + i * 60000).toISOString() }));
  for (const s of sessions) fs.writeFileSync(path.join(dir, 'points', `${s._id}.json`), JSON.stringify(s._id === 's9' ? india(s._id, s.startTime) : pts(s._id, s.startTime)));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'unused');

  // --no-process: the road matcher calls a remote server; the pipeline itself has its own tests.
  const run = (...extra) => execFileSync(process.execPath, ['src/seed/importVtsSessions.js', `--dump=${dir}`, `--token-file=${tokenFile}`, '--no-process', '--concurrency=3', ...extra], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, MONGODB_URI: uri }, encoding: 'utf8',
  });

  const dry = run();
  assert(/toImport: 3/.test(dry) && /dayHasData: 1/.test(dry), 'dry run: Abbas 2 and 8 Sep, Joel 6 Sep in; Joel 5 Sep already has data');
  assert(/testAccount: 1/.test(dry) && /active: 1/.test(dry) && /noPoints: 1/.test(dry) && /noAccount: 1/.test(dry), '…test account, running and empty sessions, and the unknown driver are left out');
  assert(/sessions: 8/.test(dry), '…and another VTS project\'s sessions are not even considered');
  assert(await Trip.countDocuments({ importBatchId: /^vts-/ }) === 0, 'the dry run writes nothing');

  const out = run('--apply', '--create-missing-drivers');
  const batch = out.match(/batch (vts-\S+)/)[1].replace(/\.$/, '');
  const robert = await User.findOne({ email: 'robert@x.com' }).select('+passwordHash').lean();
  assert(robert && robert.name === 'Robert Falelua' && String(robert.projectIds[0]) === String(he._id), 'a missing driver is created on HE Drive, code dropped from the name');
  assert(robert.passwordHash && robert.passwordHash.startsWith('$2'), '…with a random password nobody knows');

  const trips = await Trip.find({ importBatchId: batch }).lean();
  assert(trips.length === 3, '3 trips: Abbas, Joel 6 Sep, Robert — the all-Hyderabad session is skipped');
  assert(/1 skipped \(under 2 fixes in Australia\), 6 fixes outside Australia dropped/.test(out), "…the stray Hyderabad fix dropped from each of the 3 others, plus the skipped session's 3");
  assert(await LocationPoint.countDocuments({ lat: { $gt: 0 } }) === 0, 'not one point outside Australia went in');
  const t1 = trips.find((t) => t.importSourceId === 'vts:s1');
  assert(String(t1.driverId) === String(abbas._id), 'email matches regardless of case');
  assert(t1.status === 'completed' && t1.mapMatchStatus === 'pending' && t1.ukmStatus === 'pending' && t1.linkCoverageStatus === 'pending', 'a completed, pending trip — the worker takes it from here');
  assert(String(t1.projectId) === String(he._id) && t1.timezone === 'Australia/Melbourne', 'on HE Drive, zone from where it started');
  assert(t1.vehicleId && t1.pointCount === 4, 'the VTS plate finds our car; every fix counted');
  assert(t1.distanceMeters > 2000 && t1.distanceMeters < 2400, `distance from the accurate fixes only (${t1.distanceMeters} m)`);
  assert(t1.startedAt.toISOString() === '2026-09-01T22:01:00.000Z', 'the trip starts at its first fix');
  const p = await LocationPoint.find({ tripId: t1._id }).sort({ recordedAt: 1 }).lean();
  assert(p.length === 4 && p[0].clientId === 'vts:s1-a' && p[0].speedKmh === 30 && p[0].accuracy === 5, 'points land with speed and accuracy, keyed by their VTS id');

  const again = run('--apply', '--create-missing-drivers');
  assert(/alreadyImported: 3/.test(again) && /toImport: 1/.test(again), 'a re-run finds them all already in (the Hyderabad one is planned again and skipped again)');
  assert(await Trip.countDocuments({ importBatchId: /^vts-/ }) === 3, '…and adds nothing');

  execFileSync(process.execPath, ['src/seed/importVtsSessions.js', `--revert=${batch}`, '--apply'], { cwd: path.join(__dirname, '..'), env: { ...process.env, MONGODB_URI: uri }, encoding: 'utf8' });
  assert(await Trip.countDocuments({ importBatchId: batch }) === 0 && await LocationPoint.countDocuments({ clientId: /^vts:/ }) === 0, 'revert removes the batch\'s trips and points');
  assert(await Trip.countDocuments({ driverId: joel._id }) === 2, '…and nothing else');

  // VTS's cleaned route as the trip's route: no road-matching, cut where it jumps across a gap.
  fs.mkdirSync(path.join(dir, 'clean'));
  const route = [[-37.80, 144.96], [-37.795, 144.96], [-37.79, 144.96], [-37.60, 144.96] /* 21 km jump */, [-37.595, 144.96], [17.45, 78.36] /* Hyderabad */];
  // s10: an older session VTS kept only the cleaned route of — its raw fixes come back empty.
  sessions.push(ses('s10', 'd1', '2026-09-09T22:00:00Z', { endTime: '2026-09-10T01:00:00Z', stats: { totalDistance: 1700, maxSpeed: 60 } }));
  fs.writeFileSync(path.join(dir, 'sessions_all.json'), JSON.stringify(sessions));
  fs.writeFileSync(path.join(dir, 'points', 's10.json'), '[]');
  for (const s of sessions) fs.writeFileSync(path.join(dir, 'clean', `${s._id}.json`), JSON.stringify(route.map(([latitude, longitude]) => ({ latitude, longitude }))));
  execFileSync(process.execPath, ['src/seed/importVtsSessions.js', `--dump=${dir}`, `--token-file=${tokenFile}`, '--concurrency=2', '--apply'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, MONGODB_URI: uri }, encoding: 'utf8',
  });
  const routed = await Trip.findOne({ importSourceId: 'vts:s1' }).lean();
  assert(routed.mapMatchStatus === 'matched' && routed.cleanedMatchedRatio === 1, 'with a VTS route the trip is matched straight away, no road server');
  assert(routed.cleanedRouteShapes.length === 2, 'the route is cut at the 21 km jump, and the Hyderabad fix is gone');
  assert(routed.cleanedDistanceMeters > 1500 && routed.cleanedDistanceMeters < 1800, `route length counts the roads, not the jump (${routed.cleanedDistanceMeters} m)`);
  assert(routed.ukmStatus !== 'pending' && routed.linkCoverageStatus !== 'pending', 'UKM and coverage are worked out as for any trip');
  const only = await Trip.findOne({ importSourceId: 'vts:s10' }).lean();
  assert(only && only.mapMatchStatus === 'matched' && only.cleanedRouteShapes.length === 2, 'a session with no raw fixes left comes in on its VTS route');
  assert(only.pointCount === 0 && await LocationPoint.countDocuments({ tripId: only._id }) === 0, '…with no points, since there are none');
  assert(only.startedAt.toISOString() === '2026-09-09T22:00:00.000Z' && only.endedAt.toISOString() === '2026-09-10T01:00:00.000Z' && only.distanceMeters === 1700, '…times from the session, km from VTS');

  console.log(`\n${passed} assertions passed`);
  fs.rmSync(dir, { recursive: true, force: true });
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
