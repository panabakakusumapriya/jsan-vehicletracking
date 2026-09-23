const mongoose = require('mongoose');

/** Imported hotel directory with a unique source ID and a geospatial map index. */
const hotelLocationSchema = new mongoose.Schema(
  {
    // Overture's UUID for this place. Unique, and the key re-imports match on — which is what
    // makes the import idempotent rather than additive. Kept as a string: an identifier that
    // happens to contain digits is not a number.
    sourceId: { type: String, required: true },

    name: { type: String, default: null, trim: true },

    // Overture's fine-grained classification: hotel, motel, hostel, bed_and_breakfast, resort,
    // guest_house and a long tail besides. `basicCategory` is the coarser grouping it rolls up
    // into, which is the one actually usable as a filter.
    category: { type: String, default: null, trim: true },
    basicCategory: { type: String, default: null, trim: true },

    // Overture's own 0..1 confidence that this place is what it says it is. Carried through
    // rather than filtered at import: where the bar should sit is a question for whoever is
    // reading, and dropping the evidence would make it unanswerable.
    confidence: { type: Number, default: null },

    phone: { type: String, default: null, trim: true },
    website: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true },

    // The postal address, split as the source splits it. Kept as separate fields rather than one
    // string because "every hotel in this city" is a question worth being able to ask.
    address: { type: String, default: null, trim: true },
    city: { type: String, default: null, trim: true },
    stateOrRegion: { type: String, default: null, trim: true },
    postalCode: { type: String, default: null, trim: true },
    isoCountry: { type: String, default: null, trim: true, uppercase: true },

    // GeoJSON Point, [lon, lat] — the same shape CourierLocation and RoadLink use, so 2dsphere
    // queries look identical everywhere in this codebase. The CSV also carries scalar
    // latitude/longitude columns; they are not stored twice, because two copies of a coordinate
    // is two chances to disagree.
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },

    // Which import produced this row, so a bad delivery can be identified and replaced without
    // guessing which rows came from where.
    sourceFile: { type: String, default: null },
  },
  { timestamps: true }
);

// The identity. Unique so a re-import updates in place instead of inserting a million duplicates.
hotelLocationSchema.index({ sourceId: 1 }, { unique: true });
// The whole point of the collection: "what is near this driver". Without this a $near cannot run
// at all — MongoDB refuses geospatial queries with no index rather than scanning.
hotelLocationSchema.index({ location: '2dsphere' });
// Country and category browsing, and per-country rollups.
hotelLocationSchema.index({ isoCountry: 1, category: 1 });

module.exports = mongoose.model('HotelLocation', hotelLocationSchema);
