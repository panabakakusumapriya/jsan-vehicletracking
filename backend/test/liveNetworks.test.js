// Live network deliveries: a project can hold several deliveries of DIFFERENT ground at once.
//
// The failure this pins down: PRJ-025 held Victoria and Queensland, then a Queensland top-up was
// imported and activated. Everything read "the active version" only, so every live assignment on
// the project — 335 of them, 13 drivers — vanished from the phones (no polygons, no roads) and
// trips driven in those areas were measured against the top-up's network, crediting nothing. The
// admin panel still showed the assignments, so nothing looked wrong from the office.
//
// Rules under test:
//   - my-areas serves an assigned area from a superseded delivery that is still in use;
//   - my-roads serves its roads, and still refuses a dead re-delivery's copy of the same area;
//   - a stale re-delivery (no ledger, no live assignment) never competes for an area code;
//   - trip attribution picks the delivery the route was actually driven in.
//
// Run: node test/liveNetworks.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'live_networks_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('live_networks_test');

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
  const AreaAssignment = require('../src/models/AreaAssignment');
  const { liveNetworkVersions } = require('../src/services/liveNetworks');
  const { assignedAreasForTrip } = require('../src/services/assignedAreas');
  await WorkArea.init(); // the 2dsphere index the attribution query rides on
  const app = createApp();

  const project = await Project.create({ name: 'PRJ-025' });
  const ali = new User({ name: 'Ali', email: 'ali@x.com', role: 'user', projectIds: [project._id] });
  await ali.setPassword('pw123456'); await ali.save();
  const token = (await request(app).post('/api/auth/login').send({ email: 'ali@x.com', password: 'pw123456' })).body.token;
  const as = (r) => r.set('Authorization', `Bearer ${token}`);

  const square = (w, s) => ({ type: 'Polygon', coordinates: [[[w, s], [w + 1, s], [w + 1, s + 1], [w, s + 1], [w, s]]] });
  const mkVersion = (label, status, createdAt) => NetworkVersion.create({
    projectId: project._id, label, status, createdAt,
    targetMeters: 100, counts: { areas: 1, links: 1, orphanLinks: 0 },
  });
  const mkArea = async (version, code, name, w, s) => {
    const area = await WorkArea.create({
      projectId: project._id, networkVersionId: version._id, areaCode: code, name,
      geometry: square(w, s), bbox: [w, s, w + 1, s + 1], targetMeters: 100, targetLinks: 1,
    });
    await RoadLink.create({
      projectId: project._id, networkVersionId: version._id, linkId: `${code}-L1`, dirTravel: 'B',
      areaId: area._id, areaCode: code, lengthMeters: 100,
      geometry: { type: 'LineString', coordinates: [[w + 0.2, s + 0.5], [w + 0.8, s + 0.5]] },
    });
    return area;
  };

  // Victoria, delivered twice: an old copy nobody uses any more, and the copy work runs against.
  const vicOld = await mkVersion('VIC (first import)', 'superseded', new Date('2026-08-21'));
  const vicOldArea = await mkArea(vicOld, 'VIC-1', 'Hampton Park - East', 144, -38);
  const vic = await mkVersion('VIC', 'superseded', new Date('2026-08-25'));
  const vicArea = await mkArea(vic, 'VIC-1', 'Hampton Park - East', 144, -38);
  // Queensland top-up, imported last and therefore the active one — different ground entirely.
  const qld = await mkVersion('QLD P2', 'active', new Date('2026-09-25'));
  const qldArea = await mkArea(qld, 'QLD-1', 'Caboolture', 152, -28);

  await AreaAssignment.create({
    projectId: project._id, networkVersionId: vic._id, areaId: vicArea._id, driverId: ali._id,
    areaName: 'Hampton Park - East', areaCode: 'VIC-1', driverName: 'Ali', assignedBy: ali._id,
    assignedAt: new Date('2026-09-01'),
  });

  console.log('\n-- which deliveries are live --');
  const live = (await liveNetworkVersions([project._id])).map((v) => String(v._id));
  assert(live[0] === String(qld._id), 'the active delivery is live, and ranked first');
  assert(live.includes(String(vic._id)), 'a superseded delivery still holding a live assignment is live');
  assert(!live.includes(String(vicOld._id)), 'a stale re-delivery with no ledger and no assignment is not');

  console.log('\n-- the driver app --');
  const mine = await as(request(app).get('/api/tracking/my-areas'));
  assert(mine.status === 200 && mine.body.areas.length === 1,
    'my-areas lists the Victorian area although the active delivery is Queensland');
  assert(mine.body.areas[0].id === String(vicArea._id),
    'and serves the copy from the delivery in use, not the stale first import');

  const roads = await as(request(app).get(`/api/tracking/my-roads?areaId=${vicArea._id}`));
  assert(roads.status === 200 && roads.body.links.length === 1, 'my-roads serves that area\'s roads');
  const stale = await as(request(app).get(`/api/tracking/my-roads?areaId=${vicOldArea._id}`));
  assert(stale.status === 403, 'the stale copy of the same area is still refused');
  const notMine = await as(request(app).get(`/api/tracking/my-roads?areaId=${qldArea._id}`));
  assert(notMine.status === 403, 'an area the driver does not hold is still refused');

  console.log('\n-- trip attribution --');
  const trip = {
    _id: new mongoose.Types.ObjectId(), driverId: ali._id, projectId: project._id,
    startedAt: new Date('2026-09-26T08:00:00Z'), endedAt: new Date('2026-09-26T10:00:00Z'),
  };
  const inVic = await assignedAreasForTrip(trip, [[144.3, -37.5], [144.6, -37.4]]);
  assert(String(inVic.networkVersionId) === String(vic._id),
    'a trip driven in Victoria is measured against the Victorian network');
  assert(inVic.areas.length === 1 && inVic.areas[0].areaCode === 'VIC-1',
    'with the driver\'s Victorian area as the assigned patch');
  const inQld = await assignedAreasForTrip(trip, [[152.4, -27.5]]);
  assert(String(inQld.networkVersionId) === String(qld._id),
    'a trip driven in Queensland goes to the Queensland network, even though the driver holds Victoria');
  const nowhere = await assignedAreasForTrip(trip, [[10, 10]]);
  assert(String(nowhere.networkVersionId) === String(vic._id),
    'a route touching no polygon falls back to the delivery holding the driver\'s areas');

  console.log(`\n🎉 LIVE NETWORKS — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
