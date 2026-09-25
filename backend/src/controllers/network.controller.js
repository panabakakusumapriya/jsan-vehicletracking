const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const ImportJob = require('../models/ImportJob');
const NetworkVersion = require('../models/NetworkVersion');
const WorkArea = require('../models/WorkArea');
const RoadLink = require('../models/RoadLink');
const LinkCoverage = require('../models/LinkCoverage');
const Project = require('../models/Project');
const AreaAssignment = require('../models/AreaAssignment');
const AreaCompletion = require('../models/AreaCompletion');
const User = require('../models/User');
const Trip = require('../models/Trip');
const { rebuildNetworkCoverage } = require('../services/linkCoverage');
const { compactLine } = require('../services/driverRoads');
const { sendCompressed } = require('../utils/compressedJson');

const networkImport = require('../services/networkImport');
const { kickImportRunner } = require('../services/importRunner');
const shapefile = require('../utils/shapefile');
const { simplifyGeometry, bboxUnion } = require('../utils/geo');
const fileStore = require('../utils/fileStore');

/**
 * The customer's target network: uploading a delivery, approving it, and reading coverage against
 * it. See services/networkImport.js for the pipeline and models/LinkCoverage.js for why coverage
 * is a fleet-wide ledger rather than a per-driver one.
 */

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

function asObjectId(value) {
  return /^[a-f\d]{24}$/i.test(String(value || '')) ? String(value) : null;
}

/** Projects the caller may act on. Admins see everything; everyone else only their own. */
function projectScope(user) {
  if (user.role === 'admin') return null;
  return (user.projectIds || []).map(String);
}

function assertProjectAccess(user, projectId) {
  const scope = projectScope(user);
  if (scope && !scope.includes(String(projectId))) {
    const err = new Error('You do not have access to that project');
    err.status = 403;
    throw err;
  }
}

/**
 * Resolve what a read is scoped to: one delivery, or a whole project.
 *
 * `:id` may be a NetworkVersion id — one frozen delivery, the old behaviour — or a Project id,
 * which means "everything this project has". The second exists because a project accumulates
 * deliveries and they are not always re-deliveries of the same ground: PRJ-025 holds Victoria
 * (402 areas) and Queensland (330), with no overlapping area code or link id between them.
 * Under version-scoping, activating Queensland made every kilometre of Victoria's work vanish
 * from the map — not deleted, just unreachable without knowing to pick a superseded snapshot.
 *
 * A project's scope is the ACTIVE version plus any superseded one that still holds coverage or a
 * live assignment. Older re-deliveries of the same ground carry neither, so they drop out and
 * their duplicate areas never double-count.
 */
async function resolveNetworkScope(req) {
  const id = asObjectId(req.params.id);
  if (!id) return null;

  const version = await NetworkVersion.findById(id).select('projectId status label counts targetMeters byPriority byFuncClass activatedAt createdAt');
  if (version) {
    return { projectId: version.projectId, versionIds: [version._id], primary: version, isProject: false };
  }

  const project = await Project.findById(id).select('_id name');
  if (!project) return null;

  const all = await NetworkVersion.find({ projectId: project._id }).sort({ createdAt: -1 }).lean();
  if (!all.length) return null;

  const withCoverage = new Set(
    (await LinkCoverage.distinct('networkVersionId', { projectId: project._id })).map(String)
  );
  const withAssignments = new Set(
    (await AreaAssignment.distinct('networkVersionId', { projectId: project._id, releasedAt: null })).map(String)
  );

  const keep = all.filter(
    (v) => v.status === 'active' || withCoverage.has(String(v._id)) || withAssignments.has(String(v._id))
  );
  const chosen = keep.length ? keep : [all[0]];
  const primary = chosen.find((v) => v.status === 'active') || chosen[0];

  return {
    projectId: project._id,
    versionIds: chosen.map((v) => v._id),
    versions: chosen,
    primary,
    isProject: true,
    // Summed so a project-wide read reports one denominator rather than the active delivery's.
    totals: chosen.reduce(
      (acc, v) => ({
        areas: acc.areas + (v.counts?.areas || 0),
        links: acc.links + (v.counts?.links || 0),
        targetMeters: acc.targetMeters + (v.targetMeters || 0),
      }),
      { areas: 0, links: 0, targetMeters: 0 }
    ),
  };
}

/**
 * Add up a precomputed rollup (byPriority / byFuncClass) across every delivery in scope.
 *
 * Each version stores its own bands. A project spanning two states has the same P1 band in both,
 * and reading only the active delivery's copy would report Queensland's P1 as the whole
 * programme's. Version-scoped reads keep the single delivery's array untouched.
 */
function mergeBands(scope, version, field, key) {
  const sources = scope.isProject && scope.versions ? scope.versions : [version];
  const merged = new Map();
  for (const v of sources) {
    for (const raw of v[field] || []) {
      const band = raw.toObject ? raw.toObject() : raw;
      const k = band[key];
      const acc = merged.get(k) || { [key]: k, areas: 0, links: 0, meters: 0, areaSqKm: 0 };
      acc.areas += band.areas || 0;
      acc.links += band.links || 0;
      acc.meters += band.meters || 0;
      acc.areaSqKm += band.areaSqKm || 0;
      merged.set(k, acc);
    }
  }
  return [...merged.values()].sort((a, b) => (a[key] ?? 0) - (b[key] ?? 0));
}

/* ------------------------------------------------------------------ import jobs */

async function listJobs(req, res) {
  const scope = projectScope(req.user);
  const filter = {};
  const projectId = asObjectId(req.query.projectId);
  if (projectId) {
    assertProjectAccess(req.user, projectId);
    filter.projectId = projectId;
  } else if (scope) {
    filter.projectId = { $in: scope };
  }

  const jobs = await ImportJob.find(filter)
    .sort({ createdAt: -1 })
    .limit(30)
    .populate('projectId', 'name code')
    .populate('requestedBy', 'name email')
    // The report is tens of kilobytes of field lists and samples; the list view never shows it.
    .select('-report');

  res.json({ jobs });
}

async function createJob(req, res) {
  const projectId = asObjectId(req.body.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });
  assertProjectAccess(req.user, projectId);

  const project = await Project.findById(projectId).select('name');
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const label = String(req.body.label || '').trim() || `${project.name} network`;
  const job = await ImportJob.create({
    projectId,
    requestedBy: req.user._id,
    label,
    includeOrphanLinks: Boolean(req.body.includeOrphanLinks),
  });

  return res.status(201).json({ job });
}

async function getJob(req, res) {
  const job = await ImportJob.findById(req.params.id)
    .populate('projectId', 'name code')
    .populate('requestedBy', 'name email');
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  assertProjectAccess(req.user, job.projectId?._id || job.projectId);
  return res.json({ job });
}

/**
 * Receive one layer's zip.
 *
 * Streamed straight to disk rather than parsed as multipart. The first delivery is 87 MB of .dbf
 * inside a zip, and every buffering option — express.raw, an in-memory multipart parser — holds
 * the whole thing in the heap of the process that is also serving the API. The client sends the
 * file as the raw request body with the name in a header, which needs no dependency at all.
 */
