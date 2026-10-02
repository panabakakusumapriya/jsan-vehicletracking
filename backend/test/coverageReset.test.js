// Clearing an area's driven data: services/coverageReset.js + models/CoverageReset.js.
//
// Why it exists: the coverage ledger is fleet-wide and first-cover-wins, so an area handed to a
// driver a second time — a trial run, a re-drive — opens on their phone already blue. A manager
// can now wipe it back to "to drive".
//
// The rule under test is that a clear STAYS cleared. The ledger is derived from trips, so a plain
// delete would be undone by the next re-attribution or rebuild: the same old trips would claim the
// same roads again. Driving from before the clear must never count again; driving after it must.
//
// Also: what goes (the area's ledger rows, in every delivery carrying that area code; the owning
// trips' assigned-route km) and what stays (trips, routes, other areas); who may; the confirm flag.
//
// Run: node test/coverageReset.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'coverage_reset_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol, msg) => assert(a != null && Math.abs(a - b) <= tol, `${msg} (got ${a})`);

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('coverage_reset_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const { attributeTripLinks, rebuildNetworkCoverage } = require('../src/services/linkCoverage');
  const { getDriverRoads, getDriverRoadsVersion } = require('../src/services/driverRoads');
  const { lineLength } = require('../src/utils/geo');
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
  const RoadLink = require('../src/models/RoadLink');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const CoverageReset = require('../src/models/CoverageReset');
  await RoadLink.syncIndexes();
  await LinkCoverage.syncIndexes();
  await WorkArea.init();
  const app = createApp();

  // ── A tiny customer network: two areas side by side ──
  // Area WEST: a street along lon 8 in two links (W1, W2) and a parallel street (W3).
  // Area EAST: one street along lon 8.02 (E1). One step of 0.001° latitude is ~111 m.
  const line = (lon, fromStep, toStep) => {
    const pts = [];
    for (let i = fromStep; i <= toStep; i++) pts.push([lon, 50 + i * 0.001]);
    return pts;
  };
  const shape = (lon, fromStep, toStep) =>
    encodePolyline6(line(lon, fromStep, toStep).map(([ln, lt]) => ({ lat: lt, lon: ln })));
  const box = (w, e) => [[[w, 49.999], [e, 49.999], [e, 50.005], [w, 50.005], [w, 49.999]]];

  const project = await Project.create({ name: 'HE Drive' });
  const version = await NetworkVersion.create({ projectId: project._id, label: 'v2', status: 'active' });
  const older = await NetworkVersion.create({ projectId: project._id, label: 'v1', status: 'superseded' });
  const mkArea = (v, code, name, w, e) => WorkArea.create({
    projectId: project._id, networkVersionId: v._id, areaCode: code, name,
    geometry: { type: 'Polygon', coordinates: box(w, e) }, bbox: [w, 49.999, e, 50.005], targetMeters: 1000, targetLinks: 3,
  });
  const west = await mkArea(version, 'WEST', 'Westside', 7.99, 8.01);
  const east = await mkArea(version, 'EAST', 'Eastside', 8.011, 8.03);
  const westBefore = await mkArea(older, 'WEST', 'Westside', 7.99, 8.01); // the same ground, last delivery
  const mkLink = (v, linkId, coords, area, code) => RoadLink.create({
    projectId: project._id, networkVersionId: v._id, linkId, dirTravel: 'B', areaId: area._id, areaCode: code,
    geometry: { type: 'LineString', coordinates: coords }, lengthMeters: lineLength(coords),
  });
  const W1 = await mkLink(version, 'W1', line(8, 0, 2), west, 'WEST');
  const W2 = await mkLink(version, 'W2', line(8, 2, 4), west, 'WEST');
  await mkLink(version, 'W3', line(8.003, 0, 2), west, 'WEST');
  const E1 = await mkLink(version, 'E1', line(8.02, 0, 4), east, 'EAST');

  let seq = 0;
  const mkUser = async (name, role) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: [project._id] });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'manager');
  const ravi = await mkUser('ravi', 'user');
  const sam = await mkUser('sam', 'user');
  await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: west._id, driverId: ravi.user._id, areaCode: 'WEST', assignedAt: new Date('2026-01-01') });

  const mkTrip = (driver, shapes, startedAt, endedAt) => Trip.create({
    clientTripId: `t${++seq}`, driverId: driver.user._id, projectId: project._id, status: 'completed',
    startedAt, endedAt, cleanedRouteShapes: shapes, cleanedDistanceMeters: 0, cleanedMatchedRatio: 1,
    mapMatchStatus: 'matched', distanceMeters: 0,
  });
  const reload = (t) => Trip.findById(t._id).lean();
  const owner = async (linkId) => (await LinkCoverage.findOne({ networkVersionId: version._id, linkId }).lean())?.firstTripId;
  const lastWeek = (min) => new Date(Date.now() - 7 * 86400_000 + min * 60_000);
  const url = (areaId, what) => `/api/network/versions/${version._id}/areas/${areaId}/${what}`;
  const roadsOf = (who) => getDriverRoads({ driverId: who.user._id, projectIds: [project._id], areaId: west._id });
  const blue = (roads) => roads.links.filter((l) => l[2] === 1).map((l) => l[0]).sort().join();

  /* ── last week: Ravi drives his area, Sam drives the one next door ── */
  const t1 = await mkTrip(ravi, [shape(8, 0, 4)], lastWeek(0), lastWeek(20));
  const tEast = await mkTrip(sam, [shape(8.02, 0, 4)], lastWeek(5), lastWeek(25));
  await attributeTripLinks(t1._id);
  await attributeTripLinks(tEast._id);
  // …and the previous delivery's ledger still carries that area too.
  await LinkCoverage.create({ projectId: project._id, networkVersionId: older._id, linkId: 'W1', lengthMeters: W1.lengthMeters, areaId: westBefore._id, firstTripId: t1._id, firstDriverId: ravi.user._id, firstAt: lastWeek(1) });
  const driven = W1.lengthMeters + W2.lengthMeters;
  assert(String(await owner('W1')) === String(t1._id) && String(await owner('W2')) === String(t1._id) && String(await owner('E1')) === String(tEast._id), 'before: W1 and W2 are driven by Ravi\'s trip, E1 by Sam\'s');
  near((await reload(t1)).linkUkmMeters, driven, 1, 'before: Ravi\'s trip is credited with W1+W2');
  const before = await roadsOf(ravi);
  assert(blue(before) === 'W1,W2', 'before: his phone shows W1 and W2 as done');

  /* ── who may, and the confirm flag ── */
  assert((await ravi.as(request(app).post(url(west._id, 'clear-coverage'))).send({ confirm: true })).status === 403, 'a driver may not clear driven data');
  const unsure = await boss.as(request(app).post(url(west._id, 'clear-coverage'))).send({});
  assert(unsure.status === 400 && (await LinkCoverage.countDocuments({ areaId: west._id })) === 2, 'without confirm: true nothing is cleared (400)');

  /* ── the clear ── */
  const cleared = await boss.as(request(app).post(url(west._id, 'clear-coverage'))).send({ confirm: true, note: 'trial run' });
  assert(cleared.status === 200 && cleared.body.clearedLinks === 2 && cleared.body.tripsAffected === 1, `cleared: ${cleared.body.clearedLinks} roads, ${cleared.body.tripsAffected} trip affected`);
  near(cleared.body.clearedMeters, driven, 1, 'the answer says how much road was wiped');
  assert((await LinkCoverage.countDocuments({ areaId: west._id })) === 0, 'the area has no driven roads any more');
  assert((await LinkCoverage.countDocuments({ areaId: westBefore._id })) === 0, '…nor has the same area in the previous delivery');
  assert(String(await owner('E1')) === String(tEast._id), 'the area next door is untouched');
  const r1 = await reload(t1);
  assert(r1.linkUkmMeters === 0 && r1.cleanedRouteShapes.length === 1 && r1.status === 'completed', 'Ravi\'s trip keeps its route and history, but is no longer credited with those roads');
  near((await reload(tEast)).linkUkmNetworkMeters, E1.lengthMeters, 1, 'Sam\'s trip is credited exactly as before');
  const record = await CoverageReset.findOne({ projectId: project._id, areaCode: 'WEST' }).lean();
  assert(record && record.linkIds.sort().join() === 'W1,W2,W3' && record.clearedByName === 'boss' && record.note === 'trial run' && record.clearedLinks === 2,
    'the clear is on record: which roads, who, why');
  const after = await roadsOf(ravi);
  assert(blue(after) === '' && after.version !== before.version, 'his phone gets every road back as "to drive" — and a new version string, so it knows to refetch');
  assert((await getDriverRoadsVersion({ driverId: ravi.user._id, projectIds: [project._id], areaId: west._id })).version === after.version, '…which the cheap version probe agrees with at once');
  const card = await boss.as(request(app).get(url(west._id, 'coverage')));
  assert(card.status === 200 && card.body.coveredLinks === 0 && card.body.pct === 0 && card.body.byDriver.length === 0 && card.body.lastCleared.byName === 'boss',
    'the area card reads 0% driven, and says who cleared it');
  assert((await boss.as(request(app).get(url(east._id, 'coverage')))).body.lastCleared === null, 'an area never cleared says so');

  /* ── it stays cleared ── */
  await attributeTripLinks(t1._id);
  assert((await owner('W1')) == null && (await owner('W2')) == null, 're-attributing the old trip (a re-match) does not bring its roads back');
  const rebuilt = await rebuildNetworkCoverage(version._id);
  assert((await owner('W1')) == null && (await owner('W2')) == null && String(await owner('E1')) === String(tEast._id),
    `a full rebuild of the ledger does not either — it re-claims only E1 (${rebuilt.coveredLinks} road)`);
  assert((await reload(t1)).linkUkmMeters === 0, '…and the old trip stays uncredited');
  // Driven before the clear, attributed after it (it was still waiting for its map-match).
  const late = await mkTrip(ravi, [shape(8.003, 0, 2)], lastWeek(40), lastWeek(50));
  await attributeTripLinks(late._id);
  assert((await owner('W3')) == null, 'a trip driven before the clear but processed after it claims nothing in the area');

  /* ── driving after the clear counts ── */
  const soon = (min) => new Date(Date.now() + min * 60_000);
  const t2 = await mkTrip(sam, [shape(8, 0, 4)], soon(5), soon(25));
  await AreaAssignment.updateMany({ areaId: west._id }, { $set: { releasedAt: new Date() } });
  await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: west._id, driverId: sam.user._id, areaCode: 'WEST', assignedAt: new Date() });
  await attributeTripLinks(t2._id);
  assert(String(await owner('W1')) === String(t2._id) && String(await owner('W2')) === String(t2._id), 'reassigned and driven again: the new trip claims W1 and W2');
  near((await reload(t2)).linkUkmMeters, driven, 1, '…and is credited with them');
  const samRoads = await getDriverRoads({ driverId: sam.user._id, projectIds: [project._id], areaId: west._id });
  assert(blue(samRoads) === 'W1,W2', 'the new driver\'s phone shows what HE drove, and only that');
  await rebuildNetworkCoverage(version._id);
  assert(String(await owner('W1')) === String(t2._id) && (await reload(t1)).linkUkmMeters === 0, 'after another rebuild the new trip still owns them, the old one still does not');

  /* ── a second clear, and a signed-off area ── */
  const again = await boss.as(request(app).post(url(west._id, 'clear-coverage'))).send({ confirm: true });
  assert(again.status === 200 && again.body.clearedLinks === 2 && (await CoverageReset.countDocuments({ areaCode: 'WEST' })) === 2, 'clearing twice is two entries on record');
  const nothing = await boss.as(request(app).post(url(west._id, 'clear-coverage'))).send({ confirm: true });
  assert(nothing.status === 200 && nothing.body.clearedLinks === 0, 'clearing an area with nothing driven is allowed, and clears nothing');
  await boss.as(request(app).post(url(east._id, 'complete'))).send({});
  const signed = await boss.as(request(app).post(url(east._id, 'clear-coverage'))).send({ confirm: true });
  assert(signed.status === 409 && /reopen/.test(signed.body.error) && String(await owner('E1')) === String(tEast._id), `a completed area is refused: ${signed.body.error}`);
  await boss.as(request(app).post(url(east._id, 'reopen'))).send({});
  assert((await boss.as(request(app).post(url(east._id, 'clear-coverage'))).send({ confirm: true })).status === 200 && (await owner('E1')) == null, '…and cleared once reopened');
  assert((await Trip.countDocuments({})) === 4, 'no trip was deleted by any of it');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
