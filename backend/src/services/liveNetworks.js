const mongoose = require('mongoose');
const NetworkVersion = require('../models/NetworkVersion');
const WorkArea = require('../models/WorkArea');
const LinkCoverage = require('../models/LinkCoverage');
const AreaAssignment = require('../models/AreaAssignment');

/**
 * Which network deliveries a project is working from RIGHT NOW — for the driver's app and for trip
 * attribution, not just the admin map.
 *
 * "The active version" used to be the answer, and it is wrong for a project whose deliveries are
 * different GROUND rather than re-deliveries of the same ground. PRJ-025 holds Victoria (402 areas),
 * Queensland (330) and a Queensland P2 top-up (134). Importing the top-up activated it and
 * superseded the other two, and from that moment every one of the project's 335 live assignments —
 * 13 drivers — resolved to nothing: their phones drew no polygons and no roads, and their trips
 * were measured against a network 1,000 km away, crediting nothing. The panel kept showing the
 * assignments, because it already read the project this way (resolveNetworkScope), so nothing
 * looked wrong from the office.
 *
 * The rule is the panel's rule, so the two cannot disagree: the active version, plus any superseded
 * one that still holds a live assignment or a coverage ledger. A superseded re-delivery of the same
 * ground carries neither, so it drops out and its duplicate areas never compete.
 *
 * Returned active-first, then newest-first. That order is what resolves an areaCode present in more
 * than one live delivery: the current copy of an area wins over an older one.
 */
async function liveNetworkVersions(projectIds) {
  const ids = (projectIds || [])
    .map(String)
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return [];

  const all = await NetworkVersion.find({
    projectId: { $in: ids },
    status: { $in: ['active', 'superseded'] },
  })
    .select('_id projectId status createdAt')
    .lean();
  if (!all.length) return [];

  // exists() per version rather than distinct() over the ledgers: both ride an index prefix and
  // stop at the first row, and this runs on every my-areas poll from every phone.
  const flags = await Promise.all(
    all.map(async (v) => {
      if (v.status === 'active') return true;
      const [cov, asg] = await Promise.all([
        LinkCoverage.exists({ networkVersionId: v._id }),
        AreaAssignment.exists({ networkVersionId: v._id, releasedAt: null }),
      ]);
      return Boolean(cov || asg);
    })
  );

  return all
    .filter((_, i) => flags[i])
    .sort(
      (a, b) =>
        (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
        new Date(b.createdAt) - new Date(a.createdAt)
    );
}

/**
 * The WorkArea rows a set of assignments refers to, one per area, from the live deliveries.
 *
 * Matched by areaCode — the customer's stable id, which survives re-imports — with the raw id kept
 * for rows predating the code snapshot. When a code exists in several live deliveries, the copy in
 * the highest-ranked one (see liveNetworkVersions) is the one returned.
 */
async function resolveAssignedAreas(versions, assignments, select) {
  if (!versions.length || !assignments.length) return [];
  const codes = [...new Set(assignments.map((a) => a.areaCode).filter(Boolean))];
  const legacyIds = assignments.filter((a) => !a.areaCode).map((a) => a.areaId);

  const rows = await WorkArea.find({
    networkVersionId: { $in: versions.map((v) => v._id) },
    $or: [{ areaCode: { $in: codes } }, { _id: { $in: legacyIds } }],
  })
    .select(`${select} areaCode networkVersionId`)
    .lean();

  const rank = new Map(versions.map((v, i) => [String(v._id), i]));
  const best = new Map();
  for (const row of rows) {
    const key = row.areaCode || String(row._id);
    const held = best.get(key);
    if (!held || rank.get(String(row.networkVersionId)) < rank.get(String(held.networkVersionId))) {
      best.set(key, row);
    }
  }
  return [...best.values()];
}

module.exports = { liveNetworkVersions, resolveAssignedAreas };
