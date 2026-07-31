const env = require('../config/env');
const { haversineMeters } = require('../utils/geo');

/**
 * Booking.com property search, via RapidAPI.
 *
 * Three things about this provider shape the whole file:
 *
 * 1. FAILURES ARRIVE AS HTTP 200. A rejected request still comes back 200 with `status:false`
 *    in the body, and `message` is EITHER a plain string ("Something went wrong…") OR an array
 *    of per-field validation objects ([{"arrival_date":"Invalid value"}]). Trusting `res.ok`
 *    would show a manager "no hotels near this driver" when the truth is "we sent a bad date",
 *    so every response body is inspected and both message shapes are decoded.
 *
 * 2. CALLS COST MONEY. RapidAPI meters per request, unlike the weather feed. So results are
 *    cached hard, and a daily budget refuses the call rather than quietly running up a bill if
 *    something starts hammering the endpoint.
 *
 * 3. `distances` IS NOT DISTANCES. The field exists on every property but is empty, or carries
 *    sustainability badges. There is no "how far from the driver" in the payload at all, so it
 *    is computed here from the coordinates.
 */
const HOST = 'booking-com15.p.rapidapi.com';
const SEARCH_PATH = '/api/v1/hotels/searchHotelsByCoordinates';

/** Cached responses keyed by every parameter that changes the answer. */
const cache = new Map(); // key -> { at: ms, data }

/** Per-UTC-day call budget, so a runaway page cannot burn a month's quota in an hour. */
const budget = { day: null, used: 0 };

const utcDay = () => new Date().toISOString().slice(0, 10);

function currentBudget() {
  if (budget.day !== utcDay()) {
    budget.day = utcDay();
    budget.used = 0;
  }
  return budget;
}

function budgetStatus() {
  const b = currentBudget();
  return { used: b.used, cap: env.HOTELS_DAILY_CALL_CAP, remaining: Math.max(0, env.HOTELS_DAILY_CALL_CAP - b.used) };
}

function isConfigured() {
  return Boolean(env.RAPIDAPI_KEY);
}

/**
 * Turn whatever the provider put in `message` into one sentence a manager can act on.
 * The array form is the useful one — it names the parameter that was wrong.
 */
function describeFailure(message) {
  if (Array.isArray(message)) {
    const fields = message.flatMap((entry) =>
      Object.entries(entry || {}).map(([field, why]) => `${field} (${why})`)
    );
    const unique = [...new Set(fields)];
    return unique.length
      ? `Booking.com rejected these search values: ${unique.join(', ')}`
      : 'Booking.com rejected the search values';
  }
  if (typeof message === 'string' && message.trim()) return message.trim();
  return 'Booking.com refused the search without saying why';
}

