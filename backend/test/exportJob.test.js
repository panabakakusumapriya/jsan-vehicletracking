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
  const { tick, cleanupArtifacts, EXPORT_BUCKET, ORIGIN } = require('../src/services/exportRunner');
  const fileStore = require('../src/utils/fileStore');
  const storedBytes = async (id) => {
    let n = 0;
    for await (const chunk of fileStore.openDownload(id, EXPORT_BUCKET)) n += chunk.length;
    return n;
  };

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
    filter: { status: { $in: ['completed', 'timed_out'] } }, total: 3, origin: ORIGIN,
  });

  const ranId = await tick();
  assert(String(ranId) === String(job._id), 'the runner claimed the queued job');

  const after = await ExportJob.findById(job._id);
  assert(after.status === 'ready', `status is ready (got ${after.status}${after.error ? ': ' + after.error : ''})`);
  assert(after.done === 3, `progress counted every trip (got ${after.done})`);
  assert(after.bytes > 0, `the artifact has real bytes (got ${after.bytes})`);

  console.log('\n── the zip lives in the shared store, not on the disk of the server that built it ──');
  assert(!!after.fileId, 'the job records its stored file');
  assert(!after.filePath, 'and no local path, which another server could not read');
  // The size the job reports must match the stored file, or the download can be served truncated.
  assert((await storedBytes(after.fileId)) === after.bytes, 'recorded byte count matches the stored zip');
  const leftovers = fs.existsSync(require('../src/services/exportRunner').EXPORT_DIR)
    ? fs.readdirSync(require('../src/services/exportRunner').EXPORT_DIR).filter((f) => f === after.fileName)
    : [];
  assert(leftovers.length === 0, 'the scaffolding copy in /tmp is removed once stored');

  console.log('\n── a mixed range still exports every trip, and says so ──');
  assert(after.fellBackToRaw === 1, `the unmatched trip fell back to raw and was counted (got ${after.fellBackToRaw})`);

  console.log('\n── the queue is drained, so a second tick does nothing ──');
  assert((await tick()) === null, 'no job left to claim');

  console.log('\n── a job is built by the server that created it ──');
  const foreign = await ExportJob.create({
    requestedBy: driver._id, format: 'kml', layer: 'raw',
    filter: { status: { $in: ['completed', 'timed_out'] } }, total: 3, origin: 'some-other-host',
  });
  assert((await tick()) === null, 'a fresh job from another server is left for that server');
  const own = await ExportJob.create({
    requestedBy: driver._id, format: 'kml', layer: 'raw',
    filter: { status: { $in: ['completed', 'timed_out'] } }, total: 3, origin: ORIGIN,
  });
  assert(String(await tick()) === String(own._id), 'a job stamped with this server is built here');
  // Straight to the collection: Mongoose treats createdAt as immutable and drops it from updates.
  await ExportJob.collection.updateOne({ _id: foreign._id }, { $set: { createdAt: new Date(Date.now() - 2 * 60_000) } });
  assert(String(await tick()) === String(foreign._id), 'one left unclaimed for over a minute is adopted, not stranded');
  const legacy = await ExportJob.create({
    requestedBy: driver._id, format: 'kml', layer: 'raw',
    filter: { status: { $in: ['completed', 'timed_out'] } }, total: 3,
  });
  assert((await tick()) === null, 'a fresh unstamped job (older server code) is not taken — it is not ours');
  await ExportJob.collection.updateOne({ _id: legacy._id }, { $set: { createdAt: new Date(Date.now() - 2 * 60_000) } });
  assert(String(await tick()) === String(legacy._id), 'but it too is adopted once left for over a minute');

  console.log('\n── a failing job is recorded, not left running forever ──');
  const bad = await ExportJob.create({
    requestedBy: driver._id, format: 'kml', layer: 'raw',
    filter: { startedAt: { $gte: 'not-a-date' } }, total: 1, origin: ORIGIN,
  });
  await tick();
  const badAfter = await ExportJob.findById(bad._id);
  assert(badAfter.status === 'failed', `a broken filter ends as failed (got ${badAfter.status})`);
  assert(!!badAfter.error, 'and the reason is recorded for the user');

  console.log('\n── cleanup removes stored zips with no live job ──');
  const orphanId = after.fileId;
  await ExportJob.deleteOne({ _id: after._id });
  await cleanupArtifacts();
  assert((await fileStore.list({ _id: orphanId }, EXPORT_BUCKET)).length === 1, 'a recent upload is left alone (its job may not have recorded it yet)');
  await mongoose.connection.db.collection(`${EXPORT_BUCKET}.files`).updateOne({ _id: orphanId }, { $set: { uploadDate: new Date(Date.now() - 60 * 60_000) } });
  await cleanupArtifacts();
  assert((await fileStore.list({ _id: orphanId }, EXPORT_BUCKET)).length === 0, 'the stored zip is deleted once its job record is gone');
  const ownAfter = await ExportJob.findById(own._id);
  assert((await fileStore.list({ _id: ownAfter.fileId }, EXPORT_BUCKET)).length === 1, 'a zip whose job is still live is kept');

  console.log('\n── the download is served from the store, by any server ──');
  const request = require('supertest');
  const { createApp } = require('../src/app');
  const app = createApp();
  const admin = new User({ name: 'Exp Admin', email: 'admin@x.com', role: 'admin' });
  await admin.setPassword('pw123456');
  await admin.save();
  const token = (await request(app).post('/api/auth/login').send({ email: 'admin@x.com', password: 'pw123456' })).body.token;
  const auth = (r) => r.set('Authorization', `Bearer ${token}`);
  const created = await auth(request(app).post('/api/trips/export-jobs')).send({ format: 'kml', layer: 'raw' });
  assert(created.status === 202, `the export is queued (got ${created.status})`);
  const httpJob = await ExportJob.findById(created.body.jobId);
  assert(httpJob.origin === ORIGIN, 'the job is stamped with the server that queued it');
  assert(String(await tick()) === String(created.body.jobId), 'and that server builds it');
  const built = await ExportJob.findById(created.body.jobId);
  const binary = (res, cb) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); };
  const dl = await auth(request(app).get(`/api/trips/export-jobs/${built._id}/download`)).buffer(true).parse(binary);
  assert(dl.status === 200, `the download succeeds (got ${dl.status})`);
  assert(/application\/zip/.test(dl.headers['content-type'] || ''), 'served as a zip');
  assert(/attachment; filename="trips_/.test(dl.headers['content-disposition'] || ''), 'with the zip file name');
  assert(dl.body.length === built.bytes && dl.body.slice(0, 2).toString() === 'PK', `the whole zip arrives (got ${dl.body.length} of ${built.bytes} bytes)`);
  await fileStore.remove(built.fileId, EXPORT_BUCKET);
  const gone = await auth(request(app).get(`/api/trips/export-jobs/${built._id}/download`));
  assert(gone.status === 410 && /run it again/.test(gone.body.error || ''), `a zip that has expired says so (got ${gone.status})`);

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n🎉 BACKGROUND EXPORT JOBS VERIFIED — ${passed} assertions passed\n`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
