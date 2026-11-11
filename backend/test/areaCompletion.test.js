// Area completion: a manager's verdict that a work area is finished, and the assignment rules
// that verdict enforces.
//
// The rules under test: completion is keyed by the customer's areaCode within a coverage cycle
// (so it survives the next network import); signing an area off releases its drivers, including
// rows left pointing at an older version's polygon; a completed area cannot be handed to anyone
// else without an explicit override; and two drivers may not hold one polygon at once, while a
// straight handover from one driver to another still works.
//
// Run: npm run test:area-completion
process.env.JWT_SECRET = process.env.JWT_SECRET || 'area_completion_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('area_completion_test');

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const AreaCompletion = require('../src/models/AreaCompletion');
  const app = createApp();

  const project = await Project.create({ name: 'Victoria' });
  const admin = new User({ name: 'Ops Manager', email: 'ops@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const token = (await request(app).post('/api/auth/login').send({ email: 'ops@x.com', password: 'pw123456' })).body.token;
  const as = (r) => r.set('Authorization', `Bearer ${token}`);

  const mkDriver = async (name, email) => {
    const u = new User({ name, email, role: 'user', projectIds: [project._id] });
    await u.setPassword('pw123456'); await u.save();
    return u;
  };
  const dan = await mkDriver('Dan', 'dan@x.com');
  const mo = await mkDriver('Mo', 'mo@x.com');

  // An older import and the live one, both holding the same real suburb (areaCode SA2-1) — the
  // shape this project is actually in, with five versions behind it.
  const old = await NetworkVersion.create({ projectId: project._id, label: 'v1', status: 'superseded' });
  const version = await NetworkVersion.create({
    projectId: project._id, label: 'v2', status: 'active',
    targetMeters: 1500, counts: { areas: 2, links: 20, orphanLinks: 0 },
  });
  const square = (x, y) => ({
    type: 'Polygon',
    coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]],
  });
  const oldArea = await WorkArea.create({
    projectId: project._id, networkVersionId: old._id, areaCode: 'SA2-1', name: 'Wallan',
    geometry: square(0, 0), targetMeters: 1000, targetLinks: 10,
  });
  const area = await WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: 'SA2-1', name: 'Wallan',
    geometry: square(0, 0), bbox: [0, 0, 1, 1], targetMeters: 1000, targetLinks: 10,
  });
  const other = await WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: 'SA2-2', name: 'Lara',
    geometry: square(2, 2), bbox: [2, 2, 3, 3], targetMeters: 500, targetLinks: 5,
  });

  // Wallan's 1000 m as five real links, three of them driven: 600 m first-covered by Dan, 150 m
  // by Mo, 250 m still outstanding.
  let n = 0;
  const RoadLink = require('../src/models/RoadLink');
  const mkLink = async (meters) => {
    const linkId = `L${++n}`;
    await RoadLink.create({
      projectId: project._id, networkVersionId: version._id, linkId, dirTravel: 'B',
      areaId: area._id, areaCode: 'SA2-1', lengthMeters: meters,
      geometry: { type: 'LineString', coordinates: [[0.1 * n, 0.1], [0.1 * n, 0.2]] },
    });
    return linkId;
  };
  const cover = async (driver, meters) => LinkCoverage.create({
    networkVersionId: version._id, linkId: await mkLink(meters), projectId: project._id,
    areaId: area._id, lengthMeters: meters, firstDriverId: driver._id,
    firstTripId: new mongoose.Types.ObjectId(), firstAt: new Date(), passes: 1,
  });
  await cover(dan, 400); await cover(dan, 200); await cover(mo, 150);
  await mkLink(150); await mkLink(100); // never driven — what is left to do

  console.log('\n-- the click-a-polygon panel --');
  const cov = await as(request(app).get(`/api/network/versions/${version._id}/areas/${area._id}/coverage`));
  assert(cov.status === 200 && Math.round(cov.body.coveredMeters) === 750, `750 m covered (got ${cov.body.coveredMeters})`);
  assert(Math.round(cov.body.pct) === 75, `75% of the area (got ${cov.body.pct})`);
  const danRow = cov.body.byDriver.find((d) => d.name === 'Dan');
  assert(danRow && danRow.meters === 600, `the per-driver split credits Dan with 600 m (got ${danRow && danRow.meters})`);
  assert(cov.body.byDriver.find((d) => d.name === 'Mo').meters === 150, 'and Mo with the 150 m he reached first');

  console.log('\n-- assigning --');
  const assign = (driverIds, extra = {}) => as(request(app).put(`/api/network/versions/${version._id}/assignments`))
    .send({ areaIds: [String(area._id)], driverIds, mode: 'set', ...extra });

  assert((await assign([String(dan._id)])).status === 200, 'Dan takes Wallan');
  const both = await assign([String(dan._id), String(mo._id)]);
  assert(both.status === 409 && both.body.blockers[0].reason === 'multiple_drivers',
    'two drivers on one polygon is refused — a work area belongs to one driver');
  const forced = await assign([String(dan._id), String(mo._id)], { override: true });
  assert(forced.status === 409 && forced.body.blockers[0].reason === 'multiple_drivers',
    'and an admin override does NOT clear it — one driver per area is an invariant, not a preference');
  assert(both.body.canOverride === false, 'the response says so rather than dangling an override');

  assert((await assign([String(mo._id)])).status === 200,
    'but a handover Dan to Mo works — the case where a driver stops driving or leaves the company');
  assert((await AreaAssignment.countDocuments({ areaId: area._id, releasedAt: null })) === 1,
    'and leaves exactly one holder');

  // What the new driver sees on the phone. This is the whole point of a fleet-wide ledger: Mo
  // inherits Dan's 600 m as already done and is shown only what is left to drive.
  const { getDriverRoads } = require('../src/services/driverRoads');
  const roads = await getDriverRoads({ driverId: mo._id, projectIds: [project._id], areaId: area._id });
  assert(roads !== null, 'the new holder is entitled to the area on his phone');
  const coveredForMo = (roads.links || []).filter((l) => l[2] === 1).length;
  const todoForMo = (roads.links || []).filter((l) => l[2] === 0).length;
  assert(coveredForMo === 3,
    `all 3 already-driven links read as covered for Mo, including the 2 Dan drove (got ${coveredForMo})`);
  assert(todoForMo === 2, `and only the 2 undriven links are left for him to drive (got ${todoForMo})`);

  // The same picture on the admin map's "Assigned routes" layer — every road in a held area,
  // at any zoom, with the driven ones flagged.
  const assigned = await as(request(app).get(`/api/network/versions/${version._id}/assigned-links`));
  assert(assigned.status === 200 && assigned.body.links.length === 5,
    `assigned routes carry all 5 roads of the held area (got ${assigned.body.links.length})`);
  assert(assigned.body.links.filter((l) => l[2] === 1).length === 3,
    'with the 3 driven ones flagged covered — red/blue on the map without a second request');
  assert(assigned.body.areas === 1, 'and it reports how many areas it drew');
  assert(Array.isArray(assigned.body.links[0][3]) && assigned.body.links[0][3].length >= 2,
    'geometry arrives as positional tuples, not GeoJSON — key names would outweigh coordinates here');

  // A row left over from the previous import: same suburb, previous version's polygon id.
  await AreaAssignment.create({
    projectId: project._id, networkVersionId: old._id, areaId: oldArea._id, driverId: dan._id,
    areaName: 'Wallan', areaCode: 'SA2-1', driverName: 'Dan', assignedBy: admin._id, assignedAt: new Date(),
  });

  console.log('\n-- the manager signs it off --');
  const done = await as(request(app).post(`/api/network/versions/${version._id}/areas/${area._id}/complete`))
    .send({ note: 'Remainder is a gated estate and two private lanes' });
  assert(done.status === 200 && done.body.completion.status === 'completed', 'the area is marked completed');
  assert(Math.round(done.body.completion.pctAtCompletion) === 75,
    `the verdict records what the ledger actually said — 75%, not 100 (got ${done.body.completion.pctAtCompletion})`);
  assert(done.body.completion.completedByDriverName === 'Dan',
    'and credits the driver who first-covered the most of it');
  assert(done.body.releasedAssignments === 2,
    `signing off releases the drivers, stale older-version rows included (got ${done.body.releasedAssignments})`);
  assert((await AreaAssignment.countDocuments({ areaCode: 'SA2-1', releasedAt: null })) === 0,
    'so the roads leave every holding driver phone');

  console.log('\n-- a completed area is not handed to anyone else --');
  const after = await assign([String(dan._id)]);
  assert(after.status === 409 && after.body.blockers[0].reason === 'completed',
    'assigning a completed area is refused');
  assert(after.body.blockers[0].message.includes('Ops Manager'), 'and the refusal names who signed it off');
  assert(after.body.canOverride === true, 'an admin is told they may override');
  assert((await assign([String(dan._id)], { override: true })).status === 200,
    'and an explicit override goes through — a wrongly-completed area must not be a dead end');

  console.log('\n-- the rest of the panel agrees --');
  const areas = await as(request(app).get(`/api/network/versions/${version._id}/areas`));
  const row = areas.body.areas.find((a) => a.areaCode === 'SA2-1');
  assert(row.completed === true && row.completedByName === 'Ops Manager', 'the areas table shows it completed');
  assert(areas.body.areas.find((a) => a.areaCode === 'SA2-2').completed === false, 'and Lara is untouched');
  const geo = await as(request(app).get(`/api/network/versions/${version._id}/areas.geojson`));
  assert(geo.body.features.find((f) => f.properties.areaCode === 'SA2-1').properties.completed === true,
    'the choropleth carries it too, so a signed-off polygon reads as finished at a glance');
  const summary = await as(request(app).get(`/api/network/versions/${version._id}`));
  assert(summary.body.coverage.completedAreas === 1, `the stat strip counts 1 completed (got ${summary.body.coverage.completedAreas})`);

  console.log('\n-- reopening --');
  const re = await as(request(app).post(`/api/network/versions/${version._id}/areas/${area._id}/reopen`))
    .send({ reason: 'Customer added streets in this suburb' });
  assert(re.status === 200 && re.body.completion.status === 'reopened', 'the area reopens');
  assert((await assign([String(mo._id)])).status === 200, 'and is assignable again with no override');
  assert((await AreaCompletion.countDocuments({ areaCode: 'SA2-1' })) === 1,
    'the verdict is one row that flips, so who signed what off and when is never lost');

  const stillThere = await as(request(app).post(`/api/network/versions/${version._id}/areas/${other._id}/reopen`)).send({});
  assert(stillThere.status === 404, 'reopening an area that was never completed is a 404, not a silent no-op');

  console.log('\n-- driven tracks on the coverage map --');
  const Trip = require('../src/models/Trip');
  const { encodePolyline6 } = require('../src/services/valhalla');
  const shape = encodePolyline6([{ lat: 0.1, lon: 0.1 }, { lat: 0.2, lon: 0.1 }]);
  const day = (n) => new Date(Date.now() - n * 86400000);
  const mkTrip = (driver, startedAt, extra) => Trip.create({
    clientTripId: `trip-${Math.random()}`, driverId: driver._id, projectId: project._id,
    status: 'completed', startedAt, endedAt: new Date(startedAt.getTime() + 3600000), ...extra,
  });
  await mkTrip(dan, day(2), {
    mapMatchStatus: 'matched', cleanedRouteShapes: [shape], cleanedDistanceMeters: 4200,
    assignedAreaIds: [area._id],
  });
  await mkTrip(mo, day(3), { mapMatchStatus: 'matched', cleanedRouteShapes: [shape], cleanedDistanceMeters: 1500 });
  await mkTrip(dan, day(1), { mapMatchStatus: 'pending' });            // still snapping
  await mkTrip(dan, day(40), { mapMatchStatus: 'matched', cleanedRouteShapes: [shape] }); // outside the window

  const tracks = await as(request(app).get(
    `/api/network/versions/${version._id}/tracks?from=${day(14).toISOString()}&to=${day(0).toISOString()}`
  ));
  assert(tracks.status === 200 && tracks.body.tracks.length === 2,
    `only the 2 snapped trips inside the window are drawn (got ${tracks.body.tracks.length})`);
  assert(tracks.body.pendingSnap === 1,
    'the unsnapped trip is counted, not drawn — raw GPS over a road network would read as coverage');
  assert(tracks.body.tracks.every((t) => t.shapes.length > 0 && t.driverName),
    'each track carries its polyline and the driver it belongs to');

  const areaTracks = await as(request(app).get(
    `/api/network/versions/${version._id}/tracks?from=${day(14).toISOString()}&to=${day(0).toISOString()}&areaId=${area._id}`
  ));
  assert(areaTracks.body.tracks.length === 1,
    `filtering by area narrows it to trips recorded while that polygon was assigned (got ${areaTracks.body.tracks.length})`);

  const tooWide = await as(request(app).get(
    `/api/network/versions/${version._id}/tracks?from=${day(200).toISOString()}&to=${day(0).toISOString()}`
  ));
  assert(tooWide.status === 200, 'a wide range is answered — the 90-day cap was removed on 2026-11-11');

  // An imported day is real work with real geometry and no handset: mapMatchStatus stays
  // 'skipped' because the matcher genuinely never ran on it. Gating the layer on 'matched'
  // hid 478 days of driven road, so the rule is "has a cleaned route", not "was matched".
  await mkTrip(mo, day(4), {
    mapMatchStatus: 'skipped', importBatchId: 'test-import',
    cleanedRouteShapes: [shape], cleanedDistanceMeters: 9100,
  });
  const withImported = await as(request(app).get(
    `/api/network/versions/${version._id}/tracks?from=${day(14).toISOString()}&to=${day(0).toISOString()}`
  ));
  assert(withImported.body.tracks.length === 3,
    `an imported day is drawn too — it has snapped geometry, just not from the matcher (got ${withImported.body.tracks.length})`);
  assert(withImported.body.pendingSnap === 1,
    'and it is NOT counted as still snapping: there is nothing left to snap');

  console.log('\n-- holders are read the way the phone reads them: by area code --');
  const bulk = (areaIds, driverIds, extra = {}) => as(request(app).put(`/api/network/versions/${version._id}/assignments`))
    .send({ areaIds: areaIds.map(String), driverIds: driverIds.map(String), mode: 'set', ...extra });
  const holdersOf = async (code) => (await AreaAssignment.find({ areaCode: code, releasedAt: null }).lean()).map((r) => String(r.driverId));
  // Mo holds Wallan on the live delivery; Dan is still recorded on the OLDER delivery's copy of it.
  // The phone gives Wallan to both — and the save used to see only Mo, so a handover left Dan on it.
  await AreaAssignment.create({
    projectId: project._id, networkVersionId: old._id, areaId: oldArea._id, driverId: dan._id,
    areaName: 'Wallan', areaCode: 'SA2-1', driverName: 'Dan', assignedBy: admin._id, assignedAt: new Date(),
  });
  assert((await bulk([area._id], [mo._id])).status === 200, 'setting Wallan to Mo saves');
  let wallan = await holdersOf('SA2-1');
  assert(wallan.length === 1 && wallan[0] === String(mo._id),
    `and releases Dan's row on the older delivery too — one holder, as the phone sees it (got ${wallan.length})`);

  await AreaAssignment.updateMany({ areaCode: 'SA2-1', releasedAt: null }, { $set: { releasedAt: new Date() } });
  await AreaAssignment.create({
    projectId: project._id, networkVersionId: old._id, areaId: oldArea._id, driverId: dan._id,
    areaName: 'Wallan', areaCode: 'SA2-1', driverName: 'Dan', assignedBy: admin._id, assignedAt: new Date(),
  });
  const addMo = await as(request(app).put(`/api/network/versions/${version._id}/assignments`))
    .send({ areaIds: [String(area._id)], driverIds: [String(mo._id)], mode: 'add' });
  assert(addMo.status === 409 && addMo.body.blockers[0].reason === 'multiple_drivers',
    'adding Mo beside Dan is refused even though Dan is recorded on another delivery’s copy of Wallan');
  assert((await bulk([area._id], [dan._id])).status === 200, 'setting it to Dan, who already holds it, is fine');
  wallan = await holdersOf('SA2-1');
  assert(wallan.length === 1 && wallan[0] === String(dan._id), 'and leaves him holding it once');

  console.log('\n-- several areas at once, one of them signed off --');
  const laraDone = await as(request(app).post(`/api/network/versions/${version._id}/areas/${other._id}/complete`)).send({});
  assert(laraDone.status === 200, 'Lara is signed off');
  const strict = await bulk([area._id, other._id], [mo._id]);
  assert(strict.status === 409 && strict.body.blockers.some((b) => b.areaCode === 'SA2-2' && b.reason === 'completed'),
    'without skipCompleted the whole save is refused, as before');
  assert((await holdersOf('SA2-1'))[0] === String(dan._id), 'and nothing moved');
  const lenient = await bulk([area._id, other._id], [mo._id], { skipCompleted: true });
  assert(lenient.status === 200, 'with skipCompleted the open area is saved');
  assert(lenient.body.skipped.length === 1 && lenient.body.skipped[0].areaCode === 'SA2-2',
    'and the signed-off one is named as left out');
  assert((await holdersOf('SA2-2')).length === 0, 'nobody was put on the signed-off area');
  wallan = await holdersOf('SA2-1');
  assert(wallan.length === 1 && wallan[0] === String(mo._id), 'Wallan went from Dan to Mo');
  const allDone = await bulk([other._id], [dan._id], { skipCompleted: true });
  assert(allDone.status === 200 && allDone.body.added === 0 && allDone.body.skipped.length === 1,
    'a selection of only signed-off areas changes nothing and says why');

  console.log('\n-- a zone cut from an area is held by whoever holds the area --');
  const kilmoreOld = await WorkArea.create({
    projectId: project._id, networkVersionId: old._id, areaCode: 'SA2-9', name: 'Kilmore',
    geometry: square(4, 4), bbox: [4, 4, 5, 5], targetMeters: 100, targetLinks: 1,
  });
  const zone = await WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: 'SA2-9-02', name: 'Kilmore (rest)',
    geometry: square(4, 4), bbox: [4, 4, 5, 5], targetMeters: 100, targetLinks: 1,
    props: { splitFrom: { code: 'SA2-9', name: 'Kilmore', cut: true } },
  });
  await AreaAssignment.create({
    projectId: project._id, networkVersionId: old._id, areaId: kilmoreOld._id, driverId: dan._id,
    areaName: 'Kilmore', areaCode: 'SA2-9', driverName: 'Dan', assignedBy: admin._id, assignedAt: new Date(),
  });
  const clash = await bulk([zone._id], [mo._id]);
  assert(clash.status === 409 && clash.body.blockers[0].reason === 'multiple_drivers'
    && clash.body.blockers[0].drivers.some((d) => d.startsWith('Dan')),
    'giving Mo a zone of Dan’s area is refused — Dan’s phone already has it');
  assert((await holdersOf('SA2-9')).length === 1, 'and Dan keeps the whole area');
  const single = await as(request(app).put(`/api/network/versions/${version._id}/areas/${zone._id}/assignments`))
    .send({ driverIds: [String(mo._id)] });
  assert(single.status === 409 && single.body.blockers[0].reason === 'multiple_drivers',
    'the one-area endpoint reads it the same way');
  assert((await bulk([zone._id], [dan._id])).status === 200, 'giving the zone to Dan himself is fine — one holder, not two');

  console.log('\n-- re-figuring earlier trips after an assignment --');
  const { recomputeForAssignment, queueRecomputeForAssignment, assignmentQueueIdle } = require('../src/services/linkCoverage');
  await assignmentQueueIdle(); // the saves above queued their own work
  const floorTrip = await mkTrip(mo, day(5), { importBatchId: 'vtsfloor-test', linkUkmNetworkMeters: 0 });
  const realTrip = await mkTrip(mo, day(6), {});
  for (const t of [floorTrip, realTrip]) {
    await LinkCoverage.create({
      networkVersionId: version._id, linkId: await mkLink(80), projectId: project._id, areaId: area._id,
      lengthMeters: 80, firstDriverId: mo._id, firstTripId: t._id, firstAt: new Date(), passes: 1,
    });
  }
  const redo = await recomputeForAssignment(project._id, [{ driverId: mo._id, areaCode: 'SA2-1' }]);
  assert(!(await Trip.findById(floorTrip._id).lean()).linkCoverageComputedAt,
    'a VTS floor placeholder is never re-figured — it has no points to measure');
  assert((await Trip.findById(realTrip._id).lean()).linkCoverageComputedAt && redo.trips === 1,
    `a real trip that owns a road there is (re-figured ${redo.trips})`);
  const q1 = queueRecomputeForAssignment(project._id, [{ driverId: mo._id, areaCode: 'SA2-1' }]);
  const q2 = queueRecomputeForAssignment(project._id, [{ driverId: mo._id, areaCode: 'SA2-1' }]);
  assert(q1 === 1 && q2 === 1, 'the same driver + area queued twice is one piece of work');
  await assignmentQueueIdle();
  assert(true, 'and the background queue drains');

  console.log(`\n🎉 AREA COMPLETION VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch((e) => { console.error(e); process.exit(1); });
