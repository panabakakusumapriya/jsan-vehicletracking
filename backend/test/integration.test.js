// Integration test — exercises the real controllers against an in-memory MongoDB.
// Run: npm test   (no external DB / network needed)
const { MongoMemoryServer } = require('mongodb-memory-server');

function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('jsan_test');
  process.env.JWT_SECRET = 'integration_test_secret_key_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const Point = require('../src/models/LocationPoint');
  await User.init(); await Trip.init(); await Point.init(); // build indexes

  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();

  // seed a driver directly
  const driver = new User({ name: 'D', email: 'd@x.com', role: 'user' });
  await driver.setPassword('pw123456');
  await driver.save();

  // login
  const login = await request(app).post('/api/auth/login').send({ email: 'd@x.com', password: 'pw123456' });
  assert(login.status === 200 && login.body.token, 'driver can log in and gets a token');
  const token = login.body.token;
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);

  // first heartbeat (1 point) starts a trip
  const p1 = { clientId: 'c1', clientTripId: 't1', lat: 17.4123, lon: 78.4456, speedKmh: 20, recordedAt: '2026-07-08T10:00:00.000Z', tripStatus: 'active' };
  let r = await auth(request(app).post('/api/tracking/ingest')).send({ points: [p1] });
  assert(r.status === 200 && r.body.accepted === 1, 'first heartbeat accepted (1 point)');
  assert((await Trip.countDocuments()) === 1, 'exactly one trip created');

  // TIMEZONE FROM COORDINATES: the driver is never asked, and the phone is never consulted.
  // These coordinates are Hyderabad, so the trip and the driver must both land on Asia/Kolkata.
  const tzTrip = await Trip.findOne({ clientTripId: 't1' });
  assert(tzTrip.timezone === 'Asia/Kolkata', `trip timezone derived from position (${tzTrip.timezone})`);
  const tzDriver = await User.findById(driver._id);
  assert(tzDriver.timezone === 'Asia/Kolkata', 'driver record picked up the same zone');

  // second point ~1.5km away advances distance
  const p2 = { clientId: 'c2', clientTripId: 't1', lat: 17.4223, lon: 78.4556, speedKmh: 45, recordedAt: '2026-07-08T10:00:10.000Z', tripStatus: 'active' };
  r = await auth(request(app).post('/api/tracking/ingest')).send({ points: [p2] });
  let trip = await Trip.findOne({ clientTripId: 't1' });
  assert(Math.round(trip.distanceMeters) > 1400 && Math.round(trip.distanceMeters) < 1700, `distance accumulated ~${Math.round(trip.distanceMeters)}m`);
  assert(trip.maxSpeedKmh === 45, 'max speed tracked (45)');
  assert(trip.pointCount === 2, 'point count is 2');

  // IDEMPOTENCY: re-send p1+p2 -> no new points, still ack'd
  r = await auth(request(app).post('/api/tracking/ingest')).send({ points: [p1, p2] });
  assert(r.body.accepted === 2, 'duplicate resend still ack\'d (so device can delete local)');
  assert((await Point.countDocuments()) === 2, 'no duplicate points inserted (idempotent)');

  // trip END signal (speed 0)
  const p3 = { clientId: 'c3', clientTripId: 't1', lat: 17.4223, lon: 78.4556, speedKmh: 0, recordedAt: '2026-07-08T10:00:20.000Z', tripStatus: 'ended' };
  await auth(request(app).post('/api/tracking/ingest')).send({ points: [p3] });
  trip = await Trip.findOne({ clientTripId: 't1' });
  assert(trip.status === 'completed' && trip.endedAt, 'trip closed on ended signal');

  // OFFLINE BATCH: many buffered points for a new trip in one shot
  const batch = Array.from({ length: 30 }, (_, i) => ({
    clientId: `b${i}`, clientTripId: 't2', lat: 17.5 + i * 0.001, lon: 78.5, speedKmh: 30,
    recordedAt: new Date(Date.parse('2026-07-08T11:00:00Z') + i * 10000).toISOString(),
    tripStatus: i === 29 ? 'ended' : 'active',
  }));
  r = await auth(request(app).post('/api/tracking/ingest')).send({ points: batch });
  assert(r.body.accepted === 30, 'offline batch of 30 accepted at once');
  const t2 = await Trip.findOne({ clientTripId: 't2' });
  assert(t2.pointCount === 30 && t2.status === 'completed', 'offline trip built + closed from batch');

  // CROSSING A ZONE: re-derived from the new position. This is the case that a login-time or
  // handset-based detection cannot see at all — the phone never moved zones, the driver did.
  await auth(request(app).post('/api/tracking/ingest')).send({
    points: [{ clientId: 'tz-move', clientTripId: 'tz-trip', lat: -31.95, lon: 115.86, speedKmh: 10, recordedAt: '2026-07-08T12:00:00.000Z', tripStatus: 'active' }],
  });
  const moved = await User.findById(driver._id);
  assert(moved.timezone === 'Australia/Perth', `driver now in Perth re-derives (${moved.timezone})`);
  assert(
    (await Trip.findOne({ clientTripId: 'tz-trip' })).timezone === 'Australia/Perth',
    'the new trip is stamped where it started'
  );
  assert(
    (await Trip.findOne({ clientTripId: 't1' })).timezone === 'Asia/Kolkata',
    'the earlier trip keeps its own zone — a later move never rewrites history'
  );
  // Leave no active trip behind, so the live-snapshot assertion below still means something.
  await Trip.updateOne({ clientTripId: 'tz-trip' }, { $set: { status: 'completed', endedAt: new Date() } });

  // admin live snapshot (should now show 0 active for this driver, both trips closed)
  const admin = new User({ name: 'A', email: 'a@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const al = await request(app).post('/api/auth/login').send({ email: 'a@x.com', password: 'pw123456' });
  const live = await request(app).get('/api/tracking/live').set('Authorization', `Bearer ${al.body.token}`);
  assert(live.status === 200 && Array.isArray(live.body.drivers), 'admin live endpoint returns driver array');
  assert(live.body.drivers.length === 0, 'no active trips remain (both ended)');

  // ── ALERTS: a driver that stops reporting must page their manager exactly once ──
  const { tick } = require('../src/services/driverWatchdog');
  const PushSub = require('../src/models/PushSubscription');
  await PushSub.init();

  const manager = new User({ name: 'M', email: 'm@x.com', role: 'manager' });
  await manager.setPassword('pw123456'); await manager.save();
  driver.managerId = manager._id;
  await driver.save();

  // A live trip whose last heartbeat is 10 min old — past DRIVER_OFFLINE_AFTER_SECONDS (180)
  // but inside SESSION_DEAD_AFTER_SECONDS (900), so it is "offline", not yet "dead".
  const silent = new Date(Date.now() - 10 * 60 * 1000);
  const live2 = await Trip.create({
    clientTripId: 't3', driverId: driver._id, managerId: manager._id, status: 'active',
    startedAt: silent, lastLocation: { lat: 17.4, lon: 78.4, speed: 0, heading: 0, recordedAt: silent },
  });

  let swept = await tick();
  assert(swept.offline === 1, 'watchdog raised exactly 1 driver-offline alert');
  let flagged = await Trip.findById(live2._id);
  assert(flagged.offlineNotifiedAt instanceof Date, 'trip carries the offlineNotifiedAt claim');

  swept = await tick();
  assert(swept.offline === 0, 'a second sweep does not re-alert the same silent trip');

  // Device comes back: a fresh heartbeat clears the flag and raises the recovery alert.
  await Trip.updateOne(
    { _id: live2._id },
    { $set: { 'lastLocation.recordedAt': new Date(), startedAt: new Date() } }
  );
  swept = await tick();
  assert(swept.online === 1, 'watchdog raised the back-online alert once the driver reported');
  flagged = await Trip.findById(live2._id);
  assert(flagged.offlineNotifiedAt === null, 'offline claim cleared, so a later drop alerts again');

  // Subscription registration is manager/admin only — drivers use the mobile app.
  const ml = await request(app).post('/api/auth/login').send({ email: 'm@x.com', password: 'pw123456' });
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'k', auth: 'a' } };
  let s = await request(app).post('/api/push/subscribe').set('Authorization', `Bearer ${ml.body.token}`).send(sub);
  assert(s.status === 201, 'manager can register a push subscription');
  s = await request(app).post('/api/push/subscribe').set('Authorization', `Bearer ${ml.body.token}`).send(sub);
  assert(s.status === 201 && (await PushSub.countDocuments()) === 1, 're-registering the same endpoint upserts (no duplicate)');
  s = await auth(request(app).post('/api/push/subscribe')).send(sub);
  assert(s.status === 403, 'drivers cannot subscribe to panel alerts');

  // A trip silent past the dead-session window is closed by the same sweep.
  await Trip.updateOne(
    { _id: live2._id },
    { $set: { 'lastLocation.recordedAt': new Date(Date.now() - 60 * 60 * 1000) } }
  );
  swept = await tick();
  assert(swept.closed === 1, 'watchdog closes trips silent past the dead-session window');
  assert((await Trip.findById(live2._id)).status === 'timed_out', 'dead trip marked timed_out');

  console.log('\n🎉 ALL CORE FLOWS VERIFIED');
  await require('mongoose').disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
