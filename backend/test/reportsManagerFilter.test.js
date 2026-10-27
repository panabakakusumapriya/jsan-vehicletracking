// Reports for a manager: the date and driver filters must narrow what the manager may see —
// never widen it, never be ignored.
// Run: npm run test:reports-manager
process.env.JWT_SECRET = process.env.JWT_SECRET || 'reports_manager_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';
process.env.MAP_MATCH_ENABLED = 'false';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('reports_manager_test');

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const app = createApp();

  const mk = async (fields) => {
    const u = new User({ password: undefined, ...fields });
    await u.setPassword('pw123456');
    await u.save();
    return u;
  };
  const manager = await mk({ name: 'Mia Manager', email: 'mia@x.com', role: 'manager' });
  const mine1 = await mk({ name: 'Driver One', email: 'd1@x.com', role: 'user', managerId: manager._id, country: 'Australia' });
  const mine2 = await mk({ name: 'Driver Two', email: 'd2@x.com', role: 'user', managerId: manager._id, country: 'Australia' });
  const other = await mk({ name: 'Not Hers', email: 'd3@x.com', role: 'user', country: 'Australia' });

  // Trips on three Brisbane days (UTC+10): 20, 21 and 22 Oct 2026, mid-morning local.
  const at = (day) => new Date(`2026-10-${day}T00:30:00Z`);
  for (const d of [mine1, mine2, other]) {
    for (const day of [20, 21, 22]) {
      await Trip.create({ driverId: d._id, status: 'completed', startedAt: at(day), endedAt: new Date(at(day).getTime() + 3600_000), distanceMeters: 10_000 });
    }
  }

  const token = (await request(app).post('/api/auth/login').send({ email: 'mia@x.com', password: 'pw123456' })).body.token;
  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${token}`);
  const days = (res) => (res.body.summaries || []).map((s) => `${s.driverName || s.driverId}@${s.date}`).sort();

  console.log('\n── the overview, a date picked (what Reports sends) ──');
  const oneDay = await get('/api/trips/merged-summary?limit=500&from=2026-10-21&to=2026-10-21&tz=Australia/Brisbane');
  console.log('   rows:', days(oneDay).join(', '));
  assert(oneDay.status === 200, `the overview answers (got ${oneDay.status})`);
  assert((oneDay.body.summaries || []).every((s) => s.date === '2026-10-21'), 'every row is the picked day');
  assert((oneDay.body.summaries || []).length === 2, `one row per own driver for that day (got ${(oneDay.body.summaries || []).length})`);

  console.log('\n── a driver picked as well ──');
  const oneDriver = await get(`/api/trips/merged-summary?limit=500&driverId=${mine1._id}&from=2026-10-21&to=2026-10-21&tz=Australia/Brisbane`);
  console.log('   rows:', days(oneDriver).join(', '));
  assert((oneDriver.body.summaries || []).length === 1 && oneDriver.body.summaries[0].date === '2026-10-21', 'that driver, that day only');

  console.log('\n── a country picked: the page sends every driver in that country ──');
  const ids = [mine1, mine2, other].map((d) => d._id).join(',');
  const country = await get(`/api/trips/merged-summary?limit=500&driverIds=${ids}&from=2026-10-21&to=2026-10-21&tz=Australia/Brisbane`);
  console.log('   rows:', days(country).join(', '));
  assert(!(country.body.summaries || []).some((s) => String(s.driverId) === String(other._id)), 'a driver the manager does not manage never appears');
  assert((country.body.summaries || []).length === 2, `just her own two drivers (got ${(country.body.summaries || []).length})`);

  console.log('\n── asking for a driver she does not manage by id ──');
  const notHers = await get(`/api/trips/merged-summary?limit=500&driverId=${other._id}&from=2026-10-21&to=2026-10-21&tz=Australia/Brisbane`);
  assert((notHers.body.summaries || []).length === 0, `nothing comes back (got ${(notHers.body.summaries || []).length})`);
  const tripsNotHers = await get(`/api/trips?driverId=${other._id}&from=2026-10-21&to=2026-10-21&tz=Australia/Brisbane`);
  assert((tripsNotHers.body.trips || []).length === 0, 'and the trip list returns none of their trips either');

  console.log('\n── the day view (driver + date): only that day ──');
  const pts = await get(`/api/trips/merged-points?driverId=${mine1._id}&date=2026-10-21`);
  console.log('   status', pts.status, 'trips', (pts.body.trips || []).length);
  assert(pts.status === 200 && (pts.body.trips || []).length === 1, `one trip that day (got ${(pts.body.trips || []).length})`);
  const ptsOther = await get(`/api/trips/merged-points?driverId=${other._id}&date=2026-10-21`);
  assert(ptsOther.status === 404 || (ptsOther.body.trips || []).length === 0, `another manager's driver's day is not shown (got ${ptsOther.status})`);

  console.log('\n── the same rule on Weather and App Health ──');
  for (const d of [mine1, other]) {
    await Trip.create({ driverId: d._id, status: 'timed_out', startedAt: at(21), endedAt: new Date(at(21).getTime() + 600_000), distanceMeters: 2000 });
  }
  const wxOther = await get(`/api/weather/trip-history?driverId=${other._id}`);
  assert(wxOther.status === 200 && (wxOther.body.trips || []).length === 0, `weather: a driver she does not manage shows nothing (got ${(wxOther.body.trips || []).length})`);
  const wxMine = await get(`/api/weather/trip-history?driverId=${mine1._id}`);
  assert((wxMine.body.trips || []).length === 1, `weather: her own driver's trip shows (got ${(wxMine.body.trips || []).length})`);
  const activity = await get('/api/app-activity');
  const names = (activity.body.summary || []).map((s) => s.driver?.name).sort();
  assert(activity.status === 200 && !names.includes('Not Hers') && names.length === 2, `app health: her two drivers only (got ${names.join(', ')})`);

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n🎉 REPORTS FOR A MANAGER VERIFIED — ${passed} assertions passed\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