async function uploadLayer(req, res) {
  const layer = String(req.query.layer || '').toLowerCase();
  if (!['boundary', 'network'].includes(layer)) {
    return res.status(400).json({ error: 'layer must be "boundary" or "network"' });
  }

  const job = await ImportJob.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  assertProjectAccess(req.user, job.projectId);
  if (!['draft', 'awaiting_approval', 'failed'].includes(job.status)) {
    return res.status(409).json({ error: `Cannot replace files while the job is "${job.status}"` });
  }

  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: `Archive is larger than ${MAX_UPLOAD_BYTES / 1e6} MB` });
  }

  const name = String(req.headers['x-file-name'] || req.query.name || `${layer}.zip`);

  /**
   * Straight into GridFS, not onto local disk.
   *
   * The container's filesystem does not survive a redeploy or a restart, and a second replica does
   * not see the first one's /tmp. Writing only to disk meant an upload could complete and then be
   * gone before the import runner reached it — after the operator had already spent minutes
   * pushing the file up. The database copy is the one that lasts.
   */
  let stored;
  try {
    stored = await fileStore.putStream(req, {
      filename: name,
      metadata: { jobId: String(job._id), layer, projectId: String(job.projectId) },
    });
  } catch (err) {
    return res.status(400).json({ error: `Upload failed: ${err.message}` });
  }

  if (!stored.bytes) {
    await fileStore.remove(stored.id);
    return res.status(400).json({ error: 'Uploaded archive was empty' });
  }

  // Seed the on-disk cache too, so the very next step does not have to stream it back down.
  networkImport.ensureDir(networkImport.IMPORT_DIR);
  const dest = path.join(networkImport.IMPORT_DIR, `${job._id}-${layer}.zip`);
  try {
    await fileStore.downloadTo(stored.id, dest);
  } catch {
    // Cache miss is survivable — extractLayer re-materialises from GridFS on demand.
  }

  // Replacing a layer: drop the previous stored copy so re-uploads do not accumulate.
  const previousId = job.files?.[layer]?.fileId;
  if (previousId && String(previousId) !== String(stored.id)) {
    await fileStore.remove(previousId);
  }

  job.files[layer] = {
    name,
    bytes: stored.bytes,
    // `path` is deliberately NOT persisted. It is only ever valid on the machine that wrote it,
    // and storing it caused a Linux container's `/tmp/...` to be reopened on Windows as
    // `C:	mp\...`. The cache location is recomputed locally wherever the import actually runs —
    // see networkImport.extractLayer.
    path: null,
    fileId: stored.id,
    sha256: stored.sha256,
    uploadedAt: new Date(),
  };
  // A new file invalidates whatever the previous report said.
  job.report = null;
  job.error = null;

  /**
   * EITHER archive is enough to start.
   *
   *  - work areas only  -> a new version with the polygons; roads can follow later
   *  - roads only       -> added in place to the project's ACTIVE version, whose areas already
   *                        exist (see resolveRoadsOnlyTarget). This is the normal second step:
   *                        the customer sends boundaries first and the network afterwards.
   *  - both             -> a complete new version
   *
   * Requiring the boundary unconditionally meant a roads-only upload sat in `draft` forever telling
   * the operator to re-upload polygons that were already in the database.
   */
  const ready = Boolean(job.files.boundary?.name || job.files.network?.name);
  job.status = ready ? 'queued' : 'draft';
  if (ready) job.progress = { phase: 'queued', done: 0, total: 0 };
  await job.save();

  // Start immediately rather than waiting out a poll interval. The operator has just watched a
  // 33 MB upload finish; a job that then sits visibly idle reads as broken.
  if (ready) kickImportRunner();

  return res.json({ job });
}

/** Column mapping and the orphan-link toggle, editable right up until commit. */
async function updateJob(req, res) {
  const job = await ImportJob.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  assertProjectAccess(req.user, job.projectId);
  if (['parsing', 'committing', 'ready'].includes(job.status)) {
    return res.status(409).json({ error: `Cannot edit a job that is "${job.status}"` });
  }

  if (req.body.label) job.label = String(req.body.label).trim();
  if (typeof req.body.includeOrphanLinks === 'boolean') {
    job.includeOrphanLinks = req.body.includeOrphanLinks;
  }
  if (req.body.mapping && typeof req.body.mapping === 'object') {
    for (const [key, value] of Object.entries(req.body.mapping)) {
      if (key in job.mapping) job.mapping[key] = value ? String(value) : null;
    }
  }
  await job.save();
  return res.json({ job });
}

/** Queue the preflight. Writes nothing to the live collections — see models/ImportJob.js. */
async function validateJob(req, res) {
  const job = await ImportJob.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  assertProjectAccess(req.user, job.projectId);
  // `path` is only a cache hint and may be null after a redeploy — presence is defined by the
  // durable copy, not by whether this container happens to still have it on disk.
  if (!job.files?.boundary?.name && !job.files?.network?.name) {
    return res.status(400).json({ error: 'Upload at least one archive first' });
  }
  if (['parsing', 'committing'].includes(job.status)) {
    return res.status(409).json({ error: 'That job is already running' });
  }

  job.status = 'queued';
  job.error = null;
  job.progress = { phase: 'queued', done: 0, total: 0 };
  await job.save();
  return res.json({ job });
}

/** Approve the report and write the version. Refuses while blocking errors stand. */
async function commitJob(req, res) {
  const job = await ImportJob.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  assertProjectAccess(req.user, job.projectId);
  if (job.status !== 'awaiting_approval') {
    return res.status(409).json({ error: `Job must be awaiting approval, not "${job.status}"` });
  }
  const blocking = job.report?.errors || [];
  if (blocking.length) {
    return res.status(400).json({
      error: `Fix ${blocking.length} blocking problem(s) first: ${blocking[0].message}`,
    });
  }

  job.status = 'committing';
  job.error = null;
  job.progress = { phase: 'queued', done: 0, total: 0 };
  await job.save();
  return res.json({ job });
}

async function deleteJob(req, res) {
  const job = await ImportJob.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  assertProjectAccess(req.user, job.projectId);
  if (['parsing', 'committing'].includes(job.status)) {
    return res.status(409).json({ error: 'Cannot delete a job while it is running' });
  }

  // Explicit user-initiated delete — the only place stored originals are removed. The artifact
  // sweep never touches them.
  for (const layer of ['boundary', 'network']) {
    // Derived locally for the same reason extractLayer derives it — a stored path may belong to
    // another machine entirely.
    fs.rmSync(path.join(networkImport.IMPORT_DIR, `${job._id}-${layer}.zip`), { force: true });
    await fileStore.remove(job.files?.[layer]?.fileId);
  }
  fs.rmSync(networkImport.jobDir(job._id), { recursive: true, force: true });
  await job.deleteOne();
  return res.json({ ok: true });
}

/* ------------------------------------------------------------------ versions */

async function listVersions(req, res) {
  const scope = projectScope(req.user);
  const filter = {};
  const projectId = asObjectId(req.query.projectId);
  if (projectId) {
    assertProjectAccess(req.user, projectId);
    filter.projectId = projectId;
  } else if (scope) {
    filter.projectId = { $in: scope };
  }

  const versions = await NetworkVersion.find(filter)
    .sort({ createdAt: -1 })
    .populate('projectId', 'name code')
    .populate('createdBy', 'name')
    .populate('activatedBy', 'name');

  res.json({ versions });
}

/**
 * One version's headline numbers: the target from the version document, the covered side from a
 * single aggregation over the ledger.
 *
 * Two queries total, whatever the size of the network. The rollups were precomputed at import and
 * the coverage side groups on an index that already holds lengthMeters, so neither has to touch
 * the 654k links.
 */
async function versionSummary(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = await NetworkVersion.findById(scope.primary._id).populate('projectId', 'name code');

  const rows = await LinkCoverage.aggregate([
    { $match: { networkVersionId: { $in: scope.versionIds } } },
    {
      $group: {
        _id: { priority: '$priority', funcClass: '$funcClass' },
        meters: { $sum: '$lengthMeters' },
        links: { $sum: 1 },
      },
    },
  ]);

  const coveredByPriority = new Map();
  const coveredByFuncClass = new Map();
  let coveredMeters = 0;
  let coveredLinks = 0;

  for (const row of rows) {
    coveredMeters += row.meters;
    coveredLinks += row.links;
    const p = coveredByPriority.get(row._id.priority) || { meters: 0, links: 0 };
    p.meters += row.meters;
    p.links += row.links;
    coveredByPriority.set(row._id.priority, p);
    const f = coveredByFuncClass.get(row._id.funcClass) || { meters: 0, links: 0 };
    f.meters += row.meters;
    f.links += row.links;
    coveredByFuncClass.set(row._id.funcClass, f);
  }

  const projectId = version.projectId?._id || version.projectId;
  const cycleId = await cycleIdFor(projectId);
  const [completedAreas, assignedAreaCodes] = await Promise.all([
    AreaCompletion.countDocuments({
      projectId,
      coverageCycleId: cycleId,
      status: 'completed',
    }),
    // By areaCode, so an area held through an older version's row still counts as assigned.
    AreaAssignment.distinct('areaCode', { projectId, releasedAt: null }),
  ]);

  return res.json({
    version,
    coverage: {
      coveredMeters,
      coveredLinks,
      // Project-wide reads sum every delivery in scope, so the denominator is the whole programme
      // rather than whichever delivery happens to be active.
      targetMeters: scope.totals ? scope.totals.targetMeters : version.targetMeters,
      targetLinks: scope.totals ? scope.totals.links : version.counts.links,
      // Headline counters for the map's stat strip: how many areas are signed off, and how many
      // are currently in somebody's hands.
      completedAreas,
      assignedAreas: assignedAreaCodes.length,
      totalAreas: scope.totals ? scope.totals.areas : version.counts.areas,
      byPriority: mergeBands(scope, version, 'byPriority', 'priority').map((band) => ({
        ...(band.toObject ? band.toObject() : band),
        coveredMeters: coveredByPriority.get(band.priority)?.meters || 0,
        coveredLinks: coveredByPriority.get(band.priority)?.links || 0,
      })),
      byFuncClass: mergeBands(scope, version, 'byFuncClass', 'funcClass').map((row) => ({
        ...(row.toObject ? row.toObject() : row),
        coveredMeters: coveredByFuncClass.get(row.funcClass)?.meters || 0,
        coveredLinks: coveredByFuncClass.get(row.funcClass)?.links || 0,
      })),
    },
  });
}

