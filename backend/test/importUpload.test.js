// When an upload starts an import: POST /api/network/imports/:id/file.
//
// It used to start on the FIRST archive. Christchurch's roads began loading on their own while the
// operator was still choosing the polygon zip, and once running there was no way to add it — they
// had to start a new import. Now:
//   - an upload starts the import by itself only when BOTH archives are in (this is also all an
//     older panel tab knows how to do, and it now waits for the second file);
//   - `hold=1` never starts — the panel sends both files that way and then starts once;
//   - one archive on its own is still a valid import, started explicitly (POST …/validate).
//
// Run: node test/importUpload.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'import_upload_test_secret_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('import_upload_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const User = require('../src/models/User');
  const Project = require('../src/models/Project');
  const ImportJob = require('../src/models/ImportJob');
  // The runner is not under test: a queued job here must stay queued, not be picked up and parsed.
  require('../src/services/importRunner').kickImportRunner = () => {};
  const app = createApp();

  const project = await Project.create({ name: 'HE Drive' });
  const boss = new User({ name: 'boss', email: 'boss@x.com', role: 'manager', projectIds: [project._id] });
  await boss.setPassword('pw123456');
  await boss.save();
  const token = (await request(app).post('/api/auth/login').send({ email: 'boss@x.com', password: 'pw123456' })).body.token;
  const as = (r) => r.set('Authorization', `Bearer ${token}`);

  const newJob = async () => (await as(request(app).post('/api/network/imports')).send({ projectId: project._id })).body.job._id;
  const upload = (id, layer, query = '') =>
    as(request(app).post(`/api/network/imports/${id}/file?layer=${layer}${query}`))
      .set('Content-Type', 'application/zip')
      .set('X-File-Name', `${layer}.zip`)
      .send(Buffer.from(`not really a zip: ${layer}`));
  const statusOf = async (id) => (await ImportJob.findById(id).lean()).status;

  /* ── the old panel's way: one file, then the other, no hold ── */
  const a = await newJob();
  const roads = await upload(a, 'network');
  assert(roads.status === 200 && roads.body.job.status === 'draft', 'roads alone, uploaded first: the import waits — it does not start loading');
  assert((await statusOf(a)) === 'draft', '…and is still waiting');
  const areas = await upload(a, 'boundary');
  assert(areas.body.job.status === 'queued' && areas.body.job.files.boundary.name && areas.body.job.files.network.name,
    'the polygon zip can still be added to it, and with both in it starts');

  /* ── the new panel's way: both held, then one start ── */
  const b = await newJob();
  assert((await upload(b, 'boundary', '&hold=1')).body.job.status === 'draft', 'held: the first archive waits');
  assert((await upload(b, 'network', '&hold=1')).body.job.status === 'draft', 'held: so does the second — nothing starts until asked');
  const started = await as(request(app).post(`/api/network/imports/${b}/validate`)).send({});
  assert(started.status === 200 && (await statusOf(b)) === 'queued', 'one start, with both archives in');

  /* ── one archive really is the whole delivery ── */
  const c = await newJob();
  await upload(c, 'network');
  const alone = await as(request(app).post(`/api/network/imports/${c}/validate`)).send({});
  assert(alone.status === 200 && (await statusOf(c)) === 'queued', 'roads for areas already loaded: started explicitly, on their own');
  const d = await newJob();
  assert((await as(request(app).post(`/api/network/imports/${d}/validate`)).send({})).status === 400, 'nothing to start without an archive');

  /* ── replacing a file on a checked import ── */
  await ImportJob.updateOne({ _id: a }, { $set: { status: 'awaiting_approval' } });
  assert((await upload(a, 'network')).body.job.status === 'queued', 'replacing one of two archives re-checks at once');
  await ImportJob.updateOne({ _id: c }, { $set: { status: 'failed' } });
  assert((await upload(c, 'network')).body.job.status === 'draft', 'replacing the only archive waits — the polygon zip can still be added before it runs again');

  console.log(`\n${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
