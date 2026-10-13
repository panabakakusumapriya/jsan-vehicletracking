// GET /api/analytics/overview — the admin dashboard: km and UKM by project and region, by
// day / week / month.
//
// Every breakdown adds up to the same totals; a breakdown ignores its own filter but honours the
// other; UKM splits into assigned + free drive, outside UKM stays beside it; a trip's region is
// its delivery's, else its time zone's country; the network figure is the live deliveries' to date.
//
// Run: node test/analytics.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

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
  const NetworkVersion = require('../src/models/NetworkVersion');
  const LinkCoverage = require('../src/models/LinkCoverage');
  const { _test } = require('../src/controllers/analytics.controller');
  const app = createApp();

  const login = async (email, role) => {
    const u = new User({ name: email.split('@')[0], email, role });
    await u.setPassword('pw123456'); await u.save();
    return (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
  };
  const superT = await login('root@x.com', 'superadmin');
  const adminT = await login('admin@x.com', 'admin');
  const managerT = await login('mgr@x.com', 'manager');
  const get = (q, t = superT) =>
    request(app).get(`/api/analytics/overview?from=2026-10-01&to=2026-10-14&tz=UTC${q}`).set('Authorization', `Bearer ${t}`);

  const p1 = await Project.create({ name: 'PRJ-1' });
  const p2 = await Project.create({ name: 'PRJ-2' });
  const vAu = await NetworkVersion.create({ projectId: p1._id, label: 'AU', status: 'active', region: 'Australia', regionSource: 'manual', targetMeters: 1000000 });
  const vNz = await NetworkVersion.create({ projectId: p1._id, label: 'NZ', status: 'superseded', region: 'New Zealand', regionSource: 'manual', targetMeters: 500000 });
  const vP2 = await NetworkVersion.create({ projectId: p2._id, label: 'P2', status: 'active', region: 'Australia', regionSource: 'manual', targetMeters: 200000 });
  const mkDriver = (name, project, country) =>
    User.create({ name, email: `${name}@x.com`, role: 'user', projectIds: [project._id], country, passwordHash: 'x' });
  const a = await mkDriver('a', p1, 'AU');
  const b = await mkDriver('b', p1, 'NZ');
  const c = await mkDriver('c', p2, 'IN');

  // Ledger rows: what has been driven of each live delivery, to date. vNz is superseded but still
  // live because it carries coverage.
  const cov = (v, p, id, m) => LinkCoverage.create({ projectId: p._id, networkVersionId: v._id, linkId: id, lengthMeters: m, firstTripId: new mongoose.Types.ObjectId(), firstDriverId: a._id, firstAt: new Date() });
  await cov(vAu, p1, 'L1', 250000);
  await cov(vNz, p1, 'L2', 100000);
  await cov(vP2, p2, 'L3', 50000);

  const at = (day) => new Date(`2026-10-${String(day).padStart(2, '0')}T08:00:00Z`);
  const trip = (d, day, km, o = {}) => Trip.create({ driverId: d._id, status: 'completed', startedAt: at(day), endedAt: at(day), distanceMeters: km * 1000, ...o });
  // Week of Mon 28 Sep (1–4 Oct), week of 5 Oct, week of 12 Oct.
  await trip(a, 1, 100, { projectId: p1._id, assignedNetworkVersionId: vAu._id, ukmBasis: 'assigned', effectiveUkmMeters: 40000, linkUkmMeters: 40000, linkUkmNetworkMeters: 55000 });
  await trip(a, 6, 50, { projectId: p1._id, timezone: 'Australia/Melbourne', ukmBasis: 'global', effectiveUkmMeters: 10000 }); // free drive, region from zone
  await trip(b, 7, 80, { projectId: p1._id, assignedNetworkVersionId: vNz._id, ukmBasis: 'assigned', effectiveUkmMeters: 30000, linkUkmMeters: 30000, linkUkmNetworkMeters: 30000 });
  await trip(c, 13, 20, { importBatchId: 'imp', effectiveUkmMeters: 5000, ukmBasis: 'global' }); // no projectId → driver's; no zone → driver's country
  await trip(c, 13, 999, { projectId: p2._id, parkedJitter: true, effectiveUkmMeters: 999000 }); // jitter: nothing
  await trip(a, 20, 500, { projectId: p1._id }); // after the period
  await trip(a, 20 - 19, 0); // a zero trip still in the period — harmless
  await Trip.create({ driverId: a._id, status: 'completed', startedAt: new Date('2026-09-20T08:00:00Z'), distanceMeters: 70000, effectiveUkmMeters: 7000, projectId: p1._id }); // previous period

  assert((await get('', adminT)).status === 200, 'an admin can open the dashboard');
  assert((await get('', managerT)).status === 403, 'a manager cannot — admins and superadmins only');

  const all = (await get('&grain=week')).body;
  const t = all.totals;
  assert(t.km === 250000, 'km: 100 + 50 + 80 + 20 (imported counts), no jitter, nothing outside the dates');
  assert(t.ukm === 85000 && t.assignedUkm === 70000 && t.freeUkm === 15000, 'UKM 85 = 70 assigned + 15 free drive');
  assert(t.outsideUkm === 15000, 'outside UKM (network − assigned) is reported beside UKM, not added in');
  assert(t.drivers === 3, '3 drivers drove');
  assert(t.network.targetMeters === 1700000 && t.network.coveredMeters === 400000, 'network: every live delivery, driven to date');
  assert(all.previous.km === 70000 && all.previous.ukm === 7000, 'the 14 days before are there for the change figures');

  assert(all.period.grain === 'week' && all.timeline.length === 3, 'weekly: 3 Monday buckets cover 1–14 Oct');
  assert(all.timeline[0].date === '2026-09-28' && all.timeline[0].km === 100000, 'the first week starts on its Monday');
  assert(all.timeline[1].km === 130000 && all.timeline[1].ukm === 40000, 'week of 5 Oct: 50 + 80 km, 10 + 30 UKM');

  const sum = (rows, f) => rows.reduce((s, r) => s + r[f], 0);
  for (const dim of ['byProject', 'byRegion', 'byDriver']) {
    assert(sum(all[dim], 'km') === t.km && sum(all[dim], 'ukm') === t.ukm, `${dim} adds up to the totals`);
  }
  const r1 = all.byProject.find((r) => r.name === 'PRJ-1');
  assert(r1.km === 230000 && r1.ukm === 80000 && r1.drivers === 2, 'PRJ-1: 230 km, 80 UKM, 2 drivers');
  assert(r1.series.length === 3 && r1.series[1].km === 130000, 'each project carries its own week-by-week figures');
  assert(r1.network.targetMeters === 1500000 && r1.network.coveredMeters === 350000, 'PRJ-1 network: both live deliveries');
  assert(all.byProject.find((r) => r.name === 'PRJ-2').km === 20000, 'a trip without a project counts for its driver\'s');

  const au = all.byRegion.find((r) => r.key === 'Australia');
  assert(au && au.km === 150000, 'Australia: the delivery\'s region (100) + the free drive\'s time zone (50)');
  assert(all.byRegion.find((r) => r.key === 'New Zealand').km === 80000, 'New Zealand from the delivery the trip was measured on');
  assert(all.byRegion.find((r) => r.key === 'India').km === 20000, 'no delivery, no zone → the driver\'s country');
  assert(au.network.targetMeters === 1200000, 'Australia\'s network: both projects\' Australian deliveries');

  const onlyP1 = (await get(`&projectId=${p1._id}`)).body;
  assert(onlyP1.totals.km === 230000 && onlyP1.totals.network.targetMeters === 1500000, 'a project filter narrows the totals and the network');
  assert(onlyP1.byProject.length === 2, '…but the project table still lists every project');
  assert(sum(onlyP1.byRegion, 'km') === 230000 && !onlyP1.byRegion.some((r) => r.key === 'India'), '…and the region table honours it');

  const nz = (await get('&region=New%20Zealand')).body;
  assert(nz.totals.km === 80000 && nz.totals.network.targetMeters === 500000, 'a region filter narrows km and network');
  assert(nz.byDriver.length === 1 && nz.byDriver[0].name === 'b', 'drivers honour the region filter');

  const month = (await get('&grain=month')).body;
  assert(month.period.grain === 'month' && month.timeline.length === 1 && month.timeline[0].date === '2026-10-01', 'monthly');
  const day = (await get('&grain=day')).body;
  assert(day.timeline.length === 14, 'daily: one bucket per day, gaps filled');
  const long = (await request(app).get('/api/analytics/overview?from=2025-01-01&to=2026-10-14&tz=UTC&grain=day').set('Authorization', `Bearer ${superT}`)).body;
  assert(long.period.grain === 'week', 'a daily view of nearly two years is drawn by week instead');
  assert(_test.fitGrain('week', 1000) === 'month', 'weeks over ~2 years become months');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
