const mongoose = require('mongoose');
const Assignment = require('../models/Assignment');
const MobileDevice = require('../models/MobileDevice');
const Vehicle = require('../models/Vehicle');
const User = require('../models/User');

const { OPEN } = Assignment;

/** Thrown for rule violations the caller should turn into a 4xx, not a 500. */
class CustodyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CustodyError';
    this.status = status;
  }
}

/**
 * Run `fn` inside a transaction where the deployment supports one.
 *
 * Atlas is a replica set, so the real deployment gets true atomicity for the
 * close-old + open-new swap. A standalone mongod (a plain local install) cannot do
 * transactions at all; rather than refuse to run, we fall back to sequential writes.
 * That fallback is safe in the way that matters: the unique indexes still make
 * "two people holding one asset" impossible. The failure it admits is the recoverable
 * one — an asset left held by nobody — which the repair script detects.
 */
async function runAtomically(fn) {
  let session;
  try {
    session = await mongoose.startSession();
  } catch {
    return fn(null);
  }
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      // withTransaction aborts before committing, so nothing was persisted — retrying
      // without a session cannot double-apply.
      return fn(null);
    }
    throw err;
  } finally {
    await session.endSession().catch(() => {});
  }
}

function isTransactionUnsupported(err) {
  const msg = String(err && err.message);
  return (
    /Transaction numbers are only allowed on a replica set/i.test(msg) ||
    /Transactions are not supported/i.test(msg) ||
    /This MongoDB deployment does not support retryable writes/i.test(msg) ||
    err?.codeName === 'IllegalOperation'
  );
}

async function loadAsset(assetKind, assetId) {
  if (assetKind === 'vehicle') {
    const v = await Vehicle.findById(assetId);
    if (!v) throw new CustodyError('Vehicle not found', 404);
    return { doc: v, label: v.plateNumber, managerId: v.managerId };
  }
  if (assetKind === 'mobile') {
    const d = await MobileDevice.findById(assetId);
    if (!d) throw new CustodyError('Mobile device not found', 404);
    return { doc: d, label: d.displayLabel(), managerId: d.managerId };
  }
  throw new CustodyError(`Unknown assetKind "${assetKind}"`);
}

/**
 * Would an open interval starting at `start` collide with history?
 *
 * The unique indexes stop two rows being open at once, but they cannot stop a BACKDATED
 * assignment landing on top of a closed one — e.g. logging "Joel had it 1–10 June" when
 * Derrick already has a closed row for 5–20 June. That is what this checks.
 *
 * The new interval is [start, ∞), so it collides with any row whose endedAt > start —
 * except the currently open row, which this operation is about to truncate to end exactly
 * at `start`. Truncation is only legal if that row began at or before `start`.
 */
async function assertNoOverlap({ match, start, label }, session) {
  const clashes = await Assignment.find({ ...match, endedAt: { $gt: start } })
    .session(session || null)
    .sort({ startedAt: 1 });

  for (const row of clashes) {
    const isOpenRow = row.endedAt.getTime() === OPEN.getTime();
    if (isOpenRow && row.startedAt <= start) continue; // will be closed at `start`
    const until = isOpenRow ? 'now' : row.endedAt.toISOString().slice(0, 10);
    throw new CustodyError(
      `${label} already has custody recorded from ${row.startedAt
        .toISOString()
        .slice(0, 10)} to ${until}. Overlapping history is not allowed — ` +
        'correct or end that record first.',
      409
    );
  }
}

/** Close a specific open row and clear the cache pointers it implies. */
async function closeRow(row, endedAt, actorId, session) {
  row.endedAt = endedAt;
  row.releasedBy = actorId || null;
  await row.save({ session: session || undefined });
  await clearCaches(row, session);
  return row;
}

/**
 * Clear an asset's own holder pointer, then re-derive the driver's cache pointer for this
 * kind from whatever open assignments remain — the most recently started one, or null if the
 * driver now holds none of this kind. An unconditional recompute (rather than "only if it was
 * pointing at this row") means the cache can never drift from the ledger, even though a
 * driver can now hold several assets of the same kind at once.
 */
