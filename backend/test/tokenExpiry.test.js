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
  // The panel DEFAULT is under test: '' is "set" to dotenv (so .env cannot fill it in) and falsy
  // to env.js (so the default applies). The OLD name is set to what the Railway host carried for
  // ten days after the week shipped — it must change nothing now.
  process.env.PANEL_JWT_EXPIRES_IN = '';
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
  assert(env.PANEL_JWT_EXPIRES_IN === '7d', 'panel expiry defaults to 7d');
  assert(env.JWT_EXPIRES_IN === undefined, 'the retired JWT_EXPIRES_IN host variable is not read at all');

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
  assert(adminDays === 7, `admin token lives 7 days despite a stale JWT_EXPIRES_IN=30d in the environment (got ${adminDays})`);

  const managerToken = signToken(manager);
  const { iat: mIat, exp: mExp } = jwt.decode(managerToken);
  const managerDays = Math.round((mExp - mIat) / DAY);
  assert(managerDays === 7, `manager (non-driver role) also gets the 7-day expiry, not the driver one`);

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
  assert(adminLogin.status === 200 && adminLoginDays === 7, 'a real admin login issues a 7-day token');

  const health = await request(app).get('/health');
  assert(health.body.tokenLifetime?.panel === '7d' && health.body.tokenLifetime?.driver === '365d', '/health reports the lifetimes in force');

  console.log('\n── one driver account, signed in on two phones at once ──');
  const meOk = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${driverLogin.body.token}`);
  assert(meOk.status === 200, 'a fresh driver token authenticates fine');

  // A second login from the same account (another device) is allowed, and does not sign the
  // first device out.
  const secondLogin = await request(app).post('/api/auth/login').send({ email: 'driver@x.com', password: 'pw123456' });
  assert(secondLogin.status === 200 && Boolean(secondLogin.body.token), 'a second concurrent driver login is accepted');
  const meFirst = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${driverLogin.body.token}`);
  const meSecond = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${secondLogin.body.token}`);
  assert(meFirst.status === 200, 'the first phone stays signed in after the second login');
  assert(meSecond.status === 200, 'the second phone is signed in too');

  // Signing out on one phone leaves the other working.
  await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${secondLogin.body.token}`);
  const meAfterLogout = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${driverLogin.body.token}`);
  assert(meAfterLogout.status === 200, 'logging out on one phone does not sign the other out');

  console.log(`\n🎉 TOKEN EXPIRY — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
