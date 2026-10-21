const fs = require('fs');
const os = require('os');
const path = require('path');
const archiver = require('archiver');
const ExportJob = require('../models/ExportJob');
const fileStore = require('../utils/fileStore');
const Trip = require('../models/Trip');
const LocationPoint = require('../models/LocationPoint');
// Required for their side effect of registering the schema: the populate() calls below reference
// these models by name, and a background worker must not depend on some route or controller
// having been loaded first to make that resolve.
require('../models/User');
require('../models/Vehicle');
const { buildKml, buildSnappedKml, buildJson, baseFilename } = require('../utils/tripExport');
const { decodePolyline6 } = require('./roadSegments');

/**
 * Background worker for bulk trip exports. See models/ExportJob.js for why these do not run
 * inside the request.
 *
 * One job at a time, deliberately. The work is CPU-bound (polyline decode, KML string building,
 * zip deflate) on the same process that serves the API, so running several concurrently would
 * make the whole panel unresponsive rather than making any single export finish sooner.
 *
 * The finished zip is kept in GridFS, not on this container's disk. It used to stay in /tmp and
 * be served from there, which only works when the process that built it is the one that answers
 * the download: a redeploy or restart in between wiped it, and on 21 Oct 2026 a development
 * server on a laptop, pointed at the production database, claimed about half of production's
 * jobs and built them on the laptop — every one of those downloads came back "Export file has
 * been cleaned up". The zip is still assembled in /tmp (archiver writes a stream) and uploaded
 * once complete; any server can then serve it.
 *
 * And a job is built by the server that created it: ORIGIN is stamped on the job at request time
 * and the runner claims only its own, so a stray process sharing the database never takes
 * another deployment's work. A job nobody has claimed for ADOPT_AFTER_MS is open to any runner,
 * so one queued just before a restart is not stranded.
 */

const EXPORT_DIR = path.join(os.tmpdir(), 'jsan-exports');
const EXPORT_BUCKET = 'tripExports';
// Stable for the life of a container; differs between Railway and a laptop sharing its database.
const ORIGIN = os.hostname();
const ADOPT_AFTER_MS = 60_000;
// A stored zip is deleted once its job record has gone (TTL, 24 h) and it is at least this old,
// so the sweep never races an upload that has not recorded its file id yet.
const ORPHAN_MIN_AGE_MS = 10 * 60_000;
const TRIP_CHUNK = 25; // trips per point-fetch — bounds peak memory, see below

let timer = null;
let running = false;

function ensureDir() {
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });
}

/** Points for a batch of trips in one query, grouped by trip id. */
async function pointsForTrips(tripIds) {
  const byTrip = new Map(tripIds.map((id) => [String(id), []]));
  const all = await LocationPoint.find({ tripId: { $in: tripIds } })
    .sort({ tripId: 1, recordedAt: 1 })
    .select('tripId lat lon speedKmh heading recordedAt')
    .lean();
  for (const p of all) {
    const arr = byTrip.get(String(p.tripId));
    if (arr) arr.push(p);
  }
  return byTrip;
}

function snappedPathsFor(trip) {
  if (!trip.cleanedRouteShapes || !trip.cleanedRouteShapes.length) return null;
  return {
    route: trip.cleanedRouteShapes.flatMap((sh) => decodePolyline6(sh)).map((pt) => [pt.lon, pt.lat]),
    // Prefer the GLOBAL verdict (ukmUniqueShapes) over the per-driver one (ukmNewShapes): an export
    // and the dashboard must not disagree about which stretch of a street was new road. Falls back to
    // the per-driver shapes only for trips the global engine has not reached yet.
    ukm: (trip.ukmUniqueShapes?.length ? trip.ukmUniqueShapes : trip.ukmNewShapes || [])
      .map((sh) => decodePolyline6(sh).map((pt) => [pt.lon, pt.lat])),
  };
}

