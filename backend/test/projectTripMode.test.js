// Manual trip recording, per project: the driver presses Start trip / Stop trip in the app, and
// everything between — on foot included — is a trip. Set in the admin panel, delivered on /me and
// on the heartbeat response, exactly like the stop timeout.
//
// Guards three things:
//   - the setting's absent / 'auto' / 'manual' handling (absent must stay 'auto' everywhere);
//   - delivery to the phone on both paths, and an edit reaching the heartbeat at once;
//   - a manual trip (`manual-…` id) is marked as such and is NEVER called parked-phone noise, even
//     in the exact shape the noise rule removes — a walk round one block back to where it began.
// Run: node test/projectTripMode.test.js
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('project_trip_mode_test');
  process.env.JWT_SECRET = 'project_trip_mode_secret_1234567890';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const Trip = require('../src/models/Trip');
  const { classifyTrip } = require('../src/services/tripNoise');
  const app = createApp();

  const admin = new User({ name: 'Admin', email: 'admin@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const adminLogin = await request(app).post('/api/auth/login').send({ email: 'admin@x.com', password: 'pw123456' });
  const asAdmin = (req) => req.set('Authorization', `Bearer ${adminLogin.body.token}`);

  console.log('\n── the setting ──');
  const walk = await asAdmin(request(app).post('/api/projects')).send({ name: 'On foot', tripMode: 'manual' });
  assert(walk.status === 201 && walk.body.project.tripMode === 'manual', 'a project can be created on manual recording');
  const drive = await asAdmin(request(app).post('/api/projects')).send({ name: 'Vehicles' });
  assert(drive.body.project.tripMode === 'auto', 'a project created without the field is automatic');
  const bad = await asAdmin(request(app).post('/api/projects')).send({ name: 'Bad', tripMode: 'walking' });
  assert(bad.status === 400, `an unknown mode is refused (got ${bad.status})`);

  const id = walk.body.project._id;
  const renamed = await asAdmin(request(app).patch(`/api/projects/${id}`)).send({ name: 'On foot (SEA)' });
  assert(renamed.body.project.tripMode === 'manual', 'a PATCH that does not mention it leaves it alone');

  // A project saved before the field existed: no tripMode in the document at all.
  await Project.collection.insertOne({ name: 'Legacy', active: true, enabledModules: ['dashboard', 'map'] });
  const legacy = await Project.collection.findOne({ name: 'Legacy' });

  console.log('\n── delivery: /me and the heartbeat ──');
  const login = async (email, projectId) => {
    const u = new User({ name: email, email, role: 'user', projectIds: [projectId] });
    await u.setPassword('pw123456'); await u.save();
    return (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
  };
  const walker = await login('walker@x.com', id);
  const driver = await login('driver@x.com', drive.body.project._id);
  const old = await login('legacy@x.com', legacy._id);
  const me = (t) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${t}`);
  const beat = (t) => request(app).post('/api/app-activity/heartbeat').set('Authorization', `Bearer ${t}`).send({ gpsOn: true });

  assert((await me(walker)).body.user.tripMode === 'manual', '/me tells a manual project\'s driver');
  assert((await me(driver)).body.user.tripMode === 'auto', '/me says auto for an automatic project');
  assert((await me(old)).body.user.tripMode === 'auto', 'and auto for a project saved before the setting existed');
  assert((await beat(walker)).body.tripMode === 'manual', 'the heartbeat carries manual to the running engine');
  assert((await beat(old)).body.tripMode === 'auto', 'and auto for the legacy project');

  const back = await asAdmin(request(app).patch(`/api/projects/${id}`)).send({ tripMode: 'auto' });
  assert(back.body.project.tripMode === 'auto', 'switched back to automatic');
  assert((await beat(walker)).body.tripMode === 'auto',
    'the very next heartbeat says so — the edit clears the minute-long settings memo');
  await asAdmin(request(app).patch(`/api/projects/${id}`)).send({ tripMode: 'manual' });

  console.log('\n── a manual trip is marked, and is never parked-phone noise ──');
  // A walk round one block: out ~180 m, round, and back to within a few metres of the start.
  // Net < 150 m and spread < 400 m — the parked-jitter rule's exact shape.
  const t0 = Date.parse('2026-11-12T03:00:00Z');
  const loop = [[0, 0], [0.0008, 0], [0.0016, 0], [0.0016, 0.0008], [0.0016, 0.0016], [0.0008, 0.0016], [0, 0.0016], [0, 0.0008], [0.00002, 0.00001]];
  const pointsFor = (clientTripId) => loop.map(([dLat, dLon], i) => ({
    clientId: `${clientTripId}-${i}`,
    clientTripId,
    lat: -6.185 + dLat,
    lon: 106.815 + dLon,
    speedKmh: 4.5,
    accuracy: 6,
    isMoving: true,
    recordedAt: new Date(t0 + i * 60_000).toISOString(),
    tripStatus: i === loop.length - 1 ? 'ended' : 'active',
  }));
  const ingest = (t, pts) => request(app).post('/api/tracking/ingest').set('Authorization', `Bearer ${t}`).send({ points: pts });

  const m = await ingest(walker, pointsFor('manual-0d6f1c3a-walk'));
  assert(m.status === 200 || m.status === 201, `the manual walk was ingested (got ${m.status})`);
  const manualTrip = await Trip.findOne({ clientTripId: 'manual-0d6f1c3a-walk' }).lean();
  assert(manualTrip && manualTrip.startMode === 'manual', 'the trip is stored as started by hand');
  assert(manualTrip.status === 'completed', 'and the phone\'s end marker closed it');
  await classifyTrip(manualTrip._id);
  const manualAfter = await Trip.findById(manualTrip._id).lean();
  assert(manualAfter.parkedJitterAt && manualAfter.parkedJitter === false,
    'a verdict was made and it is NOT parked jitter — a phone does not press Start');

  // The same shape from the automatic engine is still caught: the rule itself is untouched.
  await ingest(walker, pointsFor('0d6f1c3a-auto'));
  const autoTrip = await Trip.findOne({ clientTripId: '0d6f1c3a-auto' }).lean();
  assert(autoTrip.startMode === 'auto', 'an ordinary trip id is an automatic trip');
  await classifyTrip(autoTrip._id);
  assert((await Trip.findById(autoTrip._id).lean()).parkedJitter === true,
    'and the identical shape from the automatic engine is still flagged as parked noise');

  // A continuation (after an 8-hour force-close) keeps the prefix, and so the mark.
  const { isManualTrip } = require('../src/services/tripNoise');
  assert(isManualTrip({ clientTripId: 'manual-0d6f1c3a-walk~1794479079319' }), 'a continuation of a manual trip is manual');
  assert(!isManualTrip({ clientTripId: null }) && !isManualTrip(null), 'no id, no trip: not manual');

  console.log(`\n🎉 PROJECT TRIP MODE VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch((e) => { console.error(e); process.exit(1); });
