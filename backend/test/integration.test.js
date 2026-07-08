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

  // admin live snapshot (should now show 0 active for this driver, both trips closed)
  const admin = new User({ name: 'A', email: 'a@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const al = await request(app).post('/api/auth/login').send({ email: 'a@x.com', password: 'pw123456' });
  const live = await request(app).get('/api/tracking/live').set('Authorization', `Bearer ${al.body.token}`);
  assert(live.status === 200 && Array.isArray(live.body.drivers), 'admin live endpoint returns driver array');
  assert(live.body.drivers.length === 0, 'no active trips remain (both ended)');

  console.log('\n🎉 ALL CORE FLOWS VERIFIED');
  await require('mongoose').disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
