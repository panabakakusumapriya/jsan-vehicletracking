const mongoose = require('mongoose');

const ASSET_KINDS = ['vehicle', 'mobile'];

/**
 * "Still held" is stored as a far-future date rather than null. See §4 of
 * docs/asset-custody-design.md — the short version:
 *
 *   null  -> every point-in-time query needs `$or: [{endedAt: null}, {endedAt: {$gt: t}}]`,
 *            and MongoDB cannot serve an $or from one index. Measured on 6k rows it examined
 *            506 documents to return 446, and needed partial indexes for the invariants.
 *   OPEN  -> "open" is just a value, so the range predicate is a plain IXSCAN touching
 *            exactly the documents it returns, and ordinary unique indexes enforce the
 *            invariants below.
 *
 * The sentinel never reaches an API consumer: toJSON maps it back to `endedAt: null`.
 */
const OPEN = new Date('9999-12-31T00:00:00.000Z');

/**
 * One row = one stint of custody. Append-only: reassigning CLOSES the open row and OPENS a
 * new one, so history cannot be overwritten the way User.vehicleId could.
 */
const assignmentSchema = new mongoose.Schema(
  {
    assetKind: { type: String, enum: ASSET_KINDS, required: true },
    assetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true, default: () => OPEN },

    // ---- Snapshots ----
    // A report for March must still read correctly after the truck is sold, the plate
    // re-issued, the manager changed or the driver deleted. Storing only assetId would make
    // old rows resolve to today's names, or to nothing at all.
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    country: { type: String, trim: true, default: null },
    // Snapshotted for the same reason as country: a driver moving project must not rewrite
    // which project last month's assets belonged to. Captured from the start so the data is
    // there when it's needed — a filter can be added later, but history cannot be re-learned.
    project: { type: String, trim: true, default: null },
    assetLabel: { type: String, trim: true, default: null },
    driverName: { type: String, trim: true, default: null },

    // ---- Audit ----
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, trim: true, default: null },
    // true = inferred by the backfill migration, not observed. The UI says "since at least…"
    // for these, because a guessed date presented as fact is worse than an honest unknown.
    backfilled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// ---- Invariants, enforced by the database rather than by code that might forget ----
// Because "open" is a fixed value, this plain unique index makes a double-assignment a
// write error (E11000) instead of a corruption discovered months later in a report.
// An asset still has exactly ONE holder at a time — a truck can't be driven by two people at
// once, and a handset can't be in two pockets. Enforced here.
assignmentSchema.index({ assetKind: 1, assetId: 1, endedAt: 1 }, { unique: true });
// NOT unique: a driver may hold several assets of the same kind at once (several vehicles,
// several handsets) — that's the whole point of the multi-asset Drivers screen. Kept as a
// plain index for the "what does this driver hold right now" lookups in
// assetCustody.syncAssignments and the cache-recompute in clearCaches.
assignmentSchema.index({ assetKind: 1, driverId: 1, endedAt: 1 });

// ---- Read paths ----
assignmentSchema.index({ startedAt: 1, endedAt: 1 }); // month-overlap report
assignmentSchema.index({ driverId: 1, startedAt: -1 }); // one driver's timeline
assignmentSchema.index({ assetKind: 1, assetId: 1, startedAt: -1 }); // one asset's life story

assignmentSchema.virtual('isOpen').get(function isOpen() {
  return this.endedAt && this.endedAt.getTime() === OPEN.getTime();
});

// Keep the sentinel inside the data layer: consumers see the natural `endedAt: null`.
function presentation(doc, ret) {
  if (ret.endedAt && new Date(ret.endedAt).getTime() === OPEN.getTime()) {
    ret.endedAt = null;
    ret.open = true;
  } else {
    ret.open = false;
  }
  return ret;
}
assignmentSchema.set('toJSON', { virtuals: true, transform: presentation });
assignmentSchema.set('toObject', { virtuals: true, transform: presentation });

const Assignment = mongoose.model('Assignment', assignmentSchema);
Assignment.OPEN = OPEN;
Assignment.ASSET_KINDS = ASSET_KINDS;

/** Rows overlapping the half-open window [from, to). The one predicate the design rests on. */
Assignment.overlapFilter = function overlapFilter(from, to) {
  return { startedAt: { $lt: to }, endedAt: { $gt: from } };
};

module.exports = Assignment;
