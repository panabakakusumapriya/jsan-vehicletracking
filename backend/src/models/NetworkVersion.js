const mongoose = require('mongoose');

/**
 * One import of a customer's work areas + target road network, frozen as a version.
 *
 * The customer sends the network as a shapefile ("Updated_P1_VIC" — the name says out loud that
 * there will be another one). Geometry is therefore immutable and versioned, while coverage
 * (see LinkCoverage) is mutable and belongs to a version. Keeping the two apart means a re-drive
 * next year resets progress without touching a single line of geometry, and a corrected boundary
 * file does not silently rewrite what we already reported as done.
 *
 * Exactly one version per project may be `active` at a time — that is the one attribution writes
 * against and every dashboard reads. Older ones become `superseded` but are never deleted on
 * activation, because the numbers we already invoiced against still have to be reproducible.
 */
const networkVersionSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    label: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ['building', 'ready', 'active', 'superseded', 'failed'],
      default: 'building',
      index: true,
    },

    // The .prj strings exactly as they arrived, per layer. The two files in the first delivery
    // disagreed — boundaries in GDA94, roads in WGS84, ~1.8 m apart in Victoria and widening
    // ~7 cm a year. Everything is normalised to WGS84 on import; this records what it came from
    // so the question can be answered later instead of argued about.
    sourceCRS: {
      boundary: { type: String, default: null },
      network: { type: String, default: null },
    },

    // SHA-256 of each uploaded zip. Re-uploading the same file is then detectable rather than
    // producing a second identical version nobody can tell apart.
    sourceHash: {
      boundary: { type: String, default: null },
      network: { type: String, default: null },
    },

    counts: {
      areas: { type: Number, default: 0 },
      links: { type: Number, default: 0 },
      // Links that fell outside every polygon — boundary-clipping slivers. Counted, never
      // silently dropped: whether they are in scope is the customer's call, not ours.
      orphanLinks: { type: Number, default: 0 },
    },

    // The project denominator. Every "% complete" anywhere in the product divides by this.
    targetMeters: { type: Number, default: 0 },
    orphanMeters: { type: Number, default: 0 },

    // Precomputed rollups so the summary endpoint is a document read, not an aggregation over
    // 654k links.
    byPriority: {
      type: [
        {
          _id: false,
          priority: Number,
          areas: Number,
          links: Number,
          meters: Number,
        },
      ],
      default: [],
    },
    byFuncClass: {
      type: [
        {
          _id: false,
          funcClass: Number,
          links: Number,
          meters: Number,
        },
      ],
      default: [],
    },

    importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    activatedAt: { type: Date, default: null },
    activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: null },
  },
  { timestamps: true }
);

networkVersionSchema.index({ projectId: 1, createdAt: -1 });
// Serves "the current target network for this project", which every attribution run asks for.
networkVersionSchema.index({ projectId: 1, status: 1 });

module.exports = mongoose.model('NetworkVersion', networkVersionSchema);
