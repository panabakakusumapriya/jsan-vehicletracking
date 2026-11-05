// POST /api/markers/batch: several drops in one request, each handled as a single drop is.
// Run: node test/markerBatch.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'marker_batch_test_secret_1234567890';
let passed = 0;
function assert(cond, msg) { if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); } passed += 1; console.log('✅', msg); }
(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('marker_batch_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const MarkerCategory = require('../src/models/MarkerCategory');
  const Marker = require('../src/models/Marker');
  const app = createApp();
  const u = new User({ name: 'Dee Driver', email: 'dee@x.com', role: 'user' });
  await u.setPassword('pw123456'); await u.save();
  const cat = await MarkerCategory.create({ name: 'Red Flag', color: '#ef4444', active: true });
  const token = (await request(app).post('/api/auth/login').send({ email: 'dee@x.com', password: 'pw123456' })).body.token;
  const m = (id, extra = {}) => ({ clientId: id, lat: -27.47, lon: 153.02, categoryId: String(cat._id), recordedAt: new Date().toISOString(), ...extra });
  const r = await request(app).post('/api/markers/batch').set('Authorization', `Bearer ${token}`)
    .send({ markers: [m('a1'), m('a2'), m('a1'), m('bad', { categoryId: String(new mongoose.Types.ObjectId()) })] });
  assert(r.status === 200 && r.body.results.length === 4, `answers every entry (${r.status}, ${r.body.results && r.body.results.length})`);
  assert(r.body.results[0].marker && r.body.results[1].marker, 'the two new drops are stored');
  assert(r.body.results[2].marker && r.body.results[2].marker.id === r.body.results[0].marker.id, 'the same clientId twice is one marker, not two');
  assert(r.body.results[3].error && r.body.results[3].permanent === true, 'an unknown category is a permanent error for that entry only');
  assert(await Marker.countDocuments({}) === 2, 'two markers in the database');
  const again = await request(app).post('/api/markers/batch').set('Authorization', `Bearer ${token}`).send({ markers: [m('a2')] });
  assert(again.body.results[0].marker && await Marker.countDocuments({}) === 2, 're-sending an uploaded drop (a retry) adds nothing');

  // ---- a driver takes their own marker off the map
  const as = (t, req) => req.set('Authorization', `Bearer ${t}`);
  const mine = async (t) => (await as(t, request(app).get('/api/markers/mine'))).body.markers;
  const firstId = r.body.results[0].marker.id;
  assert(r.body.results[0].marker.clientId === 'a1', 'a marker carries the phone’s clientId back');
  const rm = await as(token, request(app).delete(`/api/markers/mine/${firstId}`));
  assert(rm.status === 200 && rm.body.removed === true, `removing by id works (${rm.status})`);
  assert((await mine(token)).every((x) => x.id !== firstId), 'and it is gone from the driver’s map');
  const kept = await Marker.findById(firstId).lean();
  assert(kept && kept.removedAt && String(kept.removedBy) === String(u._id), 'the record is kept, with who removed it and when');
  const rm2 = await as(token, request(app).delete(`/api/markers/mine/${firstId}`));
  assert(rm2.status === 200 && rm2.body.removed === true, 'removing it again is harmless (a retry from the phone)');
  const byClient = await as(token, request(app).delete('/api/markers/mine/a2'));
  assert(byClient.body.removed === true && (await mine(token)).length === 0,
    'a marker can be removed by the clientId of the drop — the phone may only know it by that');
  const never = await as(token, request(app).delete('/api/markers/mine/m-never-uploaded'));
  assert(never.status === 200 && never.body.removed === false, 'a drop that never reached the server answers removed:false, not an error');

  const o = new User({ name: 'Other Driver', email: 'other@x.com', role: 'user' });
  await o.setPassword('pw123456'); await o.save();
  const otherToken = (await request(app).post('/api/auth/login').send({ email: 'other@x.com', password: 'pw123456' })).body.token;
  const theirs = (await as(otherToken, request(app).post('/api/markers/batch')).send({ markers: [m('o1')] })).body.results[0].marker;
  const steal = await as(token, request(app).delete(`/api/markers/mine/${theirs.id}`));
  assert(steal.body.removed === false && !(await Marker.findById(theirs.id).lean()).removedAt,
    'another driver’s marker cannot be removed');

  const admin = new User({ name: 'Ada Admin', email: 'ada@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const adminToken = (await request(app).post('/api/auth/login').send({ email: 'ada@x.com', password: 'pw123456' })).body.token;
  const staff = (await as(adminToken, request(app).get('/api/markers?days=30'))).body.markers;
  assert(staff.length === 1 && staff[0].id === theirs.id, `the office lists leave removed markers out too (got ${staff.length})`);
  await mongoose.disconnect(); await mongod.stop();
  console.log(`\n🎉 MARKER BATCH VERIFIED — ${passed} assertions passed\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
