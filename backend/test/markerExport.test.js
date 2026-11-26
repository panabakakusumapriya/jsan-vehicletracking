// GET /api/markers/export — the Trips page's filters as a markers file (Excel / CSV / KML).
// Covers: every live marker exported with driver-local times, removed markers left out, the
// driver / driverIds / date filters, a manager only ever gets their own drivers, an empty
// driverIds exports nothing, CSV BOM, KML pins grouped per category in the category colour,
// and drivers are refused.
// Run: node test/markerExport.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('marker_export_test');
  process.env.JWT_SECRET = 'marker_export_test_secret_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const XLSX = require('xlsx');
  const User = require('../src/models/User');
  const Marker = require('../src/models/Marker');
  const MarkerCategory = require('../src/models/MarkerCategory');

  const mk = async (fields) => { const u = new User(fields); await u.setPassword('pw123456'); return u.save(); };
  const admin = await mk({ name: 'Admin', email: 'a@x.com', role: 'admin' });
  const manager = await mk({ name: 'Manny', email: 'm@x.com', role: 'manager' });
  const alice = await mk({ name: 'Alice', email: 'alice@x.com', role: 'user', country: 'AU', managerId: manager._id });
  const bob = await mk({ name: 'Bob', email: 'bob@x.com', role: 'user', country: 'NZ' });
  void admin;

  const red = await MarkerCategory.create({ name: 'Red Flag', color: '#ef4444', active: true });
  const blue = await MarkerCategory.create({ name: 'Blue Marker', color: '#4285f4', active: true });
  const base = { lat: -27.47, lon: 153.02 };
  await Marker.create({ ...base, driverId: alice._id, driverName: 'Alice', categoryId: red._id, reason: 'Tunnel', note: 'says "closed", see photo', recordedAt: new Date('2026-08-01T00:30:00Z'), vehiclePlate: 'ABC123' });
  await Marker.create({ ...base, driverId: alice._id, driverName: 'Alice', categoryId: blue._id, reason: 'Low-Hanging Trees', recordedAt: new Date('2026-08-03T02:00:00Z') });
  await Marker.create({ ...base, driverId: alice._id, driverName: 'Alice', categoryId: red._id, reason: 'By Mistake', recordedAt: new Date('2026-08-02T00:00:00Z'), removedAt: new Date() });
  await Marker.create({ lat: -41.29, lon: 174.78, driverId: bob._id, driverName: 'Bob', categoryId: red._id, reason: 'Traffic Accident', recordedAt: new Date('2026-08-01T05:00:00Z') });

  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();
  const login = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
  const tokens = { admin: await login('a@x.com'), manager: await login('m@x.com') };
  const get = (url, who = 'admin') => request(app).get(url).set('Authorization', `Bearer ${tokens[who]}`)
    .buffer(true).parse((res, cb) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); });
  const rowsOf = (res) => XLSX.utils.sheet_to_json(XLSX.read(res.body, { type: 'buffer' }).Sheets.Markers);

  console.log('\n── Excel ──');
  const x = await get('/api/markers/export?format=xlsx');
  assert(x.status === 200, `the export succeeds (got ${x.status})`);
  assert(/spreadsheetml/.test(x.headers['content-type']) && /markers-.*\.xlsx"/.test(x.headers['content-disposition']), 'served as a named Excel workbook');
  const wb = XLSX.read(x.body, { type: 'buffer' });
  assert(wb.SheetNames.join() === 'Markers,About', `Markers + About sheets (got ${wb.SheetNames.join(', ')})`);
  const rows = rowsOf(x);
  assert(rows.length === 3, `every live marker, the removed one left out (got ${rows.length})`);
  const tunnel = rows.find((r) => r.Reason === 'Tunnel');
  assert(tunnel && tunnel.Driver === 'Alice' && tunnel.Category === 'Red Flag' && tunnel.Vehicle === 'ABC123', 'a row carries driver, category, reason and vehicle');
  assert(/^Australia\//.test(tunnel['Time zone']) && tunnel.Date === '2026-08-01' && /^1[01]:30$/.test(tunnel.Time), `in the driver's local time (${tunnel['Time zone']} ${tunnel.Date} ${tunnel.Time})`);
  assert(/google\.com\/maps.*-27\.47,153\.02/.test(tunnel['Google Maps']), 'with a Google Maps link to the spot');
  assert(!('_color' in tunnel), 'no internal columns leak into the sheet');

  console.log('\n── filters ──');
  assert(rowsOf(await get(`/api/markers/export?driverId=${bob._id}`)).every((r) => r.Driver === 'Bob'), 'driverId narrows to that driver');
  assert(rowsOf(await get(`/api/markers/export?driverIds=${alice._id}`)).length === 2, 'driverIds (a project/country pick) narrows to those drivers');
  const none = await get('/api/markers/export?driverIds=');
  assert(none.status === 200 && rowsOf(none).length === 0, 'an empty driverIds exports nothing, not the whole fleet');
  const day = rowsOf(await get('/api/markers/export?from=2026-08-01&to=2026-08-01&tz=UTC'));
  assert(day.length === 2 && day.every((r) => r.Reason !== 'Low-Hanging Trees'), `from/to keeps that day only (got ${day.length})`);
  assert((await get('/api/markers/export?from=not-a-date')).status === 400, 'a bad date is a 400, not a crash');

  console.log('\n── who may export ──');
  const mine = rowsOf(await get('/api/markers/export', 'manager'));
  assert(mine.length === 2 && mine.every((r) => r.Driver === 'Alice'), 'a manager gets only their own drivers');
  assert(rowsOf(await get(`/api/markers/export?driverId=${bob._id}`, 'manager')).length === 0, 'asking for someone else\'s driver gives a manager nothing');
  tokens.driver = await login('alice@x.com');
  assert((await get('/api/markers/export', 'driver')).status === 403, 'a driver is refused');

  console.log('\n── CSV ──');
  const c = await get('/api/markers/export?format=csv');
  const text = c.body.toString('utf8');
  assert(/text\/csv/.test(c.headers['content-type']) && text.charCodeAt(0) === 0xfeff, 'CSV with a UTF-8 byte-order mark');
  assert(text.includes('"says ""closed"", see photo"'), 'quotes in a note are escaped, the row stays whole');
  const parsed = XLSX.utils.sheet_to_json(XLSX.read(text.slice(1), { type: 'string' }).Sheets.Sheet1);
  assert(parsed.length === 3, `a header plus one line per marker (got ${parsed.length})`);

  console.log('\n── KML ──');
  const k = await get('/api/markers/export?format=kml');
  const kml = k.body.toString('utf8');
  assert(/kml/.test(k.headers['content-type']) && /\.kml"/.test(k.headers['content-disposition']), 'served as KML');
  assert((kml.match(/<Placemark>/g) || []).length === 3, 'one pin per live marker');
  assert(kml.includes('<name>Red Flag (2)</name>') && kml.includes('<name>Blue Marker (1)</name>'), 'pins grouped in a folder per category');
  assert(kml.includes('<color>ff4444ef</color>'), 'pins in the category colour (KML aabbggrr)');
  assert(kml.includes('placemark_circle.png#ogr-sym-3</href>') && !kml.includes('paddle'), 'pins are filled dots — QGIS reads ogr-sym-3, not a hollow square');
  assert(kml.includes('<coordinates>174.78,-41.29,0</coordinates>'), 'coordinates as lon,lat');
  assert(kml.includes('&quot;closed&quot;') && !kml.includes('"closed"'), 'text is XML-escaped');

  console.log(`\n${passed} passed`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  process.exit(1);
});
