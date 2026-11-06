// A region's whole month, merged: services/monthExport.js via POST /api/trips/export-jobs {kind:'month'}.
//
// Under test: which trips are in (the region's drivers, the month by each trip's LOCAL date, no
// parked-jitter sessions), the zip's three files and their Driver → Day layout, trips with no
// cleaned road yet, the raw-only choice, and the request's validation.
//
// Run: node test/monthExport.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'month_export_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

const zlib = require('zlib');
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

/** The files in a zip, by name — read through the central directory (archiver writes data descriptors). */
function unzip(buf) {
  const out = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString('utf8');
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(dataAt, dataAt + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('month_export_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');
  const LocationPoint = require('../src/models/LocationPoint');
  const ExportJob = require('../src/models/ExportJob');
  const { tick, EXPORT_BUCKET } = require('../src/services/exportRunner');
  const fileStore = require('../src/utils/fileStore');
  const app = createApp();

  const mkUser = async (name, role, extra = {}) => {
    const u = new User({ name, email: `${name.replace(/\s/g, '').toLowerCase()}@x.com`, role, ...extra });
    await u.setPassword('pw123456');
    await u.save();
    return u;
  };
  const admin = await mkUser('Ada Admin', 'admin');
  const token = (await request(app).post('/api/auth/login').send({ email: 'adaadmin@x.com', password: 'pw123456' })).body.token;
  const as = (r) => r.set('Authorization', `Bearer ${token}`);
  const zoe = await mkUser('Zoe Brown', 'user', { country: 'Australia', timezone: 'Australia/Melbourne' });
  const amy = await mkUser('Amy Clark', 'user', { country: 'australia', timezone: 'Australia/Melbourne' });
  const kiri = await mkUser('Kiri Tane', 'user', { country: 'New Zealand', timezone: 'Pacific/Auckland' });

  const shape = (lon) => encodePolyline6([0, 1, 2, 3].map((i) => ({ lat: -37.8 + i * 0.001, lon })));
  let seq = 0;
  const mkTrip = async (driver, startIso, { cleaned = true, ...rest } = {}) => {
    const start = new Date(startIso);
    const trip = await Trip.create({
      clientTripId: `m${++seq}`, driverId: driver._id, status: 'completed',
      startedAt: start, endedAt: new Date(start.getTime() + 3600_000),
      distanceMeters: 12_345, maxSpeedKmh: 60,
      ...(cleaned ? { mapMatchStatus: 'matched', cleanedRouteShapes: [shape(145 + seq * 0.01)], cleanedDistanceMeters: 11_000 } : { mapMatchStatus: 'pending' }),
      ...rest,
    });
    await LocationPoint.insertMany([0, 1, 2].map((i) => ({
      tripId: trip._id, driverId: driver._id, lat: -37.8 + i * 0.001, lon: 145 + seq * 0.01, recordedAt: new Date(start.getTime() + i * 60_000),
    })));
    return trip;
  };

  // 08:00 on 1 October in Melbourne is still 30 September in UTC: October's, by its local date.
  const firstOfMonth = await mkTrip(zoe, '2026-09-30T22:00:00Z');
  const midMonth = await mkTrip(zoe, '2026-10-15T01:00:00Z');
  // 07:00 on 1 November in Melbourne is 31 October in UTC: November's.
  const nextMonth = await mkTrip(zoe, '2026-10-31T20:00:00Z');
  const jitter = await mkTrip(zoe, '2026-10-16T01:00:00Z', { parkedJitter: true });
  const amyOne = await mkTrip(amy, '2026-10-20T01:00:00Z');
  const amyRaw = await mkTrip(amy, '2026-10-20T04:00:00Z', { cleaned: false });
  const kiriTrip = await mkTrip(kiri, '2026-10-10T01:00:00Z');

  const build = async (body) => {
    const r = await as(request(app).post('/api/trips/export-jobs')).send(body);
    if (r.status !== 202) return { status: r.status, body: r.body };
    await tick();
    const job = await ExportJob.findById(r.body.jobId).lean();
    const chunks = [];
    if (job.fileId) for await (const c of fileStore.openDownload(job.fileId, EXPORT_BUCKET)) chunks.push(c);
    return { status: r.status, job, files: job.fileId ? unzip(Buffer.concat(chunks)) : {} };
  };

  console.log('\n── Australia, October ──');
  const au = await build({ kind: 'month', month: '2026-10', country: 'Australia' });
  assert(au.status === 202 && au.job.status === 'ready', `the job is built (${au.job && au.job.status} ${au.job && au.job.error ? au.job.error : ''})`);
  assert(au.job.kind === 'month' && au.job.params.month === '2026-10', 'recorded as a month job');
  const names = Object.keys(au.files).sort();
  assert(names.join() === 'Australia_2026-10_cleaned_roads.kml,Australia_2026-10_raw_gps.kml,Australia_2026-10_summary.csv',
    `three files: raw GPS, cleaned roads, summary (got ${names.join()})`);
  const raw = au.files['Australia_2026-10_raw_gps.kml'];
  const clean = au.files['Australia_2026-10_cleaned_roads.kml'];
  const has = (kml, trip) => kml.includes(`<Data name="trip_id"><value>${trip._id}</value></Data>`);
  assert(has(raw, firstOfMonth) && has(raw, midMonth), 'the 1 October (local) drive and a mid-month drive are in');
  assert(!has(raw, nextMonth), 'a drive on 1 November local time is not, though it is 31 October in UTC');
  assert(!has(raw, jitter), 'a parked-GPS-jitter session is left out');
  assert(has(raw, amyOne) && has(raw, amyRaw), 'both Australian drivers are in — the region match ignores case');
  assert(!has(raw, kiriTrip) && !raw.includes('Kiri Tane'), 'a New Zealand driver is not');
  assert(au.job.done === 4 && au.job.total === 4, `progress covers the 4 trips of the month (got ${au.job.done}/${au.job.total})`);
  assert(raw.indexOf('<name>Amy Clark</name>') < raw.indexOf('<name>Zoe Brown</name>'), 'drivers are folders, in name order');
  assert(raw.includes('<Folder><name>2026-10-01</name>') && raw.includes('<Folder><name>2026-10-15</name>'), 'days are folders under the driver, by local date');
  assert((raw.match(/<Placemark>/g) || []).length === 4, 'one raw track per trip');
  assert(/<coordinates>145\.\d{6},-37\.800000 /.test(raw), 'raw tracks are the recorded points');
  assert(raw.includes('<TimeSpan><begin>2026-09-30T22:00:00.000Z</begin>'), 'each track is time-stamped, for Google Earth\'s time slider');
  assert((raw.match(/<Folder>/g) || []).length === (raw.match(/<\/Folder>/g) || []).length, 'every folder is closed');
  assert((clean.match(/<Placemark>/g) || []).length === 3 && !has(clean, amyRaw), 'the cleaned file holds the 3 trips that have a snapped road');
  assert(au.job.fellBackToRaw === 1, 'and the job counts the one without');
  const csv = au.files['Australia_2026-10_summary.csv'].replace(/^﻿/, '').split('\r\n');
  assert(csv[0].startsWith('Driver,Email,Region,Date,Trips'), 'the summary has a header');
  const amyRow = csv.find((l) => l.startsWith('Amy Clark,'));
  assert(amyRow && amyRow.includes(',2026-10-20,2,24.69,11.00,6,1'), `one row per driver-day: 2 trips, raw and cleaned km, points, 1 without a cleaned road (got ${amyRow})`);

  console.log('\n── choices and limits ──');
  const rawOnly = await build({ kind: 'month', month: '2026-10', country: 'Australia', layers: 'raw' });
  assert(Object.keys(rawOnly.files).sort().join() === 'Australia_2026-10_raw_gps.kml,Australia_2026-10_summary.csv', 'raw GPS only, when asked');
  const all = await build({ kind: 'month', month: '2026-10' });
  assert(Object.keys(all.files).some((n) => n.endsWith('_2026-10_raw_gps.kml') && !n.startsWith('Australia')) && Object.entries(all.files).find(([n]) => n.endsWith('_raw_gps.kml'))[1].includes('Kiri Tane'),
    'no region: every driver the requester can see');
  assert((await build({ kind: 'month', month: '2026-13' })).status === 400, 'a bad month is a 400');
  assert((await build({ kind: 'month', month: '2025-01', country: 'Australia' })).status === 404, 'a month with no trips is a 404, not an empty file');

  console.log(`\n🎉 MONTH EXPORT VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
