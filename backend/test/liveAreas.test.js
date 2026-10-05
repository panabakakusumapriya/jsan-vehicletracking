// The live map's assigned areas: GET /api/tracking/live-areas.
//
// Each visible driver's held work areas as outlines, so the map shows their patch and whether they
// are in it. Under test: areas resolve the way the driver's phone resolves them (by area code, to
// the current live delivery), released assignments drop out, a driver with nothing assigned has
// nothing, who may ask, and what a manager of another project sees.
//
// Run: node test/liveAreas.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'live_areas_test_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('live_areas_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const AreaAssignment = require('../src/models/AreaAssignment');
  await WorkArea.init();
  const app = createApp();

  const project = await Project.create({ name: 'HE Drive' });
  const other = await Project.create({ name: 'Elsewhere' });
  const old = await NetworkVersion.create({ projectId: project._id, label: 'old', status: 'superseded' });
  const current = await NetworkVersion.create({ projectId: project._id, label: 'current', status: 'active' });
  const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  const mkArea = (v, code, name, w, s, e, n, withOutline = true) => WorkArea.create({
    projectId: v.projectId, networkVersionId: v._id, areaCode: code, name,
    geometry: box(w, s, e, n), bbox: [w, s, e, n], ...(withOutline ? { outline: box(w, s, e, n) } : {}),
  });
  const westOld = await mkArea(old, 'WEST', 'Westside (old)', 8, 50, 8.01, 50.01);
  const west = await mkArea(current, 'WEST', 'Westside', 8, 50, 8.01, 50.01);
  const east = await mkArea(current, 'EAST', 'Eastside', 8.02, 50, 8.03, 50.01, false);
  await mkArea(current, 'NORTH', 'Northside', 8, 50.02, 8.01, 50.03);

  const mkUser = async (name, role, p = project) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: [p._id] });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'manager');
  const stranger = await mkUser('stranger', 'manager', other);
  const ravi = await mkUser('ravi', 'user');
  const sam = await mkUser('sam', 'user');
  await mkUser('tara', 'user'); // holds nothing

  const assign = (who, area, extra = {}) => AreaAssignment.create({ projectId: project._id, networkVersionId: area.networkVersionId, areaId: area._id, areaCode: area.areaCode, driverId: who.user._id, ...extra });
  await assign(ravi, westOld); // made against the previous delivery
  await assign(sam, west);
  await assign(sam, east);
  await assign(ravi, await WorkArea.findOne({ areaCode: 'NORTH' }), { releasedAt: new Date() });

  const read = (who) => who.as(request(app).get('/api/tracking/live-areas'));

  assert((await read(ravi)).status === 403, 'a driver may not read where everyone\'s areas are');
  const res = await read(boss);
  assert(res.status === 200 && res.body.edgeMeters === 45, 'a manager may; "on the edge" is 45 m — the 20 m buffer plus the 25 m outline simplification');
  const byCode = new Map(res.body.areas.map((a) => [a.areaCode, a]));
  assert(res.body.areas.length === 2 && byCode.has('WEST') && byCode.has('EAST') && !byCode.has('NORTH'), 'the held areas, and not the one Ravi was released from');
  assert(byCode.get('WEST')._id === String(west._id) && byCode.get('WEST').name === 'Westside',
    'an assignment made against the previous delivery resolves to the current copy of the area — as on the phone');
  assert(byCode.get('WEST').driverIds.sort().join() === [String(ravi.user._id), String(sam.user._id)].sort().join(), 'every holder of an area is named on it');
  assert(byCode.get('EAST').driverIds.join() === String(sam.user._id), '…and only its holders');
  assert(byCode.get('EAST').outline.type === 'Polygon' && byCode.get('EAST').outline.coordinates[0].length === 5, 'an area without a stored outline is drawn as its bounding box rather than left out');
  assert(!res.body.areas.some((a) => a.geometry), 'only the outline travels, never the full geometry');
  const none = await read(stranger);
  assert(none.status === 200 && none.body.areas.length === 0, 'a manager of another project sees none of these drivers\' areas');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
