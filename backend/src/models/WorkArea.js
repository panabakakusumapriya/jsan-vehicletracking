const mongoose = require('mongoose');

/**
 * One polygon the customer wants driven — in the first delivery, an ABS SA2 statistical area
 * carrying a customer-added `Priority` column. This is the work breakdown: crews are dispatched
 * by area, and progress is reported by area.
 *
 * `targetMeters` / `targetLinks` are filled in at import time by the link -> area spatial join,
 * so no dashboard query ever has to run a geo join to answer "how much is in this area".
 */
const workAreaSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true },
    networkVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NetworkVersion',
      required: true,
    },

    // The customer's own identifier for the area (SA2_21CODE). Their ID, not ours — an audit
    // against their spreadsheet has to line up without a translation step.
    areaCode: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    // The next level up (SA3 name), used purely for grouping 402 areas into something a human
    // can scan.
    parentName: { type: String, default: null, trim: true },

    // Customer priority band. Deliberately a plain number with no enum: the meaning of the bands
    // is the customer's, and in the first delivery P0 looks like "unset" rather than "urgent"
    // (P0 areas average 231 km2 of countryside; P1 averages 10.8 km2 of city). Ordering is a
    // project setting, not a truth baked into the schema.
    priority: { type: Number, default: 0, index: true },

    geometry: {
      type: { type: String, enum: ['Polygon', 'MultiPolygon'], required: true },
      coordinates: { type: Array, required: true },
    },

    /**
     * A simplified copy of `geometry` for drawing only, computed once at import.
     *
     * The 402 areas in the first delivery carry 263,795 vertices — 7.4 MB of GeoJSON to hand a
     * browser for outlines a few pixels wide. At a 25 m tolerance that becomes 0.86 MB with no
     * visible difference on screen. Deliberately NOT indexed and never used for containment: which
     * links belong to an area is decided against the full geometry above, so a smoothed boundary
     * can never move a road into the wrong area.
     */
    outline: {
      type: { type: String, enum: ['Polygon', 'MultiPolygon'], default: undefined },
      coordinates: { type: Array, default: undefined },
    },
    // Cheap pre-filter for viewport queries, so the panel can list areas in view without paying
    // for a 2dsphere lookup on every pan. [west, south, east, north]
    bbox: { type: [Number], default: undefined },

    areaSqm: { type: Number, default: null },

    targetMeters: { type: Number, default: 0 },
    targetLinks: { type: Number, default: 0 },

    // Everything else that came out of the .dbf, kept verbatim. The customer's columns are their
    // business and change between deliveries; dropping them on import would mean a re-import to
    // answer a question we did not anticipate.
    props: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// One area code per version — catches a duplicated feature in the source file at insert time
// rather than as a double-counted denominator three months later.
workAreaSchema.index({ networkVersionId: 1, areaCode: 1 }, { unique: true });
// The areas table: filter by version, order by priority then size of the job.
workAreaSchema.index({ networkVersionId: 1, priority: 1, targetMeters: -1 });
workAreaSchema.index({ geometry: '2dsphere' });

module.exports = mongoose.model('WorkArea', workAreaSchema);
