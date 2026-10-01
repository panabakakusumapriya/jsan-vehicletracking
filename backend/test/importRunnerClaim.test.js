// Import runner claims: one job is committed ONCE, however many runners are polling.
//
// Every API process runs the import runner. Auckland's delivery (2026-10-01) was committed three
// times in parallel during a deploy's container overlap: the old claim set startedAt and only then
// flipped the status, and a job that parsed straight into its commit sat in 'committing' — the very
// status other runners claim. This drives several runners at the same job at once, with the heavy
// import work stubbed, and counts commits.
//
// Run: node test/importRunnerClaim.test.js
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('import_runner_claim_test');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const ImportJob = require('../src/models/ImportJob');
  const NetworkVersion = require('../src/models/NetworkVersion');
  const networkImport = require('../src/services/networkImport');
  const { tick } = require('../src/services/importRunner');

  // The parse and the commit are stubbed: slow enough that concurrent runners overlap, and the
  // commit counts how often it is reached.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let commits = 0;
  networkImport.extractJob = async () => { await sleep(150); return { boundary: {}, network: {} }; };
  networkImport.buildReport = async () => {
    await sleep(150);
    return { report: { errors: [], warnings: [], totals: { links: 0 } }, areas: [], mapping: {} };
  };
  networkImport.commit = async (job) => {
    commits += 1;
    await sleep(300);
    return NetworkVersion.create({
      projectId: job.projectId, label: job.label, status: 'building',
      targetMeters: 0, counts: { areas: 0, links: 0, orphanLinks: 0 },
    });
  };

  const projectId = new mongoose.Types.ObjectId();
  const mkJob = (extra) => ImportJob.create({
    projectId, requestedBy: new mongoose.Types.ObjectId(), label: 'Auckland', status: 'queued', ...extra,
  });

  console.log('\n-- three runners, one queued job --');
  const job = await mkJob();
  const results = await Promise.all([tick(), tick(), tick()]);
  assert(results.filter(Boolean).length === 1, `exactly one runner claims it (${results.filter(Boolean).length} did)`);
  assert(commits === 1, `and it is committed once (${commits})`);
  const done = await ImportJob.findById(job._id).lean();
  assert(done.status === 'ready' && done.claimToken === null, 'the job finishes ready, with its claim released');
  assert((await NetworkVersion.countDocuments({ projectId })) === 1, 'one network version, not three');

  console.log('\n-- the parse-to-commit handoff --');
  commits = 0;
  const job2 = await mkJob();
  // Runner A starts; while it is between parse and commit (status 'committing'), B and C poll.
  const a = tick();
  await sleep(200);
  const mid = await ImportJob.findById(job2._id).lean();
  const others = await Promise.all([tick(), tick()]);
  await a;
  assert(Boolean(mid.claimToken), 'mid-run the job carries its owner\'s claim');
  assert(others.every((r) => r === null), 'other runners leave an owned job alone');
  assert(commits === 1, `so it is still committed once (${commits})`);

  console.log('\n-- a runner that died mid-job --');
  commits = 0;
  const stale = await mkJob({
    status: 'committing', claimToken: 'dead-runner', claimedAt: new Date(Date.now() - 11 * 60 * 1000),
  });
  const r = await tick();
  assert(r === String(stale._id) && commits === 1, 'a claim with no heartbeat for 10+ minutes is taken over');

  commits = 0;
  await mkJob({ status: 'committing', claimToken: 'busy-runner', claimedAt: new Date() });
  assert((await tick()) === null && commits === 0, 'a live claim is not');

  console.log(`\n🎉 IMPORT RUNNER CLAIMS — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
