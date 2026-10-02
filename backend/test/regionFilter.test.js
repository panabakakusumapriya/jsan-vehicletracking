// The coverage page's region filter: "show me Australia", "show me New Zealand".
//
// A project can hold several deliveries of different ground (PRJ-025: Victoria, Queensland, a
// Queensland top-up, Auckland), and the customer's import names do not say which is where — three
// of those four are called the same thing. So each live delivery gets a region, detected from the
// time zone under its work areas (services/deliveryRegions.js) and renamable from the panel, and
// the page reads through a scope of "these deliveries" written as their ids joined with '~'.
//
// Under test: detection and its persistence, which deliveries are live, the '~' scope and what it
// refuses, every number on the page narrowed to the region (summary, sign-offs, assignments,
// areas, map, tracks, drivers), the per-delivery rows, and naming a delivery.
//
// Run: node test/regionFilter.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'region_filter_test_secret_1234567890';
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
  process.env.MONGODB_URI = mongod.getUri('region_filter_test');

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
  const AreaCompletion = require('../src/models/AreaCompletion');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const Trip = require('../src/models/Trip');
  await Promise.all([WorkArea.init(), LinkCoverage.init(), Trip.init()]);
  const app = createApp();

  // ── PRJ-025 in miniature: Victoria and Queensland (superseded, still worked), Auckland (active),
  //    and an older copy of Victoria nobody works from any more. The first three share a name. ──
  const project = await Project.create({ name: 'HE Drive' });
  const other = await Project.create({ name: 'Elsewhere' });
  const SAME = 'PRJ-025-HE-DRIVE-AUSGNZ network';
  const mkVersion = (label, status, areas, km, createdAt) => NetworkVersion.create({
    projectId: project._id, label, status, createdAt,
    counts: { areas, links: areas * 10, orphanLinks: 0 }, targetMeters: km * 1000,
    byPriority: [{ priority: 1, areas, links: areas * 10, meters: km * 1000 }],
    byFuncClass: [{ funcClass: 5, links: areas * 10, meters: km * 1000 }],
  });
  const oldVic = await mkVersion(SAME, 'superseded', 2, 200, new Date('2026-08-21'));
  const vic = await mkVersion(SAME, 'superseded', 2, 200, new Date('2026-08-25'));
  const qld = await mkVersion(SAME, 'superseded', 1, 300, new Date('2026-09-24'));
  const nz = await mkVersion('Auckland (NZ)', 'active', 2, 100, new Date('2026-10-01'));
  const elsewhere = await NetworkVersion.create({ projectId: other._id, label: 'x', status: 'active' });

  const box = (lon, lat, d = 0.02) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]];
  const mkArea = (v, code, name, lon, lat, km) => WorkArea.create({
    projectId: v.projectId, networkVersionId: v._id, areaCode: code, name, priority: 1,
    geometry: { type: 'Polygon', coordinates: box(lon, lat) }, bbox: [lon - 0.02, lat - 0.02, lon + 0.02, lat + 0.02],
    targetMeters: km * 1000, targetLinks: 10,
  });
  await mkArea(oldVic, 'VIC-1', 'Carlton', 144.96, -37.8, 100);
  await mkArea(oldVic, 'VIC-2', 'Brunswick', 144.96, -37.76, 100);
  const carlton = await mkArea(vic, 'VIC-1', 'Carlton', 144.96, -37.8, 100);
  await mkArea(vic, 'VIC-2', 'Brunswick', 144.96, -37.76, 100);
  const southBank = await mkArea(qld, 'QLD-1', 'South Brisbane', 153.02, -27.48, 300);
  const ponsonby = await mkArea(nz, 'AKL-1', 'Ponsonby', 174.74, -36.85, 50);
  await mkArea(nz, 'AKL-2', 'Remuera', 174.8, -36.88, 50);

  const mkUser = async (name, role, projects = [project]) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: projects.map((p) => p._id) });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return { user: u, as: (r) => r.set('Authorization', `Bearer ${token}`) };
  };
  const boss = await mkUser('boss', 'manager');
  const ravi = await mkUser('ravi', 'user');
  const sam = await mkUser('sam', 'user');

  // Victoria is live through its coverage, Queensland through an assignment, Auckland by being active.
  const cover = (v, area, linkId, meters, who, tripId) => LinkCoverage.create({
    projectId: project._id, networkVersionId: v._id, linkId, lengthMeters: meters, areaId: area._id, priority: 1, funcClass: 5,
    firstTripId: tripId || new mongoose.Types.ObjectId(), firstDriverId: who.user._id, firstAt: new Date(),
  });
  await cover(vic, carlton, 'V1', 40_000, ravi);
  await cover(nz, ponsonby, 'N1', 5_000, sam);
  await AreaAssignment.create({ projectId: project._id, networkVersionId: qld._id, areaId: southBank._id, driverId: ravi.user._id, areaCode: 'QLD-1' });
  await AreaAssignment.create({ projectId: project._id, networkVersionId: nz._id, areaId: ponsonby._id, driverId: sam.user._id, areaCode: 'AKL-1' });
  await AreaCompletion.collection.insertOne({ projectId: project._id, areaCode: 'AKL-2', coverageCycleId: '', status: 'completed', completedAt: new Date() });

  const get = (path, who = boss) => who.as(request(app).get(`/api/network${path}`));

  /* ── which deliveries, and where ── */
  const listed = await get(`/versions?projectId=${project._id}`);
  const byId = new Map(listed.body.versions.map((v) => [v._id, v]));
  assert(listed.status === 200 && listed.body.versions.length === 4, 'the project lists its four deliveries');
  assert(byId.get(String(vic._id)).live && byId.get(String(qld._id)).live && byId.get(String(nz._id)).live && !byId.get(String(oldVic._id)).live,
    'three are live; the older copy of Victoria is not');
  assert(byId.get(String(vic._id)).region === 'Australia' && byId.get(String(qld._id)).region === 'Australia' && byId.get(String(nz._id)).region === 'New Zealand',
    'their regions are read off the ground: Australia, Australia, New Zealand — whatever they are called');
  assert(byId.get(String(oldVic._id)).region == null, 'a delivery nobody works from is not looked at');
  const stored = await NetworkVersion.findById(vic._id).lean();
  assert(stored.region === 'Australia' && stored.regionSource === 'auto', 'the detected region is stored, so it is worked out once');

  /* ── the '~' scope ── */
  const AU = `${vic._id}~${qld._id}`;
  const NZ = String(nz._id);
  assert((await get(`/versions/${vic._id}~${elsewhere._id}`)).status === 404, 'deliveries of two different projects are not one scope');
  assert((await get(`/versions/${vic._id}~nonsense`)).status === 404, 'nor is a malformed id');
  assert((await get(`/versions/${vic._id}~${new mongoose.Types.ObjectId()}`)).status === 404, 'nor one that does not exist');
  const outsider = await mkUser('outsider', 'manager', [other]);
  assert((await get(`/versions/${AU}`, outsider)).status === 403, 'a manager of another project may not read it');

  /* ── the numbers, narrowed ── */
  const all = (await get(`/versions/${project._id}`)).body.coverage;
  const au = (await get(`/versions/${AU}`)).body.coverage;
  const nzSum = (await get(`/versions/${NZ}`)).body.coverage;
  assert(all.targetMeters === 600_000 && all.coveredMeters === 45_000 && all.totalAreas === 5, 'everything: 600 km across five areas, 45 km driven');
  assert(au.targetMeters === 500_000 && au.coveredMeters === 40_000 && au.totalAreas === 3, 'Australia: 500 km, three areas, 40 km driven');
  assert(nzSum.targetMeters === 100_000 && nzSum.coveredMeters === 5_000 && nzSum.totalAreas === 2, 'New Zealand: 100 km, two areas, 5 km driven');
  assert(all.completedAreas === 1 && au.completedAreas === 0 && nzSum.completedAreas === 1, 'the Auckland sign-off counts in New Zealand and not in Australia');
  assert(all.assignedAreas === 2 && au.assignedAreas === 1 && nzSum.assignedAreas === 1, 'so do the areas out with a driver');
  assert(au.byPriority.length === 1 && au.byPriority[0].meters === 500_000 && au.byPriority[0].coveredMeters === 40_000, 'the priority bands add up the region\'s deliveries only');
  const rows = new Map(all.byDelivery.map((d) => [d.versionId, d]));
  assert(all.byDelivery.length === 3 && rows.get(String(vic._id)).coveredMeters === 40_000 && rows.get(String(qld._id)).assignedAreas === 1 && rows.get(String(nz._id)).completedAreas === 1,
    'the project-wide summary carries one row per live delivery, each with its own figures');
  assert(rows.get(String(nz._id)).region === 'New Zealand' && rows.get(String(qld._id)).label === SAME, '…with its region and name');
  assert(au.byDelivery.map((d) => d.versionId).sort().join() === [String(vic._id), String(qld._id)].sort().join(), 'a region\'s summary has rows for its own deliveries');

  const areaCodes = async (scope) => (await get(`/versions/${scope}/areas`)).body.areas.map((a) => a.areaCode).sort().join();
  assert((await areaCodes(AU)) === 'QLD-1,VIC-1,VIC-2' && (await areaCodes(NZ)) === 'AKL-1,AKL-2', 'the areas table lists only the region\'s areas');
  const shapes = (await get(`/versions/${AU}/areas.geojson`)).body;
  assert(shapes.features.length === 3 && shapes.bbox[0] > 144 && shapes.bbox[2] < 154, 'the map gets only Australia\'s polygons, and frames Australia');
  const drivers = (await get(`/versions/${NZ}/coverage-drivers`)).body.drivers;
  assert(drivers.length === 1 && drivers[0].name === 'sam', 'the crew list names who drove in New Zealand');
  const held = (await get(`/versions/${AU}/assignments`)).body.assignments;
  assert(held.length === 1 && held[0].areaCode === 'QLD-1', 'the assignments are Australia\'s');
  assert((await get(`/versions/${AU}/areas/${ponsonby._id}/coverage`)).status === 404, 'an Auckland area is not found through the Australia scope');
  assert((await get(`/versions/${NZ}/areas/${ponsonby._id}/coverage`)).body.coveredMeters === 5_000, '…and is through New Zealand\'s');

  /* ── tracks and drivers, by where they drove ── */
  const shape = '_ibE_seK_seK_seK';
  const ago = (min) => new Date(Date.now() - min * 60_000);
  let seq = 0;
  const mkTrip = (who, o) => Trip.create({ clientTripId: `t${++seq}`, driverId: who.user._id, projectId: project._id, status: 'completed', mapMatchStatus: 'matched', ...o });
  await mkTrip(sam, { startedAt: ago(300), endedAt: ago(280), cleanedRouteShapes: [shape], assignedNetworkVersionId: nz._id, lastLocation: { lat: -36.85, lon: 174.74, recordedAt: ago(281) } });
  await mkTrip(sam, { startedAt: ago(100), endedAt: ago(90), cleanedRouteShapes: [shape], assignedNetworkVersionId: vic._id, lastLocation: { lat: -37.8, lon: 144.96, recordedAt: ago(91) } });
  await mkTrip(ravi, { startedAt: ago(60), endedAt: ago(50), mapMatchStatus: 'pending', lastLocation: { lat: -36.86, lon: 174.75, recordedAt: ago(51) } });
  await mkTrip(ravi, { startedAt: ago(40), endedAt: ago(30), cleanedRouteShapes: [shape], lastLocation: { lat: -27.47, lon: 153.02, recordedAt: ago(31) } });
  const tracks = async (scope) => (await get(`/versions/${scope}/tracks`)).body;
  const tAll = await tracks(project._id);
  const tNz = await tracks(NZ);
  const tAu = await tracks(AU);
  assert(tAll.tracks.length === 3 && tAll.pendingSnap === 1, 'everything: three drawn drives, one still snapping');
  assert(tNz.tracks.length === 1 && tNz.tracks[0].driverName === 'sam' && tNz.pendingSnap === 1, 'New Zealand: Sam\'s Auckland drive, and the one still snapping in Auckland');
  assert(tAu.tracks.length === 2 && tAu.pendingSnap === 0, 'Australia: the drive measured against Victoria, and one not yet measured that ended in Brisbane');

  const positions = async (scope) => (await get(`/versions/${scope}/driver-positions`)).body.positions;
  const pNz = await positions(NZ);
  const samNz = pNz.find((p) => p.name === 'sam');
  assert(samNz && samNz.area.areaCode === 'AKL-1', 'on New Zealand\'s map Sam is where he last worked there, though he has since driven in Victoria');
  assert((await positions(project._id)).find((p) => p.name === 'sam').area.areaCode === 'VIC-1', 'on the whole project he is in Victoria');
  const raviNz = pNz.find((p) => p.name === 'ravi');
  assert(raviNz && raviNz.area.areaCode === 'AKL-1', 'Ravi\'s unmeasured Auckland drive puts him in Auckland on New Zealand\'s map');
  assert((await positions(AU)).find((p) => p.name === 'ravi').area.areaCode === 'QLD-1', '…and his Brisbane drive on Australia\'s');

  /* ── naming a delivery ── */
  const patch = (who, id, body) => who.as(request(app).patch(`/api/network/versions/${id}`)).send(body);
  assert((await patch(ravi, qld._id, { label: 'Queensland' })).status === 403, 'a driver may not rename a delivery');
  assert((await patch(outsider, qld._id, { label: 'Queensland' })).status === 403, 'nor may a manager of another project');
  assert((await patch(boss, qld._id, { label: '   ' })).status === 400, 'a delivery cannot be left without a name');
  const named = await patch(boss, qld._id, { label: '  Queensland   top-up ', region: 'Queensland' });
  assert(named.status === 200 && named.body.version.label === 'Queensland top-up' && named.body.version.region === 'Queensland' && named.body.version.regionSource === 'manual',
    'a manager names it and says where it is');
  const relisted = new Map((await get(`/versions?projectId=${project._id}`)).body.versions.map((v) => [v._id, v]));
  assert(relisted.get(String(qld._id)).region === 'Queensland', 'a region a person typed is never detected over');
  const reset = await patch(boss, qld._id, { region: '' });
  assert(reset.status === 200 && reset.body.version.region === 'Australia' && reset.body.version.regionSource === 'auto', 'emptying the region hands it back to detection');
  assert((await get(`/versions/${project._id}`)).body.coverage.byDelivery.find((d) => d.versionId === String(qld._id)).label === 'Queensland top-up', 'the new name is what the summary shows');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
