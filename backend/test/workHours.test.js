// Working hours — each trip's start-to-end, added up per day.
//
// The Trips page shows it on every driver-day row (merged-summary `workMs`) and as the day-total
// row under the expanded trips; the driver app shows the same sum under the day's trips
// (GET /api/tracking/my-day). Gaps between trips are not work time, a trip still running counts up
// to now, and an imported day is left out — its times are a fixed window the importer stamped.
//
// Run: node test/workHours.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

const MIN = 60 * 1000;

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('work_hours_test');
  process.env.JWT_SECRET = 'work_hours_test_secret_1234567890';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const app = createApp();

  const mk = async (email, role, extra = {}) => {
    const u = new User({ name: email.split('@')[0], email, role, ...extra });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
    return { u, get: (path) => request(app).get(path).set('Authorization', `Bearer ${token}`) };
  };
  const admin = await mk('admin@x.com', 'admin');
  const drv = await mk('drv@x.com', 'user', { timezone: 'Asia/Kolkata' });

  // 2026-10-01 in Kolkata (UTC+5:30): 13:28–14:12 (44 min) and 15:00–16:30 (90 min); a parked-jitter
  // session and an imported day the same date must add nothing.
  const t = (hhmm) => new Date(`2026-10-01T${hhmm}:00+05:30`);
  await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: t('13:28'), endedAt: t('14:12'), distanceMeters: 12000 });
  await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: t('15:00'), endedAt: t('16:30'), distanceMeters: 30000 });
  await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: t('17:00'), endedAt: t('17:40'), distanceMeters: 50, parkedJitter: true });
  await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: t('08:00'), endedAt: t('18:00'), distanceMeters: 9000, importBatchId: 'batch-1' });
  // The next day: one trip still running, started 20 minutes ago.
  await Trip.create({ driverId: drv.u._id, status: 'active', startedAt: new Date(Date.now() - 20 * MIN), endedAt: null, distanceMeters: 4000 });

  console.log('\n── Trips page: the driver-day row ──');
  const sum = await admin.get('/api/trips/merged-summary');
  // The driver has no country, so merged-summary groups in UTC — 13:28 IST is 07:58Z, same day.
  const day = sum.body.summaries.find((s) => s.date === '2026-10-01');
  assert(day.totalTrips === 3, 'the day counts its two recorded trips and the imported one (parked jitter is left out, as everywhere)');
  assert(day.workMs === 134 * MIN, 'working hours = 44 + 90 = 134 min — the gap between trips is not counted, the imported day adds nothing');
  const live = sum.body.summaries.find((s) => s.anyActive);
  assert(live.workMs >= 20 * MIN && live.workMs < 21 * MIN, 'a trip still running counts up to now');

  console.log('\n── driver app: my-day ──');
  const mine = await drv.get('/api/tracking/my-day?date=2026-10-01&tz=Asia/Kolkata');
  assert(mine.status === 200, 'a driver can read their own day');
  assert(mine.body.trips.length === 2, 'two trips listed — no parked jitter, no imported day');
  assert(mine.body.trips[0].durationMs === 44 * MIN, 'the 13:28–14:12 trip is 44 minutes');
  assert(mine.body.totals.workMs === 134 * MIN, 'the total row is 2 h 14 min');
  assert(mine.body.totals.distanceMeters === 42000, '…and 42 km');
  const today = await drv.get('/api/tracking/my-day?tz=UTC');
  assert(today.body.trips.length === 1 && today.body.trips[0].status === 'active' && today.body.totals.workMs >= 20 * MIN,
    'without a date it is today, and the running trip counts to now');
  const fallback = await drv.get('/api/tracking/my-day?date=2026-10-01');
  assert(fallback.body.timezone === 'Asia/Kolkata' && fallback.body.trips.length === 2, 'without tz the driver\'s stored zone decides the day');
  assert((await admin.get('/api/tracking/my-day')).status === 403, 'my-day is for drivers only');
  assert((await drv.get('/api/tracking/my-day?date=2026-13-45')).status === 400, 'a nonsense date is refused, not guessed');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
