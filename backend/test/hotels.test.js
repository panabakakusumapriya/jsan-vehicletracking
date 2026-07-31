// Hotel search tests — provider quirks, mapping, distance, dates, caching, budget.
// Run: npm run test:hotels   (no DB, no network — fetch is stubbed)
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/hotels_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hotels_test_secret_key_1234567890';
process.env.RAPIDAPI_KEY = 'test-key';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (got ${a})`);

const booking = require('../src/services/bookingHotels');
const { describeFailure, mapProperty, cacheKey } = booking;
const search = require('../src/services/hotelSearch');
const { defaultDates, validateDates, driverLocalToday, addDays, daysBetween, SORTS } = search;

// A property shaped exactly like the live payload (trimmed to the fields we read).
const RAW = {
  hotel_id: 10711933,
  hotel_name: 'Collection O Palm Springs Beach Resort',
  city: 'Mumbai',
  countrycode: 'in',
  class: 3,
  class_is_estimated: 0,
  review_score: 8.7,
  review_score_word: 'Excellent',
  review_nr: 3,
  has_free_parking: 1,
  is_free_cancellable: 1,
  is_no_prepayment_block: 1,
  hotel_include_breakfast: 0,
  latitude: 19.244493,
  longitude: 72.78339,
  main_photo_url: 'https://cf.bstatic.com/xdata/images/hotel/square60/496036413.jpg',
  checkin: { from: '12:00', until: '' },
  checkout: { from: '', until: '11:00' },
  unit_configuration_label: 'Classic Triple Room\n<b>Hotel room</b>: 1 bed',
  urgency_message: 'Only 2 left at this price',
  min_total_price: 3407.71,
  currencycode: 'AUD',
  badges: [{ text: 'Limited-time Deal' }],
  // The field that looks like it answers "how far" but never does.
  distances: [{ text: 'Travel Sustainable', icon_name: 'travel_sustainable' }],
  composite_price_breakdown: {
    gross_amount_per_night: { value: 1630.98, amount_rounded: 'Rs. 1,631', currency: 'INR' },
    gross_amount: { value: 1630.98, amount_rounded: 'Rs. 1,631', currency: 'INR' },
    all_inclusive_amount: { value: 1712.529, amount_rounded: 'Rs. 1,713', currency: 'INR' },
    strikethrough_amount_per_night: { value: 1989, amount_rounded: 'Rs. 1,989', currency: 'INR' },
  },
};
const ORIGIN = { lat: 19.24232736426361, lon: 72.85841985686734 };

(async () => {
  console.log('\n── provider failure decoding ──');
  assert(
    describeFailure([{ arrival_date: 'Invalid value' }, { departure_date: 'Invalid value' }])
      .includes('arrival_date'),
    'validation-array failures name the offending field'
  );
  assert(
    describeFailure([{ arrival_date: 'Invalid value' }, { arrival_date: 'Invalid value' }])
      .match(/arrival_date/g).length === 1,
    'duplicate field errors are reported once'
  );
  assert(
    describeFailure('Something went wrong.') === 'Something went wrong.',
    'string failures pass through verbatim'
  );
  assert(describeFailure(undefined).length > 0, 'a missing message still yields a sentence');

  console.log('\n── property mapping ──');
  const p = mapProperty(RAW, ORIGIN, 1);
  assert(p.name === 'Collection O Palm Springs Beach Resort', 'name is carried through');
  assert(p.stars === 3 && p.starsEstimated === false, 'star rating read from `class`');
  assert(mapProperty({ ...RAW, class: 0 }, ORIGIN, 1).stars === null, 'class 0 means unrated, not zero stars');
  assert(p.score === 8.7 && p.reviews === 3, 'review score and count');
  assert(p.freeParking === true && p.freeCancellation === true, 'parking + cancellation flags');
  assert(p.perNight.label === 'Rs. 1,631', "provider's formatted price is kept for display");
  assert(p.perNight.value === 1630.98, 'numeric price kept for sorting');
  assert(p.totalWithTaxes.value === 1712.53, 'all-in total rounded to cents');
  assert(p.roomLabel === 'Classic Triple Room · Hotel room: 1 bed', 'HTML and newlines stripped from room label');
  assert(p.checkinFrom === '12:00' && p.checkinUntil === null, 'empty check-in cutoff becomes null');
  assert(p.badges[0] === 'Limited-time Deal', 'badges flattened to text');
  assert(p.localPrice.currency === 'AUD' && p.localPrice.value === 3407.71,
    "the property's own charging currency is kept alongside the converted price");
  assert(mapProperty({ ...RAW, min_total_price: undefined }, ORIGIN, 1).localPrice === null,
    'a property with no local price reports none rather than a bogus zero');

  console.log('\n── distance (the API never provides it) ──');
  near(p.distanceKm, 7.9, 0.4, 'distance computed from coordinates');
  assert(mapProperty({ ...RAW, latitude: null, longitude: null }, ORIGIN, 1).distanceKm === null,
    'a property with no coordinates has no distance rather than a wrong one');

  console.log('\n── cache keys ──');
  const q = { lat: 19.24, lon: 72.85, arrival: '2026-08-01', departure: '2026-08-02', adults: 1, rooms: 1, radiusKm: 30, currency: 'INR', page: 1 };
  assert(cacheKey(q) === cacheKey({ ...q, lat: 19.2401, lon: 72.8502 }),
    'drivers a few hundred metres apart share one cached search');
  assert(cacheKey(q) !== cacheKey({ ...q, lat: 21.5 }), 'a different city is a different key');
  assert(cacheKey(q) !== cacheKey({ ...q, arrival: '2026-08-05' }), 'different dates are a different key');
  assert(cacheKey(q) !== cacheKey({ ...q, currency: 'AUD' }), 'different currency is a different key');

  console.log('\n── date maths ──');
  assert(addDays('2026-08-01', 1) === '2026-08-02', 'addDays across a normal day');
  assert(addDays('2026-12-31', 1) === '2027-01-01', 'addDays across a year boundary');
  assert(daysBetween('2026-08-01', '2026-08-04') === 3, 'daysBetween counts nights');

  const today = new Date().toISOString().slice(0, 10);
  const sydney = defaultDates({ timezone: 'Australia/Sydney', lon: 151 });
  assert(sydney.arrival >= today, "a driver's local today is never behind the UTC date");
  assert(daysBetween(sydney.arrival, sydney.departure) === 1, 'default stay is one night');

  // Honolulu is far enough behind UTC to be "yesterday" for part of every day.
  const hawaii = defaultDates({ timezone: 'Pacific/Honolulu', lon: -157 });
  assert(hawaii.arrival >= today, 'a timezone behind UTC is clamped forward, never left in the past');

  assert(driverLocalToday({ lon: 150 }).length === 10, 'longitude fallback yields a date when no timezone is known');
  assert(driverLocalToday({ timezone: 'Not/AZone', lon: 0 }).length === 10, 'an invalid timezone falls back rather than throwing');

  console.log('\n── date validation ──');
  let threw = false;
  try { validateDates('2020-01-01', '2020-01-02', {}); } catch { threw = true; }
  assert(threw, 'a check-in in the past is refused');

  const future = addDays(today, 5);
  assert(validateDates(future, future, {}).nights === 1, 'a zero-night stay becomes one night');
  assert(validateDates(future, addDays(future, 2), {}).nights === 2, 'an explicit 2-night stay is kept');
  assert(validateDates(future, addDays(future, 999), {}).nights <= 30, 'absurd stays are capped');
  assert(validateDates('garbage', 'nonsense', { timezone: 'Asia/Kolkata', lon: 78 }).arrival >= today,
    'unparseable dates fall back to tonight rather than erroring');

  console.log('\n── sorting ──');
  const list = [
    { distanceKm: 10, perNight: { value: 500 }, score: 7 },
    { distanceKm: 2, perNight: { value: 900 }, score: 9 },
    { distanceKm: 5, perNight: { value: 100 }, score: 8 },
  ];
  assert([...list].sort(SORTS.distance)[0].distanceKm === 2, 'distance sort puts the nearest first');
  assert([...list].sort(SORTS.price)[0].perNight.value === 100, 'price sort puts the cheapest first');
  assert([...list].sort(SORTS.rating)[0].score === 9, 'rating sort puts the best first');
  assert([...list, { distanceKm: null, perNight: null, score: null }].sort(SORTS.distance).pop().distanceKm === null,
    'entries with no distance sink to the bottom instead of the top');

  console.log('\n── live call path (fetch stubbed) ──');
  const realFetch = global.fetch;
  let calls = 0;
  let lastUrl = '';
  const reply = (body, status = 200) => {
    global.fetch = async (url) => { calls += 1; lastUrl = String(url); return { ok: status < 400, status, json: async () => body }; };
  };

  booking._cache.clear();
  booking._budget.day = null;
  const baseQ = { lat: 19.24, lon: 72.85, arrival: future, departure: addDays(future, 1), adults: 1, rooms: 1, radiusKm: 30, currency: 'INR', page: 1, nights: 1 };

  // The headline quirk: HTTP 200 that actually means failure.
  reply({ status: false, message: [{ arrival_date: 'Invalid value' }] });
  let caught = null;
  try { await booking.searchByCoordinates(baseQ); } catch (e) { caught = e; }
  assert(caught && caught.message.includes('arrival_date'),
    'HTTP 200 with status:false is treated as a failure, not an empty result');

  reply({
    status: true,
    data: {
      count: 42,
      result: [
        RAW,
        { ...RAW, hotel_id: 2, soldout: 1 },
        { ...RAW, hotel_id: 3, cant_book: true },
      ],
    },
  });
  const ok = await booking.searchByCoordinates({ ...baseQ, arrival: addDays(future, 1), departure: addDays(future, 2) });
  assert(ok.properties.length === 1, 'sold-out and unbookable properties are dropped');
  assert(ok.totalFound === 42, 'provider total is reported separately from what is shown');
  assert(ok.fromCache === false, 'a fresh fetch is flagged as such');
  assert(lastUrl.includes('arrival_date=') && lastUrl.includes('radius=30'), 'query parameters are sent');
  assert(!lastUrl.includes('children_age'), 'children_age is omitted when there are no children');

  const before = calls;
  const again = await booking.searchByCoordinates({ ...baseQ, arrival: addDays(future, 1), departure: addDays(future, 2) });
  assert(calls === before, 'an identical search is served from cache with no second paid call');
  assert(again.fromCache === true, 'cached responses say so explicitly');

  const childUrl = { ...baseQ, arrival: addDays(future, 3), departure: addDays(future, 4), childrenAge: '0,17' };
  await booking.searchByCoordinates(childUrl);
  assert(lastUrl.includes('children_age=0%2C17'), 'children ages are sent when present');

  // Budget guard
  booking._budget.used = 9999;
  caught = null;
  try { await booking.searchByCoordinates({ ...baseQ, arrival: addDays(future, 7), departure: addDays(future, 8) }); }
  catch (e) { caught = e; }
  assert(caught && caught.status === 429, 'the daily call budget refuses further paid calls');
  booking._budget.used = 0;

  reply({}, 401);
  caught = null;
  try { await booking.searchByCoordinates({ ...baseQ, arrival: addDays(future, 9), departure: addDays(future, 10) }); }
  catch (e) { caught = e; }
  assert(caught && caught.message.includes('key'), 'a rejected API key says so plainly');

  global.fetch = realFetch;
  console.log(`\n🎉 HOTEL SEARCH — ${passed} assertions passed\n`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
