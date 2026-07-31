// Coordinate → IANA timezone resolution. No DB, no network.
// Run: npm run test:tz
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/tz_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'tz_test_secret_key_1234567890';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

const { timezoneFromCoords } = require('../src/utils/tzFromCoords');
const { isValidTimeZone, formatDateInZone } = require('../src/utils/timezone');

(async () => {
  console.log('\n── one country, several clocks ──');
  // The whole reason a country code cannot do this job. All three are "AU".
  assert(timezoneFromCoords(-26.4003, 153.0523) === 'Australia/Brisbane', 'Noosa QLD → Australia/Brisbane');
  assert(timezoneFromCoords(-37.7360, 144.6700) === 'Australia/Melbourne', 'Melbourne → Australia/Melbourne');
  assert(timezoneFromCoords(-31.9500, 115.8600) === 'Australia/Perth', 'Perth → Australia/Perth');
  assert(
    new Set([
      timezoneFromCoords(-26.4003, 153.0523),
      timezoneFromCoords(-37.7360, 144.6700),
      timezoneFromCoords(-31.9500, 115.8600),
    ]).size === 3,
    'three Australian drivers resolve to three different zones, not one national default'
  );

  console.log('\n── the rest of the fleet ──');
  assert(timezoneFromCoords(17.447, 78.361) === 'Asia/Kolkata', 'Hyderabad → Asia/Kolkata');
  assert(timezoneFromCoords(15.677, 79.998) === 'Asia/Kolkata', 'rural Andhra → Asia/Kolkata');
  assert(timezoneFromCoords(48.8566, 2.3522) === 'Europe/Paris', 'Paris → Europe/Paris');
  assert(timezoneFromCoords(1.3521, 103.8198) === 'Asia/Singapore', 'Singapore → Asia/Singapore');

  console.log('\n── bad input is refused, not guessed ──');
  assert(timezoneFromCoords(0, 0) === null, 'exact 0,0 is a failed GPS fix, not the Gulf of Guinea');
  assert(timezoneFromCoords(0.00005, -0.00002) === null, 'a hair off 0,0 is still a failed fix');
  assert(timezoneFromCoords(null, null) === null, 'nulls yield no zone');
  assert(timezoneFromCoords(undefined, undefined) === null, 'undefined yields no zone');
  assert(timezoneFromCoords('17.4', '78.3') === null, 'strings are refused rather than coerced');
  assert(timezoneFromCoords(NaN, 10) === null, 'NaN yields no zone');
  assert(timezoneFromCoords(Infinity, 10) === null, 'Infinity yields no zone');
  assert(timezoneFromCoords(91, 10) === null, 'latitude beyond the pole is refused');
  assert(timezoneFromCoords(10, 181) === null, 'longitude beyond the meridian is refused');

  console.log('\n── open ocean still answers without throwing ──');
  let threw = false;
  let mid = null;
  try { mid = timezoneFromCoords(-40, -30); } catch { threw = true; }
  assert(!threw, 'a mid-Atlantic point does not throw');
  assert(mid === null || typeof mid === 'string', 'a mid-Atlantic point yields a zone or nothing');

  console.log('\n── everything produced is usable downstream ──');
  // A zone that Intl cannot parse would break the weather, hotel and custody date maths.
  const sample = [
    [-26.4003, 153.0523], [-37.736, 144.67], [-31.95, 115.86],
    [17.447, 78.361], [48.8566, 2.3522], [1.3521, 103.8198],
    [40.7128, -74.006], [55.7558, 37.6173], [-33.8688, 151.2093],
  ];
  for (const [la, lo] of sample) {
    const z = timezoneFromCoords(la, lo);
    assert(isValidTimeZone(z), `${la},${lo} → "${z}" is a zone Intl accepts`);
  }
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(formatDateInZone(new Date(), timezoneFromCoords(17.447, 78.361))),
    'a resolved zone drives formatDateInZone, which is what hotel check-in dates depend on'
  );

  console.log(`\n🎉 COORDINATE TIMEZONES — ${passed} assertions passed\n`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
