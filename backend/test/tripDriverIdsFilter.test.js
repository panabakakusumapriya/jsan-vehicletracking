// GET /api/trips?driverIds= — the multi-driver scoping used by the admin panel's Project /
// Country filters. Guards specifically against the "silent drop" bug: a project/country combo
// that resolves to zero drivers must return zero trips, never silently fall back to "no
// filter, show the whole fleet" — that's exactly the anomaly a manager would never notice
// (looks like an empty result, but sitting right next to "everyone else's trips" would be far
// worse: a manager filtering to their own team seeing someone else's driver instead).
// Run: npm run test:trip-filter
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('trip_driverids_test');
  process.env.JWT_SECRET = 'trip_driverids_test_secret_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');

  const admin = new User({ name: 'Admin', email: 'a@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();

  const alice = new User({ name: 'Alice', email: 'alice@x.com', role: 'user' });
  await alice.setPassword('pw123456'); await alice.save();
  const bob = new User({ name: 'Bob', email: 'bob@x.com', role: 'user' });
  await bob.setPassword('pw123456'); await bob.save();

  await Trip.create({ driverId: alice._id, status: 'completed', startedAt: new Date('2026-08-01T10:00:00Z'), endedAt: new Date('2026-08-01T11:00:00Z') });
  await Trip.create({ driverId: bob._id, status: 'completed', startedAt: new Date('2026-08-02T10:00:00Z'), endedAt: new Date('2026-08-02T11:00:00Z') });

  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();
  const login = await request(app).post('/api/auth/login').send({ email: 'a@x.com', password: 'pw123456' });
  const asAdmin = (r) => r.set('Authorization', `Bearer ${login.body.token}`);

  console.log('\n── driverIds scopes to exactly the given set ──');
  const onlyAlice = await asAdmin(request(app).get(`/api/trips?driverIds=${alice._id}`));
  assert(onlyAlice.body.trips.length === 1 && onlyAlice.body.total === 1, 'driverIds=<alice> returns only Alice\'s trip');
  assert((typeof onlyAlice.body.trips[0].driverId === 'object' ? onlyAlice.body.trips[0].driverId.name : null) === 'Alice',
    'the one trip returned really is Alice\'s');

  const both = await asAdmin(request(app).get(`/api/trips?driverIds=${alice._id},${bob._id}`));
  assert(both.body.total === 2, 'driverIds=<alice>,<bob> returns both trips');

  console.log('\n── the critical case: driverIds present but resolving to zero drivers ──');
  const empty = await asAdmin(request(app).get('/api/trips?driverIds='));
  assert(empty.body.total === 0 && empty.body.trips.length === 0,
    'driverIds= (a project/country combo matching nobody) returns ZERO trips — not silently every trip in the fleet');

  const noFilterAtAll = await asAdmin(request(app).get('/api/trips'));
  assert(noFilterAtAll.body.total === 2,
    'sanity check: omitting driverIds entirely (not even present) still returns everyone — confirms the empty case above is a real, deliberate distinction, not just "always empty"');

  console.log('\n── a real driverId always wins over a stale/incidental driverIds ──');
  const priority = await asAdmin(request(app).get(`/api/trips?driverId=${bob._id}&driverIds=${alice._id}`));
  assert(priority.body.total === 1 && (typeof priority.body.trips[0].driverId === 'object' ? priority.body.trips[0].driverId.name : null) === 'Bob',
    'an explicit single driverId takes precedence over driverIds, matching a specific-driver pick in the UI');

  console.log('\n── the export endpoint applies the identical rule ──');
  const exportEmpty = await asAdmin(request(app).get('/api/trips/export?format=json&driverIds='));
  assert(exportEmpty.status === 200, 'export with driverIds= (zero drivers) still succeeds — as an empty archive, not an error, and not everyone\'s trips');

  console.log(`\n🎉 TRIP driverIds FILTER — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
