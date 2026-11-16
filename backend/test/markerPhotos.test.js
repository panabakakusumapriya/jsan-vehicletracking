// Marker photos and reasons: the phone asks for signed upload links, puts each JPEG straight into
// the S3 bucket, then sends the marker with the keys and the driver's reason.
//
// Guards: the upload-link endpoint's checks; that a drop only keeps keys handed out for THIS driver
// and THIS drop (never another driver's photo, never an arbitrary bucket path); that a retry of a
// drop that first arrived without photos completes it; that every read hands back viewable links;
// and that a drop from an older app (no reason, no photos) is still accepted.
// Signing is local arithmetic, so a fake bucket config is enough — nothing is sent to S3 here.
// Run: node test/markerPhotos.test.js
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('marker_photos_test');
  process.env.JWT_SECRET = 'marker_photos_secret_1234567890';
  // A made-up bucket: the test must never reach the real one, whatever .env.local holds.
  Object.assign(process.env, {
    S3_ENDPOINT: 'https://bucket.invalid',
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'auto',
    S3_ACCESS_KEY_ID: 'test-id',
    S3_SECRET_ACCESS_KEY: 'test-secret',
  });

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Marker = require('../src/models/Marker');
  const MarkerCategory = require('../src/models/MarkerCategory');
  const app = createApp();

  const login = async (email, role) => {
    const u = new User({ name: email.split('@')[0], email, role });
    await u.setPassword('pw123456'); await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
    return { user: u, token };
  };
  const admin = await login('admin@x.com', 'admin');
  const d1 = await login('driver1@x.com', 'user');
  const d2 = await login('driver2@x.com', 'user');
  const cat = await MarkerCategory.create({ name: 'Yellow Marker', color: '#fbbc04', description: 'Private Road, Private Property', order: 1 });
  const as = (who, req) => req.set('Authorization', `Bearer ${who.token}`);

  console.log('\n── signed upload links ──');
  const bad = await as(d1, request(app).post('/api/markers/photo-uploads')).send({ clientId: 'x', count: 1 });
  assert(bad.status === 400, 'a missing or malformed drop id is refused');
  const tooMany = await as(d1, request(app).post('/api/markers/photo-uploads')).send({ clientId: 'm-abc-123', count: 4 });
  assert(tooMany.status === 400, 'more than three photos is refused');
  const staff = await as(admin, request(app).post('/api/markers/photo-uploads')).send({ clientId: 'm-abc-123', count: 1 });
  assert(staff.status === 403, 'only drivers ask for upload links');

  const up = await as(d1, request(app).post('/api/markers/photo-uploads')).send({ clientId: 'm-abc-123', count: 2 });
  assert(up.status === 200 && up.body.uploads.length === 2, 'two links for two photos');
  const prefix = `markers/${d1.user._id}/m-abc-123/`;
  assert(up.body.uploads[0].key === `${prefix}0.jpg` && up.body.uploads[1].key === `${prefix}1.jpg`,
    'keys sit under markers/<driver>/<drop>/ — the same keys every time this drop asks');
  assert(/X-Amz-Signature=/.test(up.body.uploads[0].url) && up.body.uploads[0].contentType === 'image/jpeg',
    'each link is a signed PUT for image/jpeg');
  const again = await as(d1, request(app).post('/api/markers/photo-uploads')).send({ clientId: 'm-abc-123', count: 2 });
  assert(again.body.uploads[0].key === up.body.uploads[0].key, 'asking again gives the same keys (a retry overwrites, never orphans)');

  console.log('\n── a drop with a reason and photos ──');
  const drop = {
    clientId: 'm-abc-123', lat: -6.185, lon: 106.815, categoryId: String(cat._id),
    recordedAt: '2026-11-13T03:00:00Z', reason: 'Private Road', note: 'Gate locked, guard turned us back',
    photos: [
      { key: `${prefix}0.jpg`, width: 1600, height: 1200, bytes: 312000 },
      { key: `markers/${d2.user._id}/m-abc-123/0.jpg` }, // another driver's key
      { key: `${prefix}../../etc.jpg` }, // not a photo key at all
      { key: `${prefix}0.jpg` }, // the same key twice
    ],
  };
  const r = await as(d1, request(app).post('/api/markers/batch')).send({ markers: [drop] });
  const got = r.body.results[0].marker;
  assert(r.status === 200 && got, 'the drop was stored');
  assert(got.reason === 'Private Road' && got.note === 'Gate locked, guard turned us back', 'with its reason and the driver\'s words');
  assert(got.photos.length === 1 && got.photos[0].key === `${prefix}0.jpg`,
    'only the photo handed out for this driver and drop was kept — foreign, malformed and repeated keys dropped');
  assert(/X-Amz-Signature=/.test(got.photos[0].url) && got.photos[0].width === 1600, 'and it comes back with a signed link to view it');

  console.log('\n── a drop that arrived without its photos is completed by its retry ──');
  const bare = { clientId: 'm-def-456', lat: -6.19, lon: 106.82, categoryId: String(cat._id), recordedAt: '2026-11-13T03:05:00Z' };
  await as(d1, request(app).post('/api/markers/batch')).send({ markers: [bare] });
  const p2 = `markers/${d1.user._id}/m-def-456/`;
  const retry = await as(d1, request(app).post('/api/markers/batch')).send({ markers: [{ ...bare, reason: 'Private Property', photos: [{ key: `${p2}0.jpg` }] }] });
  assert(retry.body.results[0].marker.photos.length === 1 && retry.body.results[0].marker.reason === 'Private Property',
    'the retry attached the photo and reason');
  assert((await Marker.countDocuments({ clientId: 'm-def-456' })) === 1, 'and it is still one marker');

  console.log('\n── an older app: no reason, no photos ──');
  const old = await as(d1, request(app).post('/api/markers')).send({ lat: -6.2, lon: 106.83, categoryId: String(cat._id), clientId: 'm-old-789' });
  assert(old.status === 201 && old.body.marker.reason === null && old.body.marker.photos.length === 0, 'is still accepted as before');

  console.log('\n── reading markers back ──');
  const list = await as(admin, request(app).get('/api/markers?days=365')).send();
  const seen = list.body.markers.find((m) => m.clientId === 'm-abc-123');
  assert(seen && seen.reason === 'Private Road' && /X-Amz-Signature=/.test(seen.photos[0].url), 'the panel gets the reason and a viewable photo');
  const mine = await as(d1, request(app).get('/api/markers/mine')).send();
  assert(mine.body.markers.some((m) => m.photos.length && m.photos[0].url), 'and so does the driver\'s own map');

  console.log('\n── no bucket configured ──');
  for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) delete process.env[k];
  const off = await as(d1, request(app).post('/api/markers/photo-uploads')).send({ clientId: 'm-ghi-000', count: 1 });
  assert(off.status === 503, 'upload links answer 503 (the phone keeps the drop queued) instead of failing obscurely');
  const offList = await as(admin, request(app).get('/api/markers?days=365')).send();
  assert(offList.status === 200 && offList.body.markers.length === 3, 'and reading markers still works, links left out');

  console.log(`\n🎉 MARKER PHOTOS VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch((e) => { console.error(e); process.exit(1); });
