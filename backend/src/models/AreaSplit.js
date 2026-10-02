const mongoose = require('mongoose');

/**
 * The record of one work area being split into zones — and the way back.
 *
 * A manager picks an area that is too big for one driver, types the size a zone should be, and the
 * area is replaced by zones (services/workAreaSplit.js). Three things have to outlive that moment,
 * and they live here rather than on the zones:
 *
 *  - `places`: the OpenStreetMap place names the zones were cut from. Looked up once, at preview,
 *    and used again when the split is applied — so what is written is what was previewed, whatever
 *    the map server would answer a minute later.
 *  - `parent`: the area exactly as it was, _id included. Splitting deletes the area; a manager who
 *    then wants 300 km zones instead of 250 needs it back. Joining the zones restores this
 *    document rather than trying to weld polygons together again.
 *  - who did it and with what sizes, because "why are there 16 Aucklands" will be asked.
 *
 * One per area per network version: a second split of the same area reuses the record.
 */
const areaSplitSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    networkVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'NetworkVersion', required: true },
    /** The code of the area that was split — the zones' codes are this plus "-01", "-02"… */
    areaCode: { type: String, required: true },
    areaName: { type: String, default: null },

    /** preview: sizes tried, nothing written · applied: the zones exist · joined: put back. */
    status: { type: String, enum: ['preview', 'applied', 'joined'], default: 'preview' },

    options: {
      minKm: { type: Number, default: null },
      maxKm: { type: Number, default: null },
      absorbRemainder: { type: Boolean, default: true },
    },

    places: { type: [mongoose.Schema.Types.Mixed], default: [] },
    placesSource: { type: String, default: null },

    /** The WorkArea document that was replaced, whole. Null until the split is applied. */
    parent: { type: mongoose.Schema.Types.Mixed, default: null },
    zoneCodes: { type: [String], default: [] },
    /**
     * Links of the area that were given to no zone: the odd road on a far-off islet, too little
     * for a zone of its own (areaSplit's strandedKm). They sit outside every area while the split
     * stands; joining puts them back on the area.
     */
    strandedLinkIds: { type: [String], default: [] },

    splitBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    splitAt: { type: Date, default: null },
    joinedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    joinedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

areaSplitSchema.index({ networkVersionId: 1, areaCode: 1 }, { unique: true });

module.exports = mongoose.model('AreaSplit', areaSplitSchema);
