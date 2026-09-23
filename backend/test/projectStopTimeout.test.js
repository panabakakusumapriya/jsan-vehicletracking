// The per-project stop timeout: how long a vehicle may sit still before the handset ends the
// trip. Set in the admin panel, delivered to the app twice — on /me (right at cold start) and on
// the heartbeat response (right in the middle of a shift, with nobody touching the phone).
//
// What this guards is mostly the ABSENT/NULL/NUMBER distinction. The engine reads a missing
// value as "use my own default (10 min)" and a 0 as "end the trip the instant it stops", so any
// place that collapses those two is a fleet-wide outage waiting to happen.
// Run: node test/projectStopTimeout.test.js
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('project_stop_timeout_test');
  process.env.JWT_SECRET = 'project_stop_timeout_secret_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const app = createApp();

  const admin = new User({ name: 'Admin', email: 'admin@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const adminLogin = await request(app).post('/api/auth/login').send({ email: 'admin@x.com', password: 'pw123456' });
  const adminToken = adminLogin.body.token;
  const asAdmin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

  console.log('\n── creating a project with a stop timeout ──');
  const created = await asAdmin(request(app).post('/api/projects'))
    .send({ name: 'P1VC', tripEndAfterMinutes: 3 });
  assert(created.status === 201, `project created (got ${created.status})`);
  assert(created.body.project.tripEndAfterMinutes === 3, 'the 3-minute setting was stored');

  const plain = await asAdmin(request(app).post('/api/projects')).send({ name: 'Delivery' });
  assert(plain.status === 201 && plain.body.project.tripEndAfterMinutes === null,
    'a project created without the field stores null — meaning "use the app default"');

  console.log('\n── the bounds are enforced server-side, not only in the form ──');
  for (const [value, why] of [[1, 'below the floor'], [45, 'above the ceiling'], ['abc', 'not a number']]) {
    const bad = await asAdmin(request(app).post('/api/projects')).send({ name: `Bad ${value}`, tripEndAfterMinutes: value });
    assert(bad.status === 400, `${JSON.stringify(value)} is rejected (${why}, got ${bad.status})`);
  }
  assert((await Project.countDocuments({})) === 2, 'neither rejected project was created');

  console.log('\n── editing ──');
  const id = created.body.project._id;
  const renamed = await asAdmin(request(app).patch(`/api/projects/${id}`)).send({ name: 'P1VC renamed' });
  assert(renamed.body.project.tripEndAfterMinutes === 3,
    'a PATCH that does not mention the field LEAVES IT ALONE — renaming a project must not change how its trips end');

  const cleared = await asAdmin(request(app).patch(`/api/projects/${id}`)).send({ tripEndAfterMinutes: null });
  assert(cleared.body.project.tripEndAfterMinutes === null, 'an explicit null clears the override');

  const reset = await asAdmin(request(app).patch(`/api/projects/${id}`)).send({ tripEndAfterMinutes: 3 });
  assert(reset.body.project.tripEndAfterMinutes === 3, 'and it can be set again');

  const tooLow = await asAdmin(request(app).patch(`/api/projects/${id}`)).send({ tripEndAfterMinutes: 0 });
  assert(tooLow.status === 400, '0 is refused on PATCH too — it would mean "end the trip instantly"');
  assert((await Project.findById(id)).tripEndAfterMinutes === 3, 'and the stored value is untouched by the refused edit');

  console.log('\n── delivery path 1: GET /api/auth/me, which the app re-reads on every foreground ──');
  const driver = new User({ name: 'Driver', email: 'driver@x.com', role: 'user', projectIds: [id] });
  await driver.setPassword('pw123456'); await driver.save();
  const driverLogin = await request(app).post('/api/auth/login').send({ email: 'driver@x.com', password: 'pw123456' });
  const driverToken = driverLogin.body.token;

  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${driverToken}`);
  assert(me.body.user.tripEndAfterMinutes === 3, `the driver's own project setting reaches them (got ${me.body.user.tripEndAfterMinutes})`);

  const plainDriver = new User({ name: 'Other', email: 'other@x.com', role: 'user', projectIds: [plain.body.project._id] });
  await plainDriver.setPassword('pw123456'); await plainDriver.save();
  const plainLogin = await request(app).post('/api/auth/login').send({ email: 'other@x.com', password: 'pw123456' });
  const plainMe = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${plainLogin.body.token}`);
  assert(plainMe.body.user.tripEndAfterMinutes === null,
    'a project with no override reports null, NOT 0 — 0 would end trips the moment they stopped');

  console.log('\n── delivery path 2: the heartbeat response, which reaches the service mid-shift ──');
  const beat = await request(app).post('/api/app-activity/heartbeat')
    .set('Authorization', `Bearer ${driverToken}`).send({ gpsOn: true, networkOn: true });
  assert(beat.status === 200 && beat.body.ok === true, 'the heartbeat still does its original job');
  assert(beat.body.tripEndAfterMinutes === 3, `and carries the project setting back (got ${beat.body.tripEndAfterMinutes})`);

  // A DIFFERENT driver on purpose: the controller memoises project settings for 60 s, so asking
  // about this one proves the absent case without waiting out the cache on the first project.
  const plainBeat = await request(app).post('/api/app-activity/heartbeat')
    .set('Authorization', `Bearer ${plainLogin.body.token}`).send({ gpsOn: true });
  assert(plainBeat.status === 200 && plainBeat.body.ok === true, 'a driver whose project has no override still gets a healthy heartbeat');
  assert(!('tripEndAfterMinutes' in plainBeat.body),
    'and the field is ABSENT rather than 0/null — absent is what tells the handset to keep its own default');

  console.log(`\n🎉 PROJECT STOP TIMEOUT VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch((e) => { console.error(e); process.exit(1); });
