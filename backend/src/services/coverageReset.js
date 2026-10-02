const WorkArea = require('../models/WorkArea');
const RoadLink = require('../models/RoadLink');
const LinkCoverage = require('../models/LinkCoverage');
const AreaCompletion = require('../models/AreaCompletion');
const CoverageReset = require('../models/CoverageReset');
const Project = require('../models/Project');
const { computeTripLinkMetrics } = require('./linkCoverage');
const { clearVersionMemo } = require('./driverRoads');

/**
 * Clearing an area's driven data — see models/CoverageReset.js for why it is more than a delete.
 *
 * What it does, in this order:
 *   1. writes the CoverageReset row, so nothing driven up to now can be claimed again;
 *   2. deletes the area's LinkCoverage rows — in every delivery of the project that carries the
 *      same area code, since those are the same ground;
 *   3. recalculates the trips that owned those rows, because a trip's assigned-route km is
 *      "the links whose ledger row names this trip", and those rows are gone;
 *   4. forgets the cached road-layer version, so phones see the change at their next check.
 *
 * What it does not touch: trips, GPS points, routes, distances, the global-UKM ledger, any other
 * area. The driver's history is intact; only the "this road is done" marks go.
 */

/** Recalculated in the request up to this many trips; the rest carry on after it has answered. */
const INLINE_TRIPS = 40;

const refuse = (message, status = 409) => Object.assign(new Error(message), { status });

async function clearAreaCoverage({ versionId, areaId, userId = null, userName = null, note = null }) {
  const area = await WorkArea.findOne({ _id: areaId, networkVersionId: versionId })
    .select('projectId networkVersionId areaCode name')
    .lean();
  if (!area) throw refuse('Work area not found in this network version', 404);

  // A sign-off records the percentage it was made at. Wiping the roads under it would leave
  // "completed at 87%" over an area showing nothing driven.
  const project = await Project.findById(area.projectId).select('coverageCycleId').lean();
  const signedOff = await AreaCompletion.exists({
    projectId: area.projectId,
    coverageCycleId: (project && project.coverageCycleId) || '',
    areaCode: area.areaCode,
    status: 'completed',
  });
  if (signedOff) throw refuse(`${area.name} is marked completed — reopen it before clearing its driven data`);

  // The same area in the project's other deliveries is the same ground.
  const copies = await WorkArea.find({ projectId: area.projectId, areaCode: area.areaCode })
    .select('_id networkVersionId')
    .lean();
  const everywhere = { $or: copies.map((c) => ({ networkVersionId: c.networkVersionId, areaId: c._id })) };

  const [links, rows] = await Promise.all([
    RoadLink.find({ networkVersionId: versionId, areaId }).select('linkId -_id').lean(),
    LinkCoverage.find(everywhere).select('networkVersionId lengthMeters firstTripId').lean(),
  ]);
  const here = rows.filter((r) => String(r.networkVersionId) === String(versionId));
  const tripIds = [...new Set(rows.map((r) => String(r.firstTripId)).filter(Boolean))];

  // 1. The marker first: an attribution running right now must find it before it can re-insert.
  const resetAt = new Date();
  const reset = await CoverageReset.create({
    projectId: area.projectId,
    networkVersionId: versionId,
    areaId,
    areaCode: area.areaCode,
    areaName: area.name,
    resetAt,
    linkIds: links.map((l) => l.linkId),
    clearedLinks: here.length,
    clearedMeters: here.reduce((sum, r) => sum + (r.lengthMeters || 0), 0),
    tripsAffected: tripIds.length,
    clearedBy: userId,
    clearedByName: userName,
    note: note ? String(note).trim().slice(0, 500) : null,
  });

  // 2. The rows.
  await LinkCoverage.deleteMany(everywhere);
  clearVersionMemo();

  // 3. The trips that owned them. A few are done before answering; a long tail is not worth
  //    holding a request open for, and each trip's figures are right the moment it is reached.
  const recalc = async (ids) => {
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await computeTripLinkMetrics(id);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[coverage reset] recalculating trip', id, err.message);
      }
    }
  };
  await recalc(tripIds.slice(0, INLINE_TRIPS));
  const later = tripIds.slice(INLINE_TRIPS);
  if (later.length) recalc(later).catch(() => {});

  // A claim that was mid-flight when the marker went in may have landed after the delete.
  await LinkCoverage.deleteMany({ ...everywhere, firstAt: { $lte: resetAt } });
  clearVersionMemo();

  return {
    area: { _id: area._id, code: area.areaCode, name: area.name },
    resetId: reset._id,
    resetAt,
    clearedLinks: reset.clearedLinks,
    clearedMeters: reset.clearedMeters,
    tripsAffected: tripIds.length,
    tripsPending: later.length,
  };
}

/** The most recent clear of an area, for the panel's card. Null when it has never been cleared. */
async function lastReset(projectId, areaCode) {
  if (!areaCode) return null;
  const row = await CoverageReset.findOne({ projectId, areaCode })
    .sort({ resetAt: -1 })
    .select('resetAt clearedByName clearedLinks clearedMeters')
    .lean();
  return row
    ? { at: row.resetAt, byName: row.clearedByName, links: row.clearedLinks, meters: row.clearedMeters }
    : null;
}

module.exports = { clearAreaCoverage, lastReset };