async function clearCaches(row, session) {
  const opts = session ? { session } : {};
  const cacheField = row.assetKind === 'vehicle' ? 'vehicleId' : 'mobileDeviceId';

  if (row.assetKind === 'vehicle') {
    await Vehicle.updateOne({ _id: row.assetId, assignedDriverId: row.driverId }, { $set: { assignedDriverId: null } }, opts);
  } else {
    await MobileDevice.updateOne(
      { _id: row.assetId, currentDriverId: row.driverId },
      { $set: { currentDriverId: null, status: 'in_stock' } },
      opts
    );
  }

  const next = await Assignment.findOne({ assetKind: row.assetKind, driverId: row.driverId, endedAt: OPEN })
    .sort({ startedAt: -1 })
    .session(session || null);
  await User.updateOne({ _id: row.driverId }, { $set: { [cacheField]: next ? next.assetId : null } }, opts);
}

/**
 * The newest assignment becomes the driver's cache pointer for this kind — the one trip
 * ingestion and the Drivers table read. Older ones the driver still holds stay open in the
 * ledger, just not the pointer.
 */
async function applyCaches(row, session) {
  const opts = session ? { session } : {};
  if (row.assetKind === 'vehicle') {
    await Vehicle.updateOne({ _id: row.assetId }, { $set: { assignedDriverId: row.driverId } }, opts);
    await User.updateOne({ _id: row.driverId }, { $set: { vehicleId: row.assetId } }, opts);
  } else {
    await MobileDevice.updateOne(
      { _id: row.assetId },
      { $set: { currentDriverId: row.driverId, status: 'assigned' } },
      opts
    );
    await User.updateOne({ _id: row.driverId }, { $set: { mobileDeviceId: row.assetId } }, opts);
  }
}

/**
 * Give `assetId` to `driverId` from `startedAt` (default: now).
 *
 * Closes whoever currently holds the ASSET — one asset still has exactly one holder at a
 * time — then opens the new stint. Deliberately does NOT touch the driver's other open
 * assignments of this kind: a driver may hold several vehicles or several handsets at once.
 * The new assignment becomes the driver's cache pointer (`User.vehicleId` /
 * `mobileDeviceId`), so "the vehicle this driver is on right now" — what trip ingestion reads
 * — stays well-defined even while they hold more than one.
 */
async function assign({ assetKind, assetId, driverId, startedAt, note, backfilled, actor }) {
  const start = startedAt ? new Date(startedAt) : new Date();
  if (Number.isNaN(start.getTime())) throw new CustodyError('startedAt is not a valid date');
  // A small skew allowance covers clock drift between the panel and the server.
  if (start.getTime() > Date.now() + 60_000) {
    throw new CustodyError('startedAt cannot be in the future', 400);
  }

  const driver = await User.findById(driverId);
  if (!driver || driver.role !== 'user') throw new CustodyError('Driver not found', 404);
  if (!driver.active) throw new CustodyError('Driver is inactive — reactivate them first', 409);

  const asset = await loadAsset(assetKind, assetId);

  // Already in the right hands: return the existing stint rather than churning history.
  const openForAsset = await Assignment.findOne({ assetKind, assetId, endedAt: OPEN });
  if (openForAsset && String(openForAsset.driverId) === String(driverId)) {
    return { assignment: openForAsset, unchanged: true };
  }

  return runAtomically(async (session) => {
    await assertNoOverlap(
      { match: { assetKind, assetId }, start, label: `${asset.label}` },
      session
    );

    // Release the asset from whoever holds it now — an asset still has exactly one holder at
    // a time. The driver's OTHER open assignments of this kind are left untouched: that is
    // precisely what lets them hold more than one.
    const toClose = await Assignment.find({ endedAt: OPEN, assetKind, assetId }).session(session || null);
    for (const row of toClose) await closeRow(row, start, actor?._id, session);

    const [created] = await Assignment.create(
      [
        {
          assetKind,
          assetId,
          driverId,
          startedAt: start,
          endedAt: OPEN,
          managerId: driver.managerId || asset.managerId || null,
          country: driver.country || null,
          project: driver.project || null,
          assetLabel: asset.label,
          driverName: driver.name,
          assignedBy: actor?._id || null,
          note: note || null,
          backfilled: Boolean(backfilled),
        },
      ],
      session ? { session } : {}
    );

    await applyCaches(created, session);
    return { assignment: created, unchanged: false };
  });
}

