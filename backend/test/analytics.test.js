// GET /api/analytics/overview — the superadmin dashboard.
//
// Every breakdown (project / region / country) adds up to the same totals; a dimension ignores
// its own filter but honours the others; parked jitter is left out; imported trips count for
// distance but not for hours; superadmins only.
//
// Run: node test/analytics.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const HOUR = 3600 * 1000;

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('analytics_test');
  process.env.JWT_SECRET = 'analytics_test_secret_1234567890';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  const Project = require('../src/models/Project');
  const Marker = require('../src/models/Marker');
  const MarkerCategory = require('../src/models/MarkerCategory');
  const app = createApp();

  const login = async (email, role) => {
    const u = new User({ name: email.split('@')[0], email, role });
    await u.setPassword('pw123456'); await u.save();
    return (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
  };
  const superT = await login('root@x.com', 'superadmin');
  const adminT = await login('admin@x.com', 'admin');
  const get = (q, t = superT) => request(app).get(`/api/analytics/overview?from=2026-10-01&to=2026-10-07&tz=UTC${q}`).set('Authorization', `Bearer ${t}`);

  const eu = await Project.create({ name: 'EU-PROJ' });
  const au = await Project.create({ name: 'AU-PROJ' });
  const mkDriver = (name, project, country, region, extra = {}) =>
    User.create({ name, email: `${name}@x.com`, role: 'user', projectIds: [project._id], country, region, passwordHash: 'x', ...extra });
  const fr = await mkDriver('fr', eu, 'FR', 'EU');
  const de = await mkDriver('de', eu, 'Germany', null); // region derived from the country
  const aus = await mkDriver('aus', au, 'Australia', 'APAC');
  await mkDriver('gone', au, 'AU', 'Hdhs', { active: false, driverStatus: 'Exit' }); // junk region → derived

  const at = (day, h) => new Date(`2026-10-0${day}T${String(h).padStart(2, '0')}:00:00Z`);
  const trip = (d, day, km, o = {}) => Trip.create({ driverId: d._id, status: 'completed', startedAt: at(day, 8), endedAt: at(day, 10), distanceMeters: km * 1000, ...o });
  await trip(fr, 1, 100, { projectId: eu._id, effectiveUkmMeters: 40000 });
  await trip(fr, 2, 50, { projectId: eu._id });
  await trip(de, 2, 30); // no projectId on the trip → the driver's project
  await trip(aus, 3, 200, { projectId: au._id, importBatchId: 'b1' }); // imported: km yes, hours no
  await trip(aus, 4, 999, { projectId: au._id, parkedJitter: true }); // jitter: nothing
  await trip(fr, 9, 500, { projectId: eu._id }); // outside the period
  await Trip.create({ driverId: fr._id, status: 'completed', startedAt: new Date('2026-09-28T08:00:00Z'), endedAt: new Date('2026-09-28T09:00:00Z'), distanceMeters: 70000, projectId: eu._id }); // previous period
  const cat = await MarkerCategory.create({ name: 'Red Flag', color: '#ef4444', order: 1 });
  await Marker.create({ driverId: aus._id, categoryId: cat._id, lat: -37, lon: 145, recordedAt: at(3, 9) });

  assert((await get('', adminT)).status === 403, 'an admin is not let in — superadmins only');
  const all = (await get('')).body;
  assert(all.totals.km === 380000, 'total km for the period: 100 + 50 + 30 + 200 (imported counts), no jitter, nothing outside the dates');
  assert(all.totals.trips === 4 && all.totals.drivingDrivers === 3, '4 trips by 3 drivers');
  assert(all.totals.workMs === 6 * HOUR, 'working hours leave the imported trip out (3 × 2 h)');
  assert(all.totals.drivers === 4 && all.totals.activeDrivers === 3, 'roster: 4 drivers, 3 still active');
  assert(all.totals.markers === 1 && all.totals.ukm === 40000, 'markers and UKM counted');
  assert(all.previous.km === 70000 && all.previous.trips === 1, 'the previous 7 days are there for the change figures');
  const sum = (rows, f) => rows.reduce((a, r) => a + r[f], 0);
  for (const dim of ['byProject', 'byRegion', 'byCountry']) {
    assert(sum(all[dim], 'km') === all.totals.km && sum(all[dim], 'trips') === all.totals.trips, `${dim} adds up to the totals`);
  }
  const euRow = all.byProject.find((p) => p.name === 'EU-PROJ');
  assert(euRow.km === 180000 && euRow.drivers === 2, 'EU-PROJ: 180 km, 2 drivers (a trip without a project counts for its driver\'s)');
  assert(all.byRegion.find((r) => r.key === 'EU').km === 180000 && all.byRegion.find((r) => r.key === 'APAC').drivers === 2, 'regions: Germany derived as EU; a junk region falls back to the country (AU → APAC)');
  assert(all.byCountry.some((c) => c.key === 'France') && !all.byCountry.some((c) => c.key === 'FR'), 'ISO country codes are shown as names');
  assert(all.timeline.length === 7 && all.period.unit === 'day' && all.timeline[0].km === 100000, 'a 7-day period has a daily timeline, gaps filled');
  assert(all.topDrivers[0].name === 'aus' && all.topDrivers[0].km === 200000, 'top drivers by km');

  const onlyEu = (await get(`&projectId=${eu._id}`)).body;
  assert(onlyEu.totals.km === 180000 && onlyEu.totals.drivers === 2, 'filtering a project narrows the totals');
  assert(onlyEu.byProject.length === 2, '…but the project chart still shows every project, so the selection is highlighted, not alone');
  assert(sum(onlyEu.byCountry, 'km') === 180000, '…and the country chart honours the project filter');
  const apac = (await get('&region=APAC')).body;
  assert(apac.totals.km === 200000 && apac.totals.markers === 1, 'filtering a region');
  assert((await get('&country=Germany')).body.totals.km === 30000, 'filtering a country');
  const long = (await request(app).get('/api/analytics/overview?from=2026-01-01&to=2026-10-07&tz=UTC').set('Authorization', `Bearer ${superT}`)).body;
  assert(long.period.unit === 'week', 'a longer period is drawn by week');

  // A session left open for days (before the 8-hour trip limit) counts 12 hours, not 72.
  await Trip.create({ driverId: de._id, status: 'completed', startedAt: new Date('2026-08-01T08:00:00Z'), endedAt: new Date('2026-08-04T08:00:00Z'), distanceMeters: 5000 });
  const aug = (await request(app).get('/api/analytics/overview?from=2026-08-01&to=2026-08-05&tz=UTC').set('Authorization', `Bearer ${superT}`)).body;
  assert(aug.totals.workMs === 12 * HOUR, 'a trip left open for 3 days counts at most 12 working hours');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
