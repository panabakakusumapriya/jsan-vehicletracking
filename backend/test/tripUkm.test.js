// Per-trip UKM (unique kilometers): services/roadSegments.js.
// The rule under test: a road counts once, on the FIRST trip (chronologically) that covered it.
// Run: npm run test:trip-ukm
process.env.JWT_SECRET = process.env.JWT_SECRET || 'trip_ukm_test_secret_1234567890';
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
  process.env.MONGODB_URI = mongod.getUri('trip_ukm_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const { recomputeDriverUkm, segmentsForTrip, segmentKey, decodePolyline6 } = require('../src/services/roadSegments');
  const { haversineMeters } = require('../src/utils/geo');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');

  // A straight run of road, 0.001 deg of latitude per step ≈ 111 m per step.
  const road = (fromStep, toStep) => {
    const pts = [];
    for (let i = fromStep; i <= toStep; i++) pts.push({ lat: 50 + i * 0.001, lon: 8 });
    return encodePolyline6(pts);
  };
  const STEP_M = 111.19; // haversine length of one 0.001 deg latitude step

  console.log('\n── segmentKey: direction does not matter ──');
  {
    const a = { lat: 50.0, lon: 8.0 };
    const b = { lat: 50.001, lon: 8.0 };
    assert(segmentKey(a, b) === segmentKey(b, a), 'A->B and B->A produce the same key, so a road driven back is not counted twice');
  }

  console.log('\n── segmentsForTrip: a road driven 3x inside one trip counts once ──');
  {
    // Out, back, out again over the same 3 steps.
    const out = [];
    for (let i = 0; i <= 3; i++) out.push({ lat: 50 + i * 0.001, lon: 8 });
    const back = [...out].reverse();
    const shape = encodePolyline6([...out, ...back.slice(1), ...out.slice(1)]);
    const segs = segmentsForTrip([shape]);
    assert(segs.size === 3, `3 distinct pieces of road despite being driven 3 times (got ${segs.size})`);
    let total = 0;
    for (const m of segs.values()) total += m;
    near(total, 3 * STEP_M, 1, 'distinct length is one pass, not three');
  }

  const driver = new User({ name: 'D', email: 'd@x.com', role: 'user' });
  await driver.setPassword('pw123456');
  await driver.save();

  const t0 = Date.parse('2026-08-01T08:00:00Z');
  const DAY = 86400000;
  const mk = async (dayOffset, shapes) =>
    Trip.create({
      driverId: driver._id,
      status: 'completed',
      startedAt: new Date(t0 + dayOffset * DAY),
      endedAt: new Date(t0 + dayOffset * DAY + 3600_000),
      distanceMeters: 1000,
      cleanedRouteShapes: shapes,
      mapMatchStatus: 'matched',
    });

  console.log('\n── the headline rule: same route the next day earns nothing ──');
  {
    const monday = await mk(0, [road(0, 5)]);   // 5 steps of new road
    const tuesday = await mk(1, [road(0, 5)]);  // identical route
    await recomputeDriverUkm(driver._id);

    const m = await Trip.findById(monday._id);
    const tu = await Trip.findById(tuesday._id);
    near(m.ukmMeters, 5 * STEP_M, 1, "Monday earns the whole route as new road");
    assert(tu.ukmMeters === 0, `Tuesday earns 0 for re-driving the same road (got ${tu.ukmMeters})`);
    near(tu.ukmWithinTripMeters, 5 * STEP_M, 1, 'but Tuesday still reports the distinct road it covered');
  }

  console.log('\n── partial overlap: only the genuinely new part counts ──');
  {
    await Trip.deleteMany({});
    const day1 = await mk(0, [road(0, 4)]);  // steps 0-4
    const day2 = await mk(1, [road(2, 8)]);  // steps 2-8: 2-4 repeat, 4-8 are new
    await recomputeDriverUkm(driver._id);

    const a = await Trip.findById(day1._id);
    const b = await Trip.findById(day2._id);
    near(a.ukmMeters, 4 * STEP_M, 1, 'day 1 earns its 4 steps');
    near(b.ukmMeters, 4 * STEP_M, 1, 'day 2 earns only the 4 steps day 1 never drove');
    near(b.ukmWithinTripMeters, 6 * STEP_M, 1, 'day 2 still covered 6 distinct steps in total');
  }

  console.log('\n── chronological, not processing order: a back-dated sync takes the credit ──');
  {
    await Trip.deleteMany({});
    // Created second, but it was DRIVEN first — an offline trip syncing late.
    const later = await mk(5, [road(0, 3)]);
    const earlier = await mk(1, [road(0, 3)]);
    await recomputeDriverUkm(driver._id);

    const e = await Trip.findById(earlier._id);
    const l = await Trip.findById(later._id);
    near(e.ukmMeters, 3 * STEP_M, 1, 'the trip that actually drove it first owns the road');
    assert(l.ukmMeters === 0, `the later trip earns 0 even though it was stored first (got ${l.ukmMeters})`);
  }

  console.log('\n── idempotent: running twice cannot change the answer ──');
  {
    const before = await Trip.find({}).select('_id ukmMeters').sort({ startedAt: 1 }).lean();
    await recomputeDriverUkm(driver._id);
    await recomputeDriverUkm(driver._id);
    const after = await Trip.find({}).select('_id ukmMeters').sort({ startedAt: 1 }).lean();
    assert(
      JSON.stringify(before.map((t) => t.ukmMeters)) === JSON.stringify(after.map((t) => t.ukmMeters)),
      'repeated recomputes produce identical figures — history never silently drifts'
    );
  }

  console.log('\n── unmatched trips stay null rather than claiming zero new road ──');
  {
    await Trip.deleteMany({});
    const unmatched = await Trip.create({
      driverId: driver._id, status: 'completed',
      startedAt: new Date(t0), endedAt: new Date(t0 + 3600_000),
      distanceMeters: 5000, mapMatchStatus: 'pending',
    });
    await recomputeDriverUkm(driver._id);
    const u = await Trip.findById(unmatched._id);
    assert(u.ukmMeters === null, 'no snapped route means no figure — absent is not the same claim as none');
  }

  console.log('\n── ukmNewShapes: the highlighted geometry matches the number ──');
  {
    await Trip.deleteMany({});
    const day1 = await mk(0, [road(0, 4)]);   // steps 0-4
    const day2 = await mk(1, [road(2, 8)]);   // 2-4 repeat, 4-8 new
    await recomputeDriverUkm(driver._id);

    const a = await Trip.findById(day1._id);
    const b = await Trip.findById(day2._id);

    assert(a.ukmNewShapes.length === 1, 'a wholly-new trip highlights as one continuous stretch');
    assert(b.ukmNewShapes.length === 1, 'day 2 highlights only its new tail, as one stretch');

    // The highlighted geometry must measure the same as the reported figure, or the map is lying.
    const lengthOf = (shapes) => {
      let total = 0;
      for (const s of shapes) {
        const v = decodePolyline6(s);
        for (let i = 1; i < v.length; i++) total += haversineMeters(v[i - 1], v[i]);
      }
      return total;
    };
    near(lengthOf(b.ukmNewShapes), b.ukmMeters, 1, 'highlighted length equals the UKM figure for that trip');
    near(lengthOf(a.ukmNewShapes), a.ukmMeters, 1, 'and for day 1 too');
  }

  console.log('\n── a repeated middle section splits the highlight in two ──');
  {
    await Trip.deleteMany({});
    // Day 1 drives the middle only; day 2 drives across it, so day 2's new road is either side.
    await mk(0, [road(3, 5)]);
    const day2 = await mk(1, [road(0, 8)]);
    await recomputeDriverUkm(driver._id);
    const b = await Trip.findById(day2._id);
    assert(
      b.ukmNewShapes.length === 2,
      `the highlight breaks where the driver rejoined known road, giving 2 stretches (got ${b.ukmNewShapes.length})`
    );
    // 8 steps driven, 2 of them (3->4, 4->5) already covered by day 1, so 6 are new — 3 either side.
    near(b.ukmMeters, 6 * STEP_M, 1, 'and counts only the 6 steps outside the previously-driven middle');
  }

  console.log('\n── a different road is not confused with an already-driven one ──');
  {
    await Trip.deleteMany({});
    const north = await mk(0, [road(0, 3)]);
    // Same latitudes, different longitude — a parallel street.
    const parallel = [];
    for (let i = 0; i <= 3; i++) parallel.push({ lat: 50 + i * 0.001, lon: 8.01 });
    const east = await mk(1, [encodePolyline6(parallel)]);
    await recomputeDriverUkm(driver._id);
    const n = await Trip.findById(north._id);
    const e = await Trip.findById(east._id);
    near(n.ukmMeters, 3 * STEP_M, 1, 'first street counts');
    near(e.ukmMeters, 3 * STEP_M, 1, 'a parallel street ~700 m away counts separately, not as a repeat');
  }

  console.log('\n── the matcher tick catches up trips matched without a UKM figure ──');
  {
    // How the reported bug happened: the re-match script writes snapped geometry directly and
    // never computes UKM, so a perfectly matched trip sits with a route and no figure, and the
    // trip page hides the card. The worker has to notice and fix that on its own rather than
    // depending on anyone remembering to run backfill:ukm.
    await Trip.deleteMany({});
    const orphan = await mk(0, [road(0, 4)]);
    await Trip.updateOne({ _id: orphan._id }, { $set: { ukmMeters: null, ukmWithinTripMeters: null } });

    const before = await Trip.findById(orphan._id);
    assert(before.ukmMeters === null, 'starts with snapped geometry but no UKM figure');

    const { tick } = require('../src/services/mapMatcher');
    await tick();

    const after = await Trip.findById(orphan._id);
    near(after.ukmMeters, 4 * STEP_M, 1, 'the tick computed the missing UKM without being asked');
    assert(after.ukmNewShapes && after.ukmNewShapes.length === 1, 'and produced the highlight geometry too');
  }


  console.log('\n── the sweep also catches UKM computed from geometry that has since changed ──');
  {
    // Re-matching a trip rewrites its route. A UKM figure derived from the OLD route then
    // describes roads the trip no longer claims to have driven — and because ukmMeters is not
    // null, a "missing UKM" check walks straight past it. A real trip re-matched from 23 km to
    // 130 km kept its 23 km-era UKM until this case was handled.
    await Trip.deleteMany({});
    const t = await mk(0, [road(0, 6)]);
    // Pretend UKM was computed BEFORE the current geometry was matched.
    await Trip.updateOne({ _id: t._id }, { $set: {
      ukmMeters: 111, ukmWithinTripMeters: 111, ukmNewShapes: [],
      ukmComputedAt: new Date(t0 - 3600_000),
      mapMatchedAt: new Date(t0),
    } });

    const { tick } = require('../src/services/mapMatcher');
    await tick();

    const after = await Trip.findById(t._id);
    near(after.ukmMeters, 6 * STEP_M, 1, 'UKM is recomputed from the current route, not left at its stale value');
    assert(after.ukmComputedAt >= after.mapMatchedAt, 'and is now at least as new as the geometry it describes');
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n🎉 TRIP UKM (unique kilometers) VERIFIED — ${passed} assertions passed\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
