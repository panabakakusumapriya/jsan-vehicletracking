// Background bulk export: models/ExportJob.js + services/exportRunner.js.
// Run: npm run test:export-job
process.env.JWT_SECRET = process.env.JWT_SECRET || 'export_job_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

const fs = require('fs');
let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('export_job_test');

  const { encodePolyline6 } = require('../src/services/valhalla');
  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const Trip = require('../src/models/Trip');
  const User = require('../src/models/User');
  const LocationPoint = require('../src/models/LocationPoint');
  const ExportJob = require('../src/models/ExportJob');
  const { tick, cleanupArtifacts } = require('../src/services/exportRunner');

  const driver = new User({ name: 'Exp Driver', email: 'e@x.com', role: 'user' });
  await driver.setPassword('pw123456');
  await driver.save();

  const t0 = Date.parse('2026-08-01T08:00:00Z');
  const line = (n) => encodePolyline6(Array.from({ length: n }, (_, i) => ({ lat: 50 + i * 0.001, lon: 8 })));

  // Two matched trips with snapped geometry, one never matched — the realistic mix.
  const mk = async (i, matched) => {
    const trip = await Trip.create({
      driverId: driver._id, status: 'completed',
      startedAt: new Date(t0 + i * 3600_000), endedAt: new Date(t0 + i * 3600_000 + 1800_000),
      distanceMeters: 5000, maxSpeedKmh: 80,
      ...(matched ? { mapMatchStatus: 'matched', cleanedRouteShapes: [line(6)], cleanedDistanceMeters: 555, ukmNewShapes: [line(3)], ukmMeters: 222 } : {}),
    });
    await LocationPoint.create({ tripId: trip._id, driverId: driver._id, lat: 50, lon: 8, recordedAt: new Date(t0 + i * 3600_000) });
    await LocationPoint.create({ tripId: trip._id, driverId: driver._id, lat: 50.01, lon: 8, recordedAt: new Date(t0 + i * 3600_000 + 60_000) });
    return trip;
  };
  await mk(0, true); await mk(1, true); await mk(2, false);

  console.log('\n── a queued snapped job is picked up, built, and marked ready ──');
  const job = await ExportJob.create({
    requestedBy: driver._id, format: 'kml', layer: 'snapped',
    filter: { status: { $in: ['completed', 'timed_out'] } }, total: 3,
  });

  const ranId = await tick();
  assert(String(ranId) === String(job._id), 'the runner claimed the queued job');

  const after = await ExportJob.findById(job._id);
  assert(after.status === 'ready', `status is ready (got ${after.status}${after.error ? ': ' + after.error : ''})`);
  assert(after.done === 3, `progress counted every trip (got ${after.done})`);
  assert(after.bytes > 0, `the artifact has real bytes on disk (got ${after.bytes})`);
  assert(fs.existsSync(after.filePath), 'the zip exists at the recorded path');

  // The size the job reports must match the file, or the download can be served truncated.
  assert(fs.statSync(after.filePath).size === after.bytes, 'recorded byte count matches the file actually on disk');

  console.log('\n── a mixed range still exports every trip, and says so ──');
  assert(after.fellBackToRaw === 1, `the unmatched trip fell back to raw and was counted (got ${after.fellBackToRaw})`);

  console.log('\n── the queue is drained, so a second tick does nothing ──');
  assert((await tick()) === null, 'no job left to claim');

  console.log('\n── a failing job is recorded, not left running forever ──');
  const bad = await ExportJob.create({
    requestedBy: driver._id, format: 'kml', layer: 'raw',
    filter: { startedAt: { $gte: 'not-a-date' } }, total: 1,
  });
  await tick();
  const badAfter = await ExportJob.findById(bad._id);
  assert(badAfter.status === 'failed', `a broken filter ends as failed (got ${badAfter.status})`);
  assert(!!badAfter.error, 'and the reason is recorded for the user');

  console.log('\n── cleanup removes artifacts with no live job ──');
  const orphanPath = after.filePath;
  await ExportJob.deleteOne({ _id: after._id });
  await cleanupArtifacts();
  assert(!fs.existsSync(orphanPath), 'the file is deleted once its job record is gone');

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n🎉 BACKGROUND EXPORT JOBS VERIFIED — ${passed} assertions passed\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
