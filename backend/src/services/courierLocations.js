const CourierLocation = require('../models/CourierLocation');
const env = require('../config/env');

/**
 * Nearby courier / drop-off points, answered from our own imported dataset instead of a metered
 * Places API. Drop-in replacement for serperCouriers.js#searchNearby.
 *
 * What this removes, and why it matters more than "one less API call"
 * ------------------------------------------------------------------
 * Serper's free allowance is a ONE-TIME 2,500-query bucket that never refills, which is why the
 * old path carried a daily cap, an aggressive cache and a budget readout on the page. Every
 * lookup spent a slice of something finite. This costs nothing, works with no network, cannot be
 * rate-limited at the worst possible moment, and returns the same answer twice — so the cache and
 * the budget both stop being concepts the reader has to think about.
 *
 * It also removes a whole hop. Serper has no working coordinate parameter (see the header of
 * serperCouriers.js), so the old flow had to reverse-geocode the driver's lat/lon into a place
 * NAME through Nominatim first, and a failure there meant no results at all. A $geoNear takes the
 * coordinates directly. The place name is now only ever a label.
 *
 * Why nothing is filtered by category
 * -----------------------------------
 * Tempting, and wrong. The very first spot-check of this data returned "DHL Express Service Point
 * (Pall Mall)" filed under `b2b_business_management_service`, and FedEx Office branches are filed
 * under `printing_service`. The provider's categories describe what the SHOP is, not whether you
 * can hand it a parcel. The dataset is already curated to carriers — that is what it is for — so
 * filtering it again against our own guesses would drop real drop-off points and nobody would
 * notice. Category is returned for display, and offered as an explicit opt-in filter for a caller
 * who genuinely wants one, but it is never applied silently.
 */

/** Real distance is what enforces the radius, exactly as it did with the provider's results. */
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * Drop-off points within `radiusKm` of a coordinate, nearest first.
 *
 * Returns the same place shape the Serper path produced, so the controller and the React page do
 * not have to care which source answered. `rating`/`ratingCount` come back null/0 because this
 * dataset has no review data — deliberately NOT filled in from the provider's `confidence`, which
 * measures "are we sure this place exists", not "is it any good". Conflating the two would put a
 * number under a ★ that means something else entirely.
 */
async function nearbyCouriers({ lat, lon, radiusKm, limit, brand = null, category = null }) {
  const radius = clamp(parseInt(radiusKm, 10) || env.COURIER_DEFAULT_RADIUS_KM, 1, 200);
  const max = clamp(parseInt(limit, 10) || env.COURIER_MAX_RESULTS, 1, 200);

  // $geoNear must be the first stage, and it is the only one that can use the 2dsphere index.
  // `query` filters INSIDE it rather than in a later $match, so the index does the narrowing
  // instead of the pipeline sorting the whole country and discarding most of it.
  const query = {};
  if (brand) query.brand = brand;
  if (category) query.category = category;

  const rows = await CourierLocation.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [lon, lat] },
        distanceField: 'distanceMeters',
        maxDistance: radius * 1000,
        spherical: true,
        ...(Object.keys(query).length ? { query } : {}),
      },
    },
    { $limit: max },
    {
      $project: {
        sourceId: 1, name: 1, brand: 1, category: 1, basicCategory: 1,
        address: 1, phone: 1, website: 1, isoCountry: 1, confidence: 1,
        location: 1, distanceMeters: 1,
      },
    },
  ]);

  const places = rows.map((r) => ({
    id: r.sourceId,
    name: r.name || 'Unnamed location',
    address: r.address || null,
    // Underscored provider slugs are unreadable in a table: courier_and_delivery_service.
    category: r.category ? r.category.replace(/_/g, ' ') : null,
    phone: r.phone || null,
    website: r.website || null,
    // No review data in this dataset. Kept as nulls rather than dropped from the shape so the
    // page renders identically whichever source answered.
    rating: null,
    ratingCount: 0,
    lat: r.location.coordinates[1],
    lon: r.location.coordinates[0],
    distanceKm: Math.round(r.distanceMeters / 100) / 10,
    // --- richer than the provider gave us ---
    brand: r.brand || null,
    // The dataset's own 0..1 certainty that the place is what it claims. Surfaced so a low-
    // confidence hit can be treated with suspicion instead of looking identical to a certain one.
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    isoCountry: r.isoCountry || null,
  }));

  return { places, totalFound: places.length, radiusKm: radius };
}

/** How much of the world this dataset actually holds — for the "no results" case to be honest. */
async function datasetStatus() {
  const total = await CourierLocation.estimatedDocumentCount();
  return { total, source: 'CourierLocation', metered: false };
}

module.exports = { nearbyCouriers, datasetStatus };
