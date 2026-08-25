const mongoose = require('mongoose');

/**
 * Which driver is responsible for which work area.
 *
 * Deliberately NOT folded into the Assignment model used for vehicles and handsets. That one
 * enforces "an asset has exactly one holder at a time" with a unique index, which is correct for a
 * truck and wrong here: a 1,400 km² rural area can reasonably be shared between crews, and a driver
 * covers many areas. Extending its enum would have meant weakening an invariant that is currently
 * protecting real data.
 *
 * Append-only in the same spirit though: releasing sets `releasedAt` rather than deleting the row,
 * so "who was responsible for this area in March" stays answerable after the roster changes.
 */
const areaAssignmentSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    networkVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NetworkVersion',
      required: true,
    },
    areaId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkArea', required: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Snapshots, for the same reason Assignment keeps them: a name resolved at read time turns
    // last month's record into today's roster the moment somebody is renamed or removed.
    areaName: { type: String, trim: true, default: null },
    areaCode: { type: String, trim: true, default: null },
    driverName: { type: String, trim: true, default: null },

    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: Date.now },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Null means still held. Unlike Assignment there is no sentinel here: the queries this
    // collection serves are "who holds it now" and "one area's history", neither of which needs
    // the point-in-time range scan that made the sentinel worth its awkwardness there.
    releasedAt: { type: Date, default: null },
    note: { type: String, trim: true, default: null },
  },
  { timestamps: true }
);

// One live row per (area, driver) — assigning the same driver twice is a no-op, not a duplicate.
// Partial so released rows accumulate freely as history.
areaAssignmentSchema.index(
  { areaId: 1, driverId: 1 },
  { unique: true, partialFilterExpression: { releasedAt: null } }
);
// "Who is on this version right now", which is what the map colours by.
areaAssignmentSchema.index({ networkVersionId: 1, releasedAt: 1 });
// One driver's patch, for the driver app and the workload view.
areaAssignmentSchema.index({ driverId: 1, releasedAt: 1 });
areaAssignmentSchema.index({ areaId: 1, assignedAt: -1 });

module.exports = mongoose.model('AreaAssignment', areaAssignmentSchema);
