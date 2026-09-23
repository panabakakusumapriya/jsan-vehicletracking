const HotelLocation = require('../models/HotelLocation');
const env = require('../config/env');

/** Find imported accommodation by distance using the HotelLocation geospatial index. */

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * Accommodation within `radiusKm` of a coordinate, nearest first.
 */
async function nearbyHotels({ lat, lon, radiusKm, limit, category = null, isoCountry = null }) {
  const radius = clamp(parseInt(radiusKm, 10) || env.HOTELS_DEFAULT_RADIUS_KM, 1, 200);
  const max = clamp(parseInt(limit, 10) || env.HOTELS_MAX_RESULTS, 1, 200);

  // $geoNear must be the first stage, and it is the only one that can use the 2dsphere index.
  // `query` filters INSIDE it rather than in a later $match, so the index does the narrowing
  // instead of the pipeline sorting a whole country and discarding most of it — which matters
  // rather more here than for couriers: this collection is fifteen times larger.
  const query = {};
  if (category) query.category = category;
  if (isoCountry) query.isoCountry = String(isoCountry).toUpperCase();

  const rows = await HotelLocation.aggregate([
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
        sourceId: 1, name: 1, category: 1, basicCategory: 1, confidence: 1,
        address: 1, city: 1, stateOrRegion: 1, postalCode: 1, isoCountry: 1,
        phone: 1, website: 1, email: 1, location: 1, distanceMeters: 1,
      },
    },
  ]);

  const places = rows.map((r) => ({
    id: r.sourceId,
    name: r.name || 'Unnamed property',
    // One readable line, from whichever parts the source actually had.
    address: [r.address, r.city, r.stateOrRegion, r.postalCode].filter(Boolean).join(', ') || null,
    city: r.city || null,
    // Underscored provider slugs are unreadable in a table: bed_and_breakfast.
    category: r.category ? r.category.replace(/_/g, ' ') : null,
    phone: r.phone || null,
    website: r.website || null,
    email: r.email || null,
    // No review or price data in this dataset. Kept as nulls rather than dropped from the shape
    // so the page renders identically whichever source answered — and never guessed at.
    rating: null,
    ratingCount: 0,
    perNight: null,
    lat: r.location.coordinates[1],
    lon: r.location.coordinates[0],
    distanceKm: Math.round(r.distanceMeters / 100) / 10,
    // The dataset's own 0..1 certainty that the place is what it claims. Surfaced so a low
    // confidence hit can be treated with suspicion instead of looking identical to a certain one.
    confidence: typeof r.confidence === 'number' ? r.confidence : null,
    isoCountry: r.isoCountry || null,
  }));

  return { places, totalFound: places.length, radiusKm: radius };
}

/** How much of the world this dataset actually holds — for the "no results" case to be honest. */
async function datasetStatus() {
  const total = await HotelLocation.estimatedDocumentCount();
  return { total, source: 'HotelLocation', metered: false };
}

module.exports = { nearbyHotels, datasetStatus };
