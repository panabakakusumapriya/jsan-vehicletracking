const mongoose = require('mongoose');
const NetworkVersion = require('../models/NetworkVersion');
const WorkArea = require('../models/WorkArea');
const RoadLink = require('../models/RoadLink');
const LinkCoverage = require('../models/LinkCoverage');
const AreaAssignment = require('../models/AreaAssignment');
const AreaCompletion = require('../models/AreaCompletion');
const AreaSplit = require('../models/AreaSplit');
const CoverageReset = require('../models/CoverageReset');
const Trip = require('../models/Trip');
const roadBlobs = require('./roadBlobs');

/**
 * Take back what an import loaded, when deleting the import in the panel.
 *
 * Deleting an import used to remove only its record and archives. The delivery it had loaded — work
 * areas, roads, and the "active" mark — stayed, with nothing left in Network imports to say where
 * it came from: the deleted Vietnam upload's 75 zones and 192,827 roads went on filling the map.
 *
 * Only a delivery nothing has happened on yet: no assignment ever made (released ones included —
 * they are history), no coverage, no sign-off, no reset, no trip measured against it. Anything else
 * is real work and stays; the panel says so. Only the delivery this import CREATED
 * (version.importJobId): a roads-only upload that joined the active delivery's areas did not make
 * that delivery, and deleting it must never take the delivery with it.
 *
 * If it was the active delivery, the newest delivery still in use becomes active again — exactly
 * the mark the import took from it. Statuses only: nothing is re-measured, because no trip was ever
 * measured against what is being removed.
 *
 * Returns { removed: true, versionId, areas, links, reactivated } or { removed: false, reason }.
 */
async function removeUnusedDelivery(job) {
  const versionId = job.networkVersionId;
  if (!versionId) return { removed: false, reason: null };
  const version = await NetworkVersion.findById(versionId);
  if (!version) return { removed: false, reason: null };
  if (String(version.importJobId || '') !== String(job._id)) {
    return { removed: false, reason: 'These roads were added to an existing delivery, which stays.' };
  }

  const [coverage, assignment, completion, reset, trip] = await Promise.all([
    LinkCoverage.exists({ networkVersionId: version._id }),
    AreaAssignment.exists({ networkVersionId: version._id }),
    AreaCompletion.exists({ networkVersionId: version._id }),
    CoverageReset.exists({ networkVersionId: version._id }),
    Trip.exists({ assignedNetworkVersionId: version._id }),
  ]);
  const inUse = [
    assignment && 'areas have been assigned in it',
    (coverage || trip) && 'driving has been measured against it',
    completion && 'areas in it have been signed off',
    reset && 'its coverage has been reset',
  ].filter(Boolean);
  if (inUse.length) {
    return {
      removed: false,
      reason: `Its work areas stay: ${inUse.join(', ')}. Load a replacement instead.`,
    };
  }

  let reactivated = null;
  if (version.status === 'active') {
    reactivated = await nextActive(version);
  }

  const [areas, links] = await Promise.all([
    WorkArea.deleteMany({ networkVersionId: version._id }).then((r) => r.deletedCount),
    RoadLink.deleteMany({ networkVersionId: version._id }).then((r) => r.deletedCount),
    AreaSplit.deleteMany({ networkVersionId: version._id }),
  ]);
  await removeRoadBlobs(version._id);
  await version.deleteOne();
  if (reactivated) {
    await NetworkVersion.updateOne({ _id: reactivated._id }, { $set: { status: 'active' } });
  }
  return { removed: true, versionId: version._id, areas, links, reactivated: reactivated ? reactivated.label : null };
}

/**
 * The delivery to hand the active mark back to: the newest one the project is still working from
 * (assignments, coverage, or kept on the map) — never an abandoned re-delivery or a stray test
 * upload, which would put dead areas back in front of the managers.
 */
async function nextActive(leaving) {
  const others = await NetworkVersion.find({
    projectId: leaving.projectId,
    _id: { $ne: leaving._id },
    status: 'superseded',
  })
    .select('_id label keepLive activatedAt createdAt')
    .sort({ activatedAt: -1, createdAt: -1 })
    .lean();
  for (const v of others) {
    // eslint-disable-next-line no-await-in-loop
    const live = v.keepLive || (await LinkCoverage.exists({ networkVersionId: v._id }))
      // eslint-disable-next-line no-await-in-loop
      || (await AreaAssignment.exists({ networkVersionId: v._id, releasedAt: null }));
    if (live) return v;
  }
  return null;
}

async function removeRoadBlobs(versionId) {
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: roadBlobs.BUCKET });
  const files = await bucket.find({ 'metadata.versionId': String(versionId) }).toArray();
  for (const f of files) {
    // eslint-disable-next-line no-await-in-loop
    await bucket.delete(f._id).catch(() => {});
  }
}

module.exports = { removeUnusedDelivery };
