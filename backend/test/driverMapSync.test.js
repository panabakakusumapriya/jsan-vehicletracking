// Driver map sync: the two small reads the phone uses to keep its red/blue map current.
//
//   GET /api/tracking/my-roads/version  — "has any area changed colour?"
//   GET /api/tracking/my-trips/settled  — "has the server finished these trips?"
//
// The rules under test: the probe's version is byte-identical to the one my-roads hands out (if
// they ever disagree the phone refetches forever or never again, and neither failure announces
// itself); the version carries the geometry format, so a change in what is served forces a
// refetch; the probe enforces entitlement exactly like my-roads; and a trip is only "settled"
// when the server genuinely has a verdict — a FAILED match is not one, because nothing retries it
// and treating it as final repaints streets the driver really drove.
//
// Run: node test/driverMapSync.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'driver_map_sync_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('driver_map_sync_test');

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
  const Trip = require('../src/models/Trip');
  const { clearVersionMemo, SIMPLIFY_TOLERANCE_METERS } = require('../src/services/driverRoads');
  const app = createApp();

  const project = await Project.create({ name: 'Queensland' });
  const mkUser = async (name, email) => {
    const u = new User({ name, email, role: 'user', projectIds: [project._id] });
    await u.setPassword('pw123456'); await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
    return { u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const dan = await mkUser('Dan', 'dan@x.com');
  const mo = await mkUser('Mo', 'mo@x.com');

  const version = await NetworkVersion.create({
    projectId: project._id, label: 'v1', status: 'active',
    targetMeters: 300, counts: { areas: 1, links: 3, orphanLinks: 0 },
  });
  const area = await WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: 'SA2-9', name: 'Maleny',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
    bbox: [0, 0, 1, 1], targetMeters: 300, targetLinks: 3,
  });
  for (let i = 1; i <= 3; i++) {
    await RoadLink.create({
      projectId: project._id, networkVersionId: version._id, linkId: `L${i}`, dirTravel: 'B',
      areaId: area._id, areaCode: 'SA2-9', lengthMeters: 100,
      // Three vertices, one of them nearly collinear — what a simplifier would have removed.
      geometry: { type: 'LineString', coordinates: [[0.1 * i, 0.1], [0.1 * i, 0.15000001], [0.1 * i, 0.2]] },
    });
  }
  await AreaAssignment.create({
    projectId: project._id, networkVersionId: version._id, areaId: area._id, driverId: dan.u._id,
    areaName: 'Maleny', areaCode: 'SA2-9', driverName: 'Dan', assignedBy: dan.u._id, assignedAt: new Date(),
  });

  const roadsVersion = async (who) => (await who.as(request(app).get(`/api/tracking/my-roads?areaId=${area._id}`))).body.version;
  const probe = (who) => who.as(request(app).get(`/api/tracking/my-roads/version?areaId=${area._id}`));

  console.log('\n-- the version probe --');
  clearVersionMemo();
  const p0 = await probe(dan);
  const v0 = await roadsVersion(dan);
  assert(p0.status === 200 && typeof p0.body.version === 'string', 'the probe answers for an assigned area');
  assert(p0.body.version === v0, `the probe and my-roads agree exactly (${p0.body.version} vs ${v0})`);
  assert(v0.endsWith(`.g${SIMPLIFY_TOLERANCE_METERS}`),
    'the version carries the geometry format, so a format change forces every phone to refetch once');
  assert(!/"links"/.test(JSON.stringify(p0.body)), 'the probe ships no roads at all');

  const roads = (await dan.as(request(app).get(`/api/tracking/my-roads?areaId=${area._id}`))).body;
  assert(roads.links.every((l) => l[3].length === 3),
    'roads arrive unsimplified — the on-device matcher measures its 11 m buffer against these');

  // Coverage lands. my-roads sees it at once; the probe may lag by its memo, never more.
  await LinkCoverage.create({
    networkVersionId: version._id, linkId: 'L1', projectId: project._id, areaId: area._id,
    lengthMeters: 100, firstDriverId: mo.u._id, firstTripId: new mongoose.Types.ObjectId(),
    firstAt: new Date(), passes: 1,
  });
  const v1 = await roadsVersion(dan);
  assert(v1 !== v0, 'another driver covering a street in the area moves the version');
  const p1 = await probe(dan);
  assert(p1.body.version === v1,
    'and a full read refreshes the probe, so a phone that just downloaded never sees an older key');
  clearVersionMemo();
  await LinkCoverage.deleteMany({ linkId: 'L1' });
  const p2 = await probe(dan);
  assert(p2.body.version === v0, 'with the memo cold, the probe reads the ledger and matches what is there now');

  const refused = await probe(mo);
  assert(refused.status === 403, 'a driver not holding the area is refused, exactly as my-roads refuses them');
  const bad = await dan.as(request(app).get('/api/tracking/my-roads/version?areaId=nope'));
  assert(bad.status === 400, 'a malformed area id is a 400, not a 500');

  console.log('\n-- which trips the server has finished --');
  const mkTrip = (driver, clientTripId, extra) => Trip.create({
    clientTripId, driverId: driver.u._id, projectId: project._id,
    status: 'completed', startedAt: new Date(Date.now() - 3600000), endedAt: new Date(), ...extra,
  });
  await mkTrip(dan, 'aaaaaaaa-0001', { mapMatchStatus: 'matched', linkCoverageStatus: 'computed' });
  await mkTrip(dan, 'aaaaaaaa-0002', { mapMatchStatus: 'matched', linkCoverageStatus: 'pending' });
  await mkTrip(dan, 'aaaaaaaa-0003', { mapMatchStatus: 'failed', linkCoverageStatus: 'pending' });
  await mkTrip(dan, 'aaaaaaaa-0004', { mapMatchStatus: 'matched', linkCoverageStatus: 'failed' });
  await mkTrip(dan, 'aaaaaaaa-0005', { mapMatchStatus: 'skipped', linkCoverageStatus: 'pending' });
  await mkTrip(dan, 'aaaaaaaa-0006', { mapMatchStatus: 'matched', linkCoverageStatus: 'no_network' });
  await mkTrip(dan, 'aaaaaaaa-0007', { status: 'active', mapMatchStatus: 'pending', linkCoverageStatus: 'pending' });
  await mkTrip(mo, 'bbbbbbbb-0001', { mapMatchStatus: 'matched', linkCoverageStatus: 'computed' });

  const ids = ['aaaaaaaa-0001', 'aaaaaaaa-0002', 'aaaaaaaa-0003', 'aaaaaaaa-0004', 'aaaaaaaa-0005',
    'aaaaaaaa-0006', 'aaaaaaaa-0007', 'aaaaaaaa-9999', 'bbbbbbbb-0001'];
  const settled = await dan.as(request(app).get(`/api/tracking/my-trips/settled?ids=${ids.join(',')}`));
  const state = Object.fromEntries(settled.body.trips.map((t) => [t.clientTripId, t.state]));
  assert(settled.status === 200 && settled.body.trips.length === ids.length, 'every asked-about id gets an answer');
  assert(state['aaaaaaaa-0001'] === 'settled', 'attribution computed → settled: the roads payload now has the verdict');
  assert(state['aaaaaaaa-0006'] === 'settled', 'no network to measure against → settled: there will never be a verdict');
  assert(state['aaaaaaaa-0005'] === 'settled', 'nothing to match → settled');
  assert(state['aaaaaaaa-0002'] === 'pending', 'still in the attribution queue → pending');
  assert(state['aaaaaaaa-0003'] === 'pending',
    'a FAILED match is not a verdict — nothing retries it, and settling it would repaint driven streets red');
  assert(state['aaaaaaaa-0004'] === 'pending', 'a failed attribution run is not a verdict either');
  assert(state['aaaaaaaa-0007'] === 'pending', 'a trip still being driven is never settled');
  assert(state['aaaaaaaa-9999'] === 'unknown', 'a trip the server has not heard of yet is unknown — points still queued');
  assert(state['bbbbbbbb-0001'] === 'unknown', "another driver's trip is invisible, even by exact id");

  const junk = await dan.as(request(app).get('/api/tracking/my-trips/settled?ids=$ne,{},'));
  assert(junk.status === 200 && junk.body.trips.length === 0, 'anything that is not a trip id is dropped, not queried');

  console.log(`\n🎉 DRIVER MAP SYNC VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch((e) => { console.error(e); process.exit(1); });
