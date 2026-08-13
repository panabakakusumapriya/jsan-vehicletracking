// Valhalla map-matching layer: valhalla.js (chunking, retry, gap-fill) and mapMatcher.js
// (the background worker that snaps completed trips, additively, alongside the raw distance).
// Run: npm run test:map-match
process.env.JWT_SECRET = process.env.JWT_SECRET || 'map_match_test_secret_key_1234567890';
process.env.VALHALLA_URL = 'https://valhalla.test';
process.env.VALHALLA_MIN_INTERVAL_MS = '0'; // no artificial pacing while testing
process.env.MAP_MATCH_CHUNK_SIZE = '3';
process.env.MAP_MATCH_MIN_DISTANCE_METERS = '30';
process.env.GAP_FILL_MIN_SECONDS = '90';
// Deliberately not the shipped defaults (60/15) — distinctive values prove these are actually
// threaded into the outbound request rather than the test just re-asserting a hardcoded literal.
process.env.MAP_MATCH_SEARCH_RADIUS = '77';
process.env.MAP_MATCH_GPS_ACCURACY = '13';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (got ${a})`);

/** A Valhalla /trace_route or /route response shaped like the real thing. */
function tripResponse(lengthKm, shape) {
  return { trip: { legs: [{ summary: { length: lengthKm }, shape: shape || `shape_${lengthKm}` }] } };
}

function stubFetch(handler) {
  global.fetch = async (url, opts) => handler(url, opts);
}

function point(lat, lon, recordedAt) {
  return { lat, lon, recordedAt: new Date(recordedAt).toISOString() };
}

(async () => {
  // Mongo must be up and MONGODB_URI set BEFORE anything under src/ is required — env.js reads
  // it once at require time and later modules (db.js) trust that frozen value, not a
  // process.env read done afterwards. See tripMergedSummary.test.js for the same ordering.
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('map_match_test');

  const realFetch = global.fetch;
  const valhalla = require('../src/services/valhalla');
  const { matchTrace, chunkPoints, splitAtGaps, encodePolyline6 } = valhalla;

  /**
   * A success response carrying a REAL precision-6 polyline through `pts`.
   *
   * Fixtures used to hand back placeholder strings like 'shape_1.5'. Those now get rejected — and
   * rightly so: matchSegment decodes what came back and checks it actually passes near the fixes
   * that produced it, so an undecodable shape is indistinguishable from a match on the wrong
   * street. Tests that assert on matched geometry have to return geometry.
   */
  const respond = (pts, lengthKm) => ({
    ok: true,
    status: 200,
    json: async () => tripResponse(lengthKm, encodePolyline6(pts)),
  });
  /** The point pattern makeTrip() writes below, so DB-backed tests can build a matching shape. */
  const dbPoints = (n) => Array.from({ length: n }, (_, i) => ({ lat: 1 + i * 0.001, lon: 1 + i * 0.001 }));

  console.log('\n── chunkPoints ──');
  assert(chunkPoints([1, 2, 3], 5).length === 1, 'fits in one chunk when under the limit');
  assert(chunkPoints([1, 2, 3, 4, 5, 6], 3).length === 2, 'splits evenly into 2 chunks of 3');
  assert(chunkPoints([1, 2, 3, 4, 5, 6, 7], 3)[2].length === 1, 'the trailing remainder is its own short chunk');

  console.log('\n── splitAtGaps ──');
  const t0 = Date.now();
  const dense = [point(1, 1, t0), point(1, 1.001, t0 + 10_000), point(1, 1.002, t0 + 20_000)];
  assert(splitAtGaps(dense, 90_000).length === 1, 'no gap over the threshold -> a single run');
  const withGap = [...dense, point(1, 1.5, t0 + 20_000 + 200_000)];
  const split = splitAtGaps(withGap, 90_000);
  assert(split.length === 2 && split[0].length === 3 && split[1].length === 1, 'a >90s silence splits into two runs');

  console.log('\n── matchTrace: basic success + km->m conversion ──');
  {
    const pts = [point(1, 1, t0), point(1, 1.001, t0 + 1000)];
    let calls = 0;
    stubFetch((url) => {
      calls += 1;
      assert(String(url).endsWith('/trace_route'), 'hits the trace_route endpoint');
      return respond(pts, 1.5);
    });
    const r = await matchTrace(pts);
    near(r.distanceMeters, 1500, 0.01, 'km summary converted to meters');
    assert(r.shapes.length === 1 && calls === 1, 'one chunk, one call, one shape returned');
  }

  console.log('\n── matchTrace: request shape (the U-turn regression) ──');
  {
    // Driver U-turns were vanishing from snapped routes for two reasons, both encoded here.
    // See MAP_MATCH_SEND_TIMESTAMPS / MAP_MATCH_SEARCH_RADIUS in config/env.js for the numbers.
    let body = null;
    stubFetch((url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => tripResponse(1) };
    });
    const pts = [point(1, 1, t0), point(1, 1.001, t0 + 10_000), point(1, 1.002, t0 + 20_000)];
    await matchTrace(pts);

    // (1) Timestamps trigger Valhalla's route-time pruning: any trace driven faster than
    // Valhalla's modelled speed for the road has its transitions rejected and the match
    // collapses to a stub. Nothing here reads a duration, so the field is pure downside.
    assert(
      body.shape.every((p) => !('time' in p)),
      'no per-point `time` is sent — timestamps collapse matches and buy this code nothing'
    );
    assert(
      body.shape.length === 3 && body.shape.every((p) => 'lat' in p && 'lon' in p),
      'every point is still sent, as plain lat/lon'
    );

    // (2) The stock 50m candidate radius cannot see the opposite carriageway at a U-turn apex,
    // so the return leg never becomes a hypothesis and the manoeuvre snaps onto the outbound side.
    assert(body.trace_options, 'trace_options is sent rather than relying on server defaults');
    assert(body.trace_options.search_radius === 77, 'search_radius comes from env, widened past the 50m default');
    assert(body.trace_options.gps_accuracy === 13, 'gps_accuracy comes from env, reflecting real phone-GPS noise');
    assert(
      !('turn_penalty_factor' in body.trace_options),
      'turn_penalty_factor is left at the server default — overriding it changed no tested trace'
    );
    assert(body.shape_match === 'map_snap' && body.costing === 'auto', 'matching mode and costing are unchanged');
  }

  console.log('\n── matchTrace: chunking (MAP_MATCH_CHUNK_SIZE=3) ──');
  {
    // 6 points, chunk size 3 -> exactly 2 chunks, both full.
    const pts = Array.from({ length: 6 }, (_, i) => point(1, 1 + i * 0.001, t0 + i * 1000));
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return respond(pts, 1); // spans both chunks, so each chunk's points sit on it
    });
    const r = await matchTrace(pts);
    assert(calls === 2, 'a 6-point trace at chunk size 3 makes exactly 2 requests');
    near(r.distanceMeters, 2000, 0.01, 'distances from both chunks are summed');
    assert(r.shapes.length === 2, 'one shape per chunk, kept separate (not merged)');
  }

  console.log('\n── matchTrace: retries on 5xx, then succeeds ──');
  {
    const pts = [point(1, 1, t0), point(1, 1.001, t0 + 1000)];
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, text: async () => 'busy' };
      return respond(pts, 1);
    });
    const r = await matchTrace(pts);
    assert(calls === 2, 'a 503 is retried once, then succeeds');
    near(r.distanceMeters, 1000, 0.01, 'the eventually-successful response is what gets used');
  }

  console.log('\n── matchTrace: does not retry a hard 400 (unmatchable trace) ──');
  {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return { ok: false, status: 400, text: async () => 'no route found' };
    });
    const pts = [point(1, 1, t0), point(1, 1.001, t0 + 1000)];
    let caught = null;
    try { await matchTrace(pts); } catch (e) { caught = e; }
    assert(caught && calls === 1, 'a 400 fails immediately with no retry — the trace is genuinely unmatchable');
  }

  console.log('\n── matchTrace: a collapsed match is rejected, not stored (the missing-roads bug) ──');
  {
    // Valhalla answers a hopeless trace with HTTP 200 and a well-formed trip whose legs cover
    // almost nothing. A real trip fed 1000 points spanning 14.71 km got back one 40 m leg, and
    // the old code stored it — 24% of that trip vanished from the map. Coverage must be checked
    // against the input, and a collapse must never be believed.
    // The file-wide MAP_MATCH_CHUNK_SIZE=3 would put every chunk below the subdivision floor, so
    // the subdivide path would never run. Widen it for these two cases only.
    const env = require('../src/config/env');
    const realChunk = env.MAP_MATCH_CHUNK_SIZE;
    const realFloor = env.MAP_MATCH_MIN_SPLIT_POINTS;
    env.MAP_MATCH_CHUNK_SIZE = 1000;
    env.MAP_MATCH_MIN_SPLIT_POINTS = 10;

    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return { ok: true, status: 200, json: async () => tripResponse(0.00004, 'collapsed') }; // 0.04 m
    });
    // 60 fixes spanning 0.0059° of latitude ≈ 657 m of real movement — vastly more than the
    // 0.04 m Valhalla claims to have matched.
    const pts = Array.from({ length: 60 }, (_, i) => point(1 + i * 0.0001, 1, t0 + i * 1000));
    const r = await matchTrace(pts);
    assert(!r.shapes.includes('collapsed'), 'the collapsed match is discarded, not stored as the answer');
    assert(r.matchedMeters === 0, 'nothing is reported as genuinely snapped');
    assert(r.distanceMeters > 500, `the stretch still contributes its real length (~657 m), so distance is not silently lost (got ${Math.round(r.distanceMeters)})`);
    assert(r.shapes.length >= 1 && r.shapes.every((s) => s.length > 0), 'raw geometry is returned instead, so the route stays drawable');
    assert(calls > 1, 'it subdivided and retried rather than giving up on the first collapse');

    console.log('\n── matchTrace: a good match is still trusted, and reported as fully snapped ──');
    const goodShape = encodePolyline6(pts);
    stubFetch(() => ({ ok: true, status: 200, json: async () => tripResponse(1.1, goodShape) }));
    const good = await matchTrace(pts);
    assert(good.shapes.includes(goodShape), 'a plausible match is kept as-is');
    near(good.matchedMeters / good.totalMeters, 1, 0.001, 'reported as 100% genuinely snapped');

    env.MAP_MATCH_CHUNK_SIZE = realChunk;
    env.MAP_MATCH_MIN_SPLIT_POINTS = realFloor;
  }

  console.log('\n── matchTrace: a match of the right LENGTH but in the wrong place is rejected ──');
  {
    // The failure length-checking alone cannot see. A real trip with clean 2-second fixes had
    // both its chunks pass the coverage gate while 14.4% of its points sat >100 m from the road
    // they had been snapped to — the matcher had wandered onto parallel streets. Length is not
    // evidence of correctness; the result has to actually go where the vehicle went.
    const env = require('../src/config/env');
    const realChunk = env.MAP_MATCH_CHUNK_SIZE;
    const realFloor = env.MAP_MATCH_MIN_SPLIT_POINTS;
    env.MAP_MATCH_CHUNK_SIZE = 1000;
    env.MAP_MATCH_MIN_SPLIT_POINTS = 10;

    // Points run north along lon=1. The "match" returned is the same length and shape but shifted
    // ~0.01 deg east (~1.1 km away) — a textbook wrong-parallel-street result.
    const pts = Array.from({ length: 60 }, (_, i) => point(1 + i * 0.0001, 1, t0 + i * 1000));
    const offsetShape = encodePolyline6(pts.map((p) => ({ lat: p.lat, lon: p.lon + 0.01 })));

    stubFetch(() => ({ ok: true, status: 200, json: async () => tripResponse(0.66, offsetShape) }));
    const r = await matchTrace(pts);
    assert(!r.shapes.includes(offsetShape), 'the displaced match is rejected despite having a believable length');
    assert(r.matchedMeters === 0, 'nothing displaced is counted as genuinely snapped');

    // Same length, but actually on the points — must still be accepted.
    const goodShape = encodePolyline6(pts.map((p) => ({ lat: p.lat, lon: p.lon })));
    stubFetch(() => ({ ok: true, status: 200, json: async () => tripResponse(0.66, goodShape) }));
    const good = await matchTrace(pts);
    assert(good.shapes.includes(goodShape), 'a match that follows the points is still accepted');
    near(good.matchedMeters / good.totalMeters, 1, 0.001, 'and counts as fully snapped');

    env.MAP_MATCH_CHUNK_SIZE = realChunk;
    env.MAP_MATCH_MIN_SPLIT_POINTS = realFloor;
  }

  console.log('\n── matchTrace: coverage is measured against the WHOLE trace, gaps included ──');
  {
    // A device that only recorded a fraction of the journey must not be reported as fully
    // snapped just because the fragments it did record matched well.
    const pts = [
      point(1, 1, t0), point(1.001, 1, t0 + 1000),          // ~111 m recorded
      point(2, 1, t0 + 500_000), point(2.001, 1, t0 + 501_000), // ~111 m recorded, ~111 km later
    ];
    // Both fragments match perfectly — the point is that matching them well must not disguise
    // the ~111 km in between that the device never recorded.
    stubFetch(() => respond(pts, 0.12));
    const r = await matchTrace(pts);
    assert(r.totalMeters > 100_000, 'totalMeters spans the whole journey, not just the recorded runs');
    assert(r.matchedMeters / r.totalMeters < 0.01, 'a mostly-unrecorded trip reports a low snapped ratio, not 100%');
  }

  console.log('\n── matchTrace: gap-fill bridges a dropout instead of double counting it ──');
  {
    const calls = { trace: 0, route: 0 };
    // Two dense 2-point runs separated by a 200s silence (> the 90s gap threshold).
    const pts = [
      point(1, 1, t0), point(1, 1.001, t0 + 5000),
      point(1, 2, t0 + 5000 + 200_000), point(1, 2.001, t0 + 5000 + 205_000),
    ];
    stubFetch(async (url) => {
      if (String(url).endsWith('/trace_route')) { calls.trace += 1; return respond(pts, 1); }
      calls.route += 1;
      // The bridge comes from /route, which is not a match and so is not proximity-checked —
      // a marker string is fine here and proves the bridged shape reaches the result.
      return { ok: true, status: 200, json: async () => tripResponse(2, 'bridge') };
    });
    const r = await matchTrace(pts, { gapFill: true, gapFillMinMs: 90_000 });
    assert(calls.trace === 2, 'each dense run is matched independently');
    assert(calls.route === 1, 'exactly one /route call bridges the single gap — not zero, not two');
    near(r.distanceMeters, 4000, 0.01, '1km + 1km (runs) + 2km (bridge) summed once each, no double count');
    assert(r.shapes.includes('bridge'), 'the bridged segment shape is included in the result');
  }

  global.fetch = realFetch;

  console.log('\n── mapMatcher.processTrip (real DB) ──');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const Trip = require('../src/models/Trip');
  const LocationPoint = require('../src/models/LocationPoint');
  const User = require('../src/models/User');
  const { processTrip, tick } = require('../src/services/mapMatcher');

  const driver = new User({ name: 'Driver', email: 'd@x.com', role: 'user' });
  await driver.setPassword('pw123456'); await driver.save();

  async function makeTrip({ distanceMeters, status = 'completed', pointCount = 3 }) {
    const trip = await Trip.create({
      driverId: driver._id, status, startedAt: new Date(t0), endedAt: new Date(t0 + 60_000),
      distanceMeters,
    });
    for (let i = 0; i < pointCount; i++) {
      await LocationPoint.create({
        tripId: trip._id, driverId: driver._id,
        lat: 1 + i * 0.001, lon: 1 + i * 0.001, recordedAt: new Date(t0 + i * 1000),
      });
    }
    return trip;
  }

  console.log('\n── skip: trivial trip never calls Valhalla ──');
  {
    let calls = 0;
    stubFetch(() => { calls += 1; return respond(dbPoints(3), 1); });
    const trip = await makeTrip({ distanceMeters: 5, pointCount: 3 }); // under MAP_MATCH_MIN_DISTANCE_METERS=30
    const outcome = await processTrip(trip._id);
    assert(outcome === 'skipped' && calls === 0, 'a near-zero-distance trip is skipped with zero Valhalla calls');
    const reloaded = await Trip.findById(trip._id);
    assert(reloaded.mapMatchStatus === 'skipped', 'status persisted as skipped');
  }

  console.log('\n── success: cleaned fields written, raw distanceMeters untouched ──');
  {
    const cleanShape = encodePolyline6(dbPoints(3));
    stubFetch(() => ({ ok: true, status: 200, json: async () => tripResponse(1.234, cleanShape) }));
    const trip = await makeTrip({ distanceMeters: 1000, pointCount: 3 });
    const outcome = await processTrip(trip._id);
    assert(outcome === 'matched', 'processTrip reports matched');
    const reloaded = await Trip.findById(trip._id);
    assert(reloaded.distanceMeters === 1000, 'raw distanceMeters is untouched by matching — additive layer, not a replacement');
    near(reloaded.cleanedDistanceMeters, 1234, 0.01, 'cleanedDistanceMeters holds the Valhalla-matched total');
    assert(reloaded.cleanedRouteShapes.includes(cleanShape), 'the matched shape is stored');
    assert(reloaded.mapMatchStatus === 'matched' && reloaded.mapMatchedAt, 'status + timestamp recorded');
  }

  console.log('\n── failure: marked failed, raw distance still untouched ──');
  {
    stubFetch(() => ({ ok: false, status: 400, text: async () => 'off road' }));
    const trip = await makeTrip({ distanceMeters: 2000, pointCount: 3 });
    const outcome = await processTrip(trip._id);
    assert(outcome === 'failed', 'processTrip reports failed');
    const reloaded = await Trip.findById(trip._id);
    assert(reloaded.distanceMeters === 2000, 'raw distance survives a failed match untouched');
    assert(reloaded.cleanedDistanceMeters === null, 'no cleaned distance is written on failure');
    assert(reloaded.mapMatchStatus === 'failed' && reloaded.mapMatchError, 'failure status + reason recorded');
  }

  console.log('\n── an already-claimed/matched trip is not reprocessed ──');
  {
    let calls = 0;
    stubFetch(() => { calls += 1; return respond(dbPoints(3), 1); });
    const trip = await makeTrip({ distanceMeters: 1000, pointCount: 3 });
    await Trip.updateOne({ _id: trip._id }, { $set: { mapMatchStatus: 'matched' } });
    const outcome = await processTrip(trip._id);
    assert(outcome === null && calls === 0, 'processTrip no-ops on a trip that is not in pending state');
  }

  console.log('\n── pre-existing trips with NO mapMatchStatus field ever stored are still picked up ──');
  {
    // Simulates every trip that existed before this feature shipped: the field is entirely
    // absent from the stored document (not "pending" — genuinely missing), which is what
    // Mongo's own querying sees even though Mongoose displays 'pending' for it in memory via
    // the schema default. $unset reproduces that on a real trip.
    stubFetch(() => respond(dbPoints(3), 1));
    const trip = await makeTrip({ distanceMeters: 1000, pointCount: 3 });
    await Trip.updateOne({ _id: trip._id }, { $unset: { mapMatchStatus: 1 } });
    const stored = await Trip.collection.findOne({ _id: trip._id });
    assert(!('mapMatchStatus' in stored), 'sanity check: the field is really gone from storage, not just null');

    const foundByTick = await Trip.find({ status: 'completed', mapMatchStatus: 'pending' }).countDocuments();
    assert(foundByTick === 0, 'a literal "pending" filter alone would miss it — this is the bug being guarded against');

    const outcome = await processTrip(trip._id);
    assert(outcome === 'matched', 'processTrip claims and matches a trip whose field was never written at all');
  }

  console.log('\n── tick() only touches completed/timed_out trips awaiting a match ──');
  {
    stubFetch(() => respond(dbPoints(3), 1));
    await Trip.deleteMany({});
    const a = await makeTrip({ distanceMeters: 1000, status: 'completed', pointCount: 3 });
    const b = await makeTrip({ distanceMeters: 1000, status: 'timed_out', pointCount: 3 });
    const activeTrip = await makeTrip({ distanceMeters: 1000, status: 'active', pointCount: 3 });
    const result = await tick();
    assert(result.matched === 2, 'both the completed and timed_out trip get matched in one sweep');
    const reloadedActive = await Trip.findById(activeTrip._id);
    assert(reloadedActive.mapMatchStatus === 'pending', 'an active trip is left alone regardless of its mapMatchStatus default');
    const reloadedA = await Trip.findById(a._id);
    const reloadedB = await Trip.findById(b._id);
    assert(reloadedA.mapMatchStatus === 'matched' && reloadedB.mapMatchStatus === 'matched', 'both closed-trip statuses are eligible');
  }

  global.fetch = realFetch;
  await require('mongoose').disconnect();
  await mongod.stop();

  console.log(`\n🎉 MAP MATCHING (Valhalla) VERIFIED — ${passed} assertions passed\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
