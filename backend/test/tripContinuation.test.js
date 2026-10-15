// Points that keep arriving under a trip id after the server force-closed that trip.
//
// The field case: a phone resumed yesterday's trip id after an overnight sign-out, the server
// force-closed the 21-hour-old trip as overlong, and the whole morning's driving was appended to
// yesterday's closed trip. Now those points open a continuation trip — but only after an
// 'overlong' close (or a timed-out trip already past the cap). A 'superseded' close keeps
// appending, or two phones on one account would keep closing each other's trips.
//
// Run: node test/tripContinuation.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('trip_continuation_test');
  process.env.JWT_SECRET = 'trip_continuation_test_secret_1234567890';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const LocationPoint = require('../src/models/LocationPoint');
  await Trip.init(); await LocationPoint.init();
  const { createApp } = require('../src/app');
  const { closeOverlongTrips, closeDeadTrips } = require('../src/services/tripLifecycle');
  const { continuationKey } = require('../src/controllers/tracking.controller');
  const app = createApp();

  const driver = new User({ name: 'D', email: 'd@x.com', role: 'user' });
  await driver.setPassword('pw123456'); await driver.save();
  const token = (await request(app).post('/api/auth/login').send({ email: 'd@x.com', password: 'pw123456' })).body.token;
  const ingest = (points) => request(app).post('/api/tracking/ingest').set('Authorization', `Bearer ${token}`).send({ points });

  const MIN = 60 * 1000;
  const now = Date.now();
  let seq = 0;
  const pt = (trip, atMs, extra = {}) => ({
    clientId: `p${++seq}`, clientTripId: trip, lat: -43.5 + seq / 10000, lon: 172.6, speedKmh: 30,
    recordedAt: new Date(atMs).toISOString(), tripStatus: 'active', ...extra,
  });
  const tripOf = (key) => Trip.findOne({ clientTripId: key, driverId: driver._id }).lean();
  const pointsOf = async (key) => LocationPoint.countDocuments({ tripId: (await tripOf(key))._id });

  // ── 1. Over the cap, force-closed, and the phone keeps going ────────────────
  await ingest([pt('t1', now - 10 * 60 * MIN), pt('t1', now - 10 * 60 * MIN + MIN)]);
  assert(await closeOverlongTrips() === 1, 'the watchdog force-closes the 10-hour trip');
  let t1 = await tripOf('t1');
  assert(t1.status === 'completed' && t1.closeReason === 'overlong', '…as overlong');

  await ingest([pt('t1', t1.endedAt.getTime() + 30 * 1000)]);
  assert(await pointsOf('t1') === 3, 'a point from just before the close still lands in the trip (late tail)');

  await ingest([pt('t1', t1.endedAt.getTime() + 5 * MIN), pt('t1', t1.endedAt.getTime() + 6 * MIN)]);
  const key = continuationKey('t1', t1.endedAt);
  let cont = await tripOf(key);
  assert(cont && cont.status === 'active', 'points recorded after the close open a continuation trip');
  assert(await pointsOf('t1') === 3 && await pointsOf(key) === 2, '…and none of them go into the closed trip');
  assert(cont.startedAt.getTime() === t1.endedAt.getTime() + 5 * MIN, '…which starts at the first of them');

  await ingest([pt('t1', t1.endedAt.getTime() + 7 * MIN), pt('t1', t1.endedAt.getTime() + 8 * MIN, { tripStatus: 'ended' })]);
  cont = await tripOf(key);
  assert(await pointsOf(key) === 4 && await Trip.countDocuments({ driverId: driver._id }) === 2, 'every later batch finds the same continuation');
  assert(cont.status === 'completed' && cont.closeReason === 'device', "the phone's end signal closes the continuation");
  t1 = await tripOf('t1');
  assert(t1.status === 'completed' && t1.pointCount === 3, 'the force-closed trip is left exactly as it was');

  // ── 2. Superseded: still appends ────────────────────────────────────────────
  await ingest([pt('s1', now - 30 * MIN)]);
  await ingest([pt('s2', now - 20 * MIN)]);
  const s1 = await tripOf('s1');
  assert(s1.status === 'completed' && s1.closeReason === 'superseded', 'a new trip closes the same driver\'s open one as superseded');
  await ingest([pt('s1', now - 10 * MIN)]);
  assert(await pointsOf('s1') === 2 && !(await tripOf(continuationKey('s1', s1.endedAt))), '…and later points for it append, no continuation (two phones on one account)');

  // ── 3. Timed out and already past the cap: continue rather than revive ──────
  const old = await Trip.create({
    clientTripId: 'd1', driverId: driver._id, status: 'active', startedAt: new Date(now - 9 * 60 * MIN),
    lastLocation: { lat: -43.5, lon: 172.6, recordedAt: new Date(now - 60 * MIN) },
  });
  await Trip.updateMany({ _id: { $ne: old._id }, driverId: driver._id, status: 'active' }, { $set: { status: 'completed' } });
  assert(await closeDeadTrips() === 1, 'a silent trip is timed out by the watchdog');
  const d1 = await tripOf('d1');
  assert(d1.closeReason === 'dead', '…recorded as dead');
  await ingest([pt('d1', now + MIN)]);
  assert((await tripOf('d1')).status === 'timed_out', 'a 9-hour-old timed-out trip is not revived by fresh points');
  assert((await tripOf(continuationKey('d1', d1.endedAt)))?.status === 'active', '…they open a continuation instead');

  // ── 3a. One batch straddling the cap: the tail stays, the rest continues, nothing is revived ──
  // (Review finding: reviving the trip for its in-cap tail let the continuation's creation close it
  // again as 'superseded', and every later batch was appended to it closed.)
  const startX = now - (8 * 60 + 5) * MIN;
  await Trip.create({
    clientTripId: 'x1', driverId: driver._id, status: 'timed_out', startedAt: new Date(startX),
    endedAt: new Date(now - 10 * MIN), closeReason: 'dead',
  });
  await ingest([pt('x1', startX + (7 * 60 + 55) * MIN), pt('x1', startX + (8 * 60 + 3) * MIN)]);
  const x1 = await tripOf('x1');
  const xKey = continuationKey('x1', x1.endedAt);
  assert(x1.status === 'timed_out' && await pointsOf('x1') === 1, 'the in-cap tail joins the trip, which is not revived');
  assert((await tripOf(xKey))?.status === 'active' && await pointsOf(xKey) === 1, '…and the rest opens a live continuation');
  await ingest([pt('x1', now + 2 * MIN)]);
  assert(await pointsOf(xKey) === 2 && await pointsOf('x1') === 1, 'the next batch reaches the continuation, not the closed trip');

  // ── 3b. Yesterday's drive, its offline backlog synced today: still one trip ──
  await Trip.create({
    clientTripId: 'o1', driverId: driver._id, status: 'timed_out', startedAt: new Date(now - 20 * 60 * MIN),
    endedAt: new Date(now - 19 * 60 * MIN), closeReason: 'dead',
  });
  await ingest([pt('o1', now - 18 * 60 * MIN), pt('o1', now - 17 * 60 * MIN)]);
  assert(await pointsOf('o1') === 2 && await Trip.countDocuments({ clientTripId: /^o1~/ }) === 0,
    "an old drive's backlog recorded within the cap joins its own trip, synced however late");

  // ── 4. Timed out but young: revived as before ───────────────────────────────
  await Trip.create({
    clientTripId: 'y1', driverId: driver._id, status: 'timed_out', startedAt: new Date(now - 60 * MIN),
    endedAt: new Date(now - 5 * MIN), closeReason: 'dead',
  });
  await ingest([pt('y1', now)]);
  const y1 = await tripOf('y1');
  assert(y1.status === 'active' && y1.closeReason === null, 'a young timed-out trip is revived as before');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
