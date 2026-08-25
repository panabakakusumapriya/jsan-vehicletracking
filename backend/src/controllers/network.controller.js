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
const User = require('../models/User');

const networkImport = require('../services/networkImport');
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
    path: dest,
    fileId: stored.id,
    sha256: stored.sha256,
    uploadedAt: new Date(),
  };
  // A new file invalidates whatever the previous report said.
  job.report = null;
  job.error = null;

  // The work areas alone are enough to start: they are what gets allocated to drivers. The road
  // layer is optional and only adds the coverage denominator, so waiting for it would block the
  // whole flow on a file the customer may not have sent.
  const ready = Boolean(job.files.boundary?.name);
  job.status = ready ? 'queued' : 'draft';
  if (ready) job.progress = { phase: 'queued', done: 0, total: 0 };
  await job.save();

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
  if (!job.files?.boundary?.name) {
    return res.status(400).json({ error: 'Upload the work-area archive first' });
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
    const p = job.files?.[layer]?.path;
    if (p) fs.rmSync(p, { force: true });
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
  const version = await NetworkVersion.findById(req.params.id).populate('projectId', 'name code');
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId?._id || version.projectId);

  const rows = await LinkCoverage.aggregate([
    { $match: { networkVersionId: version._id } },
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

  return res.json({
    version,
    coverage: {
      coveredMeters,
      coveredLinks,
      targetMeters: version.targetMeters,
      targetLinks: version.counts.links,
      byPriority: version.byPriority.map((band) => ({
        ...(band.toObject ? band.toObject() : band),
        coveredMeters: coveredByPriority.get(band.priority)?.meters || 0,
        coveredLinks: coveredByPriority.get(band.priority)?.links || 0,
      })),
      byFuncClass: version.byFuncClass.map((row) => ({
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
  const version = await NetworkVersion.findById(req.params.id).select('projectId');
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);

  const filter = { networkVersionId: version._id };
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
      .limit(1000),
    LinkCoverage.aggregate([
      { $match: { networkVersionId: version._id } },
      { $group: { _id: '$areaId', meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
    ]),
  ]);

  const byArea = new Map(covered.map((row) => [String(row._id), row]));

  return res.json({
    areas: areas.map((a) => {
      const hit = byArea.get(String(a._id));
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
  const version = await NetworkVersion.findById(req.params.id).select('projectId');
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);

  const bbox = String(req.query.bbox || '')
    .split(',')
    .map(Number);
  if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'bbox=west,south,east,north is required' });
  }

  const limit = Math.min(Number(req.query.limit) || 4000, 10000);
  const filter = {
    networkVersionId: version._id,
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
        networkVersionId: version._id,
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
  const version = await NetworkVersion.findById(req.params.id).select('projectId');
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);

  const [areas, covered] = await Promise.all([
    WorkArea.find({ networkVersionId: version._id }).select(
      'areaCode name parentName priority areaSqm targetMeters targetLinks outline bbox'
    ),
    LinkCoverage.aggregate([
      { $match: { networkVersionId: version._id } },
      { $group: { _id: '$areaId', meters: { $sum: '$lengthMeters' }, links: { $sum: 1 } } },
    ]),
  ]);

  await backfillOutlines(areas);

  const byArea = new Map(covered.map((row) => [String(row._id), row]));
  let bounds = null;
  let approximated = 0;

  const features = areas.map((a) => {
    const hit = byArea.get(String(a._id));
    const coveredMeters = hit?.meters || 0;
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
  if (!job.files?.boundary?.path) {
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
  const version = await NetworkVersion.findById(req.params.id).select('projectId');
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);

  const rows = await AreaAssignment.find({
    networkVersionId: version._id,
    releasedAt: null,
  })
    .populate('driverId', 'name email driverStatus')
    .populate('assignedBy', 'name')
    .sort({ assignedAt: -1 });

  return res.json({ assignments: rows });
}

/**
 * Set exactly which drivers hold an area.
 *
 * A set operation rather than add/remove calls: the UI is a multi-select, so "these are the drivers
 * now" is the thing the operator actually expresses. Drivers dropped from the list are RELEASED —
 * `releasedAt` is stamped and the row is kept — rather than deleted, so who was responsible for an
 * area last month survives this month's reshuffle.
 */
async function setAreaAssignments(req, res) {
  const version = await NetworkVersion.findById(req.params.id).select('projectId');
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);

  const area = await WorkArea.findOne({
    _id: asObjectId(req.params.areaId) || null,
    networkVersionId: version._id,
  }).select('name areaCode');
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

  if (toRelease.length) {
    await AreaAssignment.updateMany(
      { _id: { $in: toRelease.map((row) => row._id) } },
      { $set: { releasedAt: new Date(), releasedBy: req.user._id } }
    );
  }

  if (toAdd.length) {
    await AreaAssignment.insertMany(
      toAdd.map((driver) => ({
        projectId: version.projectId,
        networkVersionId: version._id,
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
  const version = await NetworkVersion.findById(req.params.id).select('projectId');
  if (!version) return res.status(404).json({ error: 'Network version not found' });
  assertProjectAccess(req.user, version.projectId);

  const mode = ['set', 'add', 'remove'].includes(req.body.mode) ? req.body.mode : 'set';
  const areaIds = [...new Set((req.body.areaIds || []).map(asObjectId).filter(Boolean))];
  const driverIds = [...new Set((req.body.driverIds || []).map(asObjectId).filter(Boolean))];
  if (!areaIds.length) return res.status(400).json({ error: 'areaIds is required' });

  const areas = await WorkArea.find({
    _id: { $in: areaIds },
    networkVersionId: version._id,
  }).select('name areaCode');
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
  }).select('areaId driverId');

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
          projectId: version.projectId,
          networkVersionId: version._id,
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
    networkVersionId: version._id,
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
  activateVersion,
  deleteVersion,
};
