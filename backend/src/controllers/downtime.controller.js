const asyncHandler = require('../utils/asyncHandler');
const Downtime = require('../models/Downtime');
const downtime = require('../services/downtime');
const { accessibleDriverFilter, narrowDrivers } = require('../utils/scope');
const { dayRange, isValidTimeZone } = require('../utils/timezone');
const mongoose = require('mongoose');

const toObjectId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(String(id)) : null);

/* ---------------------------------------------------------------- the driver's own */

/** POST /api/tracking/my-downtime  { startAt, endAt, reason, note?, tz?, clientId? } */
exports.report = asyncHandler(async (req, res) => {
  try {
    const saved = await downtime.report(req.user, req.body || {});
    res.status(201).json({ downtime: downtime.view(saved) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
});

/** DELETE /api/tracking/my-downtime/:id — a driver may take back an entry nobody has decided yet. */
exports.withdraw = asyncHandler(async (req, res) => {
  const id = toObjectId(req.params.id);
  if (!id) return res.status(404).json({ error: 'Not found' });
  const d = await Downtime.findOne({ _id: id, driverId: req.user._id });
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.status !== 'pending') return res.status(409).json({ error: `This downtime was already ${d.status} — ask your manager to change it` });
  await d.deleteOne();
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- the panel */

/**
 * GET /api/downtime?status=pending|approved|rejected|all&from=&to=&tz=&driverId=&driverIds=
 * Entries of the drivers the requester can see, newest first.
 */
exports.list = asyncHandler(async (req, res) => {
  const scope = await accessibleDriverFilter(req.user);
  const filter = { ...scope };
  if (req.query.driverId) filter.driverId = { $in: narrowDrivers(scope, [toObjectId(req.query.driverId)]) };
  else if (req.query.driverIds !== undefined) {
    const ids = String(req.query.driverIds).split(',').map((s) => s.trim()).filter(Boolean);
    filter.driverId = { $in: narrowDrivers(scope, ids.map(toObjectId)) };
  }
  const status = String(req.query.status || 'pending');
  if (status !== 'all') filter.status = status;
  if (req.query.from || req.query.to) {
    const zone = isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
    filter.startAt = {};
    if (req.query.from) filter.startAt.$gte = dayRange(req.query.from, zone).from;
    if (req.query.to) filter.startAt.$lt = dayRange(req.query.to, zone).to;
  }
  const rows = await Downtime.find(filter).sort({ startAt: -1 }).limit(500).lean();
  const pending = await Downtime.countDocuments({ ...scope, status: 'pending' });
  res.json({
    downtime: rows.map((d) => ({ ...downtime.view(d), driverId: String(d.driverId), driverName: d.driverName, timezone: d.timezone })),
    pending,
  });
});

/** PATCH /api/downtime/:id  { status: 'approved' | 'rejected', reviewNote? } */
exports.review = asyncHandler(async (req, res) => {
  const { status, reviewNote } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
  const id = toObjectId(req.params.id);
  const scope = await accessibleDriverFilter(req.user);
  const d = id ? await Downtime.findOne({ _id: id, ...scope }) : null;
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.status = status;
  d.reviewNote = typeof reviewNote === 'string' && reviewNote.trim() ? reviewNote.trim().slice(0, 300) : null;
  d.reviewedBy = req.user._id;
  d.reviewedByName = req.user.name || null;
  d.reviewedAt = new Date();
  await d.save();
  res.json({ downtime: { ...downtime.view(d.toObject()), driverId: String(d.driverId), driverName: d.driverName } });
});
