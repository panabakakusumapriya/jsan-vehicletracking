const mongoose = require('mongoose');

const appVersionSchema = new mongoose.Schema(
  {
    version: { type: String, required: true, unique: true }, // e.g. "1.0.0"
    platform: { type: String, enum: ['android', 'ios', 'both'], default: 'android' },
    buildNumber: { type: String, default: '' },
    downloadUrl: { type: String, default: '' },
    releaseNotes: { type: String, default: '' },
    isActive: { type: Boolean, default: false }, // the "required minimum" version
    releasedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppVersion', appVersionSchema);
