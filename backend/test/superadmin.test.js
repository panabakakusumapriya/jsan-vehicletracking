// The superadmin tier, and the panel's one-week sign-in.
//
// A superadmin is an admin everywhere an admin is allowed, and the only role that may create,
// change or deactivate admin accounts. Panel tokens (admin / manager / team lead) last 7 days by
// default; driver tokens are unchanged.
//
// Run: node test/superadmin.test.js
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('superadmin_test');
  process.env.JWT_SECRET = 'superadmin_test_secret_1234567890';
  // The DEFAULT is under test. An empty value is "set" to dotenv (so .env cannot fill it in) and
  // falsy to env.js (so the default applies).
  process.env.JWT_EXPIRES_IN = '';
  process.env.DRIVER_JWT_EXPIRES_IN = '';
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const jwt = require('jsonwebtoken');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const app = createApp();

  const mk = async (email, role) => {
    const u = new User({ name: email.split('@')[0], email, role });
    await u.setPassword('pw123456');
    await u.save();
    const login = await request(app).post('/api/auth/login').send({ email, password: 'pw123456' });
    const token = login.body.token;
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    return {
      u, token,
      get: (p) => auth(request(app).get(p)),
      post: (p, b) => auth(request(app).post(p)).send(b),
      patch: (p, b) => auth(request(app).patch(p)).send(b),
      del: (p) => auth(request(app).delete(p)),
    };
  };
  const superadmin = await mk('root@x.com', 'superadmin');
  const admin = await mk('admin@x.com', 'admin');
  const manager = await mk('mgr@x.com', 'manager');
  const driver = await mk('drv@x.com', 'user');

  console.log('\n── a superadmin is an admin everywhere ──');
  assert((await superadmin.post('/api/projects', { name: 'P1' })).status === 201, 'requireRole("admin") routes admit a superadmin (create a project)');
  assert((await superadmin.get('/api/projects')).body.projects.length === 1, 'and the admin-only project list shows them everything');
  assert((await superadmin.get('/api/auth/permissions')).body.permissions.managers === 'edit', 'every panel tab is "edit" for a superadmin, like an admin');
  assert((await superadmin.get('/api/users')).body.users.length === 4, 'a superadmin lists every user');

  console.log('\n── only a superadmin creates or changes admins ──');
  const byAdmin = await admin.post('/api/users', { name: 'A2', email: 'a2@x.com', password: 'pw123456', role: 'admin' });
  assert(byAdmin.status === 403, 'an admin cannot create another admin');
  assert((await admin.post('/api/users', { name: 'S2', email: 's2@x.com', password: 'pw123456', role: 'superadmin' })).status === 403, '…nor a superadmin');
  const mgrOk = await admin.post('/api/users', { name: 'M2', email: 'm2@x.com', password: 'pw123456', role: 'manager', projectIds: [(await superadmin.get('/api/projects')).body.projects[0]._id] });
  assert(mgrOk.status === 201, 'an admin still creates managers as before');
  const a2 = await superadmin.post('/api/users', { name: 'A2', email: 'a2@x.com', password: 'pw123456', role: 'admin' });
  assert(a2.status === 201 && a2.body.user.role === 'admin', 'a superadmin creates an admin');
  const s2 = await superadmin.post('/api/users', { name: 'S2', email: 's2@x.com', password: 'pw123456', role: 'superadmin' });
  assert(s2.status === 201 && s2.body.user.role === 'superadmin', '…and another superadmin');
  assert((await manager.post('/api/users', { name: 'X', email: 'x@x.com', password: 'pw123456', role: 'superadmin' })).status !== 201 || (await User.findOne({ email: 'x@x.com' })).role === 'user', 'a manager asking for superadmin gets a driver, as managers always did');

  assert((await admin.patch(`/api/users/${a2.body.user._id}`, { name: 'Renamed' })).status === 403, 'an admin cannot edit another admin');
  assert((await admin.patch(`/api/users/${superadmin.u._id}`, { name: 'Renamed' })).status === 403, '…nor a superadmin');
  assert((await admin.patch(`/api/users/${mgrOk.body.user._id}`, { role: 'admin' })).status === 403, '…nor promote a manager to admin');
  assert((await admin.patch(`/api/users/${admin.u._id}`, { name: 'Me' })).status === 200, 'an admin can still edit their own details');
  assert((await admin.patch(`/api/users/${admin.u._id}`, { role: 'superadmin' })).status === 400, '…but not their own role');
  assert((await superadmin.patch(`/api/users/${mgrOk.body.user._id}`, { role: 'admin' })).status === 200, 'a superadmin promotes a manager to admin');
  assert((await admin.del(`/api/users/${a2.body.user._id}`)).status === 403, 'an admin cannot deactivate an admin');
  assert((await superadmin.del(`/api/users/${superadmin.u._id}`)).status === 400, 'a superadmin cannot deactivate themselves');
  assert((await superadmin.del(`/api/users/${a2.body.user._id}`)).status === 200, 'a superadmin deactivates an admin');

  console.log('\n── sign-in lasts a week on the panel ──');
  const life = (t) => { const d = jwt.decode(t); return d.exp - d.iat; };
  const DAY = 86400;
  assert(life(admin.token) === 7 * DAY, 'an admin token lasts 7 days');
  assert(life(manager.token) === 7 * DAY, 'a manager token lasts 7 days');
  assert(life(superadmin.token) === 7 * DAY, 'a superadmin token lasts 7 days');
  assert(life(driver.token) === 365 * DAY, 'a driver token is unchanged at 365 days');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
