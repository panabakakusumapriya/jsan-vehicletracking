// The Reports tab's driver+date day report (mergedPoints / exportMerged / mergedSummary's day
// bucketing) must use the DRIVER's real-world day, not the server's/UTC — a trip that starts
// just after local midnight for a driver in Singapore (UTC+8) belongs to that local day, not
// the previous UTC day. Zone is resolved from the driver's stored `country` (coarse but the
// only location signal guaranteed to be set — see utils/countryTimezone.js).
// Run: npm run test:tz-report
const { MongoMemoryServer } = require('mongodb-memory-server');
const { timezoneForCountry } = require('../src/utils/countryTimezone');
const { dayRange } = require('../src/utils/timezone');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

console.log('\n── unit: country → timezone ──');
assert(timezoneForCountry('Singapore') === 'Asia/Singapore', 'full country name resolves');
assert(timezoneForCountry('SG') === 'Asia/Singapore', 'ISO alpha-2 code resolves to the same zone as the full name');
assert(timezoneForCountry('sg') === 'Asia/Singapore', 'lookup is case-insensitive');
assert(timezoneForCountry('Australia') === 'Australia/Sydney', 'multi-zone country gets its deliberate pick');
assert(timezoneForCountry('Narnia') === 'UTC', 'unmapped country falls back to UTC rather than throwing');
assert(timezoneForCountry(null) === 'UTC', 'missing country falls back to UTC');

console.log('\n── unit: dayRange half-open boundaries ──');
{
  const { from, to, tz } = dayRange('2026-08-02', 'Asia/Singapore');
  assert(tz === 'Asia/Singapore', 'dayRange echoes back the zone it used');
  assert(from.toISOString() === '2026-08-01T16:00:00.000Z', 'Singapore midnight Aug 2 is 16:00 UTC Aug 1 (UTC+8)');
  assert(to.toISOString() === '2026-08-02T16:00:00.000Z', 'end boundary is the following local midnight, half-open');
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('trip_timezone_report_test');
  process.env.JWT_SECRET = 'trip_timezone_report_test_secret_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');

  const admin = new User({ name: 'Admin', email: 'a@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();

  // Fixed +8, no DST — easiest zone to reason about exactly.
  const ravi = new User({ name: 'Ravi', email: 'ravi@x.com', role: 'user', country: 'Singapore' });
  await ravi.setPassword('pw123456'); await ravi.save();

  // No country on file at all — must fall back to UTC, not crash.
  const noor = new User({ name: 'Noor', email: 'noor@x.com', role: 'user', country: null });
  await noor.setPassword('pw123456'); await noor.save();

  // Ravi, 2026-08-01T10:00Z = 2026-08-01T18:00 Singapore -> clearly Aug 1 locally.
  await Trip.create({ driverId: ravi._id, status: 'completed', startedAt: new Date('2026-08-01T10:00:00Z'), endedAt: new Date('2026-08-01T10:30:00Z'), distanceMeters: 1000, maxSpeedKmh: 40 });
  // Ravi, 2026-08-01T16:30Z = 2026-08-02T00:30 Singapore -> Aug 2 locally, even though the UTC
  // calendar date is still Aug 1. This is exactly the case the old UTC-only code got wrong.
  await Trip.create({ driverId: ravi._id, status: 'completed', startedAt: new Date('2026-08-01T16:30:00Z'), endedAt: new Date('2026-08-01T17:00:00Z'), distanceMeters: 2000, maxSpeedKmh: 60 });

  // Noor, 2026-08-01T23:30Z -> with no country, must resolve to UTC and stay in Aug 1.
  await Trip.create({ driverId: noor._id, status: 'completed', startedAt: new Date('2026-08-01T23:30:00Z'), endedAt: new Date('2026-08-01T23:45:00Z'), distanceMeters: 500, maxSpeedKmh: 30 });

  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();
  const login = await request(app).post('/api/auth/login').send({ email: 'a@x.com', password: 'pw123456' });
  const asAdmin = (r) => r.set('Authorization', `Bearer ${login.body.token}`);

  console.log('\n── mergedPoints buckets by the DRIVER\'s local day, not UTC ──');
  const ravi01 = await asAdmin(request(app).get(`/api/trips/merged-points?driverId=${ravi._id}&date=2026-08-01`));
  assert(ravi01.body.totalTrips === 1, 'Ravi 2026-08-01 (Singapore-local) has only the 18:00-local trip, not the one that rolled into Aug 2');
  assert(ravi01.body.timezone === 'Asia/Singapore', 'response echoes the zone used, for on-screen transparency');

  const ravi02 = await asAdmin(request(app).get(`/api/trips/merged-points?driverId=${ravi._id}&date=2026-08-02`));
  assert(ravi02.body.totalTrips === 1, 'Ravi 2026-08-02 (Singapore-local) picks up the trip that started 16:30 UTC / 00:30 local Aug 2');
  assert(ravi02.body.trips[0].distanceMeters === 2000, 'it is specifically the 16:30Z trip, correctly rolled into the next local day');

  console.log('\n── exportMerged uses the same boundary ──');
  const exp02 = await asAdmin(request(app).get(`/api/trips/export-merged?driverId=${ravi._id}&date=2026-08-02&format=json`));
  assert(exp02.status === 200 && exp02.body.totalTrips === 1, 'export for the local day finds the rolled-over trip, matching mergedPoints');
  const exp01 = await asAdmin(request(app).get(`/api/trips/export-merged?driverId=${ravi._id}&date=2026-08-01&format=json`));
  assert(exp01.status === 200 && exp01.body.totalTrips === 1, 'export for the previous local day does not also include it');

  console.log('\n── no country on file falls back to UTC, not a crash ──');
  const noorUtc = await asAdmin(request(app).get(`/api/trips/merged-points?driverId=${noor._id}&date=2026-08-01`));
  assert(noorUtc.body.totalTrips === 1 && noorUtc.body.timezone === 'UTC', 'driver with no country resolves to UTC and still finds the trip');

  console.log('\n── mergedSummary groups the SAME two Ravi trips into two separate local days ──');
  const summary = await asAdmin(request(app).get(`/api/trips/merged-summary?driverId=${ravi._id}`));
  assert(summary.body.total === 2, 'Ravi\'s two trips land in two distinct Singapore-local day-groups, not merged into one UTC day');
  const dates = summary.body.summaries.map((s) => s.date).sort();
  assert(dates[0] === '2026-08-01' && dates[1] === '2026-08-02', 'the two day-groups are exactly Aug 1 and Aug 2 local, matching the per-trip checks above');

  console.log(`\n🎉 TRIP TIMEZONE REPORT — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
