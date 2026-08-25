const ImportJob = require('../models/ImportJob');
const NetworkVersion = require('../models/NetworkVersion');
// Required for their side effect of registering the schemas the commit path writes through — a
// background worker must not depend on some route having been loaded first to make them resolve.
require('../models/WorkArea');
require('../models/RoadLink');
require('../models/Project');
require('../models/User');

const networkImport = require('./networkImport');

/**
 * Background worker for customer network deliveries.
 *
 * Two distinct pieces of work, both too long for a request: parsing 654,447 features to build the
 * preflight report, and committing them once a human has approved it. They are separate statuses
 * rather than one long job precisely so the approval sits between them — see models/ImportJob.js.
 *
 * One job at a time, like the export runner and for the same reason: this is CPU-bound work on the
 * process that also serves the API, so concurrency would make the panel unresponsive without making
 * any single import finish sooner.
 */

let timer = null;
let running = false;

/** Throttled progress writes — a job document update per 25k features is plenty for a UI. */
function progressWriter(job) {
  let lastWrite = 0;
  return (phase, done, total = 0) => {
    const now = Date.now();
    if (now - lastWrite < 1500) return;
    lastWrite = now;
    ImportJob.updateOne(
      { _id: job._id },
      { $set: { 'progress.phase': phase, 'progress.done': done, 'progress.total': total } }
    ).catch(() => {});
  };
}

/**
 * Write the version and make it the one the panel shows.
 *
 * Activation is automatic rather than a second click. The overwhelmingly common case is "load the
 * customer's files so I can look at them", and an import you cannot see until you have found and
 * pressed 'Make active' is an import that looks broken. Superseding still keeps the previous
 * version and its coverage — nothing is discarded, it simply stops being the default view.
 */
async function finishCommit(job, layers, areas, mapping, report, onProgress) {
  const version = await networkImport.commit(job, layers, areas, mapping, onProgress);

  await NetworkVersion.updateMany(
    { projectId: version.projectId, status: 'active', _id: { $ne: version._id } },
    { $set: { status: 'superseded' } }
  );
  version.status = 'active';
  version.activatedAt = new Date();
  version.activatedBy = job.requestedBy;
  await version.save();

  await ImportJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: 'ready',
        report,
        mapping,
        networkVersionId: version._id,
        completedAt: new Date(),
        'progress.phase': 'loaded',
        error: null,
      },
    }
  );
  return version;
}

/**
 * Parse both layers, then keep going unless there is a reason not to.
 *
 * A clean delivery runs upload -> parse -> commit -> active without anyone pressing anything. A
 * delivery with BLOCKING problems stops at `awaiting_approval` no matter what `autoCommit` says,
 * because those are exactly the imports a human should look at before they become a denominator.
 */
async function runParse(job) {
  const onProgress = progressWriter(job);
  const layers = await networkImport.extractJob(job);
  const { report, areas, mapping } = await networkImport.buildReport(job, layers, onProgress);

  const mustStop = report.errors.length > 0 || !job.autoCommit;
  if (mustStop) {
    await ImportJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'awaiting_approval',
          report,
          mapping,
          'progress.phase': report.errors.length ? 'needs attention' : 'report ready',
          'progress.done': report.totals.links,
          'progress.total': report.totals.links,
          error: null,
        },
      }
    );
    return;
  }

  await ImportJob.updateOne(
    { _id: job._id },
    { $set: { status: 'committing', report, mapping, 'progress.phase': 'loading' } }
  );
  await finishCommit(job, layers, areas, mapping, report, onProgress);
}

/**
 * Commit an approved job.
 *
 * The report is rebuilt rather than trusted from the job document, because the operator may have
 * changed the column mapping or the orphan toggle since it was generated — and the area rollups
 * that become every dashboard's denominator are derived from that mapping. Re-reading costs a
 * minute; committing rollups that disagree with the mapping actually used would be silent and
 * permanent.
 */
async function runCommit(job) {
  const onProgress = progressWriter(job);
  const layers = await networkImport.extractJob(job);
  const { report, areas, mapping } = await networkImport.buildReport(job, layers, onProgress);

  if (report.errors.length) {
    throw new Error(
      `Cannot commit: ${report.errors.length} blocking problem(s) — ${report.errors[0].message}`
    );
  }

  await finishCommit(job, layers, areas, mapping, report, onProgress);
}

/** Claim one job and run whichever phase its status calls for. */
async function tick() {
  const job = await ImportJob.findOneAndUpdate(
    { status: { $in: ['queued', 'committing'] } },
    { $set: { startedAt: new Date() } },
    { sort: { createdAt: 1 }, new: true }
  );
  if (!job) return null;

  const committing = job.status === 'committing';
  if (!committing) {
    await ImportJob.updateOne({ _id: job._id }, { $set: { status: 'parsing' } });
    job.status = 'parsing';
  }

  try {
    if (committing) await runCommit(job);
    else await runParse(job);
  } catch (err) {
    await ImportJob.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', error: err.message, completedAt: new Date() } }
    ).catch(() => {});
    if (job.networkVersionId) {
      await NetworkVersion.updateOne(
        { _id: job.networkVersionId },
        { $set: { status: 'failed' } }
      ).catch(() => {});
    }
    // eslint-disable-next-line no-console
    console.error(`import-runner: job ${job._id} failed:`, err.message);
  }

  return String(job._id);
}

function startImportRunner({ everyMs = 4000 } = {}) {
  if (timer) return null;
  networkImport.ensureDir(networkImport.IMPORT_DIR);
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const id = await tick();
      if (id) {
        // eslint-disable-next-line no-console
        console.log(`import-runner: finished job ${id}`);
        await networkImport.cleanupArtifacts();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('import-runner tick failed:', err.message);
    } finally {
      running = false;
    }
  }, everyMs);
  // eslint-disable-next-line no-console
  console.log(`   Import runner every ${everyMs / 1000}s -> ${networkImport.IMPORT_DIR}`);
  return timer;
}

function stopImportRunner() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startImportRunner, stopImportRunner, tick };
