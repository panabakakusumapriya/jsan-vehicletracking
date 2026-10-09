// Driver Academy progress — PUT /api/tracking/my-academy, read back through /api/auth/me.
//
// The course runs in the driver app; progress lives on the account so a second phone does not
// send the driver through it again, and so the panel can show who has finished.
//
// Run: node test/driverAcademy.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('driver_academy_test');
  process.env.JWT_SECRET = 'driver_academy_test_secret_1234567890';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const app = createApp();

  const mk = async (email, role) => {
    const u = new User({ name: email.split('@')[0], email, role });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return { u, me: () => auth(request(app).get('/api/auth/me')), put: (b) => auth(request(app).put('/api/tracking/my-academy')).send(b) };
  };
  const drv = await mk('drv@x.com', 'user');
  const admin = await mk('admin@x.com', 'admin');

  const fresh = (await drv.me()).body.user.academy;
  assert(!fresh || (!fresh.completedAt && !fresh.skippedAt && !(fresh.lessons || []).length), 'a new driver has not started the academy');

  await drv.put({ lessons: ['welcome', 'setup'] });
  await drv.put({ lessons: ['welcome'] }); // an older copy on another phone
  let a = (await drv.me()).body.user.academy;
  assert(a.lessons.length === 2, 'lessons add up and a stale phone cannot take any back');

  await drv.put({ skipped: true });
  a = (await drv.me()).body.user.academy;
  assert(a.skippedAt && !a.completedAt, '"Skip for now" is recorded');

  await drv.put({ lessons: ['map', 'markers', 'day', 'safety', '<script>'], score: 83, completed: true });
  a = (await drv.me()).body.user.academy;
  assert(a.completedAt && a.score === 83 && a.lessons.length === 6, 'finishing records the date, the score and all six lessons (junk ids ignored)');
  const first = a.completedAt;
  await drv.put({ completed: true, score: 100 });
  a = (await drv.me()).body.user.academy;
  assert(a.completedAt === first, 'taking it again keeps the first completion date');

  assert((await admin.put({ completed: true })).status === 403, 'only drivers have an academy');
  const appCert = a.certificateId;
  assert(/^JSAN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(appCert || ''), 'finishing in the app issues a certificate number');

  console.log('\n── the web portal ──');
  const web = await mk('web@x.com', 'user');
  const tokenOf = async (email) => (await request(app).post('/api/auth/login').send({ email, password: 'pw123456' })).body.token;
  const wt = await tokenOf('web@x.com');
  const wget = (p) => request(app).get(p).set('Authorization', `Bearer ${wt}`);
  const answer = (lessonId, choice) => request(app).post('/api/academy/answer').set('Authorization', `Bearer ${wt}`).send({ lessonId, choice });
  const course = (await wget('/api/academy/course')).body;
  assert(course.lessons.length === 6 && course.name === 'web', 'the portal gets six lessons and the driver\'s name');
  assert(course.lessons.every((l) => l.question.correct === undefined && l.question.explain === undefined), 'the answers never reach the browser');
  const wrong = await answer('welcome', 0);
  assert(wrong.body.correct === false && !wrong.body.explain && wrong.body.progress.lessons.length === 0, 'a wrong answer is marked wrong and finishes nothing');
  const right = await answer('welcome', 1);
  assert(right.body.correct === true && right.body.explain && right.body.progress.lessons.includes('welcome'), 'the right answer finishes the lesson and explains why');
  // The rest right first time. The marker lesson's answer is the flag that covers cables.
  for (const l of course.lessons.slice(1)) {
    const choice = l.id === 'markers' ? Math.max(0, l.question.options.findIndex((o) => /blue/i.test(o))) : 1;
    await answer(l.id, choice);
  }
  const done = (await wget('/api/academy/course')).body.progress;
  assert(done.completedAt && done.certificateId, 'all six done on the web: completed, with a certificate number');
  assert(done.score === 83, 'scored on first tries, graded by the server: 5 of 6 = 83%');
  assert((await answer('nope', 1)).status === 400, 'an unknown lesson is refused');
  assert((await request(app).get('/api/academy/course')).status === 401, 'the course needs the driver to sign in');

  console.log('\n── checking a certificate ──');
  const check = await request(app).get(`/api/academy/certificate/${done.certificateId}`);
  assert(check.status === 200 && check.body.valid && check.body.name === 'web' && check.body.score === 83, 'anyone can check a certificate number, with no sign-in');
  assert((await request(app).get(`/api/academy/certificate/${done.certificateId.toLowerCase()}`)).body.valid, '…typed in lower case too');
  assert((await request(app).get('/api/academy/certificate/JSAN-AAAA-BBBB')).status === 404, 'a made-up number is not valid');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
