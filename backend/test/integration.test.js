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


  console.log('\n── a watchdog-closed trip revives when points start arriving again ──');
  {
    // The core reason drivers vanished from Live: the device goes quiet (tunnel, parking, app
    // killed), the watchdog closes the trip after SESSION_DEAD_AFTER_SECONDS, then the device
    // resumes with the SAME clientTripId. Points appended fine but the trip stayed closed, and
    // /api/tracking/live only returns active trips. 98 of the newest 400 closed trips were found
    // still collecting points — 245,330 points in total, some 96 hours after the trip closed.
    const send = (pts) => auth(request(app).post('/api/tracking/ingest')).send({ points: pts });

    await send([{ clientTripId: 'rv', clientId: 'rv1', lat: 1, lon: 1, speedKmh: 30, recordedAt: new Date(Date.now() - 60000).toISOString() }]);
    const started = await Trip.findOne({ clientTripId: 'rv' });
    assert(started.status === 'active', 'trip starts active');

    await Trip.updateOne({ _id: started._id }, { $set: {
      status: 'timed_out', endedAt: new Date(),
      mapMatchStatus: 'matched', cleanedDistanceMeters: 999, ukmMeters: 888,
    } });

    await send([{ clientTripId: 'rv', clientId: 'rv2', lat: 1.001, lon: 1, speedKmh: 40, recordedAt: new Date().toISOString() }]);

    const revived = await Trip.findById(started._id);
    assert(revived.status === 'active', `the trip is active again (got ${revived.status})`);
    assert(revived.endedAt === null, 'and no longer carries an end time');
    assert(revived.mapMatchStatus === 'pending', 'queued for re-matching, so its snapped route is not left frozen mid-trip');
    assert(revived.cleanedDistanceMeters === null && revived.ukmMeters === null, 'stale cleaned/UKM figures for the partial trip are cleared');

    const activeIds = (await Trip.find({ status: 'active' }).select('_id')).map((t) => String(t._id));
    assert(activeIds.includes(String(started._id)), 'it is back in the set /api/tracking/live returns');
  }

  console.log('\n── a device-ended trip is NOT revived by a late offline batch ──');
  {
    const send = (pts) => auth(request(app).post('/api/tracking/ingest')).send({ points: pts });
    await send([{ clientTripId: 'cp', clientId: 'cp1', lat: 2, lon: 2, speedKmh: 30, recordedAt: new Date(Date.now() - 60000).toISOString() }]);
    const t = await Trip.findOne({ clientTripId: 'cp' });
    await Trip.updateOne({ _id: t._id }, { $set: { status: 'completed', endedAt: new Date() } });

    await send([{ clientTripId: 'cp', clientId: 'cp2', lat: 2.001, lon: 2, speedKmh: 40, recordedAt: new Date().toISOString() }]);
    assert((await Trip.findById(t._id)).status === 'completed', 'completed means the device said so — a late batch must not reopen it');
  }

  console.log('\n── an old offline batch does not resurrect finished history ──');
  {
    const send = (pts) => auth(request(app).post('/api/tracking/ingest')).send({ points: pts });
    await send([{ clientTripId: 'ob', clientId: 'ob1', lat: 3, lon: 3, speedKmh: 30, recordedAt: new Date(Date.now() - 72 * 3600000).toISOString() }]);
    const t = await Trip.findOne({ clientTripId: 'ob' });
    await Trip.updateOne({ _id: t._id }, { $set: { status: 'timed_out', endedAt: new Date(Date.now() - 71 * 3600000) } });

    await send([{ clientTripId: 'ob', clientId: 'ob2', lat: 3.001, lon: 3, speedKmh: 40, recordedAt: new Date(Date.now() - 70 * 3600000).toISOString() }]);
    assert((await Trip.findById(t._id)).status === 'timed_out', 'points from three days ago are not "still driving"');
  }


  console.log('\n── GPS silence alone does not close a trip when the app is still alive ──');
  {
    // ~30% of all trips were ending as timed_out because the watchdog only watched location
    // points. The app also heartbeats every 30s; a driver in a tunnel or an underground car park
    // is alive and reporting, just not producing fixes. Closing that trip is wrong, and it is
    // what left points landing in a closed session afterwards.
    const AppActivity = require('../src/models/AppActivity');
    const { closeDeadTrips } = require('../src/services/tripLifecycle');
    const stale = new Date(Date.now() - 60 * 60 * 1000); // an hour with no GPS

    const alive = new User({ name: 'Tunnel', email: 'tunnel@x.com', role: 'user' });
    await alive.setPassword('pw123456'); await alive.save();
    const aliveTrip = await Trip.create({
      driverId: alive._id, status: 'active', startedAt: stale,
      lastLocation: { lat: 1, lon: 1, recordedAt: stale },
    });
    // App said hello 10 seconds ago.
    await AppActivity.create({ driverId: alive._id, action: 'heartbeat', timestamp: new Date(Date.now() - 10_000) });

    const gone = new User({ name: 'Killed', email: 'killed@x.com', role: 'user' });
    await gone.setPassword('pw123456'); await gone.save();
    const goneTrip = await Trip.create({
      driverId: gone._id, status: 'active', startedAt: stale,
      lastLocation: { lat: 2, lon: 2, recordedAt: stale },
    });
    // Its last heartbeat is as old as its last fix — the app really is gone.
    await AppActivity.create({ driverId: gone._id, action: 'heartbeat', timestamp: stale });

    const closed = await closeDeadTrips();

    assert((await Trip.findById(aliveTrip._id)).status === 'active',
      'a driver whose app is heartbeating keeps their trip despite an hour of GPS silence');
    assert((await Trip.findById(goneTrip._id)).status === 'timed_out',
      'a driver whose app stopped heartbeating is still closed as timed_out');
    assert(closed === 1, `only the genuinely dead session was closed (got ${closed})`);
  }

  console.log('\n🎉 ALL CORE FLOWS VERIFIED');
  await require('mongoose').disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