/**
 * The areas table: every work area with its target and how much of it is done.
 *
 * One find for the areas plus one aggregation for coverage, joined in memory — not a lookup per
 * area, which at 402 areas would be 402 round trips for a single page render.
 */
async function versionAreas(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const filter = { networkVersionId: { $in: scope.versionIds } };
  if (req.query.priority !== undefined && req.query.priority !== '') {
    filter.priority = Number(req.query.priority);
  }
  if (req.query.q) {
    filter.name = { $regex: String(req.query.q).trim(), $options: 'i' };
  }

  const [areas, covered] = await Promise.all([
    WorkArea.find(filter)
      .select('areaCode name parentName priority areaSqm targetMeters targetLinks bbox')
      .sort({ priority: 1, targetMeters: -1 })
      // A project spanning two states has more areas than one delivery does.
      .limit(scope.isProject ? 3000 : 1000),
    LinkCoverage.aggregate([
      { $match: { networkVersionId: { $in: scope.versionIds } } },
      { $group: { _id: '$areaId', meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
    ]),
  ]);

  const byArea = new Map(covered.map((row) => [String(row._id), row]));

  const cycleId = await cycleIdFor(scope.projectId);
  const completions = await completionsByCode(
    version.projectId,
    cycleId,
    areas.map((a) => a.areaCode)
  );

  return res.json({
    areas: areas.map((a) => {
      const hit = byArea.get(String(a._id));
      const done = completions.get(a.areaCode);
      return {
        _id: a._id,
        areaCode: a.areaCode,
        name: a.name,
        parentName: a.parentName,
        priority: a.priority,
        areaSqKm: a.areaSqm ? a.areaSqm / 1e6 : null,
        targetMeters: a.targetMeters,
        targetLinks: a.targetLinks,
        coveredMeters: hit?.meters || 0,
        coveredLinks: hit?.links || 0,
        bbox: a.bbox,
        completed: !!done,
        completedAt: done ? done.completedAt : null,
        completedByName: done ? done.completedByName : null,
      };
    }),
  });
}

/**
 * Make this version the one attribution writes against.
 *
 * Superseding rather than deleting the previous one: numbers already reported to the customer
 * have to stay reproducible, and its coverage ledger is what reproduces them.
 */
async function activateVersion(req, res) {
  const version = await NetworkVersion.findById(req.params.id);
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);
  if (!['ready', 'superseded'].includes(version.status)) {
    return res.status(409).json({ error: `Version is "${version.status}" and cannot be activated` });
  }

  await NetworkVersion.updateMany(
    { projectId: version.projectId, status: 'active', _id: { $ne: version._id } },
    { $set: { status: 'superseded' } }
  );
  version.status = 'active';
  version.activatedAt = new Date();
  version.activatedBy = req.user._id;
  await version.save();

  // Every closed trip on the project was measured against the OLD network, or against none. Their
  // link figures go back to "not established" — a stale number that looks fresh is worse than a
  // pending one — and the new version's ledger is rebuilt in the background right here, not left
  // to the map-match worker (which does not run at all when Valhalla is disabled). The cleared
  // stamp also hands them to that worker's catch-up sweep as a second net if the rebuild dies.
  // Legacy trips with no projectId are the one set this cannot reach; backfill:link-coverage does.
  await Trip.updateMany(
    { projectId: version.projectId, status: { $in: ['completed', 'timed_out'] } },
    [
      {
        $set: {
          linkCoverageStatus: 'pending',
          linkCoverageComputedAt: null,
          assignedNetworkVersionId: null,
          inAreaMeters: null,
          outAreaMeters: null,
          linkUkmMeters: null,
          linkUkmNetworkMeters: null,
          linkCoveredCount: null,
          // The driver-facing figure follows the basis: an assigned driver's number is now
          // unknown; an unassigned driver's global figure is unaffected by a network change.
          effectiveUkmMeters: {
            $cond: [{ $eq: ['$ukmBasis', 'assigned'] }, null, { $ifNull: ['$globalUniqueMeters', null] }],
          },
        },
      },
      { $unset: ['outAreaShapes', 'linkUkmShapes'] },
    ]
  );

  setImmediate(() => {
    rebuildNetworkCoverage(version._id)
      .then((s) => console.log(`network: coverage rebuilt for version ${version._id}: ${s.attributed} trip(s), ${s.coveredLinks} link(s)`))
      .catch((err) => console.error(`network: coverage rebuild for version ${version._id} failed:`, err.message));
  });

  return res.json({ version });
}

async function deleteVersion(req, res) {
  const version = await NetworkVersion.findById(req.params.id);
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);
  if (version.status === 'active') {
    return res.status(409).json({ error: 'Activate another version before deleting this one' });
  }

  const coveredLinks = await LinkCoverage.countDocuments({ networkVersionId: version._id });
  if (coveredLinks && String(req.query.force) !== 'true') {
    return res.status(409).json({
      error: `This version has ${coveredLinks.toLocaleString()} covered link(s) of recorded progress. Re-send with force=true to delete it and that history.`,
    });
  }

  await Promise.all([
    RoadLink.deleteMany({ networkVersionId: version._id }),
    WorkArea.deleteMany({ networkVersionId: version._id }),
    LinkCoverage.deleteMany({ networkVersionId: version._id }),
  ]);
  await version.deleteOne();
  return res.json({ ok: true });
}

/**
 * Road links inside a bounding box, for the map overlay.
 *
 * Hard-capped and viewport-scoped on purpose: 654,447 links is not something a browser or a phone
 * can be handed. `covered` marks each link so the overlay can colour done against outstanding.
 */
async function versionLinks(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const bbox = String(req.query.bbox || '')
    .split(',')
    .map(Number);
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bbox=west,south,east,north is required' });
  }

  const limit = Math.min(Number(req.query.limit) || 4000, 10000);
  const filter = {
    networkVersionId: { $in: scope.versionIds },
    geometry: {
      $geoIntersects: {
        $geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [bbox[0], bbox[1]],
              [bbox[2], bbox[1]],
              [bbox[2], bbox[3]],
              [bbox[0], bbox[3]],
              [bbox[0], bbox[1]],
            ],
          ],
        },
      },
    },
  };
  if (req.query.maxFuncClass) filter.funcClass = { $lte: Number(req.query.maxFuncClass) };
  if (asObjectId(req.query.areaId)) filter.areaId = req.query.areaId;

  const links = await RoadLink.find(filter)
    .select('linkId name funcClass dirTravel geometry lengthMeters areaCode')
    .limit(limit + 1);

  const truncated = links.length > limit;
  const page = truncated ? links.slice(0, limit) : links;

  const coveredIds = new Set(
    (
      await LinkCoverage.find({
        networkVersionId: { $in: scope.versionIds },
        linkId: { $in: page.map((l) => l.linkId) },
      }).select('linkId')
    ).map((c) => c.linkId)
  );

  return res.json({
    // Never a silent cap: the client shows that it is looking at part of the picture.
    truncated,
    limit,
    links: page.map((l) => ({
      linkId: l.linkId,
      name: l.name,
      funcClass: l.funcClass,
      dirTravel: l.dirTravel,
      lengthMeters: l.lengthMeters,
      areaCode: l.areaCode,
      coordinates: l.geometry.coordinates,
      covered: coveredIds.has(l.linkId),
    })),
  });
}

