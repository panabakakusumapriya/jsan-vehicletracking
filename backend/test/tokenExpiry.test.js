// Drivers (role 'user') get a long-lived driver-portal token; every other role keeps the
// shorter admin-panel one — see env.js / utils/jwt.js for why. This guards the split itself,
// not just that login succeeds.
// Run: npm run test:token-expiry
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('token_expiry_test');
  process.env.JWT_SECRET = 'token_expiry_test_secret_1234567890';
  // Set explicitly (rather than left to whatever the real backend/.env happens to contain)
  // so this test is hermetic like the rest of the suite — it is checking that env.js's
  // DRIVER_JWT_EXPIRES_IN default matches this value, not depending on it.
  process.env.DRIVER_JWT_EXPIRES_IN = '365d';
  process.env.JWT_EXPIRES_IN = '30d';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const jwt = require('jsonwebtoken');
  const User = require('../src/models/User');
  const { signToken } = require('../src/utils/jwt');
  const env = require('../src/config/env');

  console.log('\n── config ──');
  assert(env.DRIVER_JWT_EXPIRES_IN === '365d', 'driver expiry is 365d');
  assert(env.JWT_EXPIRES_IN === '30d', 'admin/manager expiry is unaffected, still 30d');

  const driver = new User({ name: 'Driver', email: 'driver@x.com', role: 'user' });
  await driver.setPassword('pw123456'); await driver.save();
  const admin = new User({ name: 'Admin', email: 'admin@x.com', role: 'admin' });
  await admin.setPassword('pw123456'); await admin.save();
  const manager = new User({ name: 'Manager', email: 'mgr@x.com', role: 'manager' });
  await manager.setPassword('pw123456'); await manager.save();

  console.log('\n── signed tokens carry the right lifetime ──');
  const DAY = 24 * 60 * 60;

  const driverToken = signToken(driver, 'session-1');
  const { iat: dIat, exp: dExp } = jwt.decode(driverToken);
  const driverDays = Math.round((dExp - dIat) / DAY);
  assert(driverDays === 365, `driver token lives 365 days (got ${driverDays})`);

  const adminToken = signToken(admin);
  const { iat: aIat, exp: aExp } = jwt.decode(adminToken);
  const adminDays = Math.round((aExp - aIat) / DAY);
  assert(adminDays === 30, `admin token still lives 30 days (got ${adminDays})`);

  const managerToken = signToken(manager);
  const { iat: mIat, exp: mExp } = jwt.decode(managerToken);
  const managerDays = Math.round((mExp - mIat) / DAY);
  assert(managerDays === 30, `manager (non-driver role) also gets the 30-day expiry, not the driver one`);

  console.log('\n── through the real /login endpoint ──');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();

  const driverLogin = await request(app).post('/api/auth/login').send({ email: 'driver@x.com', password: 'pw123456' });
  const driverLoginDecoded = jwt.decode(driverLogin.body.token);
  const driverLoginDays = Math.round((driverLoginDecoded.exp - driverLoginDecoded.iat) / DAY);
  assert(driverLogin.status === 200 && driverLoginDays === 365, 'a real driver login issues a 365-day token');

  const adminLogin = await request(app).post('/api/auth/login').send({ email: 'admin@x.com', password: 'pw123456' });
  const adminLoginDecoded = jwt.decode(adminLogin.body.token);
  const adminLoginDays = Math.round((adminLoginDecoded.exp - adminLoginDecoded.iat) / DAY);
  assert(adminLogin.status === 200 && adminLoginDays === 30, 'a real admin login still issues a 30-day token');

  console.log('\n── the long-lived driver token still respects the single-session lock ──');
  const meOk = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${driverLogin.body.token}`);
  assert(meOk.status === 200, 'a fresh driver token authenticates fine');

  // A second login from the "same" account (simulating another device) supersedes the first.
  const secondLogin = await request(app).post('/api/auth/login').send({ email: 'driver@x.com', password: 'pw123456' });
  assert(secondLogin.status === 409, 'a concurrent second driver login is still rejected as ALREADY_LOGGED_IN — the longer expiry did not weaken this');

  console.log(`\n🎉 TOKEN EXPIRY — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
