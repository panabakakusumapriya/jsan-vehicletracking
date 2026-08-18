const mongoose = require('mongoose');

/**
 * A bulk export that runs in the background instead of inside the request.
 *
 * Zipping every trip in a range is unbounded work: hundreds of trips, thousands of points each,
 * and for the snapped variant a polyline decode per trip on top. Doing that inside the HTTP
 * request meant the browser sat on an open connection until it finished or a proxy timed it out
 * mid-stream — and a truncated zip looks like a successful download until you try to open it.
 *
 * So the request only creates one of these and returns immediately. A worker builds the file on
 * disk, records progress as it goes, and the client downloads it once `status` is 'ready'.
 */
const exportJobSchema = new mongoose.Schema(
  {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    format: { type: String, enum: ['kml', 'json'], default: 'kml' },
    // 'snapped' exports each trip's map-matched route + UKM layer; 'raw' the recorded trace.
    layer: { type: String, enum: ['raw', 'snapped'], default: 'raw' },
    // The trip filter as resolved at request time, so the job is reproducible and the worker
    // never has to re-derive the requester's scope later (their permissions could change).
    filter: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: ['queued', 'running', 'ready', 'failed'],
      default: 'queued',
      index: true,
    },
    total: { type: Number, default: 0 },
    done: { type: Number, default: 0 },
    // Count of trips written as raw because they had no snapped route — surfaced so a "snapped"
    // download that is quietly part-raw does not pass unnoticed.
    fellBackToRaw: { type: Number, default: 0 },
    fileName: { type: String, default: null },
    filePath: { type: String, default: null },
    bytes: { type: Number, default: 0 },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Artifacts are disposable: the job can always be re-run. TTL lets Mongo drop the record and
    // the cleanup sweep delete the file, so finished exports cannot accumulate on disk forever.
    expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

exportJobSchema.index({ requestedBy: 1, createdAt: -1 });
exportJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('ExportJob', exportJobSchema);
