process.env.DRIVER_POSITIONS_MEMO_MS = '0'; // every request reads afresh: the test changes data between calls
// Where each driver last stopped, on the coverage map: services/driverPositions.js.
//
// The map shows what is driven and who holds an area. This adds the point the work stopped at —
// the end of each CURRENT driver's latest finished drive on the project, when that stop was
// recent (the last day by default) — so tomorrow can be planned from the map.
//
// Under test: who gets a pin (on the project, account active — not former drivers), which drive
// counts (finished, not a parked-jitter session, not an imported day with no GPS, not a drive for
// another project), the time window, "driving again now", the area a stop falls in, who may ask,
// and the route endpoint.
//
// Run: node test/driverPositions.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'driver_positions_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('driver_positions_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const LinkCoverage = require('../src/models/LinkCoverage');
  await WorkArea.init();
  await Trip.init();
  await LinkCoverage.init();
  const app = createApp();

  // ── Two projects on different ground: HE Drive around lon 8, Northern around lon 20 ──
  const box = (w, e) => [[[w, 49.999], [e, 49.999], [e, 50.005], [w, 50.005], [w, 49.999]]];
  const drive = await Project.create({ name: 'HE Drive' });
  const north = await Project.create({ name: 'Northern' });
  const version = await NetworkVersion.create({ projectId: drive._id, label: 'v2', status: 'active' });
  const northVersion = await NetworkVersion.create({ projectId: north._id, label: 'n1', status: 'active' });
  const mkArea = (p, v, code, name, w, e) => WorkArea.create({
    projectId: p._id, networkVersionId: v._id, areaCode: code, name,
    geometry: { type: 'Polygon', coordinates: box(w, e) }, bbox: [w, 49.999, e, 50.005], targetMeters: 1000, targetLinks: 3,
  });
  const west = await mkArea(drive, version, 'WEST', 'Westside', 7.99, 8.01);
  const east = await mkArea(drive, version, 'EAST', 'Eastside', 8.011, 8.03);
  await mkArea(north, northVersion, 'N1', 'Northfield', 19.99, 20.01);

  const mkUser = async (name, role, projects) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: projects.map((p) => p._id) });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'manager', [drive]);
  const stranger = await mkUser('stranger', 'manager', [north]);
  const ravi = await mkUser('ravi', 'user', [drive]);
  const sam = await mkUser('sam', 'user', [drive]);
  const tara = await mkUser('tara', 'user', [drive]);        // holds an area, has never driven
  const mona = await mkUser('mona', 'user', [drive, north]); // two projects: her trips carry none
  await AreaAssignment.create({ projectId: drive._id, networkVersionId: version._id, areaId: west._id, driverId: ravi.user._id, areaCode: 'WEST', assignedAt: new Date('2026-01-01') });
  await AreaAssignment.create({ projectId: drive._id, networkVersionId: version._id, areaId: east._id, driverId: tara.user._id, areaCode: 'EAST', assignedAt: new Date('2026-01-01') });

  let seq = 0;
  const ago = (min) => new Date(Date.now() - min * 60_000);
  /** A drive that ended `endMin` minutes ago at [lon, lat], its last fix a minute before the close. */
  const mkTrip = (who, { lon, lat, startMin, endMin, project = drive, ...rest }) => Trip.create({
    clientTripId: `t${++seq}`, driverId: who.user._id, projectId: project ? project._id : null,
    status: endMin == null ? 'active' : 'completed',
    startedAt: ago(startMin), endedAt: endMin == null ? null : ago(endMin),
    lastLocation: lon == null ? null : { lat, lon, speed: 0, heading: 90, recordedAt: ago((endMin ?? 0) + 1) },
    distanceMeters: 4200, mapMatchStatus: 'pending',
    ...rest,
  });
  const url = (id, tail = '') => `/api/network/versions/${id}/driver-positions${tail}`;
  const ask = async (who = boss, id = drive._id, query = '') => (await who.as(request(app).get(url(id, query)))).body.positions;
  const of = (rows, who) => rows.find((r) => r.driverId === String(who.user._id));

  /* ── who may ask ── */
  assert((await ravi.as(request(app).get(url(drive._id)))).status === 403, 'a driver may not see where the others are');
  assert((await stranger.as(request(app).get(url(drive._id)))).status === 403, 'nor may a manager of another project');
  assert((await boss.as(request(app).get(url(new mongoose.Types.ObjectId())))).status === 404, 'an unknown project is a 404');
  const empty = await boss.as(request(app).get(url(drive._id)));
  assert(empty.status === 200 && empty.body.positions.length === 0, 'nobody has driven yet: no positions, not an error');

  /* ── the latest stop, and where it was ── */
  await mkTrip(ravi, { lon: 8.02, lat: 50.001, startMin: 600, endMin: 550 });
  const shape = encodePolyline6([{ lat: 50.001, lon: 8 }, { lat: 50.003, lon: 8 }]);
  const last = await mkTrip(ravi, {
    lon: 8, lat: 50.003, startMin: 200, endMin: 150,
    cleanedDistanceMeters: 3900, cleanedRouteShapes: [shape], mapMatchStatus: 'matched',
  });
  let rows = await ask();
  let r = of(rows, ravi);
  assert(rows.length === 1 && r.trip.id === String(last._id) && r.lat === 50.003 && r.lon === 8, 'Ravi is where his NEWEST drive stopped, not an earlier one');
  assert(r.state === 'ended' && r.name === 'ravi' && r.heading === 90 && r.drivingNow === false, 'a finished drive, with his name and heading — and he is not on the road now');
  assert(Math.abs(new Date(r.at) - ago(151)) < 5000, 'the time is the last GPS fix, not when the trip was closed');
  assert(r.area && r.area.areaCode === 'WEST' && r.area.name === 'Westside' && r.area.mine === true, 'it names the work area he stopped in — one of his own');
  assert(r.trip.meters === 3900 && r.trip.snapped === true, 'the drive is reported with its snapped distance');
  assert(!of(rows, tara), 'a driver who holds an area but never drove has no position');

  /* ── what does not count as a stop ── */
  await mkTrip(ravi, { lon: 8.0001, lat: 50.0031, startMin: 60, endMin: 20, parkedJitter: true, parkedJitterAt: new Date() });
  r = of(await ask(), ravi);
  assert(r.trip.id === String(last._id) && Math.abs(new Date(r.at) - ago(151)) < 5000, 'a later parked-GPS-jitter session does not move him, nor change when he stopped');
  await mkTrip(ravi, { lon: null, startMin: 30, endMin: 25, importBatchId: 'batch-1', cleanedRouteShapes: [shape], mapMatchStatus: 'matched' });
  assert(of(await ask(), ravi).trip.id === String(last._id), 'an imported day has no GPS fix, so it cannot say where he stopped');

  /* ── on the road again: the pin stays at the last stop ── */
  const live = await mkTrip(ravi, { lon: 8.02, lat: 50.002, startMin: 10, endMin: null });
  await Trip.updateOne({ _id: live._id }, { $set: { 'lastLocation.recordedAt': new Date() } });
  r = of(await ask(), ravi);
  assert(r.trip.id === String(last._id) && r.lat === 50.003, 'a drive still under way is not a stop: Ravi stays where he last stopped');
  assert(r.drivingNow === true, '…and the pin says he is driving again now');
  await Trip.updateOne({ _id: live._id }, { $set: { 'lastLocation.recordedAt': ago(60) } });
  assert(of(await ask(), ravi).drivingNow === false, 'an open drive with no fix for an hour is not "driving now"');
  await Trip.deleteOne({ _id: live._id });
  const onlyOpen = await mkTrip(sam, { lon: 8.02, lat: 50.002, startMin: 40, endMin: null });
  assert(!of(await ask(), sam), 'a driver whose only drive is still open has not stopped yet: no pin');

  /* ── only recent stops ── */
  await Trip.deleteOne({ _id: onlyOpen._id });
  const old = await mkTrip(sam, { lon: 8.02, lat: 50.002, startMin: 60 * 30, endMin: 60 * 29 }); // stopped 29 h ago
  assert(!of(await ask(), sam), 'a stop more than a day old gets no pin');
  assert(of(await ask(boss, drive._id, '?withinHours=72'), sam)?.trip.id === String(old._id), '…unless the map asks for the last 3 days');
  assert(Boolean(of(await ask(boss, drive._id, '?withinHours=9999'), sam)), 'an absurd window is capped at 7 days, not refused');
  const longDrive = await mkTrip(sam, { lon: 8.021, lat: 50.0021, startMin: 60 * 28, endMin: 60 * 23 }); // started 28 h ago, stopped 23 h ago
  assert(of(await ask(), sam)?.trip.id === String(longDrive._id), 'a long drive that STOPPED inside the day counts, though it started before it');
  assert(of(await ask(), sam).area.areaCode === 'EAST' && of(await ask(), sam).area.mine === false, 'Sam stopped in Eastside — which is not his area');

  /* ── a driver on two projects: her trips carry no project ── */
  const here = await mkTrip(mona, { lon: 8.005, lat: 50.002, startMin: 500, endMin: 450, project: null });
  const there = await mkTrip(mona, { lon: 20, lat: 50.002, startMin: 100, endMin: 70, project: null });
  let m = of(await ask(), mona);
  assert(m && m.trip.id === String(here._id) && m.area.areaCode === 'WEST' && m.area.mine === false,
    'on this map she is where she last stopped on THIS ground, though a newer drive exists elsewhere');
  m = of(await ask(stranger, north._id), mona);
  assert(m && m.trip.id === String(there._id) && m.area.areaCode === 'N1', '…and on the other project\'s map she is at that newer stop');
  assert(!of(await ask(stranger, north._id), ravi), 'a driver who is not on that project does not appear on it');
  const stamped = await mkTrip(mona, { lon: 8.6, lat: 50.3, startMin: 50, endMin: 45 });
  m = of(await ask(), mona);
  assert(m.trip.id === String(stamped._id) && m.area === null, 'a drive stamped with the project counts wherever it ended — even off the map\'s areas');

  /* ── people who are no longer on the project, or no longer active ── */
  const lena = await mkUser('lena', 'user', [drive]);
  const lenaTrip = await mkTrip(lena, { lon: 8.001, lat: 50.004, startMin: 90, endMin: 85 });
  await LinkCoverage.create({ projectId: drive._id, networkVersionId: version._id, linkId: 'W9', lengthMeters: 100, areaId: west._id, firstTripId: lenaTrip._id, firstDriverId: lena.user._id, firstAt: ago(86) });
  await AreaAssignment.create({ projectId: drive._id, networkVersionId: version._id, areaId: west._id, driverId: lena.user._id, areaCode: 'WEST', assignedAt: new Date('2026-01-02') });
  assert(of(await ask(), lena)?.trip.id === String(lenaTrip._id), 'Lena, on the project, has her pin');
  await User.updateOne({ _id: lena.user._id }, { $set: { projectIds: [] } });
  assert(!of(await ask(), lena), 'moved off the project: no pin — though she drove its road and an assignment row is left');
  await User.updateOne({ _id: lena.user._id }, { $set: { projectIds: [drive._id], active: false } });
  assert(!of(await ask(), lena), 'on the project but her account deactivated: no pin');
  await User.deleteOne({ _id: lena.user._id });
  assert(!of(await ask(), lena), 'a deleted account is not drawn');

  /* ── either id works, and the rows are ordered ── */
  const byVersion = await ask(boss, version._id);
  rows = await ask();
  assert(rows.map((x) => x.name).sort().join() === 'mona,ravi,sam', `the whole project: three drivers with a recent stop (got ${rows.map((x) => x.name).join()})`);
  // One delivery (the region filter) is narrower: a drive counts when it was on THAT ground.
  // Mona's stamped drive is off it, so she shows at her earlier stop.
  assert(of(byVersion, mona)?.trip.id === String(here._id), 'one delivery: a driver shows at their last stop on its ground');
  assert(rows.every((x, i) => i === 0 || new Date(rows[i - 1].at) >= new Date(x.at)), 'the most recent stop first');

  /* ── the route leading up to the pin ── */
  const route = (who, tripId) => who.as(request(app).get(url(drive._id, `/route?tripId=${tripId}`)));
  const snapped = await route(boss, last._id);
  assert(snapped.status === 200 && snapped.body.snapped === true && snapped.body.shapes.length === 1 && snapped.body.shapes[0] === shape && snapped.body.pending === false,
    'a snapped drive comes back with its route');
  const open = await mkTrip(sam, { lon: 8.02, lat: 50.002, startMin: 5, endMin: null });
  const openRoute = await route(boss, open._id);
  assert(openRoute.status === 200 && openRoute.body.snapped === false && openRoute.body.pending === true && openRoute.body.shapes.length === 0,
    'an open drive has no route yet, and says so');
  assert((await route(boss, here._id)).status === 200, 'an unstamped drive by one of the project\'s drivers is readable');
  const foreign = await Trip.create({ clientTripId: 'f1', driverId: stranger.user._id, projectId: north._id, status: 'completed', startedAt: ago(90), endedAt: ago(80), cleanedRouteShapes: [shape] });
  assert((await route(boss, foreign._id)).status === 404, 'another project\'s trip is not');
  assert((await boss.as(request(app).get(url(drive._id, '/route')))).status === 400, 'a missing tripId is a 400');
  assert((await route(ravi, last._id)).status === 403, 'a driver may not read it');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
