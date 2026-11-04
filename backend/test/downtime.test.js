// Downtime — time a driver was stopped for a reason (weather, change-over), counted toward working
// hours once a manager approves it. The rules (services/downtime.js) and the totals on both sides:
// the driver's my-day and the Trips page's driver-day row must say the same thing.
//
// Run: node test/downtime.test.js
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
  process.env.MONGODB_URI = mongod.getUri('downtime_test');
  process.env.JWT_SECRET = 'downtime_test_secret_1234567890';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const Downtime = require('../src/models/Downtime');
  const app = createApp();

  const mk = async (email, role, extra = {}) => {
    const u = new User({ name: email.split('@')[0], email, role, ...extra });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      u,
      get: (p) => auth(request(app).get(p)),
      post: (p, b) => auth(request(app).post(p)).send(b),
      patch: (p, b) => auth(request(app).patch(p)).send(b),
      del: (p) => auth(request(app).delete(p)),
    };
  };
  const admin = await mk('admin@x.com', 'admin');
  const loneManager = await mk('mgr@x.com', 'manager');
  const drv = await mk('drv@x.com', 'user', { timezone: 'Asia/Kolkata' });

  // 2026-10-01 in Kolkata: trips 13:28–14:12 (44 min) and 15:00–16:30 (90 min) = 134 min.
  const t = (hhmm) => new Date(`2026-10-01T${hhmm}:00+05:30`);
  await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: t('13:28'), endedAt: t('14:12'), distanceMeters: 12000 });
  await Trip.create({ driverId: drv.u._id, status: 'completed', startedAt: t('15:00'), endedAt: t('16:30'), distanceMeters: 30000 });
  const add = (from, to, reason = 'weather', extra = {}) => drv.post('/api/tracking/my-downtime', { startAt: t(from), endAt: t(to), reason, tz: 'Asia/Kolkata', ...extra });

  console.log('\n── reporting: the rules ──');
  const gap = await add('14:20', '14:50', 'weather', { clientId: 'c-1' });
  assert(gap.status === 201 && gap.body.downtime.status === 'approved' && gap.body.downtime.durationMs === 30 * MIN, 'a 30-minute weather stop between two trips is saved and counted — no approval step');
  const resend = await add('14:20', '14:50', 'weather', { clientId: 'c-1' });
  assert(resend.status === 201 && resend.body.downtime.id === gap.body.downtime.id && (await Downtime.countDocuments()) === 1, 'a resend with the same clientId is the same entry, not a second one');
  const overTrip = await add('14:00', '14:20');
  assert(overTrip.status === 400 && /overlaps your trip 13:28–14:12/.test(overTrip.body.error), 'time over a trip is refused, naming the trip — it is counted already');
  const overOther = await add('14:40', '14:55');
  assert(overOther.status === 400 && /already reported downtime 14:20–14:50/.test(overOther.body.error), 'time over another entry is refused');
  assert((await add('09:00', '10:00')).status === 400, 'before the first trip: more than 3 hours before it is refused');
  const before = await add('10:30', '13:28', 'vehicle_changeover');
  assert(before.status === 201, 'up to 3 hours before the first trip is allowed (a change-over at the start of the shift)');
  const tooMuch = await add('16:30', '19:29');
  assert(tooMuch.status === 400 && /at most 6 hours/.test(tooMuch.body.error), 'a day holds at most 6 hours of downtime');
  assert((await add('16:30', '20:00')).status === 400, 'after the last trip: more than 3 hours after it is refused');
  const after = await add('16:30', '18:50', 'fuel');
  assert(after.status === 201, 'within 3 hours after the last trip is allowed');
  assert((await add('14:12', '14:20', 'other')).status === 400, '"other" needs a note');
  assert((await add('14:12', '14:20', 'other', { note: 'police stop' })).status === 201, '…and is saved with one');
  assert((await drv.post('/api/tracking/my-downtime', { startAt: new Date('2026-10-05T10:00:00+05:30'), endAt: new Date('2026-10-05T11:00:00+05:30'), reason: 'weather', tz: 'Asia/Kolkata' })).status === 400, 'a day without a trip is refused');
  assert((await drv.post('/api/tracking/my-downtime', { startAt: new Date(Date.now() + 60 * MIN), endAt: new Date(Date.now() + 90 * MIN), reason: 'weather' })).status === 400, 'the future is refused');
  assert((await add('14:12', '14:12')).status === 400, 'under a minute is refused');

  console.log('\n── counted straight away ──');
  const day = await drv.get('/api/tracking/my-day?date=2026-10-01&tz=Asia/Kolkata');
  assert(day.body.downtime.length === 4 && day.body.totals.tripWorkMs === 134 * MIN && day.body.totals.downtimeMs === 356 * MIN,
    'my-day lists the four entries: 2 h 14 min of trips + 5 h 56 min downtime');
  assert(day.body.totals.workMs === 490 * MIN && day.body.totals.pendingDowntimeMs === 0, '…working hours 8 h 10 min, nothing waiting on anyone');

  console.log('\n── the panel ──');
  assert((await drv.get('/api/downtime')).status === 403, 'drivers cannot open the staff list');
  const list = await admin.get('/api/downtime');
  assert(list.status === 200 && list.body.downtime.length === 4 && list.body.downtime[0].driverName === 'drv', 'staff see all four, with the driver');
  assert((await loneManager.get('/api/downtime')).body.downtime.length === 0, 'a manager without this driver sees none of it');
  assert((await admin.patch(`/api/downtime/${gap.body.downtime.id}`, { status: 'rejected' })).status === 404, 'there is no approve / reject any more');

  const sum = await admin.get('/api/trips/merged-summary');
  const row = sum.body.summaries.find((s) => s.date === '2026-10-01');
  assert(row.workMs === day.body.totals.workMs && row.tripWorkMs === 134 * MIN && row.downtimeMs === 356 * MIN,
    'the Trips page row says exactly what the phone says: trips + downtime');
  assert(sum.body.totals.workMs === row.workMs && sum.body.totals.downtimeMs === 356 * MIN, '…and so do the page totals');

  console.log('\n── the export ──');
  const csvRows = (text) => {
    const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
    const head = lines[0].split(',');
    return lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v])));
  };
  const tripsSheet = csvRows((await admin.get('/api/trips/export-table?format=csv&level=trips')).text);
  const dts = tripsSheet.filter((r) => r.Type === 'Downtime');
  assert(dts.length === 4 && tripsSheet.filter((r) => r.Type === 'Trip').length === 2, 'the Trips sheet lists the 4 downtime entries along with the 2 trips');
  assert(!('UKM (km)' in tripsSheet[0]) && 'Assigned UKM (km)' in tripsSheet[0] && 'Outside UKM (km)' in tripsSheet[0],
    'no plain "UKM" column — only Assigned and Outside UKM, as on the Trips page');
  const weather = dts.find((r) => r['Downtime reason'] === 'Weather');
  assert(weather.Status === 'counted' && weather['Counts in working hours'] === 'yes' && weather['Duration (h)'] === '0.5',
    'the weather stop: 0.5 h, counted in working hours');
  assert(dts.every((r) => r.Status === 'counted' && r['Counts in working hours'] === 'yes'), 'every downtime row is counted');
  const starts = tripsSheet.map((r) => r.Started);
  assert(starts.every((x, i) => i === 0 || x <= starts[i - 1]), 'trips and downtime are in one time order, newest first');
  const daysSheet = csvRows((await admin.get('/api/trips/export-table?format=csv&level=days')).text);
  const dRow = daysSheet.find((r) => r.Date === '2026-10-01');
  assert(dRow['Working hours'] === String(Math.round((490 / 60) * 100) / 100) && dRow['Downtime (h)'] === String(Math.round((356 / 60) * 100) / 100),
    'the Days sheet: working hours 8.17 h, of which 5.93 h downtime');

  console.log('\n── taking one back ──');
  assert((await drv.del(`/api/tracking/my-downtime/${gap.body.downtime.id}`)).status === 200 && (await Downtime.countDocuments()) === 3, 'a driver can remove their own entry');
  const after2 = await drv.get('/api/tracking/my-day?date=2026-10-01&tz=Asia/Kolkata');
  assert(after2.body.totals.workMs === 460 * MIN, '…and working hours drop by its 30 minutes');
  assert((await admin.del(`/api/tracking/my-downtime/${before.body.downtime.id}`)).status === 403, 'my-downtime is for drivers only');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