/** Build one job's zip on disk. Never throws — failure is recorded on the job. */
async function runJob(job) {
  ensureDir();
  const wantSnapped = job.layer === 'snapped';
  const fileName = `trips_${wantSnapped ? 'snapped_' : ''}${new Date(job.createdAt).toISOString().slice(0, 10)}_${String(job._id).slice(-6)}.zip`;
  const filePath = path.join(EXPORT_DIR, fileName);
  let stored = null;

  try {
    const trips = await Trip.find(job.filter)
      .sort({ startedAt: -1 })
      .populate('driverId', 'name email')
      .populate('vehicleId', 'plateNumber');

    await ExportJob.updateOne({ _id: job._id }, { $set: { total: trips.length, done: 0 } });

    const output = fs.createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    // Wait on the OUTPUT stream, not the archive: 'close' fires once the bytes are actually on
    // disk. Resolving on the archive's 'end' can hand back a path whose file is still being
    // flushed, which is exactly how a download turns into a truncated zip.
    const finished = new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
    });
    archive.pipe(output);

    let fellBack = 0;
    let done = 0;

    for (let i = 0; i < trips.length; i += TRIP_CHUNK) {
      const batch = trips.slice(i, i + TRIP_CHUNK);
      // Raw points are only needed when a trip is not being exported snapped.
      const needPoints = job.format === 'json' || !wantSnapped
        ? batch
        : batch.filter((t) => !snappedPathsFor(t));
      const byTrip = needPoints.length ? await pointsForTrips(needPoints.map((t) => t._id)) : new Map();

      for (const trip of batch) {
        const name = baseFilename(trip);
        if (job.format === 'json') {
          archive.append(JSON.stringify(buildJson(trip, byTrip.get(String(trip._id)) || []), null, 2), { name: `${name}.json` });
        } else {
          const snapped = wantSnapped ? snappedPathsFor(trip) : null;
          if (snapped) {
            archive.append(buildSnappedKml(trip, snapped.route, snapped.ukm), { name: `${name}_snapped.kml` });
          } else {
            if (wantSnapped) fellBack += 1;
            archive.append(buildKml(trip, byTrip.get(String(trip._id)) || []), { name: `${name}.kml` });
          }
        }
        done += 1;
      }

      // Progress after each chunk rather than each trip: one write per 25 trips is plenty for a
      // progress bar and keeps the job from writing to Mongo hundreds of times.
      await ExportJob.updateOne({ _id: job._id }, { $set: { done, fellBackToRaw: fellBack } });

      // Yield to the event loop so the API stays responsive while a long export runs.
      await new Promise((r) => setImmediate(r));
    }

    await archive.finalize();
    await finished;

    // Into the shared store, then off this disk: the local copy was only ever scaffolding.
    stored = await fileStore.putStream(fs.createReadStream(filePath), {
      filename: fileName,
      bucketName: EXPORT_BUCKET,
      contentType: 'application/zip',
      metadata: { jobId: job._id },
    });
    try { fs.unlinkSync(filePath); } catch { /* the sweep will get it */ }
    await ExportJob.updateOne(
      { _id: job._id },
      { $set: { status: 'ready', fileName, fileId: stored.id, filePath: null, bytes: stored.bytes, done, fellBackToRaw: fellBack, completedAt: new Date() } }
    );
  } catch (err) {
    try { fs.existsSync(filePath) && fs.unlinkSync(filePath); } catch { /* nothing to clean */ }
    if (stored) await fileStore.remove(stored.id, EXPORT_BUCKET);
    await ExportJob.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', error: String(err.message).slice(0, 500), completedAt: new Date() } }
    );
  }
}

/** Delete artifacts whose job record has expired (or vanished via TTL): stored zips and local leftovers. */
async function cleanupArtifacts() {
  const ready = await ExportJob.find({ status: 'ready' }).select('fileName fileId').lean();
  const liveIds = new Set(ready.filter((j) => j.fileId).map((j) => String(j.fileId)));
  const old = await fileStore.list({ uploadDate: { $lt: new Date(Date.now() - ORPHAN_MIN_AGE_MS) } }, EXPORT_BUCKET);
  for (const f of old) {
    if (!liveIds.has(String(f._id))) await fileStore.remove(f._id, EXPORT_BUCKET);
  }

  if (!fs.existsSync(EXPORT_DIR)) return;
  // Jobs from before the shared store still name a file on disk; keep those until they expire.
  const liveNames = new Set(ready.filter((j) => !j.fileId).map((j) => j.fileName));
  for (const f of fs.readdirSync(EXPORT_DIR)) {
    if (liveNames.has(f)) continue;
    try { fs.unlinkSync(path.join(EXPORT_DIR, f)); } catch { /* already gone */ }
  }
}

/** One sweep: claim the oldest queued job and build it. Exported so tests can drive it. */
async function tick() {
  const job = await ExportJob.findOneAndUpdate(
    {
      status: 'queued',
      // Ours, unstamped (queued before the stamp existed), or left unclaimed long enough to adopt.
      $or: [{ origin: ORIGIN }, { origin: null }, { createdAt: { $lt: new Date(Date.now() - ADOPT_AFTER_MS) } }],
    },
    { $set: { status: 'running', startedAt: new Date() } },
    { sort: { createdAt: 1 }, new: true }
  );
  if (!job) return null;
  await runJob(job);
  return String(job._id);
}

function startExportRunner({ everyMs = 3000 } = {}) {
  if (timer) return null;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const id = await tick();
      if (id) {
        // eslint-disable-next-line no-console
        console.log(`export-runner: finished job ${id}`);
        await cleanupArtifacts();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('export-runner tick failed:', err.message);
    } finally {
      running = false;
    }
  }, everyMs);
  // eslint-disable-next-line no-console
  console.log(`   Export runner every ${everyMs / 1000}s -> ${EXPORT_DIR}`);
  return timer;
}

function stopExportRunner() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startExportRunner, stopExportRunner, tick, cleanupArtifacts, EXPORT_DIR, EXPORT_BUCKET, ORIGIN };
