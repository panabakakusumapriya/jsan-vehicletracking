// A signed-off area's roads are drawn as done: network.controller versionLinks / versionAssignedLinks.
//
// Marking an area completed is the manager's verdict that its roads are finished, so the coverage
// map should stop showing any of them red. It does that by FLAGGING them (signedOff / state 2), not
// by inventing coverage: the ledger, the driven km and the percentages stay what was recorded, and
// reopening the area puts the red back.
//
// Run: node test/signedOffRoads.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'signed_off_roads_test_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('signed_off_roads_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const { lineLength } = require('../src/utils/geo');
  await Promise.all([WorkArea.init(), RoadLink.init(), LinkCoverage.init()]);
  const app = createApp();

  const project = await Project.create({ name: 'HE Drive' });
  const version = await NetworkVersion.create({ projectId: project._id, label: 'v', status: 'active' });
  const box = (w, e) => ({ type: 'Polygon', coordinates: [[[w, 49.999], [e, 49.999], [e, 50.005], [w, 50.005], [w, 49.999]]] });
  const mkArea = (code, w, e) => WorkArea.create({ projectId: project._id, networkVersionId: version._id, areaCode: code, name: code, geometry: box(w, e), bbox: [w, 49.999, e, 50.005], targetMeters: 300, targetLinks: 3 });
  const west = await mkArea('WEST', 7.99, 8.01);
  const east = await mkArea('EAST', 8.011, 8.03);
  const line = (lon, a, b) => [[lon, 50 + a * 0.001], [lon, 50 + b * 0.001]];
  const mkLink = (id, coords, area) => RoadLink.create({ projectId: project._id, networkVersionId: version._id, linkId: id, dirTravel: 'B', funcClass: 5, areaId: area._id, areaCode: area.areaCode, geometry: { type: 'LineString', coordinates: coords }, lengthMeters: lineLength(coords) });
  const w1 = await mkLink('W1', line(8, 0, 1), west);
  await mkLink('W2', line(8, 1, 2), west);
  await mkLink('W3', line(8.003, 0, 1), west);
  await mkLink('E1', line(8.02, 0, 1), east);

  const mkUser = async (name, role) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: [project._id] });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'manager');
  const ravi = await mkUser('ravi', 'user');
  await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: west._id, areaCode: 'WEST', driverId: ravi.user._id });
  await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: east._id, areaCode: 'EAST', driverId: ravi.user._id });
  // Ravi drove W1 only.
  await LinkCoverage.create({ projectId: project._id, networkVersionId: version._id, linkId: 'W1', lengthMeters: w1.lengthMeters, areaId: west._id, priority: 0, funcClass: 5, firstTripId: new mongoose.Types.ObjectId(), firstDriverId: ravi.user._id, firstAt: new Date() });

  const base = `/api/network/versions/${version._id}`;
  const areaRoads = async () => {
    const r = await boss.as(request(app).get(`${base}/links?bbox=7.98,49.99,8.04,50.01&areaId=${west._id}`));
    return new Map(r.body.links.map((l) => [l.linkId, l]));
  };
  const assigned = async (q = '') => {
    const r = await boss.as(request(app).get(`${base}/assigned-links?scope=assigned${q}`));
    return new Map(r.body.links.map(([id, , state]) => [id, state]));
  };
  const summary = async () => (await boss.as(request(app).get(base))).body.coverage;

  /* ── before ── */
  let roads = await areaRoads();
  assert(roads.get('W1').covered && !roads.get('W2').covered && !roads.get('W2').signedOff, 'before: W1 driven, W2 to drive, nothing signed off');
  let states = await assigned();
  assert(states.get('W1') === 1 && states.get('W2') === 0 && states.get('E1') === 0, 'before: on the assigned layer W1 is driven, W2 and E1 are red');
  const before = await summary();

  /* ── mark WEST completed ── */
  const done = await boss.as(request(app).post(`${base}/areas/${west._id}/complete`)).send({});
  assert(done.status === 200, 'the manager marks Westside completed');
  roads = await areaRoads();
  assert(roads.get('W2').signedOff && roads.get('W3').signedOff && roads.get('W1').signedOff, 'every road in it is now flagged signed off — drawn as done');
  assert(roads.get('W1').covered && !roads.get('W2').covered, '…while "covered" stays the ledger\'s truth: only W1 was driven');
  states = await assigned();
  assert(states.get('W1') === 1 && states.get('W2') === 2 && states.get('W3') === 2,
    'the assigned layer keeps the area although the driver was released: W1 driven, W2 and W3 done by sign-off');
  assert(states.get('E1') === 0, 'the area next door is untouched — still red');
  const after = await summary();
  assert(after.coveredMeters === before.coveredMeters && after.coveredLinks === before.coveredLinks, 'the driven km and road count are not inflated by the sign-off');
  assert(await LinkCoverage.countDocuments({}) === 1, 'no coverage was written for it');
  const narrowed = await assigned(`&driverIds=${ravi.user._id}`);
  assert(!narrowed.has('W2') && narrowed.get('E1') === 0, 'narrowed to a driver: a signed-off area is nobody\'s, so it is not in their layer');

  /* ── reopen ── */
  await boss.as(request(app).post(`${base}/areas/${west._id}/reopen`)).send({});
  roads = await areaRoads();
  assert(!roads.get('W2').signedOff && !roads.get('W2').covered, 'reopened: W2 is red again');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
