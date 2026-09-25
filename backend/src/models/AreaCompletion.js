const mongoose = require('mongoose');

/**
 * A manager's verdict that a work area has been driven and is finished.
 *
 * Deliberately NOT a field on WorkArea or AreaAssignment, for two reasons that both bite:
 *
 *  1. `WorkArea` rows are re-created by every network import — the same real-world suburb has a
 *     different `_id` in each version, and this project already has five. A completion stored on
 *     the polygon row would silently vanish the next time the customer sends a delivery. The
 *     customer's `areaCode` is the identity that survives, which is the same reason
 *     `listAssignments` and `assignedAreasForTrip` both resolve by `areaCode` rather than `areaId`.
 *
 *  2. `AreaAssignment` is one driver's stint, not the state of the ground. An area finished by
 *     driver A must still read as finished after A is released and B is hired.
 *
 * `coverageCycleId` is in the key on purpose: a new capture cycle is the customer paying to drive
 * the same streets again, so every area must reopen by itself when the cycle turns over. `''` (not
 * null) means "no cycle", matching CoverageSegment's convention so the two ledgers agree.
 *
 * Completion here is a HUMAN judgement, not a computed threshold. 100 % is not reachable in the
 * field — private roads, gated estates, closed roads and plain errors in the customer's file mean
 * the last few percent often cannot be driven at all — so a manager cross-verifies the ledger and
 * signs the area off. `pctAtCompletion` records what the numbers actually said at that moment, so
 * a sign-off at 44 % is visible as such forever after.
 */
const areaCompletionSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    // '' = the project has no cycle set; never null. See the note above.
    coverageCycleId: { type: String, required: true, default: '' },
    // The customer's stable area identity (SA2 code in delivery 1) — NOT our per-version _id.
    areaCode: { type: String, required: true },

    status: { type: String, enum: ['completed', 'reopened'], default: 'completed', index: true },

    // Snapshots of what the ledger said when the manager signed it off. Kept rather than
    // recomputed so the decision stays auditable after later driving moves the numbers.
    pctAtCompletion: { type: Number, default: null },
    coveredMeters: { type: Number, default: null },
    targetMeters: { type: Number, default: null },
    // Whoever first-covered the most metres inside the area at sign-off. Recorded because
    // first-cover-wins is fleet-wide: an area can go green because a different crew drove it, and
    // "completed" must not silently imply the assigned driver did the work.
    completedByDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedByDriverName: { type: String, default: null },
    // Which polygon row and network version the verdict was made against, for forensics only.
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkArea', default: null },
    networkVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'NetworkVersion', default: null },
    areaName: { type: String, default: null },

    completedAt: { type: Date, default: null },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedByName: { type: String, default: null },
    note: { type: String, default: null },

    reopenedAt: { type: Date, default: null },
    reopenedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reopenReason: { type: String, default: null },
  },
  { timestamps: true }
);

// One verdict per area per cycle. Reopening flips `status` on the same row rather than deleting
// it, so the history of who signed what off, and when, is never lost.
areaCompletionSchema.index(
  { projectId: 1, coverageCycleId: 1, areaCode: 1 },
  { unique: true, name: 'area_completion_identity' }
);

module.exports = mongoose.model('AreaCompletion', areaCompletionSchema);