/**
 * Give areas imported before `outline` existed one, computed from the geometry already stored.
 *
 * Without this those areas fall back to being drawn as their bounding box, which renders as a grid
 * of rectangles instead of the customer's actual boundaries — correct in the sense that it is
 * honest about not having the real shape, and useless to look at.
 *
 * Self-healing rather than a migration script because the alternative is asking someone to
 * re-import 654,447 road links to fix 402 polygons whose geometry is already correct in the
 * database. It costs one extra query the first time a version is opened and nothing afterwards.
 * Mutates the passed documents in place so this request serves the real shapes too.
 */
async function backfillOutlines(areas) {
  const missing = areas.filter((a) => !a.outline || !a.outline.coordinates);
  if (!missing.length) return 0;

  // .lean() — this is the one place full geometry is loaded (7.4 MB for the first delivery), and
  // it is only ever read, never saved back through a document.
  const full = await WorkArea.find({ _id: { $in: missing.map((a) => a._id) } })
    .select('geometry')
    .lean();
  const geometryById = new Map(full.map((d) => [String(d._id), d.geometry]));

  const ops = [];
  for (const area of missing) {
    const geometry = geometryById.get(String(area._id));
    if (!geometry || !geometry.coordinates) continue;
    const outline = simplifyGeometry(geometry, networkImport.OUTLINE_TOLERANCE_M);
    if (!outline) continue;
    area.outline = outline;
    ops.push({ updateOne: { filter: { _id: area._id }, update: { $set: { outline } } } });
  }

  if (ops.length) {
    // Fire and forget: the response does not depend on the write landing, and a failure here
    // should degrade to "recompute next time", not to a failed map load.
    WorkArea.bulkWrite(ops, { ordered: false }).catch(() => {});
  }
  return ops.length;
}

/**
 * Work areas as GeoJSON for the map, each carrying its own coverage so the choropleth needs no
 * second request.
 *
 * Serves `outline` — the 25 m-simplified copy written at import — never the full geometry. Full
 * geometry is 7.4 MB for the first delivery and the difference is invisible at any zoom where all
 * 402 areas are on screen. Two queries regardless of how many areas there are.
 */
