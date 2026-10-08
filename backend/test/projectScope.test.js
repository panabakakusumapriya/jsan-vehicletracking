// GET /api/projects — who is offered which projects.
//
// Every project picker in the panel is built from this list. An admin sees every project; a manager
// or team lead sees only the projects they are assigned to, so someone on one project starts on it
// and is never offered the rest of the company's.
//
// Run: node test/projectScope.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'project_scope_test_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('project_scope_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const app = createApp();

  const a = await Project.create({ name: 'PRJ-025-HE-DRIVE-AUSGNZ' });
  const b = await Project.create({ name: 'PRJ-017-AI-INFRA-EUR' });
  const c = await Project.create({ name: 'hyd-test' });
  await Project.create({ name: 'old-closed', active: false });

  const mkUser = async (name, role, projects) => {
    const u = new User({ name, email: `${name}@x.com`, role, projectIds: projects.map((p) => p._id) });
    await u.setPassword('pw123456');
    await u.save();
    const token = (await request(app).post('/api/auth/login').send({ email: `${name}@x.com`, password: 'pw123456' })).body.token;
    return (path) => request(app).get(path).set('Authorization', `Bearer ${token}`);
  };
  const names = (res) => res.body.projects.map((p) => p.name).sort().join(', ');

  const admin = await mkUser('admin', 'admin', []);
  const pradeep = await mkUser('pradeep', 'manager', [a]);
  const lead = await mkUser('lead', 'team_lead', [b, c]);
  const nobody = await mkUser('nobody', 'manager', []);

  assert(names(await admin('/api/projects')) === 'PRJ-017-AI-INFRA-EUR, PRJ-025-HE-DRIVE-AUSGNZ, hyd-test', 'an admin is offered every active project');
  assert(names(await admin('/api/projects?all=true')).includes('old-closed'), '…and, asking for all, the closed ones too');
  assert(names(await pradeep('/api/projects')) === 'PRJ-025-HE-DRIVE-AUSGNZ', 'a manager on one project is offered only that project');
  assert(names(await pradeep('/api/projects?all=true')) === 'PRJ-025-HE-DRIVE-AUSGNZ', '…even asking for all');
  assert(names(await lead('/api/projects')) === 'PRJ-017-AI-INFRA-EUR, hyd-test', 'a team lead on two projects is offered those two');
  assert((await nobody('/api/projects')).body.projects.length === 0, 'a manager on no project is offered none, not every one');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
