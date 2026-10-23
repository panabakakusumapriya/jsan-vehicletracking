// GET /api/trips/export-table — the Trips table as Excel (Days + Trips + About) or CSV.
// Covers: the Days sheet matches merged-summary row for row, the Trips sheet has every trip, the
// page's filters apply, CSV picks its table by `level` and starts with a UTF-8 BOM.
// Run: npm run test:export-table
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('export_table_test');
  process.env.JWT_SECRET = 'export_table_test_secret_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const XLSX = require('xlsx');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');

  const admin = new User({ name: 'Admin', email: 'a@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const alice = new User({ name: 'Alice', email: 'alice@x.com', role: 'user', country: 'AU' });
  await alice.setPassword('pw123456'); await alice.save();
  const bob = new User({ name: 'Bob', email: 'bob@x.com', role: 'user', country: 'AU' });
  await bob.setPassword('pw123456'); await bob.save();

  await Trip.create({ driverId: alice._id, status: 'completed', startedAt: new Date('2026-08-01T00:00:00Z'), endedAt: new Date('2026-08-01T01:30:00Z'), distanceMeters: 12345, maxSpeedKmh: 80, effectiveUkmMeters: 4000, linkUkmMeters: 3000, linkUkmNetworkMeters: 3500 });
  await Trip.create({ driverId: alice._id, status: 'completed', startedAt: new Date('2026-08-01T03:00:00Z'), endedAt: new Date('2026-08-01T03:30:00Z'), distanceMeters: 2000, maxSpeedKmh: 50 });
  await Trip.create({ driverId: alice._id, status: 'completed', startedAt: new Date('2026-08-02T00:00:00Z'), endedAt: new Date('2026-08-02T00:20:00Z'), distanceMeters: 1500, maxSpeedKmh: 40 });
  await Trip.create({ driverId: bob._id, status: 'timed_out', startedAt: new Date('2026-08-01T02:00:00Z'), endedAt: new Date('2026-08-01T02:40:00Z'), distanceMeters: 800, maxSpeedKmh: 45 });

  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();
  const token = (await request(app).post('/api/auth/login').send({ email: 'a@x.com', password: 'pw123456' })).body.token;
  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${token}`)
    .buffer(true).parse((res, cb) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); });

  console.log('\n── Excel: Days + Trips + About ──');
  const x = await get('/api/trips/export-table?format=xlsx');
  assert(x.status === 200, `the export succeeds (got ${x.status})`);
  assert(/spreadsheetml/.test(x.headers['content-type']), 'served as an Excel workbook');
  assert(/filename="trips_all-dates\.xlsx"/.test(x.headers['content-disposition']), `named for its dates (${x.headers['content-disposition']})`);
  const wb = XLSX.read(x.body, { type: 'buffer' });
  assert(['Days', 'Trips', 'About'].every((n) => wb.SheetNames.includes(n)), `three sheets (got ${wb.SheetNames.join(', ')})`);
  const days = XLSX.utils.sheet_to_json(wb.Sheets.Days);
  const trips = XLSX.utils.sheet_to_json(wb.Sheets.Trips);
  const summary = (await request(app).get('/api/trips/merged-summary').set('Authorization', `Bearer ${token}`)).body;
  assert(days.length === summary.total, `one Days row per merged-summary row (${days.length} vs ${summary.total})`);
  assert(trips.length === 4, `every trip on the Trips sheet (got ${trips.length})`);
  const aliceDay = days.find((d) => d.Driver === 'Alice' && d.Date === '2026-08-01');
  assert(aliceDay && aliceDay.Trips === 2, 'Alice 1 Aug rolls up her two trips that day');
  assert(aliceDay['Distance (km)'] === 14.3, `distance in km to 0.1 (got ${aliceDay && aliceDay['Distance (km)']})`);
  assert(aliceDay['Assigned UKM (km)'] === 3 && aliceDay['Outside UKM (km)'] === 0.5, 'assigned and outside UKM split as on the page');
  assert(aliceDay['Time zone'] && /^Australia\//.test(aliceDay['Time zone']), `times in the driver's zone (${aliceDay['Time zone']})`);
  const first = trips.find((t) => t['Distance (km)'] === 12.3);
  assert(first && first['Duration (h)'] === 1.5 && first.Source === 'App', 'a trip row carries its duration and source');

  console.log('\n── filters apply ──');
  const f = XLSX.read((await get('/api/trips/export-table?format=xlsx&status=timed_out')).body, { type: 'buffer' });
  const ft = XLSX.utils.sheet_to_json(f.Sheets.Trips);
  assert(ft.length === 1 && ft[0].Driver === 'Bob', 'a status filter narrows the export like the page');
  const one = XLSX.read((await get(`/api/trips/export-table?format=xlsx&driverId=${alice._id}`)).body, { type: 'buffer' });
  assert(XLSX.utils.sheet_to_json(one.Sheets.Trips).every((t) => t.Driver === 'Alice'), 'a driver filter narrows it to that driver');

  console.log('\n── CSV ──');
  const c1 = await get('/api/trips/export-table?format=csv&level=days');
  const text = c1.body.toString('utf8');
  assert(/text\/csv/.test(c1.headers['content-type']) && /_days\.csv"/.test(c1.headers['content-disposition']), 'CSV of days, named so');
  assert(text.charCodeAt(0) === 0xfeff, 'starts with a UTF-8 byte-order mark, so Excel reads names right');
  assert(text.trim().split('\n').length === days.length + 1, 'a header plus one line per day');
  const c2 = (await get('/api/trips/export-table?format=csv&level=trips')).body.toString('utf8');
  assert(c2.trim().split('\n').length === 5 && /Trip ID/.test(c2), 'level=trips gives one line per trip');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n🎉 TRIPS SPREADSHEET EXPORT VERIFIED — ${passed} assertions passed\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
