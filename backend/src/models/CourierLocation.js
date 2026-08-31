const mongoose = require('mongoose');

/**
 * A physical courier / delivery point — UPS access point, FedEx ship centre, package locker,
 * post office. Imported from `carriers_world.geojson`: 67,960 points across 167 countries.
 *
 * Why this collection exists alongside services/courierSearch.js
 * -------------------------------------------------------------
 * That service answers "where can this driver drop a parcel" by calling Serper.dev Places, which
 * is metered — and metered on a free tier that is a ONE-TIME 2,500-query bucket, not a monthly
 * reset (see COURIER_DAILY_CALL_CAP in config/env.js, deliberately set low for exactly that
 * reason). Every lookup spends a slice of a budget that never refills.
 *
 * This is the same question answered from data we hold. A $near against the 2dsphere index below
 * costs nothing, works offline, returns the same answer twice, and cannot be rate-limited at the
 * worst possible moment. Where the dataset has coverage it should be consulted first; the live
 * search is then a fallback for the places it does not, rather than the only route.
 *
 * Reference data, not operational data
 * ------------------------------------
 * Nothing here is produced by this fleet — it is a third-party snapshot of the world. Which means
 * it is safe to re-import, safe to drop and rebuild, and must never be the place anything about a
 * trip, driver or parcel is recorded. `sourceId` carries the provider's own identifier so a later
 * delivery of the same file updates rows in place instead of duplicating the planet.
 */
const courierLocationSchema = new mongoose.Schema(
  {
    // The provider's UUID for this place. Unique, and the key re-imports match on — which is what
    // makes the import idempotent rather than additive. Kept as a string: it is an identifier that
    // happens to contain digits, never a number.
    sourceId: { type: String, required: true },

    name: { type: String, default: null, trim: true },
    // Present on only ~12k of 68k rows — the chains (UPS, FedEx, DHL). Null is the common case, so
    // anything grouping by brand has to cope with it rather than assuming a label exists.
    brand: { type: String, default: null, trim: true },

    // The provider's fine-grained classification: courier_and_delivery_service, package_locker,
    // post_office, shipping_center and ~309 others. 416 rows carry none.
    category: { type: String, default: null, trim: true },
    // The coarser grouping the provider rolls `category` up into. Useful because the long tail of
    // categories is unusable as a filter on its own.
    basicCategory: { type: String, default: null, trim: true },

    // The provider's own 0..1 confidence that this place is what it says it is. Carried through
    // rather than filtered at import: where the bar should sit is a question for whoever is
    // reading, and dropping the evidence would make it unanswerable.
    confidence: { type: Number, default: null },

    phone: { type: String, default: null, trim: true },
    website: { type: String, default: null, trim: true },
    address: { type: String, default: null, trim: true },

    // ISO country of the point itself. `addrCountry` is what the source address claimed, kept
    // separately because the two disagree on border cases and neither is automatically right.
    isoCountry: { type: String, default: null, trim: true, uppercase: true },
    addrCountry: { type: String, default: null, trim: true, uppercase: true },
    // north_america, europe, asia, south_america, africa, oceania — plus 'unassigned' for 3 rows
    // the provider could not place. Denormalised from country so a continent rollup is a filter
    // rather than a 167-entry lookup table nobody maintains.
    continent: { type: String, default: null, trim: true },

    // GeoJSON Point, [lon, lat] — the same shape RoadLink uses, so the 2dsphere queries look the
    // same everywhere in this codebase. The source also carries scalar lon/lat properties; they
    // are not stored twice, because two copies of a coordinate is two chances to disagree.
    location: {
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    },

    // Which import produced this row. Lets a bad delivery be identified and replaced without
    // guessing which rows came from where.
    sourceFile: { type: String, default: null },
  },
  { timestamps: true }
);

// The identity. Unique so a re-import updates in place instead of inserting 68k duplicates.
courierLocationSchema.index({ sourceId: 1 }, { unique: true });
// The whole point of the collection: "what is near this driver". Without this a $near cannot run
// at all — MongoDB refuses geospatial queries with no index rather than scanning.
courierLocationSchema.index({ location: '2dsphere' });
// Country and category browsing, and the per-country rollups on the couriers page.
courierLocationSchema.index({ isoCountry: 1, category: 1 });
// Brand lookups ("nearest UPS"), which are a filter applied alongside the geo query.
courierLocationSchema.index({ brand: 1 });

module.exports = mongoose.model('CourierLocation', courierLocationSchema);
