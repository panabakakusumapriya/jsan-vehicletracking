const Assignment = require('../models/Assignment');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const custody = require('../services/assetCustody');

function handle(err, res) {
  if (err instanceof custody.CustodyError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err.code === 11000) {
    // The unique indexes fired: something is already open for this asset or driver.
    return res.status(409).json({
      error: 'That asset or driver already has an open assignment. Refresh and try again.',
    });
  }
  throw err;
}

/**
 * POST /api/assignments
 * { assetKind, assetId, driverId, startedAt?, note? }
 *
 * Closes whatever the asset and the driver were holding and opens the new stint, atomically.
 */
exports.create = asyncHandler(async (req, res) => {
  const { assetKind, assetId, driverId, startedAt, note } = req.body || {};
  if (!assetKind || !assetId || !driverId) {
    return res.status(400).json({ error: 'assetKind, assetId and driverId are required' });
  }

  // A manager may only move assets between their own drivers.
  const scope = await accessibleDriverFilter(req.user);
  if (scope.driverId && !scope.driverId.$in.some((id) => String(id) === String(driverId))) {
    return res.status(403).json({ error: 'That driver is not in your team' });
  }

  try {
    const { assignment, unchanged } = await custody.assign({
      assetKind,
      assetId,
      driverId,
      startedAt,
      note,
      actor: req.user,
    });
    res.status(unchanged ? 200 : 201).json({ assignment, unchanged });
  } catch (err) {
    return handle(err, res);
  }
});

/** POST /api/assignments/:id/return   { endedAt?, note? } */
exports.release = asyncHandler(async (req, res) => {
  const row = await Assignment.findById(req.params.id);
  if (!row) return res.status(404).json({ error: 'Assignment not found' });

  const scope = await accessibleDriverFilter(req.user);
  if (scope.driverId && !scope.driverId.$in.some((id) => String(id) === String(row.driverId))) {
    return res.status(403).json({ error: 'That driver is not in your team' });
  }

  try {
    const { assignment } = await custody.release({
      assignmentId: row._id,
      endedAt: req.body?.endedAt,
      note: req.body?.note,
      actor: req.user,
    });
    res.json({ assignment });
  } catch (err) {
    return handle(err, res);
  }
});

/**
 * GET /api/assignments?from&to&driverId&assetId&assetKind&open=true
 * Raw intervals. The pivoted monthly view lives at /api/reports/custody.
 */
exports.list = asyncHandler(async (req, res) => {
  const { from, to, driverId, assetId, assetKind, open } = req.query;
  const scope = await accessibleDriverFilter(req.user);

  const filter = { ...scope };
  if (assetKind) filter.assetKind = assetKind;
  if (assetId) filter.assetId = assetId;
  if (driverId) filter.driverId = driverId;
  if (open === 'true') filter.endedAt = Assignment.OPEN;
  if (from || to) {
    // Half-open overlap window — the one predicate the whole design rests on.
    const f = from ? new Date(from) : new Date(0);
    const t = to ? new Date(to) : Assignment.OPEN;
    Object.assign(filter, Assignment.overlapFilter(f, t));
  }

  const assignments = await Assignment.find(filter)
    .sort({ startedAt: -1 })
    .limit(Math.min(parseInt(req.query.limit || '500', 10), 2000))
    .populate('driverId', 'name email country')
    .populate('assignedBy', 'name')
    .populate('releasedBy', 'name');

  res.json({ assignments });
});

/** GET /api/assignments/driver/:driverId — one driver's timeline, newest first. */
exports.forDriver = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  if (scope.driverId && !scope.driverId.$in.some((id) => String(id) === String(req.params.driverId))) {
    return res.status(403).json({ error: 'That driver is not in your team' });
  }
  const assignments = await Assignment.find({ driverId: req.params.driverId }).sort({ startedAt: -1 });
  res.json({ assignments });
});
