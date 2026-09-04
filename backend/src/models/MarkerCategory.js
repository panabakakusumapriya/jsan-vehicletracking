const mongoose = require('mongoose');

/**
 * A marker category, defined by admins in the portal: "Accident on the road" (red),
 * "Closed road" (blue), "Private property" (blue)...
 *
 * The colour is the flag the driver picks and the dot everyone sees; the name is what it means.
 * Categories are referenced by markers, so deleting one that markers still use is refused
 * (409 from the controller) — deactivate instead, which hides it from the driver's picker
 * while keeping history legible.
 */
const markerCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /** #rrggbb — rendered directly as the dot colour on every map. */
    color: { type: String, required: true, trim: true, lowercase: true, default: '#ef4444' },
    /** The reasons this flag covers, comma-separated — shown under the name in the driver's
     *  picker, so ONE tap on the colour covers every listed reason. */
    description: { type: String, trim: true, default: null },
    active: { type: Boolean, default: true },
    /** Picker/list order; appended categories go last. */
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MarkerCategory', markerCategorySchema);
