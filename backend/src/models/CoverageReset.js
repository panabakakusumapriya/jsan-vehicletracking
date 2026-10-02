const mongoose = require('mongoose');

/**
 * "Clear the driven data for this area" — the record that makes it stick.
 *
 * The coverage ledger (LinkCoverage) is fleet-wide and first-cover-wins, so an area handed to a
 * second driver opens on their phone already blue wherever anyone has driven before. For a trial
 * run, or an area that has to be driven again from scratch, a manager can clear it: every road in
 * the area goes back to "to drive".
 *
 * Deleting the ledger rows is not enough. The ledger is DERIVED — attribution re-runs when a trip
 * is re-matched, and rebuildNetworkCoverage clears and replays a whole version — so the same old
 * trips would simply claim the same roads again and the area would turn blue by itself a day
 * later. This row is what stops that: driving observed at or before `resetAt` no longer counts
 * for the links listed here. Driving after it counts as normal.
 *
 * Keyed by the customer's LINK_IDs rather than by the area, on purpose. Areas are re-created by
 * every delivery and can be split into zones and joined back; a road is the same road throughout.
 *
 * One row per clear, never updated: together they are also the audit trail of who wiped what.
 */
const coverageResetSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    // Where it was done from. Informational — the rule itself follows the links.
    networkVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'NetworkVersion', default: null },
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkArea', default: null },
    areaCode: { type: String, default: null },
    areaName: { type: String, default: null },

    /** Driving observed at or before this moment does not count for `linkIds`. */
    resetAt: { type: Date, required: true },
    linkIds: { type: [String], default: [] },

    // What was wiped, for the record.
    clearedLinks: { type: Number, default: 0 },
    clearedMeters: { type: Number, default: 0 },
    tripsAffected: { type: Number, default: 0 },

    clearedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    clearedByName: { type: String, default: null },
    note: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// The lookup attribution makes for every trip: "were any of these links cleared, and when?"
coverageResetSchema.index({ projectId: 1, linkIds: 1 });
coverageResetSchema.index({ projectId: 1, areaCode: 1, resetAt: -1 });

module.exports = mongoose.model('CoverageReset', coverageResetSchema);
