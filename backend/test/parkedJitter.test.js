// Parked-GPS jitter: services/tripNoise.js and the exclusion it drives everywhere.
//
// The rule under test: a closed session whose fixes never left one spot — net displacement and
// largest pairwise spread both tiny — was not a drive. Nothing drove, so it must be classified as
// such, must claim no road in either coverage engine, must give back any road it claimed before it
// was classified, and must stay out of every report while remaining visible on request
// (?includeNoise=true) and untouched in the database.
//
// Run: npm run test:parked-jitter
process.env.JWT_SECRET = process.env.JWT_SECRET || 'parked_jitter_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false'; // no matcher timer during this test
process.env.PARKED_JITTER_ENABLED = 'true';
process.env.GLOBAL_UKM_ENABLED = 'true';
process.env.LINK_COVERAGE_ENABLED = 'true';

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
  process.env.MONGODB_URI = mongod.getUri('parked_jitter_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const env = require('../src/config/env');
  const { featuresFromPoints, isParkedJitter, verdictFields, classifyTrip } = require('../src/services/tripNoise');
  const { attributeTrip, rebuildScope } = require('../src/services/globalUkm');
  const { attributeTripLinks } = require('../src/services/linkCoverage');
  const { clearScopeCache } = require('../src/services/coverageScope');
  const { lineLength } = require('../src/utils/geo');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../src/models/Trip');
  const LocationPoint = require('../src/models/LocationPoint');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const RoadLink = require('../src/models/RoadLink');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const CoverageSegment = require('../src/models/CoverageSegment');
  await RoadLink.syncIndexes();
  await LinkCoverage.syncIndexes();

  // One step of 0.001° latitude is ~111.19 m, so every assertion below is stated in metres.
  const STEP_M = 111.19;
  const steps = (n) => n * STEP_M;
  const road = (fromStep, toStep, lon = 8) => {
    const pts = [];
    const dir = toStep >= fromStep ? 1 : -1;
    for (let i = fromStep; dir > 0 ? i <= toStep : i >= toStep; i += dir) pts.push({ lat: 50 + i * 0.001, lon });
    return encodePolyline6(pts);
  };
  const geoLine = (fromStep, toStep, lon = 8) => {
    const pts = [];
    for (let i = fromStep; i <= toStep; i += 1) pts.push([lon, 50 + i * 0.001]);
    return pts;
  };

  const T0 = new Date('2026-03-01T06:00:00Z').getTime();
  const at = (minutes) => new Date(T0 + minutes * 60_000);

  // A parked trace: the vehicle never moves; the handset's fixes wander a few dozen metres and the
  // offset cycle returns to its start, so net displacement is small for any n and spread stays
  // under half the jitter limit. 16 points span 5 minutes at one fix per 20 s.
  const JITTER_OFFSETS = [[0, 0], [0.0002, 0.00015], [-0.00015, 0.0002], [0.0001, -0.0002], [-0.0002, -0.0001]];
  const jitterPoints = (n = 16, center = { lat: 50.5, lon: 8.5 }, t0Ms = T0) =>
    Array.from({ length: n }, (_, i) => {
      const [dLat, dLon] = JITTER_OFFSETS[i % JITTER_OFFSETS.length];
      return { lat: center.lat + dLat, lon: center.lon + dLon, recordedAt: new Date(t0Ms + i * 20_000) };
    });

  // A real drive: a straight run north, one fix per minute.
  const drivePoints = (n, t0Ms = T0) =>
    Array.from({ length: n }, (_, i) => ({ lat: 50 + i * 0.001, lon: 8, recordedAt: new Date(t0Ms + i * 60_000) }));

  let seq = 0;
  const makeUser = async (name, { role = 'user', ...rest } = {}) => {
    seq += 1;
    const u = new User({ name, email: `${role}${seq}@x.com`, role, ...rest });
    await u.setPassword('pw123456');
    await u.save();
    return u;
  };
  const makeTrip = async (driver, opts = {}) =>
    Trip.create({
      clientTripId: `pj${++seq}`,
      driverId: driver._id,
      projectId: opts.projectId || null,
      status: opts.status || 'completed',
      startedAt: opts.startedAt || at(0),
      endedAt: opts.endedAt || at(30),
      coverageScopeId: opts.scope || 'DEFAULT',
      coverageCycleId: '',
      cleanedRouteShapes: opts.shapes || [],
      cleanedDistanceMeters: opts.shapes ? (opts.distanceMeters || 0) : 0,
      cleanedMatchedRatio: 1,
      mapMatchStatus: opts.shapes ? 'matched' : 'skipped',
      distanceMeters: opts.distanceMeters || 0,
      maxSpeedKmh: opts.maxSpeedKmh || 0,
      ...opts.extra,
    });
  const reload = (t) => Trip.findById(t._id).lean();
  const withPoints = (trip, driver, points) =>
    LocationPoint.insertMany(points.map((p) => ({ ...p, tripId: trip._id, driverId: driver._id })));

  const wipe = async () => {
    await Promise.all([
      Trip.deleteMany({}), LocationPoint.deleteMany({}), CoverageSegment.deleteMany({}),
      LinkCoverage.deleteMany({}), Project.deleteMany({}), NetworkVersion.deleteMany({}),
      RoadLink.deleteMany({}), User.deleteMany({}),
    ]);
    clearScopeCache();
  };

  /* ── the measurements ── */

  console.log('\n── featuresFromPoints ──');
  {
    const none = featuresFromPoints([]);
    assert(none.n === 0 && none.netMeters === null && none.spreadMeters === null,
      'no fixes: nothing measurable, nothing decided');

    const straight = featuresFromPoints(drivePoints(6));
    assert(straight.n === 6, 'six fixes read in');
    near(straight.netMeters, steps(5), 1, 'straight run: net displacement is the road walked (556 m)');
    near(straight.spreadMeters, steps(5), 1, 'straight run: the widest pair is the two ends');
    near(straight.pathMeters, steps(5), 1, 'and the path equals it — a straight line never wanders');

    const outAndBack = featuresFromPoints([...drivePoints(6), ...drivePoints(6).reverse().slice(1)]);
    assert(outAndBack.netMeters < 1,
      'out-and-back: net displacement ≈ 0 — the exact shape that makes the net clause alone unsafe');
    near(outAndBack.spreadMeters, steps(5), 1, 'out-and-back: the spread still sees the whole route');
    near(outAndBack.pathMeters, 2 * steps(5), 2, 'and the path counts both legs');

    const dirty = featuresFromPoints([{ lat: 50, lon: 8 }, { lat: NaN, lon: 8 }, { lat: 50.001, lon: 8 }]);
    assert(dirty.n === 2, 'an unparsed coordinate is not a position: dropped, the rest still measured');
  }

  console.log('\n── isParkedJitter: both clauses, inclusive bounds ──');
  {
    const f = (netMeters, spreadMeters, n = 8) => ({ n, netMeters, spreadMeters });
    assert(isParkedJitter(f(30, 60)), 'a few dozen metres of drift at one spot is noise');
    assert(isParkedJitter(f(150, 400)), 'exactly on both limits is still noise — the bounds are inclusive');
    assert(!isParkedJitter(f(151, 400)), 'net above the limit: not noise, however tight the spread');
    assert(!isParkedJitter(f(150, 401)),
      'spread above the limit: a session that wandered past 400 m survives as a trip — the safer of the two errors');
    assert(!isParkedJitter(f(0, 800)), 'out-and-back: tiny net, huge spread — spread clause overrules');
    assert(!isParkedJitter(f(169, 169)), 'a genuine 169 m reposition inside a car park is not deleted');
    assert(!isParkedJitter(f(30, 60, 1)), 'a single fix has no displacement to measure');

    const saved = env.PARKED_JITTER_ENABLED;
    env.PARKED_JITTER_ENABLED = false;
    try {
      assert(isParkedJitter(f(10, 10)) === false, 'kill switch: nothing is classified while the switch is off');
      assert(verdictFields(featuresFromPoints(jitterPoints())).parkedJitter === false,
        'kill switch: verdictFields would stamp "not jitter" over a parked trace — which is why the backfill refuses to run while off');
    } finally {
      env.PARKED_JITTER_ENABLED = saved;
    }
  }

  console.log('\n── verdictFields ──');
  {
    assert(verdictFields(featuresFromPoints([])) === null, 'no fixes: no verdict at all, not a "not jitter" verdict');
    assert(verdictFields(featuresFromPoints([{ lat: 50, lon: 8 }])) === null,
      'one fix: still no verdict — "unclassified" must stay distinct from "classified as a real drive"');

    const v = verdictFields(featuresFromPoints(jitterPoints()));
    assert(v.parkedJitter === true && v.parkedJitterAt instanceof Date, 'a parked trace gets a verdict with a timestamp');
    assert(Number.isInteger(v.parkedJitterMeters) && Number.isInteger(v.parkedJitterSpreadMeters),
      'figures are stored as whole metres');
    assert(v.parkedJitterMeters < 150 && v.parkedJitterSpreadMeters < 400, 'and the stored figures are the tiny ones measured');

    const rounded = verdictFields({ n: 3, netMeters: 30.6, spreadMeters: 99.4 });
    assert(rounded.parkedJitterMeters === 31 && rounded.parkedJitterSpreadMeters === 99, 'rounded to the nearest metre');
  }

  /* ── classification writes ── */

  console.log('\n── classifyTrip ──');
  {
    await wipe();
    const d = await makeUser('D');

    const parked = await makeTrip(d);
    await withPoints(parked, d, jitterPoints());
    const verdict = await classifyTrip(parked._id);
    assert(verdict && verdict.parkedJitter === true, 'classifyTrip flags a parked trace from stored points');
    const parkedAfter = await reload(parked);
    assert(parkedAfter.parkedJitter === true && parkedAfter.parkedJitterAt instanceof Date,
      'the verdict and its timestamp are stamped on the trip');
    assert(parkedAfter.parkedJitterMeters < 150 && parkedAfter.parkedJitterSpreadMeters < 400,
      'with the measured displacement and spread');

    const driven = await makeTrip(d);
    await withPoints(driven, d, drivePoints(8));
    await classifyTrip(driven._id);
    const drivenAfter = await reload(driven);
    assert(drivenAfter.parkedJitter === false && drivenAfter.parkedJitterAt instanceof Date,
      'a real drive is verdicted too — as NOT jitter, deliberately, not left unclassified');

    // The matcher hands its points over rather than have them fetched again.
    const passed = await makeTrip(d);
    await classifyTrip(passed._id, jitterPoints());
    assert((await reload(passed)).parkedJitter === true, 'points passed in by the caller are used as-is');

    const active = await makeTrip(d, { status: 'active', endedAt: null });
    await withPoints(active, d, jitterPoints());
    assert((await classifyTrip(active._id)) === null, 'an in-progress session is never verdicted');
    const activeAfter = await reload(active);
    assert(activeAfter.parkedJitterAt == null && activeAfter.parkedJitter === false,
      'and nothing was written — a drive still in progress can change');

    const silent = await makeTrip(d);
    await withPoints(silent, d, [{ lat: 50, lon: 8, recordedAt: at(0) }]);
    assert((await classifyTrip(silent._id)) === null, 'a single fix is undecidable');
    assert((await reload(silent)).parkedJitterAt == null, 'and stays unclassified, not marked a real drive');

    const saved = env.PARKED_JITTER_ENABLED;
    env.PARKED_JITTER_ENABLED = false;
    try {
      const skipped = await makeTrip(d);
      await withPoints(skipped, d, jitterPoints());
      assert((await classifyTrip(skipped._id)) === null, 'kill switch: classifyTrip does nothing');
      assert((await reload(skipped)).parkedJitterAt == null, 'and stamps no verdict');
    } finally {
      env.PARKED_JITTER_ENABLED = saved;
    }
  }

  /* ── the incident, replayed ── */

  console.log('\n── a parked session that claimed the road before it was classified ──');
  {
    await wipe();
    const jDriver = await makeUser('Jitter');
    const rDriver = await makeUser('Real');

    // History as it was before the backfill: the matcher snapped this session to the road and it
    // was credited for claiming it, because nobody had classified it yet.
    const j = await makeTrip(jDriver, { shapes: [road(0, 5)] });
    await withPoints(j, jDriver, jitterPoints());
    const r = await makeTrip(rDriver, { shapes: [road(0, 5)], startedAt: at(120), endedAt: at(150) });
    await attributeTrip(j._id);
    near((await reload(j)).globalUniqueMeters, steps(5), 1, 'the parked session is credited with the whole street');

    await attributeTrip(r._id);
    const rBefore = await reload(r);
    near(rBefore.globalUniqueMeters, 0, 0.5, 'the real driver over the same street earns nothing — it reads as already covered');
    near(rBefore.historicalDuplicateMeters, steps(5), 1, 'and all of it is filed as historical duplicate');

    await classifyTrip(j._id);
    const jAfter = await reload(j);
    assert(jAfter.ukmStatus === 'skipped', 'classified: the parked session is skipped, a final verdict');
    assert(jAfter.globalUniqueMeters === null, 'and its figures go null — not zero, nothing was ever established');
    assert((await CoverageSegment.countDocuments({ firstTripId: j._id })) === 0,
      'the road it never drove is released immediately, so nothing keeps owning a street on its behalf');

    const summary = await rebuildScope('DEFAULT', '');
    assert(summary.attributed === 1, 'the replay attributes only the real drive — the parked session is not even considered');
    const rAfter = await reload(r);
    near(rAfter.globalUniqueMeters, steps(5), 1, 'and the real driver is paid for the street');
    near(rAfter.historicalDuplicateMeters, 0, 0.5, 'with nothing filed as already covered');
    assert((await reload(j)).ukmStatus === 'skipped' && (await reload(j)).globalUniqueMeters === null,
      'the parked session stays excluded across the replay');
    near(summary.scopeUniqueMeters, steps(5), 1, 'the scope holds exactly one street that was driven once');
  }

  /* ── the assigned-network ledger ── */

  console.log('\n── the assigned-network ledger: a parked session claims no link ──');
  {
    await wipe();
    const project = await Project.create({ name: 'PJ' });
    const version = await NetworkVersion.create({ projectId: project._id, label: 'v1', status: 'active' });
    const coords = geoLine(0, 2);
    const link = await RoadLink.create({
      projectId: project._id,
      networkVersionId: version._id,
      linkId: 'L1',
      dirTravel: 'B',
      areaId: null,
      areaCode: null,
      geometry: { type: 'LineString', coordinates: coords },
      lengthMeters: lineLength(coords),
    });

    const jDriver = await makeUser('LinkJitter');
    const rDriver = await makeUser('LinkReal');
    const j = await makeTrip(jDriver, { projectId: project._id, shapes: [road(0, 2)] });
    await withPoints(j, jDriver, jitterPoints());
    const r = await makeTrip(rDriver, {
      projectId: project._id, shapes: [road(0, 2)], startedAt: at(120), endedAt: at(150),
    });

    // Again history as it was: the session claimed the link before anyone classified it.
    await attributeTripLinks(j._id);
    const jClaimed = await reload(j);
    near(jClaimed.linkUkmNetworkMeters, link.lengthMeters, 1, 'before classification the session holds the link');
    await attributeTripLinks(r._id);
    near((await reload(r)).linkUkmNetworkMeters, 0, 0.5, 'the real driver over it earns nothing');

    await classifyTrip(j._id);
    assert((await LinkCoverage.countDocuments({ networkVersionId: version._id })) === 0,
      'classified: the link is released from the ledger, claimable by the next real driver over it');
    const jSkipped = await reload(j);
    assert(jSkipped.linkCoverageStatus === 'skipped', 'the session is stamped skipped in the link ledger too');
    assert(jSkipped.linkUkmNetworkMeters === null && jSkipped.linkUkmMeters === null, 'with null figures, not zeros');

    await attributeTripLinks(r._id);
    const rAfter = await reload(r);
    near(rAfter.linkUkmNetworkMeters, link.lengthMeters, 1, 'the real driver now owns the link');
    assert(rAfter.linkCoverageStatus === 'computed', 'with a computed status on the assigned figure');

    // And the forward direction: a session flagged before it ever reached the engine claims nothing.
    const j2 = await makeTrip(jDriver, {
      projectId: project._id, shapes: [road(0, 2)], startedAt: at(240), endedAt: at(270),
      extra: { parkedJitter: true, parkedJitterAt: new Date(), parkedJitterMeters: 20, parkedJitterSpreadMeters: 45 },
    });
    await attributeTripLinks(j2._id);
    assert((await reload(j2)).linkCoverageStatus === 'skipped', 'a flagged session is skipped, never claiming');
    near((await reload(r)).linkUkmNetworkMeters, link.lengthMeters, 1, 'and the real driver keeps the link');
  }

  /* ── reports ── */

  console.log('\n── reports: the parked session is out by default, back on request ──');
  {
    await wipe();
    const request = require('supertest');
    const { createApp } = require('../src/app');
    const app = createApp();

    const admin = await makeUser('Admin', { role: 'admin' });
    const driver = await makeUser('ReportDriver');

    // The shape of the reported day: one real drive, plus a parked session whose wandering fixes
    // produced the 107 km/h headline and a phantom "trip".
    await makeTrip(driver, {
      startedAt: new Date('2026-08-01T09:00:00Z'), endedAt: new Date('2026-08-01T09:20:00Z'),
      distanceMeters: 2000, maxSpeedKmh: 45,
    });
    await makeTrip(driver, {
      startedAt: new Date('2026-08-01T10:00:00Z'), endedAt: new Date('2026-08-01T10:04:00Z'),
      distanceMeters: 500, maxSpeedKmh: 107,
      extra: { parkedJitter: true, parkedJitterAt: new Date(), parkedJitterMeters: 22, parkedJitterSpreadMeters: 44 },
    });

    const login = await request(app).post('/api/auth/login').send({ email: admin.email, password: 'pw123456' });
    const asAdmin = (req) => req.set('Authorization', `Bearer ${login.body.token}`);

    const list = await asAdmin(request(app).get('/api/trips'));
    assert(list.body.total === 1 && list.body.trips.length === 1,
      'the trip list shows the real drive only — "19 trips" of which 2 were drives is the bug being fixed');
    const noisy = await asAdmin(request(app).get('/api/trips?includeNoise=true'));
    assert(noisy.body.total === 2, '?includeNoise=true brings the parked session back for a caller who asks');

    const summary = await asAdmin(request(app).get('/api/trips/merged-summary'));
    assert(summary.body.summaries.length === 1 && summary.body.summaries[0].totalTrips === 1,
      'the grouped view counts one drive, not two sessions');
    assert(summary.body.summaries[0].totalDistance === 2000, 'and totals only the 2 km that were driven');
    assert(summary.body.summaries[0].maxSpeed === 45,
      'the 107 km/h the parked session produced is no longer the headline maximum');

    const ukm = await asAdmin(request(app).get(
      `/api/tracking/ukm-driver/${driver._id}?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z`
    ));
    assert(ukm.body.trips === 1, 'the per-driver UKM report a manager signs off counts drives, not sessions');
    assert(ukm.body.rawKm === 2, 'and its distance is the driven 2 km, not 2.5');
  }

  console.log(`\n${passed} assertions passed.`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