function fail(msg, status = 502, extra = {}) {
  const err = new Error(msg);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function cacheKey(q) {
  // Coordinates are snapped first: two drivers a few hundred metres apart want the same
  // hotels, and an unrounded key would make every heartbeat a fresh paid call.
  const snap = (v) => (Math.round(v / env.HOTELS_GRID_DEGREES) * env.HOTELS_GRID_DEGREES).toFixed(3);
  return [
    snap(q.lat), snap(q.lon), q.arrival, q.departure,
    q.adults, q.rooms, q.childrenAge || '', q.radiusKm, q.currency, q.page,
  ].join('|');
}

/** Money as both a number (for sorting) and the provider's pre-formatted string (for display). */
function money(amount) {
  if (!amount || typeof amount.value !== 'number') return null;
  return {
    value: Math.round(amount.value * 100) / 100,
    label: amount.amount_rounded || amount.amount_unrounded || null,
    currency: amount.currency || null,
  };
}

/**
 * One raw property → the fields a fleet manager actually decides on.
 *
 * The ordering here is deliberate: parking and a late check-in matter more to someone
 * arriving in a van at 23:00 than a star rating does.
 */
function mapProperty(raw, origin, nights) {
  const price = raw.composite_price_breakdown || {};
  const lat = typeof raw.latitude === 'number' ? raw.latitude : null;
  const lon = typeof raw.longitude === 'number' ? raw.longitude : null;

  const distanceKm =
    lat != null && lon != null && origin
      ? Math.round(haversineMeters(origin, { lat, lon }) / 100) / 10
      : null;

  return {
    id: raw.hotel_id ?? raw.id ?? null,
    name: raw.hotel_name_trans || raw.hotel_name || 'Unnamed property',
    city: raw.city || null,
    countryCode: (raw.countrycode || '').toUpperCase() || null,

    // `class` is the star rating; `class_is_estimated` means Booking guessed it, so the UI
    // can avoid presenting a guess as fact.
    stars: typeof raw.class === 'number' && raw.class > 0 ? raw.class : null,
    starsEstimated: Boolean(raw.class_is_estimated),

    score: typeof raw.review_score === 'number' ? raw.review_score : null,
    scoreWord: raw.review_score_word || null,
    reviews: typeof raw.review_nr === 'number' ? raw.review_nr : 0,

    lat, lon, distanceKm,
    photo: raw.main_photo_url || null,

    perNight: money(price.gross_amount_per_night),
    total: money(price.gross_amount),
    totalWithTaxes: money(price.all_inclusive_amount),
    wasPerNight: money(price.strikethrough_amount_per_night),
    nights,

    // What the property itself charges, in its own currency. Worth carrying because the
    // requested currency is a fleet-wide setting: a manager looking at an Australian hotel
    // priced in rupees still wants to see the AUD the front desk will actually ask for.
    localPrice:
      typeof raw.min_total_price === 'number' && raw.currencycode
        ? { value: Math.round(raw.min_total_price * 100) / 100, currency: raw.currencycode }
        : null,

    // The fleet-relevant flags.
    freeParking: raw.has_free_parking === 1,
    freeCancellation: raw.is_free_cancellable === 1,
    noPrepayment: raw.is_no_prepayment_block === 1,
    breakfastIncluded: raw.hotel_include_breakfast === 1,
    pool: raw.has_swimming_pool === 1,

    checkinFrom: raw.checkin?.from || null,
    checkinUntil: raw.checkin?.until || null,
    checkoutUntil: raw.checkout?.until || null,

    roomLabel: (raw.unit_configuration_label || '').replace(/<[^>]+>/g, '').replace(/\n/g, ' · ').trim() || null,
    urgency: raw.urgency_message || null,
    badges: (raw.badges || []).map((b) => b.text).filter(Boolean),
    timezone: raw.timezone || null,
  };
}

/**
 * Call the provider (or reuse a cached answer).
 *
 * Returns `{ properties, totalFound, fromCache, cachedAgeSeconds }`.
 */
async function searchByCoordinates(q) {
  if (!isConfigured()) {
    throw fail('No RapidAPI key configured — set RAPIDAPI_KEY to enable hotel search.', 503);
  }

  const key = cacheKey(q);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at <= env.HOTELS_CACHE_MINUTES * 60_000) {
    return { ...hit.data, fromCache: true, cachedAgeSeconds: Math.round((Date.now() - hit.at) / 1000) };
  }

  const b = currentBudget();
  if (b.used >= env.HOTELS_DAILY_CALL_CAP) {
    throw fail(
      `Daily hotel-search budget reached (${env.HOTELS_DAILY_CALL_CAP} calls). ` +
        'Raise HOTELS_DAILY_CALL_CAP if the plan allows more.',
      429,
      { budget: budgetStatus() }
    );
  }

  const params = new URLSearchParams({
    latitude: String(q.lat),
    longitude: String(q.lon),
    arrival_date: q.arrival,
    departure_date: q.departure,
    adults: String(q.adults),
    room_qty: String(q.rooms),
    radius: String(q.radiusKm),
    units: 'metric',
    page_number: String(q.page),
    temperature_unit: 'c',
    languagecode: 'en-us',
    currency_code: q.currency,
  });
  // Only sent when there actually are children — an empty value is a validation error.
  if (q.childrenAge) params.set('children_age', q.childrenAge);

  let res;
  b.used += 1;
  try {
    res = await fetch(`https://${HOST}${SEARCH_PATH}?${params}`, {
      headers: {
        'Content-Type': 'application/json',
        'x-rapidapi-host': HOST,
        'x-rapidapi-key': env.RAPIDAPI_KEY,
      },
      signal: AbortSignal.timeout(env.HOTELS_TIMEOUT_MS),
    });
  } catch (err) {
    throw fail(`Could not reach the hotel service (${err.message})`);
  }

  if (res.status === 401 || res.status === 403) {
    throw fail('RapidAPI rejected the key for the Booking.com API (401/403) — check the key and that the plan is subscribed.', 502);
  }
  if (res.status === 429) {
    throw fail('RapidAPI rate limit reached for this plan. Try again shortly.', 429);
  }
  if (!res.ok) {
    throw fail(`Hotel service returned HTTP ${res.status}`);
  }

  const json = await res.json().catch(() => null);
  if (!json) throw fail('Hotel service returned a response that was not JSON');

  // The important bit: 200 does not mean success for this provider.
  if (json.status !== true) throw fail(describeFailure(json.message), 502);

  const origin = { lat: q.lat, lon: q.lon };
  const properties = (json.data?.result || [])
    // Anything that cannot actually be booked is noise on a page whose job is to book a bed.
    .filter((raw) => !raw.soldout && !raw.cant_book)
    .map((raw) => mapProperty(raw, origin, q.nights));

  const data = { properties, totalFound: json.data?.count ?? properties.length };
  cache.set(key, { at: Date.now(), data });
  return { ...data, fromCache: false, cachedAgeSeconds: 0 };
}

module.exports = {
  searchByCoordinates,
  isConfigured,
  budgetStatus,
  // exported for tests
  describeFailure,
  mapProperty,
  cacheKey,
  _cache: cache,
  _budget: budget,
};
