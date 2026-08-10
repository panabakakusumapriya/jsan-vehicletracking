// GET /api/trips/merged-summary — one row per driver+calendar-day, used by the Trips page's
// grouped view (and the Reports overview). Covers: correct grouping/totals, that the same
// status/driverIds filters list()/export() use also apply here (including the "empty driverIds
// must mean zero rows, not the whole fleet" rule), and that `total` counts day-GROUPS, not raw
// trips — pagination over this endpoint must never be silently off by counting the wrong thing.
// Run: npm run test:merged-summary
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('trip_merged_summary_test');
  process.env.JWT_SECRET = 'trip_merged_summary_test_secret_1234567890';

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

  // Alice: 3 trips on 2026-08-01 (one still active), 1 trip on 2026-08-02.
  await Trip.create({ driverId: alice._id, status: 'completed', startedAt: new Date('2026-08-01T02:00:00Z'), endedAt: new Date('2026-08-01T02:30:00Z'), distanceMeters: 1000, maxSpeedKmh: 40 });
  await Trip.create({ driverId: alice._id, status: 'completed', startedAt: new Date('2026-08-01T10:00:00Z'), endedAt: new Date('2026-08-01T10:45:00Z'), distanceMeters: 2000, maxSpeedKmh: 60 });
  await Trip.create({ driverId: alice._id, status: 'active', startedAt: new Date('2026-08-01T18:00:00Z'), endedAt: null, distanceMeters: 500, maxSpeedKmh: 30 });
  await Trip.create({ driverId: alice._id, status: 'completed', startedAt: new Date('2026-08-02T09:00:00Z'), endedAt: new Date('2026-08-02T09:20:00Z'), distanceMeters: 1500, maxSpeedKmh: 50 });

  // Bob: 1 trip on 2026-08-01.
  await Trip.create({ driverId: bob._id, status: 'completed', startedAt: new Date('2026-08-01T05:00:00Z'), endedAt: new Date('2026-08-01T05:30:00Z'), distanceMeters: 800, maxSpeedKmh: 45 });

  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();
  const login = await request(app).post('/api/auth/login').send({ email: 'a@x.com', password: 'pw123456' });
  const asAdmin = (r) => r.set('Authorization', `Bearer ${login.body.token}`);

  console.log('\n── grouping and totals ──');
  const all = await asAdmin(request(app).get('/api/trips/merged-summary'));
  assert(all.body.total === 3, 'three distinct driver+day groups exist (Alice x2 days, Bob x1 day)');
  assert(all.body.summaries.length === 3, 'all three groups returned within the default page size');

  const aliceAug1 = all.body.summaries.find((s) => s.driverName === 'Alice' && s.date === '2026-08-01');
  assert(aliceAug1.totalTrips === 3, 'Alice 2026-08-01 rolls up all 3 of that day\'s trips, not just some');
  assert(aliceAug1.totalDistance === 3500, 'distance summed correctly across the day\'s trips (1000+2000+500)');
  assert(aliceAug1.maxSpeed === 60, 'max speed is the max across the day, not the last trip\'s value');
  assert(aliceAug1.anyActive === true, 'a day containing a still-active trip is flagged anyActive');

  const aliceAug2 = all.body.summaries.find((s) => s.driverName === 'Alice' && s.date === '2026-08-02');
  assert(aliceAug2.totalTrips === 1 && aliceAug2.anyActive === false, 'Alice 2026-08-02 is a separate row from 2026-08-01, not merged together');

  console.log('\n── driverIds filter applies the same rule as list()/export() ──');
  const onlyAlice = await asAdmin(request(app).get(`/api/trips/merged-summary?driverIds=${alice._id}`));
  assert(onlyAlice.body.total === 2, 'driverIds=<alice> returns only Alice\'s 2 day-groups');
  assert(onlyAlice.body.summaries.every((s) => s.driverName === 'Alice'), 'no Bob rows leaked into an Alice-scoped query');

  const emptyDriverIds = await asAdmin(request(app).get('/api/trips/merged-summary?driverIds='));
  assert(emptyDriverIds.body.total === 0 && emptyDriverIds.body.summaries.length === 0,
    'driverIds= (present, empty — a project/country combo matching nobody) returns ZERO groups, not the whole fleet');

  console.log('\n── status filter ──');
  const activeOnly = await asAdmin(request(app).get('/api/trips/merged-summary?status=active'));
  assert(activeOnly.body.total === 1, 'status=active groups only the day containing an active trip');

  console.log('\n── date range filter ──');
  const aug2Only = await asAdmin(request(app).get('/api/trips/merged-summary?from=2026-08-02&to=2026-08-02'));
  assert(aug2Only.body.total === 1 && aug2Only.body.summaries[0].date === '2026-08-02',
    'from/to scopes grouping to the requested date range, same as the flat trip list');

  console.log('\n── pagination counts GROUPS, not raw trips ──');
  const page1 = await asAdmin(request(app).get('/api/trips/merged-summary?limit=2&page=1'));
  assert(page1.body.total === 3 && page1.body.summaries.length === 2,
    'total (3) reflects day-groups, not the 5 raw trips underneath them, even though the page itself is capped to 2');
  const page2 = await asAdmin(request(app).get('/api/trips/merged-summary?limit=2&page=2'));
  assert(page2.body.summaries.length === 1, 'second page carries the remaining group');

  console.log(`\n🎉 TRIP MERGED SUMMARY — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