async function versionAreasGeoJson(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const [areas, covered] = await Promise.all([
    WorkArea.find({ networkVersionId: { $in: scope.versionIds } }).select(
      'areaCode name parentName priority areaSqm targetMeters targetLinks outline bbox'
    ),
    LinkCoverage.aggregate([
      { $match: { networkVersionId: { $in: scope.versionIds } } },
      { $group: { _id: '$areaId', meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
    ]),
  ]);

  await backfillOutlines(areas);

  const byArea = new Map(covered.map((row) => [String(row._id), row]));
  const cycleId = await cycleIdFor(version.projectId);
  const completions = await completionsByCode(
    version.projectId,
    cycleId,
    areas.map((a) => a.areaCode)
  );

  /**
   * Who holds each area, shipped WITH the polygon rather than fetched separately.
   *
   * The map used to learn this from its own call to /assignments, so the two could disagree about
   * the same polygon: click it and the panel (a live read) said "Assigned to Ali Azhar" while
   * hovering it said "Unassigned", because the hover was reading a list fetched when the page
   * loaded. Anything that changed assignments outside the panel — a bulk allocation, another
   * operator — left the map quietly wrong until someone reloaded. One fetch, one answer.
   */
  const liveHolders = await AreaAssignment.find({
    projectId: version.projectId,
    releasedAt: null,
  })
    .select('areaCode driverName driverId')
    .populate('driverId', 'name')
    .lean();
  const holdersByCode = new Map();
  for (const row of liveHolders) {
    if (!row.areaCode) continue;
    const name = row.driverId?.name || row.driverName || 'Unknown driver';
    if (!holdersByCode.has(row.areaCode)) holdersByCode.set(row.areaCode, []);
    if (!holdersByCode.get(row.areaCode).includes(name)) holdersByCode.get(row.areaCode).push(name);
  }
  let bounds = null;
  let approximated = 0;

  const features = areas.map((a) => {
    const hit = byArea.get(String(a._id));
    const coveredMeters = hit?.meters || 0;
    const done = completions.get(a.areaCode);
    bounds = bboxUnion(bounds, a.bbox && a.bbox.length === 4 ? a.bbox : null);

    // An area imported before `outline` existed would otherwise force us to load its full
    // geometry here and blow the payload up. Fall back to its bounding box and say so, rather
    // than quietly shipping 7 MB or quietly drawing nothing.
    let geometry = a.outline && a.outline.coordinates ? a.outline : null;
    if (!geometry && a.bbox && a.bbox.length === 4) {
      const [w, s, e, n] = a.bbox;
      geometry = {
        type: 'Polygon',
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      };
      approximated++;
    }

    return {
      type: 'Feature',
      id: String(a._id),
      geometry,
      properties: {
        areaId: String(a._id),
        areaCode: a.areaCode,
        name: a.name,
        parentName: a.parentName,
        priority: a.priority,
        areaSqKm: a.areaSqm ? a.areaSqm / 1e6 : null,
        targetMeters: a.targetMeters,
        targetLinks: a.targetLinks,
        coveredMeters,
        coveredLinks: hit?.links || 0,
        pct: a.targetMeters > 0 ? (coveredMeters / a.targetMeters) * 100 : 0,
        // Carried into the choropleth so a signed-off area reads as finished at a glance, however
        // its percentage happens to look — the two are deliberately independent.
        completed: !!done,
        completedAt: done ? done.completedAt : null,
        completedByName: done ? done.completedByName : null,
        // [] rather than null: the map tests length, and "nobody" is a real answer.
        assignedTo: holdersByCode.get(a.areaCode) || [],
        // Carried so the client can frame a single area without recomputing an extent from its
        // geometry. The work areas are six widely separated clusters across 295 x 263 km, so the
        // whole-extent view is mostly empty space and jumping to one area is the normal action.
        bbox: a.bbox && a.bbox.length === 4 ? a.bbox : null,
      },
    };
  });

  return res.json({
    type: 'FeatureCollection',
    bbox: bounds,
    // Surfaced rather than hidden: a bbox rectangle is not the real boundary, and the map says so.
    approximated,
    features: features.filter((f) => f.geometry),
  });
}

/**
 * Work areas from an import that has NOT been committed yet, straight off the extracted shapefile.
 *
 * The point of a preflight is to catch a wrong delivery before it becomes the denominator, and
 * "are these the right areas, in the right place" is a question no table of counts can answer —
 * only a map can. Nothing here touches the live collections.
 */
async function importPreviewGeoJson(req, res) {
  const job = await ImportJob.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Import job not found' });
  assertProjectAccess(req.user, job.projectId);
  // `name`, not `path`: path is the ephemeral local cache and is never persisted.
  if (!job.files?.boundary?.name) {
    return res.status(400).json({ error: 'Upload the work-area archive first' });
  }

  let layer;
  try {
    layer = await networkImport.extractLayer(job, 'boundary', { reuse: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const info = shapefile.inspect(layer.chosen);
  const mapping = {
    ...networkImport.sniffBoundaryMapping(info.fields),
    ...Object.fromEntries(Object.entries(job.mapping || {}).filter(([, v]) => v)),
  };

  const features = [];
  let bounds = null;
  shapefile.forEachFeature(layer.chosen, (attrs, parts) => {
    const geometry = networkImport.polygonToGeoJson(parts);
    if (!geometry) return;
    const outer =
      geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const [x, y] of outer) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    bounds = bboxUnion(bounds, [w, s, e, n]);

    features.push({
      type: 'Feature',
      geometry: simplifyGeometry(geometry, networkImport.OUTLINE_TOLERANCE_M),
      properties: {
        areaCode: mapping.areaCode ? String(attrs[mapping.areaCode] ?? '') : '',
        name: mapping.areaName ? String(attrs[mapping.areaName] ?? '') : '',
        parentName: mapping.areaParent ? String(attrs[mapping.areaParent] ?? '') : null,
        priority: mapping.priority ? Number(attrs[mapping.priority] ?? 0) || 0 : 0,
      },
    });
  });

  return res.json({ type: 'FeatureCollection', bbox: bounds, approximated: 0, features });
}

/* ------------------------------------------------------------------ area assignment */

/** Every live area -> driver assignment on a version, for the table and the map colouring. */
async function listAssignments(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  /**
   * Resolved by areaCode, matching what the DRIVER endpoints do.
   *
   * Filtering on networkVersionId alone showed only assignments made against THIS version, while
   * `my-areas` resolves by the customer's stable areaCode. The two disagreed: a driver saw
   * Whittlesea on their phone while the panel showed it unassigned — so a manager would think the
   * area was free and hand it to someone else. Whatever the driver sees, the panel must show.
   */
  const areas = await WorkArea.find({ networkVersionId: { $in: scope.versionIds } })
    .select('_id areaCode')
    .lean();
  const areaIdByCode = new Map(areas.map((a) => [a.areaCode, a._id]));

  const rows = await AreaAssignment.find({
    projectId: version.projectId,
    releasedAt: null,
    $or: [
      { areaCode: { $in: [...areaIdByCode.keys()] } },
      { areaId: { $in: areas.map((a) => a._id) } },
    ],
  })
    .populate('driverId', 'name email driverStatus')
    .populate('assignedBy', 'name')
    .sort({ assignedAt: -1 })
    .lean();

  /**
   * Re-point each row at THIS version's WorkArea _id and drop duplicates.
   *
   * The client keys everything by areaId, and a row recorded against an older version carries that
   * version's id — which matches nothing on screen. Re-importing repeatedly also leaves the same
   * (area, driver) pair recorded once per version; the unique index cannot catch that, because the
   * areaIds genuinely differ. Newest wins, since the sort is descending.
   */
  const seen = new Set();
  const assignments = [];
  for (const row of rows) {
    const areaId = areaIdByCode.get(row.areaCode) || row.areaId;
    if (!areaId) continue;
    const driverId = row.driverId?._id || row.driverId;
    const key = `${areaId}:${driverId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assignments.push({ ...row, areaId });
  }

  return res.json({ assignments });
}

/**
 * Set exactly which drivers hold an area.
 *
 * A set operation rather than add/remove calls: the UI is a multi-select, so "these are the drivers
 * now" is the thing the operator actually expresses. Drivers dropped from the list are RELEASED —
 * `releasedAt` is stamped and the row is kept — rather than deleted, so who was responsible for an
 * area last month survives this month's reshuffle.
 */
/**
 * Why an area may not take this assignment.
 *
 * Two rules, and the second is narrower than it first looks:
 *
 *  - **completed** — a manager has signed the area off in this cycle. Handing it to anyone else
 *    is re-doing paid work.
 *  - **multiple_drivers** — the save would leave TWO drivers holding one polygon at once. One
 *    polygon belongs to one driver, full stop. It tests the RESULT, not the current state,
 *    precisely so a HANDOVER still works: replacing driver A with driver B ends with one holder
 *    and is allowed — which is what happens when a driver stops driving or leaves the company.
 *    Two at once is the wasteful case, since first-cover-wins means the second crew earns nothing
 *    for streets the first already drove.
 *
 * Only `completed` can be overridden, and only by an admin or manager, because an area signed off
 * in error must not become a dead end. The single-driver rule has no override: it is an
 * invariant, not a preference.
 */
function blockerFor(area, completion, resultingDriverNames) {
  const base = { areaId: String(area._id), areaCode: area.areaCode, name: area.name };
  if (completion) {
    return {
      ...base,
      reason: 'completed',
      completedAt: completion.completedAt,
      completedByName: completion.completedByName || null,
      message: `${area.name} was marked completed${
        completion.completedByName ? ` by ${completion.completedByName}` : ''
      }`,
    };
  }
  if (resultingDriverNames.length > 1) {
    return {
      ...base,
      reason: 'multiple_drivers',
      drivers: resultingDriverNames,
      message: `${area.name} would be held by ${resultingDriverNames.length} drivers at once (${resultingDriverNames.join(', ')})`,
    };
  }
  return null;
}

/** May this caller force past a blocker? Team leads assign; only admins and managers override. */
function mayOverride(user) {
  return user.role === 'admin' || user.role === 'manager';
}

/** An override clears a completion, never the one-driver-per-area invariant. */
function clearableByOverride(blocker) {
  return blocker.reason === 'completed';
}

function respondBlocked(res, blockers, user) {
  const overridable = blockers.every(clearableByOverride) && mayOverride(user);
  return res.status(409).json({
    error:
      blockers.length === 1
        ? blockers[0].message
        : `${blockers.length} areas cannot be assigned as requested`,
    blockers,
    canOverride: overridable,
    hint: overridable
      ? 'Send override:true to assign anyway — the reason is recorded on the assignment.'
      : blockers.some((b) => b.reason === 'multiple_drivers')
        ? 'A work area belongs to one driver. Release the current holder first, then assign the new one.'
        : 'Ask an admin or manager to override this.',
  });
}

async function setAreaAssignments(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const area = await WorkArea.findOne({
    _id: asObjectId(req.params.areaId) || null,
    networkVersionId: { $in: scope.versionIds },
  }).select('name areaCode networkVersionId');
  if (!area) return res.status(404).json({ error: 'Work area not found in this version' });

  const wanted = Array.isArray(req.body.driverIds)
    ? [...new Set(req.body.driverIds.map(asObjectId).filter(Boolean))]
    : [];

  const drivers = wanted.length
    ? await User.find({ _id: { $in: wanted }, role: 'user' }).select('name')
    : [];
  if (drivers.length !== wanted.length) {
    return res.status(400).json({ error: 'One or more of those drivers do not exist' });
  }

  const current = await AreaAssignment.find({ areaId: area._id, releasedAt: null });
  const currentIds = new Set(current.map((row) => String(row.driverId)));
  const wantedIds = new Set(wanted);

  const toRelease = current.filter((row) => !wantedIds.has(String(row.driverId)));
  const toAdd = drivers.filter((driver) => !currentIds.has(String(driver._id)));

  // Only a NEW holder can be blocked. Releasing drivers, or re-saving the same set, always goes
  // through — a manager must never be trapped unable to take an area off someone.
  const override = req.body && req.body.override === true && mayOverride(req.user);
  if (toAdd.length) {
    const cycleId = await cycleIdFor(version.projectId);
    const completions = await completionsByCode(version.projectId, cycleId, [area.areaCode]);
    const blocker = blockerFor(
      area,
      completions.get(area.areaCode),
      drivers.map((d) => d.name)
    );
    // The override clears a completion; it can never clear the one-driver-per-area invariant.
    if (blocker && !(override && clearableByOverride(blocker))) {
      return respondBlocked(res, [blocker], req.user);
    }
  }

  if (toRelease.length) {
    await AreaAssignment.updateMany(
      { _id: { $in: toRelease.map((row) => row._id) } },
      { $set: { releasedAt: new Date(), releasedBy: req.user._id } }
    );
  }

  if (toAdd.length) {
    await AreaAssignment.insertMany(
      toAdd.map((driver) => ({
        projectId: scope.projectId,
        // The delivery this AREA came from — a filter would be meaningless on a write, and the
        // project's active delivery may not be the one that owns this polygon.
        networkVersionId: area.networkVersionId,
        areaId: area._id,
        driverId: driver._id,
        areaName: area.name,
        areaCode: area.areaCode,
        driverName: driver.name,
        assignedBy: req.user._id,
        assignedAt: new Date(),
        note: req.body.note ? String(req.body.note).trim() : null,
      })),
      { ordered: false }
    );
  }

  const rows = await AreaAssignment.find({ areaId: area._id, releasedAt: null }).populate(
    'driverId',
    'name email'
  );
  return res.json({ assignments: rows, added: toAdd.length, released: toRelease.length });
}

/**
 * Assign or release drivers across MANY areas at once — what the map's lasso actually needs.
 *
 * Territory is carved geographically ("these six suburbs are Dan's"), so the natural gesture
 * selects a handful of polygons and assigns them together. Doing that through the single-area
 * endpoint would be one HTTP round trip per polygon; this is four queries regardless of how many
 * areas are selected.
 *
 * modes:
 *   set    — these drivers, and only these, hold every selected area
 *   add    — add these drivers, leaving anyone already there
 *   remove — release these drivers from the selected areas
 */
async function bulkAssign(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const mode = ['set', 'add', 'remove'].includes(req.body.mode) ? req.body.mode : 'set';
  const areaIds = [...new Set((req.body.areaIds || []).map(asObjectId).filter(Boolean))];
  const driverIds = [...new Set((req.body.driverIds || []).map(asObjectId).filter(Boolean))];
  if (!areaIds.length) return res.status(400).json({ error: 'areaIds is required' });

  const areas = await WorkArea.find({
    _id: { $in: areaIds },
    networkVersionId: { $in: scope.versionIds },
  }).select('name areaCode networkVersionId');
  if (areas.length !== areaIds.length) {
    return res.status(400).json({ error: 'One or more areas do not belong to this network version' });
  }

  /**
   * Drivers must be ON THIS PROJECT. Checking only `role: 'user'` would happily place another
   * customer's crew onto these areas — the assignment would look fine in the UI and be wrong in
   * the field.
   */
  const drivers = driverIds.length
    ? await User.find({
        _id: { $in: driverIds },
        role: 'user',
        projectIds: version.projectId,
      }).select('name')
    : [];
  if (drivers.length !== driverIds.length) {
    return res.status(400).json({
      error: 'One or more of those drivers are not on this project',
    });
  }
  if (mode !== 'set' && !drivers.length) {
    return res.status(400).json({ error: 'driverIds is required for add/remove' });
  }

  const areaById = new Map(areas.map((a) => [String(a._id), a]));
  const wanted = new Set(driverIds);
  const current = await AreaAssignment.find({
    areaId: { $in: areaIds },
    releasedAt: null,
  }).select('areaId driverId driverName');

  const held = new Map(); // areaId -> Set(driverId)
  for (const row of current) {
    const key = String(row.areaId);
    if (!held.has(key)) held.set(key, new Set());
    held.get(key).add(String(row.driverId));
  }

  const releaseIds = [];
  const additions = [];

  for (const areaId of areaIds) {
    const area = areaById.get(areaId);
    const existing = held.get(areaId) || new Set();

    for (const row of current) {
      if (String(row.areaId) !== areaId) continue;
      const driverId = String(row.driverId);
      const shouldRelease =
        (mode === 'set' && !wanted.has(driverId)) || (mode === 'remove' && wanted.has(driverId));
      if (shouldRelease) releaseIds.push(row._id);
    }

    if (mode !== 'remove') {
      for (const driver of drivers) {
        if (existing.has(String(driver._id))) continue;
        additions.push({
          projectId: scope.projectId,
          networkVersionId: area.networkVersionId,
          areaId,
          driverId: driver._id,
          areaName: area.name,
          areaCode: area.areaCode,
          driverName: driver.name,
          assignedBy: req.user._id,
          assignedAt: new Date(),
          note: req.body.note ? String(req.body.note).trim() : null,
        });
      }
    }
  }

  // Blockers are checked once, for every area gaining a driver, and the whole save is refused if
  // any single area is blocked. All-or-nothing on purpose: a lasso over twelve suburbs that
  // silently assigned nine and skipped three would be discovered in the field, not on the screen.
  const override = req.body && req.body.override === true && mayOverride(req.user);
  if (additions.length) {
    const gaining = [...new Set(additions.map((a) => String(a.areaId)))];
    const cycleId = await cycleIdFor(version.projectId);
    const completions = await completionsByCode(
      version.projectId,
      cycleId,
      gaining.map((id) => areaById.get(id)).filter(Boolean).map((a) => a.areaCode)
    );

    const releasing = new Set(releaseIds.map(String));
    const holdersAfter = new Map(); // areaId -> driver names still holding it after this save
    for (const row of current) {
      if (releasing.has(String(row._id))) continue;
      const key = String(row.areaId);
      if (!holdersAfter.has(key)) holdersAfter.set(key, []);
      holdersAfter.get(key).push(row.driverName || 'another driver');
    }
    for (const add of additions) {
      const key = String(add.areaId);
      if (!holdersAfter.has(key)) holdersAfter.set(key, []);
      holdersAfter.get(key).push(add.driverName);
    }

    const blockers = [];
    for (const areaId of gaining) {
      const area = areaById.get(areaId);
      if (!area) continue;
      const blocker = blockerFor(
        area,
        completions.get(area.areaCode),
        holdersAfter.get(areaId) || []
      );
      // An override clears completions only — a second driver on a polygon is refused regardless.
      if (blocker && !(override && clearableByOverride(blocker))) blockers.push(blocker);
    }
    if (blockers.length) return respondBlocked(res, blockers, req.user);
  }

  if (releaseIds.length) {
    await AreaAssignment.updateMany(
      { _id: { $in: releaseIds } },
      { $set: { releasedAt: new Date(), releasedBy: req.user._id } }
    );
  }
  if (additions.length) {
    // ordered:false so a racing duplicate (unique on area+driver while live) cannot stop the rest.
    await AreaAssignment.insertMany(additions, { ordered: false }).catch((err) => {
      if (err && err.code !== 11000) throw err;
    });
  }

  const rows = await AreaAssignment.find({
    networkVersionId: { $in: scope.versionIds },
    releasedAt: null,
  }).populate('driverId', 'name email');

  return res.json({
    assignments: rows,
    areas: areaIds.length,
    added: additions.length,
    released: releaseIds.length,
  });
}

/** One area's assignment history, including released rows — who held it, when, and who said so. */
async function areaAssignmentHistory(req, res) {
  const area = await WorkArea.findById(asObjectId(req.params.areaId) || null).select(
    'projectId name areaCode'
  );
  if (!area) return res.status(404).json({ error: 'Work area not found' });
  assertProjectAccess(req.user, area.projectId);

  const rows = await AreaAssignment.find({ areaId: area._id })
    .populate('driverId', 'name')
    .populate('assignedBy', 'name')
    .populate('releasedBy', 'name')
    .sort({ assignedAt: -1 });

  return res.json({ area, history: rows });
}

/* ---- assigned routes: every road inside a polygon somebody holds ---- */

/**
 * The whole network is 654,447 links and can only ever be drawn by viewport. The ASSIGNED network
 * is a different animal: it is bounded by how much territory is actually out with crews, which is
 * the set a dispatcher looks at all day. Capped anyway — a project that assigned everything would
 * be back to the whole network.
 */
const ASSIGNED_LINK_LIMIT = 120000;

/**
 * GET /versions/:id/assigned-links — every road inside a currently-held work area, at any zoom.
 *
 * Returned as positional tuples `[linkId, funcClass, covered, coords]` and gzipped, the same
 * shape the phone's my-roads uses and for the same reason: at this size GeoJSON spends more bytes
 * on repeated key names than on coordinates. Geometry is simplified and rounded by the shared
 * `compactLine`, so the two maps draw the same lines from the same arithmetic.
 *
 * Assignments resolve by `areaCode`, so a driver still holding an area through a row written
 * against an earlier import is included — the same rule my-areas and the trip attributor use.
 */
async function versionAssignedLinks(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  /**
   * `assigned` draws the territory that is out with crews — every road in a held area, driven or
   * not, so outstanding work is visible as well as finished work.
   *
   * `covered` draws every road anyone has driven, anywhere in the project. It exists because work
   * outlives an assignment: a bulk import of historical driving, or an area since released, leaves
   * thousands of driven roads in polygons nobody holds today. Those are invisible under `assigned`
   * and would otherwise only show up as a percentage in a polygon's fill.
   */
  const linkScope = req.query.scope === 'covered' ? 'covered' : 'assigned';
  const driverIds = String(req.query.driverIds || '')
    .split(',')
    .map(asObjectId)
    .filter(Boolean);

  let areaIds = null;
  if (linkScope === 'assigned') {
    const assignmentFilter = { projectId: scope.projectId, releasedAt: null };
    if (driverIds.length) assignmentFilter.driverId = { $in: driverIds };
    const codes = await AreaAssignment.distinct('areaCode', assignmentFilter);
    if (!codes.length) return res.json({ links: [], areas: 0, covered: 0, truncated: false, drivers: [] });
    const areas = await WorkArea.find({ networkVersionId: { $in: scope.versionIds }, areaCode: { $in: codes } })
      .select('_id')
      .lean();
    areaIds = areas.map((a) => a._id);
    if (!areaIds.length) return res.json({ links: [], areas: 0, covered: 0, truncated: false, drivers: [] });
  }

  const coverFilter = { networkVersionId: { $in: scope.versionIds } };
  if (areaIds) coverFilter.areaId = { $in: areaIds };
  if (linkScope === 'covered' && driverIds.length) coverFilter.firstDriverId = { $in: driverIds };

  // Who first covered each link — this is what lets a road be drawn in its driver's colour, and
  // the reason LinkCoverage.firstDriverId has been indexed since the ledger was built.
  const coverage = await LinkCoverage.find(coverFilter).select('linkId firstDriverId -_id').lean();
  const coverBy = new Map(coverage.map((c) => [c.linkId, c.firstDriverId ? String(c.firstDriverId) : null]));

  const linkFilter = { networkVersionId: { $in: scope.versionIds } };
  if (areaIds) linkFilter.areaId = { $in: areaIds };
  else linkFilter.linkId = { $in: [...coverBy.keys()] };

  const rows = await RoadLink.find(linkFilter)
    .select('linkId funcClass geometry.coordinates -_id')
    .limit(ASSIGNED_LINK_LIMIT + 1)
    .lean();

  const truncated = rows.length > ASSIGNED_LINK_LIMIT;
  const page = truncated ? rows.slice(0, ASSIGNED_LINK_LIMIT) : rows;

  // Driver ids are 24 characters each and would be repeated on tens of thousands of links, so the
  // wire format carries an index into a short list instead.
  const driverIndex = new Map();
  const drivers = [];
  const links = [];
  for (const l of page) {
    const line = compactLine(l.geometry && l.geometry.coordinates);
    if (!line) continue;
    const who = coverBy.get(l.linkId);
    let idx = -1;
    if (who) {
      if (!driverIndex.has(who)) {
        driverIndex.set(who, drivers.length);
        drivers.push(who);
      }
      idx = driverIndex.get(who);
    }
    links.push([l.linkId, l.funcClass, coverBy.has(l.linkId) ? 1 : 0, line, idx]);
  }

  const names = drivers.length
    ? await User.find({ _id: { $in: drivers } }).select('name').lean()
    : [];
  const nameById = new Map(names.map((u) => [String(u._id), u.name]));

  return sendCompressed(
    req,
    res,
    {
      scope: linkScope,
      links,
      areas: areaIds ? areaIds.length : null,
      covered: coverBy.size,
      truncated,
      drivers: drivers.map((id) => ({ driverId: id, name: nameById.get(id) || 'Unknown driver' })),
      // Changes whenever the drawn picture could have changed, so the client can cache on it.
      version: `${version._id}:${linkScope}:${links.length}:${coverBy.size}`,
    },
    'assigned-links'
  );
}

/**
 * GET /versions/:id/coverage-drivers — everyone with driven road on this network, and how much.
 *
 * The map's driver legend used to be built from live assignments, which answers "who is holding a
 * polygon" and not "whose work is on this map". Those diverge the moment an area is released or a
 * history import lands: 10,568 km of real driving sat on the map credited to five people whose
 * names were nowhere in the legend, while two test accounts holding empty areas were listed.
 */
async function versionCoverageDrivers(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const rows = await LinkCoverage.aggregate([
    { $match: { networkVersionId: { $in: scope.versionIds } } },
    { $group: { _id: '$firstDriverId', links: { $sum: 1 }, meters: { $sum: '$lengthMeters' } } },
    { $sort: { meters: -1 } },
  ]);

  const ids = rows.map((r) => r._id).filter(Boolean);
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name').lean() : [];
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  return res.json({
    drivers: rows.map((r) => ({
      driverId: r._id ? String(r._id) : null,
      name: r._id ? nameById.get(String(r._id)) || 'Unknown driver' : 'Unattributed',
      links: r.links,
      meters: r.meters,
    })),
  });
}

/* ---- driven tracks: where the fleet actually went, on the coverage map ---- */

// A fortnight is the window the coverage map opens on; 90 days is as far back as one request may
// reach. Both exist for payload reasons — a snapped route is a few tens of KB, so "every track
// ever" is tens of megabytes and would arrive long after anyone stopped caring.
const TRACKS_DEFAULT_DAYS = 14;
const TRACKS_MAX_DAYS = 90;
const TRACKS_DEFAULT_LIMIT = 200;
const TRACKS_MAX_LIMIT = 500;

/**
 * GET /versions/:id/tracks — the snapped routes driven across this PROJECT in a date window.
 *
 * SNAPPED ONLY, deliberately. Raw GPS wanders off the carriageway, doubles back through buildings
 * and is exactly what map-matching exists to fix; drawing it over a road network invites the
 * reader to conclude a street was driven when the ledger says otherwise. A trip still waiting for
 * the matcher is therefore not drawn — it is counted in `pendingSnap`, so the map can say "3 trips
 * still processing" rather than silently under-reporting the day's work.
 *
 * Scoped to the version's project. Optional `driverIds` narrows it to particular crews, and
 * `areaId` to trips recorded while that polygon was assigned (`Trip.assignedAreaIds`), which is
 * the filter a manager wants when verifying one area.
 */
async function versionTracks(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const to = req.query.to ? new Date(req.query.to) : new Date();
  if (Number.isNaN(to.getTime())) return res.status(400).json({ error: 'to is not a date' });
  // A date picker sends '2026-09-24', which parses to midnight — so the day the user chose as the
  // end of the range would contain none of its own trips. Run it to the end of that day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) {
    to.setUTCHours(23, 59, 59, 999);
  }
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - TRACKS_DEFAULT_DAYS * 86400000);
  if (Number.isNaN(from.getTime())) return res.status(400).json({ error: 'from is not a date' });
  if (to.getTime() - from.getTime() > TRACKS_MAX_DAYS * 86400000) {
    return res.status(400).json({ error: `Date range is limited to ${TRACKS_MAX_DAYS} days` });
  }

  const filter = {
    projectId: scope.projectId,
    startedAt: { $gte: from, $lte: to },
  };
  const driverIds = String(req.query.driverIds || '')
    .split(',')
    .map(asObjectId)
    .filter(Boolean);
  if (driverIds.length) filter.driverId = { $in: driverIds };
  const areaId = asObjectId(req.query.areaId);
  if (areaId) filter.assignedAreaIds = areaId;

  const limit = Math.min(Number(req.query.limit) || TRACKS_DEFAULT_LIMIT, TRACKS_MAX_LIMIT);

  const [rows, pendingSnap] = await Promise.all([
    // Any trip that HAS a cleaned route, however it got one: the matcher for recorded drives,
    // the derivation from covered roads for imported days. Both are snapped geometry.
    Trip.find({ ...filter, cleanedRouteShapes: { $exists: true, $ne: [] } })
      .select('driverId startedAt endedAt cleanedRouteShapes cleanedDistanceMeters effectiveUkmMeters')
      .sort({ startedAt: -1 })
      .limit(limit + 1)
      .lean(),
    // Everything in the window the matcher has not finished with. Counted, never drawn.
    Trip.countDocuments({ ...filter, cleanedRouteShapes: { $in: [null, []] } }),
  ]);

  const truncated = rows.length > limit;
  if (truncated) rows.length = limit;

  const names = await User.find({ _id: { $in: [...new Set(rows.map((t) => String(t.driverId)))] } })
    .select('name')
    .lean();
  const nameById = new Map(names.map((u) => [String(u._id), u.name]));

  // gzipped: a busy month of imported days is ~2.3 MB of polyline, and this app has no
  // compression middleware. Same reason the assigned-network layer goes out this way.
  return sendCompressed(req, res, {
    from,
    to,
    truncated,
    pendingSnap,
    tracks: rows.map((t) => ({
      tripId: String(t._id),
      driverId: String(t.driverId),
      driverName: nameById.get(String(t.driverId)) || 'Unknown driver',
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      cleanedMeters: t.cleanedDistanceMeters || 0,
      ukmMeters: t.effectiveUkmMeters || 0,
      // polyline6, exactly as the matcher produced it — the client decodes, never derives.
      shapes: t.cleanedRouteShapes || [],
    })),
  }, 'tracks');
}

/* ---- completion: a manager's verdict that an area is finished ---- */

/**
 * The project's coverage cycle, normalised the way CoverageSegment stores it: '' means "no
 * cycle", never null. Completions are keyed by it so that starting a new capture cycle reopens
 * every area by itself — that cycle is the customer paying to drive the same streets again.
 */
async function cycleIdFor(projectId) {
  const project = await Project.findById(projectId).select('coverageCycleId').lean();
  return (project && project.coverageCycleId) || '';
}

/** areaCode -> live completion row, for the areas named. */
async function completionsByCode(projectId, cycleId, areaCodes) {
  const codes = [...new Set(areaCodes.filter(Boolean))];
  if (!codes.length) return new Map();
  const rows = await AreaCompletion.find({
    projectId,
    coverageCycleId: cycleId,
    areaCode: { $in: codes },
    status: 'completed',
  }).lean();
  return new Map(rows.map((row) => [row.areaCode, row]));
}

/**
 * Coverage inside one area, split by who got there first.
 *
 * The split is the point. First-cover-wins is fleet-wide, so an area can turn green because a
 * different crew drove it, and a manager cross-verifying "has MY driver finished this?" cannot
 * answer that from the area total alone. `LinkCoverage.firstDriverId` has been indexed since the
 * ledger was built but nothing ever queried it — this is that query.
 */
async function areaCoverageBreakdown(versionId, areaId) {
  const rows = await LinkCoverage.aggregate([
    { $match: { networkVersionId: versionId, areaId } },
    { $group: { _id: '$firstDriverId', meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
    { $sort: { meters: -1 } },
  ]);

  const driverIds = rows.map((r) => r._id).filter(Boolean);
  const drivers = driverIds.length
    ? await User.find({ _id: { $in: driverIds } }).select('name').lean()
    : [];
  const nameById = new Map(drivers.map((d) => [String(d._id), d.name]));

  return {
    coveredMeters: rows.reduce((sum, r) => sum + (r.meters || 0), 0),
    coveredLinks: rows.reduce((sum, r) => sum + (r.links || 0), 0),
    byDriver: rows.map((r) => ({
      driverId: r._id ? String(r._id) : null,
      name: r._id ? nameById.get(String(r._id)) || 'Unknown driver' : 'Unattributed',
      meters: r.meters || 0,
      links: r.links || 0,
    })),
  };
}

/**
 * GET /versions/:id/areas/:areaId/coverage — everything the click-a-polygon panel needs.
 */
async function areaCoverage(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const area = await WorkArea.findOne({
    _id: asObjectId(req.params.areaId) || null,
    networkVersionId: { $in: scope.versionIds },
  }).select('name parentName areaCode priority targetMeters targetLinks bbox networkVersionId');
  if (!area) return res.status(404).json({ error: 'Work area not found in this version' });

  const cycleId = await cycleIdFor(version.projectId);
  const [breakdown, assignments, completion] = await Promise.all([
    areaCoverageBreakdown(area.networkVersionId, area._id),
    // By areaCode, not areaId: a driver assigned before the latest import holds a row pointing at
    // the previous version's polygon, and they are still very much on this area.
    AreaAssignment.find({
      projectId: version.projectId,
      areaCode: area.areaCode,
      releasedAt: null,
    })
      .select('driverId driverName assignedAt')
      .lean(),
    AreaCompletion.findOne({
      projectId: version.projectId,
      coverageCycleId: cycleId,
      areaCode: area.areaCode,
    }).lean(),
  ]);

  const assignedIds = new Set(assignments.map((a) => String(a.driverId)));
  const assignedMeters = breakdown.byDriver
    .filter((d) => d.driverId && assignedIds.has(d.driverId))
    .reduce((sum, d) => sum + d.meters, 0);

  return res.json({
    area: {
      _id: area._id,
      areaCode: area.areaCode,
      name: area.name,
      parentName: area.parentName,
      priority: area.priority,
      targetMeters: area.targetMeters,
      targetLinks: area.targetLinks,
      bbox: area.bbox,
    },
    coveredMeters: breakdown.coveredMeters,
    coveredLinks: breakdown.coveredLinks,
    pct: area.targetMeters > 0 ? (breakdown.coveredMeters / area.targetMeters) * 100 : 0,
    // The same roads, but only what the drivers who currently hold this area covered first —
    // "did my crew do this, or did someone else?"
    assignedMeters,
    assignedPct: area.targetMeters > 0 ? (assignedMeters / area.targetMeters) * 100 : 0,
    byDriver: breakdown.byDriver,
    assignments,
    completion: completion || null,
  });
}

/**
 * POST /versions/:id/areas/:areaId/complete — the manager signs the area off.
 *
 * Also RELEASES every live assignment on the area, which is the behaviour that makes completion
 * mean something on the ground: the driver's phone stops listing those roads as work to do.
 * Released by `areaCode` rather than `areaId` on purpose — assignments made against an earlier
 * network version point at that version's polygon row and would otherwise survive the sign-off.
 */
async function completeArea(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const area = await WorkArea.findOne({
    _id: asObjectId(req.params.areaId) || null,
    networkVersionId: { $in: scope.versionIds },
  }).select('name areaCode targetMeters targetLinks networkVersionId');
  if (!area) return res.status(404).json({ error: 'Work area not found in this version' });

  const cycleId = await cycleIdFor(version.projectId);
  const breakdown = await areaCoverageBreakdown(area.networkVersionId, area._id);
  const top = breakdown.byDriver.find((d) => d.driverId) || null;

  const completion = await AreaCompletion.findOneAndUpdate(
    { projectId: version.projectId, coverageCycleId: cycleId, areaCode: area.areaCode },
    {
      $set: {
        status: 'completed',
        areaId: area._id,
        networkVersionId: area.networkVersionId,
        areaName: area.name,
        completedAt: new Date(),
        completedBy: req.user._id,
        completedByName: req.user.name,
        completedByDriverId: top ? top.driverId : null,
        completedByDriverName: top ? top.name : null,
        coveredMeters: breakdown.coveredMeters,
        targetMeters: area.targetMeters,
        pctAtCompletion:
          area.targetMeters > 0 ? (breakdown.coveredMeters / area.targetMeters) * 100 : 0,
        note: req.body && req.body.note ? String(req.body.note).trim() : null,
        reopenedAt: null,
        reopenedBy: null,
        reopenReason: null,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  const released = await AreaAssignment.updateMany(
    { projectId: version.projectId, areaCode: area.areaCode, releasedAt: null },
    { $set: { releasedAt: new Date(), releasedBy: req.user._id } }
  );

  return res.json({ completion, releasedAssignments: released.modifiedCount || 0 });
}

/**
 * POST /versions/:id/areas/:areaId/reopen — the verdict was wrong, or the ground changed.
 *
 * Completion has to be reversible. A re-matched route can release links it no longer covers, and
 * activating a new network version rebuilds the whole ledger, so an area's percentage can fall
 * after it was signed off.
 */
async function reopenArea(req, res) {
  const scope = await resolveNetworkScope(req);
  if (!scope) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, scope.projectId);
  const version = scope.primary;

  const area = await WorkArea.findOne({
    _id: asObjectId(req.params.areaId) || null,
    networkVersionId: { $in: scope.versionIds },
  }).select('areaCode networkVersionId');
  if (!area) return res.status(404).json({ error: 'Work area not found in this version' });

  const cycleId = await cycleIdFor(version.projectId);
  const completion = await AreaCompletion.findOneAndUpdate(
    { projectId: version.projectId, coverageCycleId: cycleId, areaCode: area.areaCode },
    {
      $set: {
        status: 'reopened',
        reopenedAt: new Date(),
        reopenedBy: req.user._id,
        reopenReason: req.body && req.body.reason ? String(req.body.reason).trim() : null,
      },
    },
    { new: true }
  );
  if (!completion) return res.status(404).json({ error: 'That area is not marked completed' });

  return res.json({ completion });
}

module.exports = {
  listJobs,
  createJob,
  getJob,
  uploadLayer,
  updateJob,
  validateJob,
  commitJob,
  deleteJob,
  importPreviewGeoJson,
  listVersions,
  versionSummary,
  versionAreas,
  versionAreasGeoJson,
  versionLinks,
  listAssignments,
  setAreaAssignments,
  bulkAssign,
  areaAssignmentHistory,
  areaCoverage,
  completeArea,
  reopenArea,
  versionTracks,
  versionAssignedLinks,
  versionCoverageDrivers,
  activateVersion,
  deleteVersion,
};
