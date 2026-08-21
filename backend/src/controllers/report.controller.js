const Assignment = require('../models/Assignment');
const User = require('../models/User');
const asyncHandler = require('../utils/asyncHandler');
const { accessibleDriverFilter } = require('../utils/scope');
const { monthRange, formatDateInZone } = require('../utils/timezone');

const DAY_MS = 86400000;

/** Days of `[startedAt, endedAt)` that fall inside `[from, to)`, to one decimal. */
function overlapDays(row, from, to) {
  const start = Math.max(row.startedAt.getTime(), from.getTime());
  const end = Math.min(row.endedAt.getTime(), to.getTime());
  return Math.max(0, Math.round(((end - start) / DAY_MS) * 10) / 10);
}

function stint(row, from, to, tz) {
  const clippedEnd = Math.min(row.endedAt.getTime(), to.getTime());
  return {
    assignmentId: row._id,
    assetId: row.assetId,
    label: row.assetLabel,
    from: formatDateInZone(new Date(Math.max(row.startedAt.getTime(), from.getTime())), tz),
    to: formatDateInZone(new Date(clippedEnd - 1), tz), // -1ms so a stint ending at midnight reads as the previous day
    days: overlapDays(row, from, to),
    startedBefore: row.startedAt < from,
    stillOpen: row.endedAt.getTime() === Assignment.OPEN.getTime(),
    backfilled: row.backfilled,
    country: row.country,
    project: row.project,
    note: row.note,
    // Who moved this asset, and when. The ledger has recorded it since day one and
    // /api/assignments already returns it, but this report dropped it on the way through — so the
    // one screen people open to ask "who reassigned that van, and when?" could not answer.
    // Raw timestamps, not formatted dates: from/to above are clipped to the reporting month,
    // while these are the real moments the change was made.
    assignedBy: row.assignedBy?.name || null,
    assignedAt: row.startedAt,
    releasedBy: row.releasedBy?.name || null,
    releasedAt: row.endedAt.getTime() === Assignment.OPEN.getTime() ? null : row.endedAt,
  };
}

/**
 * GET /api/reports/custody?month=2026-06&tz=Australia/Sydney
 *
 * The question this whole feature exists to answer: for a given month, which driver had
 * which vehicle and which mobile, and for how many days.
 *
 * Drivers with nothing are included on purpose — an unassigned driver or an idle month is
 * usually exactly what a manager is looking for.
 */
exports.custody = asyncHandler(async (req, res) => {
  let range;
  try {
    range = monthRange(req.query.month, req.query.tz || 'UTC');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { from, to, tz } = range;

  const scope = await accessibleDriverFilter(req.user);
  const rows = await Assignment.find({ ...scope, ...Assignment.overlapFilter(from, to) })
    .sort({ startedAt: 1 })
    .populate('driverId', 'name email country active exitDate')
    .populate('assignedBy', 'name')
    .populate('releasedBy', 'name');

  // Every driver in scope, so gaps show up rather than silently vanishing.
  const driverFilter = { role: 'user' };
  if (scope.driverId) driverFilter._id = scope.driverId;
  const drivers = await User.find(driverFilter).select('name email country active exitDate').sort({ name: 1 });

  const byDriver = new Map();
  for (const d of drivers) {
    byDriver.set(String(d._id), {
      driver: { _id: d._id, name: d.name, email: d.email, country: d.country, active: d.active, exitDate: d.exitDate },
      vehicles: [],
      mobiles: [],
      vehicleDays: 0,
      mobileDays: 0,
    });
  }

  for (const row of rows) {
    const key = String(row.driverId?._id || row.driverId);
    // A driver deleted since the stint still has history — the snapshot keeps it readable.
    if (!byDriver.has(key)) {
      byDriver.set(key, {
        driver: { _id: key, name: row.driverName || 'Removed driver', email: null, country: row.country, active: false },
        vehicles: [],
        mobiles: [],
        vehicleDays: 0,
        mobileDays: 0,
      });
    }
    const entry = byDriver.get(key);
    const s = stint(row, from, to, tz);
    if (row.assetKind === 'vehicle') {
      entry.vehicles.push(s);
      entry.vehicleDays = Math.round((entry.vehicleDays + s.days) * 10) / 10;
    } else {
      entry.mobiles.push(s);
      entry.mobileDays = Math.round((entry.mobileDays + s.days) * 10) / 10;
    }
  }

  const list = [...byDriver.values()].sort((a, b) => a.driver.name.localeCompare(b.driver.name));
  const monthDays = Math.round((to - from) / DAY_MS);

  res.json({
    month: req.query.month,
    tz,
    from,
    to,
    monthDays,
    rows: list,
    totals: {
      drivers: list.length,
      driversWithVehicle: list.filter((r) => r.vehicles.length).length,
      driversWithMobile: list.filter((r) => r.mobiles.length).length,
      driversWithNothing: list.filter((r) => !r.vehicles.length && !r.mobiles.length).length,
      vehicleStints: list.reduce((n, r) => n + r.vehicles.length, 0),
      mobileStints: list.reduce((n, r) => n + r.mobiles.length, 0),
    },
  });
});

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** GET /api/reports/custody.csv?month=&tz= — one line per driver per stint. */
exports.custodyCsv = asyncHandler(async (req, res) => {
  let range;
  try {
    range = monthRange(req.query.month, req.query.tz || 'UTC');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { from, to, tz } = range;

  const scope = await accessibleDriverFilter(req.user);
  const rows = await Assignment.find({ ...scope, ...Assignment.overlapFilter(from, to) })
    .sort({ driverName: 1, assetKind: 1, startedAt: 1 })
    .populate('driverId', 'name email country')
    .populate('assignedBy', 'name')
    .populate('releasedBy', 'name');

  const header = [
    'Month', 'Timezone', 'Driver', 'Email', 'Country', 'Project',
    'AssetKind', 'Asset', 'From', 'To', 'Days', 'StillHeld', 'Backfilled', 'Note',
    'AssignedBy', 'AssignedAt', 'ReleasedBy', 'ReleasedAt',
  ];
  const lines = [header.join(',')];

  for (const row of rows) {
    const s = stint(row, from, to, tz);
    lines.push(
      [
        req.query.month,
        tz,
        row.driverId?.name || row.driverName,
        row.driverId?.email || '',
        row.country || row.driverId?.country || '',
        row.project || '',
        row.assetKind,
        row.assetLabel,
        s.from,
        s.to,
        s.days,
        s.stillOpen ? 'yes' : 'no',
        s.backfilled ? 'yes' : 'no',
        row.note || '',
        row.assignedBy?.name || '',
        row.startedAt ? row.startedAt.toISOString() : '',
        row.releasedBy?.name || '',
        row.endedAt.getTime() === Assignment.OPEN.getTime() ? '' : row.endedAt.toISOString(),
      ]
        .map(csvCell)
        .join(',')
    );
  }

  const filename = `custody-${req.query.month}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel reads UTF-8 names correctly, matching the other exports.
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});
