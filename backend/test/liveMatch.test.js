// Cleaned km and assigned UKM WHILE a trip runs: services/liveMatcher.js (+ mapMatcher.discardLive).
//
// Under test: the first pass ten minutes in snaps the trip so far and credits its roads (assigned
// UKM, blue roads); later passes snap only the new stretch and append it; nothing runs before the
// interval; a closed trip is left to the map-matcher, whose full match replaces the provisional
// figures; and a trip that closes as too short gives back every road it was credited, which the
// driver who also passed them then claims.
//
// Run: node test/liveMatch.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'live_match_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol, msg) => assert(a != null && Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b})`);

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('live_match_test');

  // The matcher, stubbed: the trace comes back as its own snapped line. Installed before the
  // workers are loaded, since they take the function at require time.
  const valhalla = require('../src/services/valhalla');
  const { haversineMeters, lineLength } = require('../src/utils/geo');
  let matchCalls = [];
  valhalla.matchTrace = async (pts) => {
    matchCalls.push(pts.length);
    let m = 0;
    for (let i = 1; i < pts.length; i++) m += haversineMeters(pts[i - 1], pts[i]);
    return { distanceMeters: m, matchedMeters: m, totalMeters: m, shapes: [valhalla.encodePolyline6(pts.map((p) => ({ lat: p.lat, lon: p.lon })))] };
  };

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const WorkArea = require('../src/models/WorkArea');
  const RoadLink = require('../src/models/RoadLink');
  const AreaAssignment = require('../src/models/AreaAssignment');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const LocationPoint = require('../src/models/LocationPoint');
  await RoadLink.syncIndexes();
  await LinkCoverage.syncIndexes();
  const live = require('../src/services/liveMatcher');
  const { processTrip } = require('../src/services/mapMatcher');
  const { attributeTripLinks } = require('../src/services/linkCoverage');

  // A street along lon 8: L1 (50.000-50.002) and L2 (50.002-50.004) inside the driver's polygon,
  // L3 (50.006-50.008) outside it.
  const line = (lon, a, b) => { const out = []; for (let i = a; i <= b; i++) out.push([lon, 50 + i * 0.001]); return out; };
  const project = await Project.create({ name: 'HE Drive' });
  const version = await NetworkVersion.create({ projectId: project._id, label: 'v1', status: 'active' });
  const area = await WorkArea.create({
    projectId: project._id, networkVersionId: version._id, areaCode: 'SA2-1', name: 'Wallan',
    geometry: { type: 'Polygon', coordinates: [[[7.99, 49.999], [8.01, 49.999], [8.01, 50.005], [7.99, 50.005], [7.99, 49.999]]] },
    bbox: [7.99, 49.999, 8.01, 50.005],
  });
  const mkLink = (linkId, coords, areaId) => RoadLink.create({
    projectId: project._id, networkVersionId: version._id, linkId, dirTravel: 'B', areaId, areaCode: areaId ? 'SA2-1' : null,
    geometry: { type: 'LineString', coordinates: coords }, lengthMeters: lineLength(coords),
  });
  const L1 = await mkLink('L1', line(8, 0, 2), area._id);
  const L2 = await mkLink('L2', line(8, 2, 4), area._id);
  await mkLink('L3', line(8, 6, 8), null);

  let seq = 0;
  const mkDriver = async (name) => {
    const u = new User({ name, email: `${name}@x.com`, role: 'user', projectIds: [project._id] });
    await u.setPassword('pw123456');
    await u.save();
    return u;
  };
  const dan = await mkDriver('dan');
  await AreaAssignment.create({ projectId: project._id, networkVersionId: version._id, areaId: area._id, driverId: dan._id, areaCode: 'SA2-1', assignedAt: new Date(Date.now() - 864e5) });

  const minAgo = (m) => new Date(Date.now() - m * 60_000);
  /** Fixes every ~22 m along lon 8 from `fromLat` to `toLat`, one a minute ending `endMin` ago. */
  const drive = async (trip, fromLat, toLat, endMin) => {
    const n = Math.round((toLat - fromLat) / 0.0002);
    const docs = [];
    for (let i = 0; i <= n; i++) {
      docs.push({ tripId: trip._id, driverId: trip.driverId, lat: fromLat + i * 0.0002, lon: 8, accuracy: 5, recordedAt: minAgo(endMin + (n - i) * 0.5) });
    }
    await LocationPoint.insertMany(docs);
    await Trip.updateOne({ _id: trip._id }, { $inc: { distanceMeters: n * 22.2, pointCount: docs.length } });
  };
  const owner = async (linkId) => (await LinkCoverage.findOne({ linkId, networkVersionId: version._id }).lean())?.firstTripId;
  const reload = (t) => Trip.findById(t._id).lean();

  console.log('\n── a running trip, ten minutes in ──');
  const trip = await Trip.create({ clientTripId: `t${++seq}`, driverId: dan._id, projectId: project._id, status: 'active', startedAt: minAgo(30), distanceMeters: 0 });
  await drive(trip, 50.0, 50.002, 20);
  let counts = await live.tick();
  let t = await reload(trip);
  assert(counts.matched === 1 && t.liveMatch && t.liveMatch.passes === 1, `the first pass runs (${JSON.stringify(counts)})`);
  near(t.cleanedDistanceMeters, 222.4, 2, 'cleaned distance so far, while the trip is still running');
  assert(t.status === 'active' && t.mapMatchStatus === 'pending', 'the trip stays running and still waits for its full match');
  assert(String(await owner('L1')) === String(trip._id) && !(await owner('L2')), 'the road driven so far is credited (blue), the rest not yet');
  near(t.linkUkmMeters, L1.lengthMeters, 1, 'assigned UKM so far');
  assert(t.ukmBasis === 'assigned' && t.effectiveUkmMeters != null, 'on the assigned basis, with the effective figure filled in');

  counts = await live.tick();
  assert(!counts.matched, 'nothing again before the interval is up');

  console.log('\n── the next pass snaps only the new stretch ──');
  await drive(trip, 50.0022, 50.004, 2);
  await Trip.updateOne({ _id: trip._id }, { $set: { 'liveMatch.at': minAgo(11) } });
  matchCalls = [];
  counts = await live.tick();
  t = await reload(trip);
  assert(counts.matched === 1 && t.liveMatch.passes === 2, 'the second pass runs after the interval');
  assert(matchCalls[0] <= 11, `only the new fixes (and the one it joins on) are sent to the matcher (got ${matchCalls[0]})`);
  near(t.cleanedDistanceMeters, 444.8, 3, 'cleaned distance grows with the drive');
  assert(t.cleanedRouteShapes.length === 2, 'the new stretch is appended to the route, not a re-snap of all of it');
  assert(String(await owner('L2')) === String(trip._id), 'the new road is credited');
  near(t.linkUkmMeters, L1.lengthMeters + L2.lengthMeters, 2, 'assigned UKM grows with it');

  console.log('\n── the trip ends: the full match takes over ──');
  await Trip.updateOne({ _id: trip._id }, { $set: { status: 'completed', endedAt: new Date() } });
  assert((await live.livePass(trip._id)) === 'gone', 'a closed trip is left alone by the live matcher');
  matchCalls = [];
  await processTrip(trip._id);
  t = await reload(trip);
  assert(t.mapMatchStatus === 'matched' && matchCalls.length === 1 && matchCalls[0] >= 20, 'the map-matcher re-snaps the WHOLE trace once it has closed');
  assert(t.cleanedRouteShapes.length === 1, 'and its route replaces the provisional pieces');
  assert(String(await owner('L1')) === String(trip._id) && String(await owner('L2')) === String(trip._id), 'the roads stay credited to the trip');
  near(t.linkUkmMeters, L1.lengthMeters + L2.lengthMeters, 2, 'with the same assigned UKM');

  console.log('\n── a trip that closes as too short gives its roads back ──');
  const sam = await mkDriver('sam');
  const blip = await Trip.create({ clientTripId: `t${++seq}`, driverId: sam._id, projectId: project._id, status: 'active', startedAt: minAgo(40), distanceMeters: 0 });
  await drive(blip, 50.006, 50.008, 25);
  await live.tick();
  assert(String(await owner('L3')) === String(blip._id), 'the running trip was credited L3');
  // Dan drives L3 later in a finished trip: a pass, since Sam's trip got there first.
  const later = await Trip.create({
    clientTripId: `t${++seq}`, driverId: dan._id, projectId: project._id, status: 'completed', startedAt: minAgo(10), endedAt: minAgo(5),
    mapMatchStatus: 'matched', cleanedMatchedRatio: 1, cleanedDistanceMeters: 222,
    cleanedRouteShapes: [valhalla.encodePolyline6(line(8, 6, 8).map(([lon, lat]) => ({ lat, lon })))],
  });
  await attributeTripLinks(later._id);
  assert(String(await owner('L3')) === String(blip._id), 'Dan\'s later drive over L3 is a pass, not the claim');
  await Trip.updateOne({ _id: blip._id }, { $set: { status: 'completed', endedAt: new Date(), distanceMeters: 10 } });
  await processTrip(blip._id);
  const b = await reload(blip);
  assert(b.mapMatchStatus === 'skipped', 'it is skipped as too short');
  assert(b.cleanedDistanceMeters == null && !b.cleanedRouteShapes && b.linkUkmNetworkMeters == null, 'its provisional route and figures are gone');
  assert(String(await owner('L3')) === String(later._id), 'and L3 goes to the driver who really drove it next');

  console.log(`\n🎉 LIVE MATCH VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
