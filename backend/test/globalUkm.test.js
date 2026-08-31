// Global UKM: services/globalUkm.js + models/CoverageSegment.js.
//
// The rule under test: a piece of road is new EXACTLY ONCE inside a coverage scope, and it belongs
// to whoever reached it first — regardless of driver, regardless of project, and regardless of
// when their phone got round to uploading it.
//
// Run: npm run test:global-ukm
process.env.JWT_SECRET = process.env.JWT_SECRET || 'global_ukm_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false'; // no matcher timer during this test

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (got ${a})`);

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('global_ukm_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const { attributeTrip, rebuildScope, computeTripMetrics, overlapBreakdown } = require('../src/services/globalUkm');
  const { clearScopeCache } = require('../src/services/coverageScope');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const CoverageSegment = require('../src/models/CoverageSegment');

  const SCOPE = 'DEFAULT'; // env.UKM_DEFAULT_COVERAGE_SCOPE

  // A straight north–south road. One step of 0.001 deg latitude is ~111.19 m, so a road of N steps
  // is a known length and every assertion below can be stated in metres rather than in fractions.
  const STEP_M = 111.19;
  const road = (fromStep, toStep, lon = 8) => {
    const pts = [];
    const dir = toStep >= fromStep ? 1 : -1;
    for (let i = fromStep; dir > 0 ? i <= toStep : i >= toStep; i += dir) {
      pts.push({ lat: 50 + i * 0.001, lon });
    }
    return encodePolyline6(pts);
  };
  const steps = (n) => n * STEP_M;

  let driverSeq = 0;
  const makeDriver = async (name) => {
    const u = new User({ name, email: `d${++driverSeq}@x.com`, role: 'user' });
    await u.setPassword('pw123456');
    await u.save();
    return u;
  };

  // Minutes since a fixed epoch, so every trip in this file has an unambiguous place in time.
  const T0 = new Date('2026-03-01T06:00:00Z').getTime();
  const at = (minutes) => new Date(T0 + minutes * 60_000);

  let tripSeq = 0;
  const makeTrip = async (driver, shapes, startMin, endMin, extra = {}) => {
    tripSeq += 1;
    return Trip.create({
      clientTripId: `t${tripSeq}`,
      driverId: driver._id,
      status: 'completed',
      startedAt: at(startMin),
      endedAt: at(endMin),
      coverageScopeId: SCOPE,
      coverageCycleId: '',
      cleanedRouteShapes: shapes,
      cleanedDistanceMeters: 0,
      cleanedMatchedRatio: 1,
      mapMatchStatus: 'matched',
      distanceMeters: 0,
      ...extra,
    });
  };

  const reload = (t) => Trip.findById(t._id).lean();
  const uniqueM = async (t) => (await reload(t)).globalUniqueMeters;
  const dupM = async (t) => (await reload(t)).historicalDuplicateMeters;

  const reset = async () => {
    await Promise.all([
      Trip.deleteMany({}),
      CoverageSegment.deleteMany({}),
      Project.deleteMany({}),
    ]);
    clearScopeCache();
  };

  // ── EC-03 / Test A — the same driver drives the same road again on a later day ──
  console.log('\n── Test A: same driver, same road, later trip ──');
  {
    await reset();
    const d = await makeDriver('A');
    const t1 = await makeTrip(d, [road(0, 5)], 0, 30);
    const t2 = await makeTrip(d, [road(0, 5)], 1440, 1470); // next day, identical route
    await attributeTrip(t1._id);
    await attributeTrip(t2._id);
    near(await uniqueM(t1), steps(5), 1, 'first trip owns all 5 steps of new road');
    assert((await uniqueM(t2)) === 0, 'second trip earns 0 — the road was already covered');
    near(await dupM(t2), steps(5), 1, 'and reports all of it as historical duplicate');
    assert((await reload(t2)).ukmStatus === 'computed', 'zero UKM is a computed result, not an error');
  }

  // ── EC-01 / Test B — the case every previous implementation got wrong ──
  console.log('\n── Test B: a DIFFERENT driver drives the same road later ──');
  {
    await reset();
    const d1 = await makeDriver('B1');
    const d2 = await makeDriver('B2');
    const t1 = await makeTrip(d1, [road(0, 5)], 0, 30);
    const t2 = await makeTrip(d2, [road(0, 5)], 120, 150);
    await attributeTrip(t1._id);
    await attributeTrip(t2._id);
    near(await uniqueM(t1), steps(5), 1, 'driver 1 owns the road');
    assert((await uniqueM(t2)) === 0,
      'driver 2 earns 0 — under the old per-driver ledger they would have earned the full 5 steps again');
  }

  // ── EC-02 / Test C — different projects, one coverage scope ──
  console.log('\n── Test C: different PROJECTS, same coverage scope ──');
  {
    await reset();
    const pA = await Project.create({ name: 'Project A' });
    const pB = await Project.create({ name: 'Project B' });
    const d1 = await makeDriver('C1');
    const d2 = await makeDriver('C2');
    const t1 = await makeTrip(d1, [road(0, 5)], 0, 30, { projectId: pA._id });
    const t2 = await makeTrip(d2, [road(0, 5)], 120, 150, { projectId: pB._id });
    await attributeTrip(t1._id);
    await attributeTrip(t2._id);
    near(await uniqueM(t1), steps(5), 1, 'Project A covers the road first');
    assert((await uniqueM(t2)) === 0, 'Project B earns nothing — a project boundary does not reset uniqueness');
  }

  // ── Scopes still separate deliberately-independent programmes ──
  console.log('\n── Test C2: a SEPARATE coverage scope does not deduplicate against the first ──');
  {
    await reset();
    const d1 = await makeDriver('C3');
    const d2 = await makeDriver('C4');
    const t1 = await makeTrip(d1, [road(0, 5)], 0, 30);
    const t2 = await makeTrip(d2, [road(0, 5)], 120, 150, { coverageScopeId: 'OTHER-CUSTOMER' });
    await attributeTrip(t1._id);
    await attributeTrip(t2._id);
    near(await uniqueM(t1), steps(5), 1, 'scope DEFAULT owns the road');
    near(await uniqueM(t2), steps(5), 1, 'scope OTHER-CUSTOMER covers it as new — a different programme, a different universe');
  }

  // ── EC-04 — repeats inside one trip ──
  console.log('\n── Test: a road driven three times inside ONE trip counts once ──');
  {
    await reset();
    const d = await makeDriver('D');
    // Out 0->3, back 3->0, out again 0->3: 9 steps travelled over 3 steps of road.
    const t = await makeTrip(d, [road(0, 3) && encodePolyline6([
      ...[0, 1, 2, 3].map((i) => ({ lat: 50 + i * 0.001, lon: 8 })),
      ...[2, 1, 0].map((i) => ({ lat: 50 + i * 0.001, lon: 8 })),
      ...[1, 2, 3].map((i) => ({ lat: 50 + i * 0.001, lon: 8 })),
    ])], 0, 30);
    await attributeTrip(t._id);
    const row = await reload(t);
    near(row.distinctRoadMeters, steps(3), 1, 'distinct road is one pass, not three');
    near(row.sameTripRepeatMeters, steps(6), 1, 'the other 6 steps are recorded as same-trip repeat');
    near(row.globalUniqueMeters, steps(3), 1, 'UKM is measured against distinct road');
  }

  // ── EC-06 / Test E — partial overlap. Two drivers share only part of a street ──
  console.log('\n── Test E: partial overlap between two drivers ──');
  {
    await reset();
    const d1 = await makeDriver('E1');
    const d2 = await makeDriver('E2');
    const t1 = await makeTrip(d1, [road(0, 6)], 0, 60);   // steps 0..6
    const t2 = await makeTrip(d2, [road(4, 10)], 120, 180); // steps 4..10, overlapping 4..6
    await attributeTrip(t1._id);
    await attributeTrip(t2._id);
    near(await uniqueM(t2), steps(4), 1, 'driver 2 is credited only with the 4 steps nobody had driven');
    near(await dupM(t2), steps(2), 1, 'and the 2 overlapping steps are duplicate, not zero and not all of it');
  }

  // ── EC-05 / Test D — THE MANDATORY BUSINESS EXAMPLE ──
  // 30 km travelled, 3 km of it re-driven inside the trip -> 27 km distinct road.
  // History: driver 101 covered 12 km of it; driver 201 covered 4 km that sits INSIDE that 12 km.
  // Historical coverage is the UNION, 12 km — not 12 + 4 = 16. Expected UKM: 27 - 12 = 15 km.
  console.log('\n── Test D: MANDATORY — 12 km + nested 4 km history, 3 km self-repeat, 30 km driven ──');
  {
    await reset();
    // A 100 m step, so this test reads in the same units the requirement is written in:
    // 270 steps IS 27 km, 120 steps IS 12 km, and the expected answer IS 15 km.
    const HM = 0.001 / 1.1119; // degrees of latitude per 100 m at this latitude
    const km100 = (i) => ({ lat: 50 + i * HM, lon: 8 });
    const kmRoad = (a, b) => {
      const pts = [];
      const dir = b >= a ? 1 : -1;
      for (let i = a; dir > 0 ? i <= b : i >= b; i += dir) pts.push(km100(i));
      return encodePolyline6(pts);
    };
    const M = 100; // metres per step
    const d101 = await makeDriver('D101');
    const d201 = await makeDriver('D201');
    const d301 = await makeDriver('D301');

    // History. Driver 101 covers steps 0..120 (the "12 km"). Driver 201 covers steps 40..80,
    // entirely inside it (the nested "4 km").
    const h1 = await makeTrip(d101, [kmRoad(0, 120)], 0, 60);
    const h2 = await makeTrip(d201, [kmRoad(40, 80)], 120, 180);
    await attributeTrip(h1._id);
    await attributeTrip(h2._id);
    near(await uniqueM(h1), 120 * M, 20, 'driver 101 owns 12 km of history');
    assert((await uniqueM(h2)) === 0,
      'driver 201 adds NOTHING to history — its 4 km sits inside driver 101\'s 12 km');

    // Today. Driver 301 drives out to step 230, doubles back 15 steps, then carries on to 270.
    // Travelled 230 + 15 + 55 = 300 steps (~30 km). Distinct road 0..270 = 270 steps (~27 km).
    // Same-trip repeat = the 30 steps of 215..230 driven twice more (~3 km).
    const path = [];
    for (let i = 0; i <= 230; i++) path.push(km100(i));
    for (let i = 229; i >= 215; i--) path.push(km100(i));
    for (let i = 216; i <= 270; i++) path.push(km100(i));
    const today = await makeTrip(d301, [encodePolyline6(path)], 600, 660);
    await attributeTrip(today._id);

    const row = await reload(today);
    near(row.distinctRoadMeters, 270 * M, 20, 'distinct road today is 27 km (30 km driven, 3 km of it twice)');
    near(row.sameTripRepeatMeters, 30 * M, 20, 'the 3 km re-driven inside the trip is travel, not road');
    near(row.historicalDuplicateMeters, 120 * M, 20,
      'historical duplicate is the UNION: 12 km — NOT 12 + 4 = 16 km');
    near(row.globalUniqueMeters, 150 * M, 20,
      'UKM = 27 - 12 = 15 km — the mandatory expected answer');

    // Stated in kilometres too, because that is how the requirement is written down.
    const asKm = (m) => +(m / 1000).toFixed(1);
    console.log(
      `   → distinct ${asKm(row.distinctRoadMeters)} km, duplicate ${asKm(row.historicalDuplicateMeters)} km, ` +
      `UKM ${asKm(row.globalUniqueMeters)} km`
    );
  }

  // ── EC-17 / Test H — the offline trip that syncs late ──
  console.log('\n── Test H: an EARLIER trip uploaded LATER takes ownership back ──');
  {
    await reset();
    const dEarly = await makeDriver('H-early');
    const dLate = await makeDriver('H-late');
    // The 11:00 trip is processed first, because its phone had signal.
    const later = await makeTrip(dLate, [road(0, 5)], 300, 330);
    await attributeTrip(later._id);
    near(await uniqueM(later), steps(5), 1, 'the 11:00 driver provisionally owns the road');

    // The 09:00 trip finally syncs.
    const earlier = await makeTrip(dEarly, [road(0, 5)], 0, 30);
    await attributeTrip(earlier._id);

    near(await uniqueM(earlier), steps(5), 1, 'the driver who actually got there first takes the road');
    assert((await uniqueM(later)) === 0,
      'and the trip that had provisionally claimed it is recomputed down to 0 — not left miscredited');
  }

  // ── EC-20 / Test I — trip STARTS first but REACHES the road later ──
  console.log('\n── Test I: ownership follows when the road was reached, not when the trip started ──');
  {
    await reset();
    const dA = await makeDriver('I-A');
    const dB = await makeDriver('I-B');
    // Driver A starts at 08:00 and drives a long road, reaching the contested stretch (steps
    // 90..100) near the END of a 4-hour trip — around 11:40.
    const tA = await makeTrip(dA, [road(0, 100)], 120, 360);
    // Driver B starts an hour later at 09:00 but reaches the same stretch within 30 minutes.
    const tB = await makeTrip(dB, [road(90, 100)], 180, 210);

    await attributeTrip(tA._id);
    await attributeTrip(tB._id);

    near(await uniqueM(tB), steps(10), 2,
      'driver B owns the contested stretch — they reached it first, even though driver A started earlier');
    near(await uniqueM(tA), steps(90), 3, 'driver A keeps the 90 steps they genuinely covered first');
  }

  // ── EC-15 / Test L — a partial map match is flagged, not silently counted ──
  console.log('\n── Test L: a partly-unmatched trip is flagged for review ──');
  {
    await reset();
    const d = await makeDriver('L');
    const t = await makeTrip(d, [road(0, 5)], 0, 30, {
      cleanedMatchedRatio: 0.5,
      cleanedDistanceMeters: steps(5),
    });
    await attributeTrip(t._id);
    const row = await reload(t);
    assert(row.ukmStatus === 'review', 'status is review, so a report can exclude it');
    near(row.unmatchedReviewMeters, steps(5) * 0.5, 2,
      'half the distance is held apart as unmatched rather than counted as new road');
  }

  // ── EC-16 — a trip with no geometry is null, never zero ──
  console.log('\n── Test: no geometry means NULL UKM, which is not the same as zero ──');
  {
    await reset();
    const d = await makeDriver('N');
    const t = await Trip.create({
      clientTripId: 'no-geom',
      driverId: d._id,
      status: 'completed',
      startedAt: at(0),
      endedAt: at(30),
      coverageScopeId: SCOPE,
      mapMatchStatus: 'failed',
      distanceMeters: 5000,
    });
    await attributeTrip(t._id);
    const row = await reload(t);
    assert(row.globalUniqueMeters === null, 'UKM is null — "we do not know", not "we found nothing"');
    assert(row.ukmStatus === 'failed', 'and the status says why');
  }

  // ── Test P / EC-18 — determinism. A rebuild must reproduce the incremental answer exactly ──
  console.log('\n── Test P: a full scope rebuild reproduces the incremental result exactly ──');
  {
    await reset();
    const d1 = await makeDriver('P1');
    const d2 = await makeDriver('P2');
    const d3 = await makeDriver('P3');
    const t1 = await makeTrip(d1, [road(0, 20)], 0, 60);
    const t2 = await makeTrip(d2, [road(10, 30)], 30, 90);
    const t3 = await makeTrip(d3, [road(25, 40)], 200, 260);

    // Attribute in a deliberately awkward order — newest first, oldest last.
    await attributeTrip(t3._id);
    await attributeTrip(t2._id);
    await attributeTrip(t1._id);
    const incremental = [await uniqueM(t1), await uniqueM(t2), await uniqueM(t3)];

    const summary = await rebuildScope(SCOPE, '');
    const rebuilt = [await uniqueM(t1), await uniqueM(t2), await uniqueM(t3)];

    for (let i = 0; i < 3; i++) {
      near(rebuilt[i], incremental[i], 0.001, `trip ${i + 1} has the same UKM after a full rebuild`);
    }
    // t1 owns 0..20, t2 owns 20..30, t3 owns 30..40 — 40 steps of road in total, once each.
    near(summary.scopeUniqueMeters, steps(40), 3,
      'the scope ledger holds each piece of road exactly once (40 steps), however many drivers crossed it');
    near(rebuilt[0] + rebuilt[1] + rebuilt[2], steps(40), 3,
      'and the per-driver figures sum to the scope total — no double counting to reconcile');
  }

  // ── EC-22 / Test M — invalidating the first-cover trip hands the road to the next driver ──
  console.log('\n── Test M: invalidate the first-cover trip and ownership moves to the next earliest ──');
  {
    await reset();
    const d1 = await makeDriver('M1');
    const d2 = await makeDriver('M2');
    const t1 = await makeTrip(d1, [road(0, 5)], 0, 30);
    const t2 = await makeTrip(d2, [road(0, 5)], 120, 150);
    await attributeTrip(t1._id);
    await attributeTrip(t2._id);
    assert((await uniqueM(t2)) === 0, 'driver 2 starts with nothing');

    // Mark the first trip ineligible the way a real invalidation would — its geometry no longer
    // counts — and rebuild the scope.
    await Trip.updateOne({ _id: t1._id }, { $unset: { cleanedRouteShapes: 1 } });
    await rebuildScope(SCOPE, '');

    near(await uniqueM(t2), steps(5), 1, 'driver 2 now owns the road, rather than it going uncredited');
    assert((await reload(t1)).globalUniqueMeters === null, 'and the invalidated trip has no figure at all');
  }

  // ── The map colours come from the same decision as the numbers ──
  console.log('\n── Test: server-side unique/duplicate shapes agree with the numbers ──');
  {
    await reset();
    const d1 = await makeDriver('S1');
    const d2 = await makeDriver('S2');
    const t1 = await makeTrip(d1, [road(0, 6)], 0, 60);
    const t2 = await makeTrip(d2, [road(4, 10)], 120, 180);
    await attributeTrip(t1._id);
    await attributeTrip(t2._id);
    const row = await reload(t2);
    assert(Array.isArray(row.ukmUniqueShapes) && row.ukmUniqueShapes.length > 0,
      'the server emits the unique geometry, so the browser never has to work it out itself');
    assert(Array.isArray(row.ukmDuplicateShapes) && row.ukmDuplicateShapes.length > 0,
      'and the already-covered geometry too, so a repeated stretch can be drawn in a different colour');

    const { decodePolyline6 } = require('../src/services/roadSegments');
    const { haversineMeters } = require('../src/utils/geo');
    const lengthOf = (shapes) => shapes.reduce((total, s) => {
      const v = decodePolyline6(s);
      let m = 0;
      for (let i = 1; i < v.length; i++) m += haversineMeters(v[i - 1], v[i]);
      return total + m;
    }, 0);
    near(lengthOf(row.ukmUniqueShapes), row.globalUniqueMeters, 1,
      'the green line measures exactly the same length as the UKM figure');
    near(lengthOf(row.ukmDuplicateShapes), row.historicalDuplicateMeters, 1,
      'and the duplicate line matches the duplicate figure');
  }

  // ── Reconciliation invariant, asserted over everything the suite produced ──
  console.log('\n── Invariant: distinct = duplicate + unique, on every computed trip ──');
  {
    await reset();
    const drivers = await Promise.all(['R1', 'R2', 'R3'].map(makeDriver));
    const trips = [
      await makeTrip(drivers[0], [road(0, 12)], 0, 60),
      await makeTrip(drivers[1], [road(6, 18)], 30, 90),
      await makeTrip(drivers[2], [road(15, 24)], 200, 240),
      await makeTrip(drivers[0], [road(0, 24)], 400, 500),
    ];
    for (const t of trips) await attributeTrip(t._id);
    for (const t of trips) {
      const r = await reload(t);
      near(r.distinctRoadMeters, r.historicalDuplicateMeters + r.globalUniqueMeters, 0.001,
        `trip ${t.clientTripId}: distinct road balances against duplicate + unique`);
      assert(r.globalUniqueMeters >= 0 && r.historicalDuplicateMeters >= 0,
        `trip ${t.clientTripId}: no negative metres`);
    }
    const ledger = await CoverageSegment.countDocuments({ coverageScopeId: SCOPE });
    const owners = await CoverageSegment.aggregate([
      { $match: { coverageScopeId: SCOPE } },
      { $group: { _id: '$segmentKey', owners: { $addToSet: '$firstTripId' } } },
      { $match: { 'owners.1': { $exists: true } } },
    ]);
    assert(owners.length === 0,
      `no piece of road has two first owners (${ledger} segments checked)`);
  }

  // ── EC-37 — the overlap breakdown behind the "Already covered" figure ──
  // The specification is emphatic that per-driver overlap must never be SUMMED to produce a
  // duplicate total, because previous drivers overlap each other. This breakdown is the other
  // thing: each piece of road has exactly one first owner, so grouping by owner PARTITIONS the
  // duplicate distance. The rows therefore must sum to it exactly — that is the assertion.
  console.log('\n── Test: "Already covered" breaks down by driver and project, and the rows sum ──');
  {
    await reset();
    const pAlpha = await Project.create({ name: 'Project Alpha' });
    const pBeta = await Project.create({ name: 'Project Beta' });
    const alice = await makeDriver('Alice');
    const bob = await makeDriver('Bob');
    const cara = await makeDriver('Cara');

    // History: Alice holds steps 0-10 under Alpha, Bob holds 10-15 under Beta, and Cara herself
    // covered 15-18 on an earlier trip. Today Cara drives 0-25.
    const h1 = await makeTrip(alice, [road(0, 10)], 0, 60, { projectId: pAlpha._id });
    const h2 = await makeTrip(bob, [road(10, 15)], 120, 180, { projectId: pBeta._id });
    const h3 = await makeTrip(cara, [road(15, 18)], 240, 300, { projectId: pAlpha._id });
    const today = await makeTrip(cara, [road(0, 25)], 1440, 1560, { projectId: pAlpha._id });
    for (const t of [h1, h2, h3, today]) await attributeTrip(t._id);

    const row = await reload(today);
    near(row.distinctRoadMeters, steps(25), 2, 'today covered 25 steps of distinct road');
    near(row.historicalDuplicateMeters, steps(18), 2, '18 of those steps were already covered');
    near(row.globalUniqueMeters, steps(7), 2, 'leaving 7 steps of UKM');

    const b = await overlapBreakdown(today._id);
    assert(b.computed, 'the breakdown is computed for a trip with geometry');
    assert(b.rows.length === 3, `three separate coverers — two drivers and Cara herself (got ${b.rows.length})`);
    assert(b.unattributedMeters === 0, 'no road is left unattributed');

    const byDriver = new Map(b.rows.map((r) => [String(r.driverId), r]));
    near(byDriver.get(String(alice._id)).meters, steps(10), 2, 'Alice is credited with the 10 steps she held');
    near(byDriver.get(String(bob._id)).meters, steps(5), 2, 'Bob with the 5 he held');
    near(byDriver.get(String(cara._id)).meters, steps(3), 2, "Cara's own earlier trip with its 3");

    assert(String(byDriver.get(String(alice._id)).projectId) === String(pAlpha._id),
      'each row carries the project the covering trip was stamped with, not the covering driver\'s project today');
    assert(String(byDriver.get(String(bob._id)).projectId) === String(pBeta._id),
      'so a road first covered under a different project says so');

    assert(byDriver.get(String(cara._id)).selfOverlap === true,
      're-covering your own ground is flagged: a route-planning problem, not a coordination one');
    assert(byDriver.get(String(alice._id)).selfOverlap === false, "and another driver's road is not");

    // THE property that makes this table safe to publish.
    const sum = b.rows.reduce((t, r) => t + r.meters, 0);
    near(sum, row.historicalDuplicateMeters, 0.001,
      'the rows sum EXACTLY to "Already covered" — every metre in one row, none counted twice');
    near(b.totalMeters, row.historicalDuplicateMeters, 0.001,
      'and the reported total agrees with the trip figure');

    // Sorted biggest first, so the reader sees the main culprit without scanning.
    assert(b.rows[0].meters >= b.rows[b.rows.length - 1].meters, 'rows come back largest first');
  }

  console.log('\n── Test: a trip nobody preceded has an empty breakdown, not a broken one ──');
  {
    await reset();
    const d = await makeDriver('Solo');
    const t = await makeTrip(d, [road(0, 5)], 0, 30);
    await attributeTrip(t._id);
    const b = await overlapBreakdown(t._id);
    assert(b.computed && b.rows.length === 0, 'computed, with no rows — all of it was new road');
    assert(b.totalMeters === 0, 'and nothing already covered');
  }

  console.log(`\n${passed} assertions passed.`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