/** End the open stint for an asset (or a specific assignment row). */
async function release({ assignmentId, assetKind, assetId, endedAt, note, actor }) {
  const end = endedAt ? new Date(endedAt) : new Date();
  if (Number.isNaN(end.getTime())) throw new CustodyError('endedAt is not a valid date');

  const row = assignmentId
    ? await Assignment.findById(assignmentId)
    : await Assignment.findOne({ assetKind, assetId, endedAt: OPEN });

  if (!row) throw new CustodyError('No open assignment found', 404);
  if (row.endedAt.getTime() !== OPEN.getTime()) {
    throw new CustodyError('That assignment is already closed', 409);
  }
  if (end < row.startedAt) {
    throw new CustodyError('endedAt cannot be before the assignment started', 400);
  }
  if (end.getTime() > Date.now() + 60_000) {
    throw new CustodyError('endedAt cannot be in the future', 400);
  }

  return runAtomically(async (session) => {
    if (note) row.note = row.note ? `${row.note}; ${note}` : note;
    await closeRow(row, end, actor?._id, session);
    return { assignment: row };
  });
}

/**
 * Hand everything back — used when a driver exits. Without this a departed driver holds a
 * truck forever and it can never be reassigned.
 */
async function releaseAllForDriver({ driverId, endedAt, note, actor }) {
  const end = endedAt ? new Date(endedAt) : new Date();
  const rows = await Assignment.find({ driverId, endedAt: OPEN });
  if (!rows.length) return { released: 0 };

  return runAtomically(async (session) => {
    for (const row of rows) {
      if (note) row.note = row.note ? `${row.note}; ${note}` : note;
      // Guard against an exitDate earlier than the stint began.
      await closeRow(row, end < row.startedAt ? row.startedAt : end, actor?._id, session);
    }
    return { released: rows.length };
  });
}

/**
 * Make a driver's open assignments of one kind match `assetIds` exactly: release whatever
 * they hold that isn't in the list, assign whatever's in the list that they don't hold yet.
 * This is the shape the Drivers screen's multi-select already thinks in — "here is the full
 * set this driver should hold now" — so the controller can hand it the desired state directly
 * instead of diffing itself.
 *
 * Best-effort: one asset failing (already held elsewhere and blocked by an overlap, say) is
 * collected and reported back rather than aborting the rest of the batch.
 */
async function syncAssignments({ driverId, assetKind, assetIds, actor }) {
  const wanted = new Set((assetIds || []).map(String));
  const current = await Assignment.find({ assetKind, driverId, endedAt: OPEN });
  const currentIds = new Set(current.map((row) => String(row.assetId)));

  const errors = [];
  for (const row of current) {
    if (wanted.has(String(row.assetId))) continue;
    try {
      await release({ assignmentId: row._id, actor });
    } catch (err) {
      if (err instanceof CustodyError) errors.push({ assetId: String(row.assetId), error: err.message });
      else throw err;
    }
  }
  for (const assetId of wanted) {
    if (currentIds.has(assetId)) continue;
    try {
      await assign({ assetKind, assetId, driverId, actor });
    } catch (err) {
      if (err instanceof CustodyError) errors.push({ assetId, error: err.message });
      else throw err;
    }
  }
  return { errors };
}

module.exports = {
  assign,
  release,
  releaseAllForDriver,
  syncAssignments,
  CustodyError,
  OPEN,
};
