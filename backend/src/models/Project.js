const mongoose = require('mongoose');

/**
 * A project is the tenancy boundary managers and team leads operate inside. Admins created
 * projects here rather than everyone typing a free-text label, so "which project is this
 * driver on" is an actual lookup instead of a string that drifts (typos, casing, duplicates).
 */
const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    code: { type: String, trim: true, default: null },
    country: { type: String, trim: true, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', projectSchema);
