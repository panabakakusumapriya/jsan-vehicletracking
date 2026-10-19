// Changing an account's password signs that account out everywhere: every token issued before
// the change is refused, while tokens issued after it — and every OTHER account's tokens — keep
// working. This is the mechanism a retired shared login relies on, and it must not turn back into
// the single-session lock that was removed on 2026-09-29: two phones on the CURRENT password both
// stay signed in.
// Run: npm run test:password-change
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
// JWT `iat` is whole seconds. A change made in the same second as a sign-in cannot be told apart
// from it, so each step that must be "later than the token" first waits for the next second.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100 - (Date.now() % 1000)));

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('password_change_test');
  process.env.JWT_SECRET = 'password_change_test_secret_1234567890';
  process.env.PANEL_JWT_EXPIRES_IN = '7d';
  process.env.DRIVER_JWT_EXPIRES_IN = '365d';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const bcrypt = require('bcryptjs');
  const request = require('supertest');
  const User = require('../src/models/User');
  const { issuedBeforePasswordChange } = require('../src/utils/jwt');
  const { createApp } = require('../src/app');
  const app = createApp();

  const login = (email, password) => request(app).post('/api/auth/login').send({ email, password });
  const me = (token) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  async function makeUser(fields, password) {
    const u = new User(fields);
    await u.setPassword(password);
    await u.save();
    return u;
  }

  console.log('\n── the rule itself ──');
  const changedAt = new Date('2026-10-19T08:00:00.700Z');
  const sec = Math.floor(changedAt.getTime() / 1000);
  assert(issuedBeforePasswordChange({ iat: sec - 1 }, { passwordChangedAt: changedAt }) === true, 'a token from the second before the change is refused');
  assert(issuedBeforePasswordChange({ iat: sec }, { passwordChangedAt: changedAt }) === false, 'a token from the same second survives (a sign-in right after the reset)');
  assert(issuedBeforePasswordChange({ iat: sec + 1 }, { passwordChangedAt: changedAt }) === false, 'a token from after the change is fine');
  assert(issuedBeforePasswordChange({}, { passwordChangedAt: changedAt }) === true, 'a token with no iat counts as older than any change');
  assert(issuedBeforePasswordChange({ iat: 0 }, { passwordChangedAt: null }) === false, 'an account that never changed its password refuses nothing');

  console.log('\n── a driver on two phones, signed in before anything happens ──');
  const driver = await makeUser({ name: 'Driver', email: 'driver@x.com', role: 'user' }, 'pw123456');
  const phone1 = (await login('driver@x.com', 'pw123456')).body.token;
  const phone2 = (await login('driver@x.com', 'pw123456')).body.token;
  assert((await me(phone1)).status === 200 && (await me(phone2)).status === 200, 'both phones are signed in');

  console.log('\n── the shared admin login, open in two browsers ──');
  const admin = await makeUser({ name: 'Shared Admin', email: 'admin@x.com', role: 'admin' }, 'OldPass123');
  assert(admin.passwordChangedAt instanceof Date, 'creating an account stamps passwordChangedAt');
  const browserA = (await login('admin@x.com', 'OldPass123')).body.token;
  const browserB = (await login('admin@x.com', 'OldPass123')).body.token;
  assert((await me(browserA)).status === 200 && (await me(browserB)).status === 200, 'both browsers are signed in');

  // What src/seed/setPassword.js does.
  await nextSecond();
  const reloaded = await User.findById(admin._id);
  await reloaded.setPassword('Jsan4496');
  await reloaded.save();
  assert(reloaded.passwordChangedAt > admin.passwordChangedAt, 'setting the password moves passwordChangedAt forward');

  const a = await me(browserA);
  const b = await me(browserB);
  assert(a.status === 401 && a.body.error === 'PASSWORD_CHANGED', `browser A is signed out by the change (${a.status} ${a.body.error})`);
  assert(b.status === 401 && b.body.error === 'PASSWORD_CHANGED', 'browser B is signed out too');
  assert((await login('admin@x.com', 'OldPass123')).status === 401, 'the old password no longer signs in');
  const fresh = await login('admin@x.com', 'Jsan4496');
  assert(fresh.status === 200 && (await me(fresh.body.token)).status === 200, 'signing in with the new password works straight away, in the same second as the change');
  assert((await me(phone1)).status === 200 && (await me(phone2)).status === 200, 'the driver on another account is untouched on both phones');

  console.log('\n── an unrelated save does not sign anyone out ──');
  const again = await User.findById(admin._id);
  again.phone = '+61 400 000 000';
  await again.save();
  assert(again.passwordChangedAt.getTime() === reloaded.passwordChangedAt.getTime(), 'saving other fields leaves passwordChangedAt alone');
  assert((await me(fresh.body.token)).status === 200, 'the new session is still signed in');

  console.log('\n── a driver reset from the panel is cut off on every phone ──');
  const superadmin = await makeUser({ name: 'Boss', email: 'boss@x.com', role: 'superadmin' }, 'pw123456');
  const bossToken = (await login('boss@x.com', 'pw123456')).body.token;
  await nextSecond();
  const reset = await request(app).patch(`/api/users/${driver._id}`).set('Authorization', `Bearer ${bossToken}`).send({ password: 'NewDriverPw1' });
  assert(reset.status === 200, `the panel reset succeeds (${reset.status} ${JSON.stringify(reset.body).slice(0, 80)})`);
  assert(reset.body.token === undefined, 'resetting someone ELSE returns no token for the caller');
  assert((await me(phone1)).status === 401 && (await me(phone2)).status === 401, 'both of the driver\'s phones are signed out');
  assert((await me(bossToken)).status === 200, 'the superadmin who did it stays signed in');
  const phone3 = await login('driver@x.com', 'NewDriverPw1');
  assert(phone3.status === 200 && (await me(phone3.body.token)).status === 200, 'the driver signs back in with the new password');

  console.log('\n── resetting your OWN password keeps you signed in ──');
  await nextSecond();
  const own = await request(app).patch(`/api/users/${superadmin._id}`).set('Authorization', `Bearer ${bossToken}`).send({ password: 'pw654321' });
  assert(own.status === 200 && typeof own.body.token === 'string', 'the response carries a fresh token');
  assert((await me(bossToken)).status === 401, 'the token the request arrived with is now refused');
  assert((await me(own.body.token)).status === 200, 'the fresh token works');

  console.log('\n── accounts from before the field existed ──');
  await User.collection.insertOne({
    name: 'Legacy', email: 'legacy@x.com', role: 'manager', active: true,
    passwordHash: await bcrypt.hash('pw123456', 10),
  });
  const legacyLogin = await login('legacy@x.com', 'pw123456');
  assert(legacyLogin.status === 200 && (await me(legacyLogin.body.token)).status === 200, 'an account with no passwordChangedAt signs in and is accepted');
  const legacy = await User.findOne({ email: 'legacy@x.com' });
  assert(legacy.passwordChangedAt == null, 'a plain sign-in does not stamp it (only a password change does)');

  console.log('\n── the stamp is visible but never the hash ──');
  const safe = legacy.toSafeJSON();
  assert(!('passwordHash' in safe) && !('activeSessionId' in safe), 'toSafeJSON still hides the secrets');

  console.log(`\n🎉 PASSWORD CHANGE SIGNS OUT — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
