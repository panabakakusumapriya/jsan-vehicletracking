const mongoose = require('mongoose');

/**
 * A customer shapefile delivery working its way in, from upload to committed NetworkVersion.
 *
 * Background for the same reason exports are (see models/ExportJob.js): the first delivery is
 * 160 MB across two zips, and committing it writes 654,447 links. That is minutes of work, not
 * something an HTTP request can hold open.
 *
 * The stage that matters is `awaiting_approval`. Parsing produces a report — CRS and datum,
 * geometry validity, duplicate IDs, links landing outside every polygon, the attribute columns we
 * think map to id/name/priority — and NOTHING is written to the live collections until a human
 * has read it and pressed commit. A boundary file that is subtly wrong is very cheap to reject at
 * this point and very expensive to discover after three months of coverage has been reported
 * against it.
 */
const importJobSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    label: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: [
        'draft', // created; waiting for both zips to be uploaded
        'queued', // validate requested, runner has not picked it up
        'parsing', // reading the shapefiles, building the report
        'awaiting_approval', // report ready, nothing written yet
        'committing', // writing areas + links
        'ready', // committed; networkVersionId is populated
        'failed',
        'cancelled',
      ],
      default: 'draft',
      index: true,
    },

    // Two layers, uploaded separately, validated together — the orphan-link check needs both.
    files: {
      boundary: {
        name: { type: String, default: null },
        bytes: { type: Number, default: 0 },
        // On-disk CACHE path only. Railway's filesystem is ephemeral, so this may vanish at any
        // moment; `fileId` below is the copy that actually survives. See utils/fileStore.js.
        path: { type: String, default: null },
        // GridFS id — the durable original.
        fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
        sha256: { type: String, default: null },
        uploadedAt: { type: Date, default: null },
      },
      network: {
        name: { type: String, default: null },
        bytes: { type: Number, default: 0 },
        path: { type: String, default: null },
        fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
        sha256: { type: String, default: null },
        uploadedAt: { type: Date, default: null },
      },
    },

    // Which .dbf column means what. Defaulted by sniffing the header, overridable by the operator
    // before commit, because the next delivery will not use the same column names.
    mapping: {
      areaCode: { type: String, default: null },
      areaName: { type: String, default: null },
      areaParent: { type: String, default: null },
      priority: { type: String, default: null },
      areaSqm: { type: String, default: null },
      linkId: { type: String, default: null },
      linkName: { type: String, default: null },
      funcClass: { type: String, default: null },
      dirTravel: { type: String, default: null },
      autoAccess: { type: String, default: null },
    },

    // Whether the 999-links-outside-every-polygon population counts toward the project. An
    // explicit setting with an explicit default, so it can never become a silent drop.
    includeOrphanLinks: { type: Boolean, default: false },

    /**
     * Run straight through upload -> parse -> commit without waiting for a human.
     *
     * On by default, because the normal case is "load the customer's files and show me them" and
     * an approval click in the middle of that is ceremony, not safety. The safety is still there:
     * a report with BLOCKING errors parks at `awaiting_approval` regardless of this flag, so the
     * only imports that stop are the ones that should.
     */
    autoCommit: { type: Boolean, default: true },

    // The preflight report — see services/networkImport.js#buildReport for its shape.
    report: { type: mongoose.Schema.Types.Mixed, default: null },

    progress: {
      phase: { type: String, default: null },
      done: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    networkVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NetworkVersion',
      default: null,
    },

    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Extracted shapefiles are large and reproducible from the uploaded zip, so the artifacts are
    // swept. The job document itself is kept — the report is the record of what we accepted.
    artifactsExpireAt: { type: Date, default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

importJobSchema.index({ projectId: 1, createdAt: -1 });

module.exports = mongoose.model('ImportJob', importJobSchema);
