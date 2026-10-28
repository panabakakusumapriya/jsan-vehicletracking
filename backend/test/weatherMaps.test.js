// Weather along a trip + the map weather grid. Pure parts only — no DB, no network.
// run: npm run test:weather:maps
process.env.MONGODB_URI = 'mongodb://unused/weather_maps_test';
process.env.JWT_SECRET = 'weather_maps_test_secret_key_1234567890';

const { pickSamples, weatherAt } = require('../src/services/tripRouteWeather');
const { snapBox, GRID_MAX_CELLS } = require('../src/services/weatherGrid');
const { classifyWmo } = require('../src/services/weatherCodes');
const { dayConfidence } = require('../src/services/forecastConfidence');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

const T0 = Date.UTC(2026, 9, 27, 0, 0, 0);
const MIN = 60_000;
// A drive heading north at ~60 km/h: one fix a minute, ~1 km apart.
const drive = (minutes, kmPerMin = 1) =>
  Array.from({ length: minutes + 1 }, (_, i) => ({ t: T0 + i * MIN, lat: -27.5 + i * kmPerMin * 0.009, lon: 153 }));

console.log('\n── where along a trip the weather is looked up ──');
let s = pickSamples(drive(60, 0.2)); // slow city hour, 12 km
assert(s[0].t === T0, 'the start is always a sample');
assert(s[s.length - 1].t === T0 + 60 * MIN, 'and so is the end');
assert(s.length === 5, 'a slow hour is sampled every 15 minutes (0, 15, 30, 45, 60)');

s = pickSamples(drive(60, 2)); // fast motorway hour, 120 km
assert(s.length > 5, 'a fast hour gets extra samples by road distance');
const gaps = s.slice(1).map((x, i) => (x.t - s[i].t) / MIN);
assert(Math.min(...gaps) >= 5, 'but never closer than five minutes apart');

s = pickSamples(drive(14 * 60, 1.5)); // a 14-hour day
assert(s.length <= 40, 'a very long day is capped at 40 lookups');
assert(s[0].t === T0 && s[s.length - 1].t === T0 + 14 * 60 * MIN, 'the cap keeps the start and the end');

s = pickSamples(drive(17, 0.2));
const lastGap = (s[s.length - 1].t - s[s.length - 2].t) / MIN;
assert(lastGap >= 5, 'the end replaces a sample taken just before it instead of crowding it');

assert(pickSamples([]).length === 0, 'no GPS, no samples');

console.log('\n── reading a sample out of the hourly series ──');
const H = 3600;
const t0 = T0 / 1000;
const series = {
  hourly: {
    time: [t0, t0 + H, t0 + 2 * H],
    temperature_2m: [20, 30, 30],
    precipitation: [0, 5, 0],
    weather_code: [0, 63, 0],
    wind_speed_10m: [10, 20, 20],
    wind_gusts_10m: [10, 20, 20],
    visibility: [10000, 10000, 10000],
    is_day: [1, 1, 1],
  },
};
const mid = weatherAt(series, T0 + 30 * MIN);
assert(mid.tempC === 25, 'temperature is interpolated between the hours around the sample');
assert(mid.precipMm === 5, 'rain is the NEXT hour\'s value (Open-Meteo sums the preceding hour)');
assert(weatherAt(series, T0 + 10 * MIN).description === classifyWmo(0).description &&
  weatherAt(series, T0 + 50 * MIN).description === classifyWmo(63).description, 'the condition comes from the nearer hour');
assert(weatherAt({ hourly: { time: [] } }, T0) === null, 'an empty series gives no weather rather than zeros');

console.log('\n── map weather grid ──');
const city = snapBox({ w: 152.9, s: -27.6, e: 153.2, n: -27.35 });
assert(city.step <= 0.05, 'a city view gets a fine (~5 km) grid');
const aus = snapBox({ w: 110, s: -47, e: 179, n: -10 });
assert(aus.cols <= GRID_MAX_CELLS + 1 && aus.rows <= GRID_MAX_CELLS + 1, 'Australia + NZ fits one request');
assert(aus.w <= 110 && aus.e >= 179, 'and the whole view is covered, not just its middle');
const a = snapBox({ w: 152.61, s: -27.79, e: 153.39, n: -27.21 });
const b = snapBox({ w: 152.63, s: -27.77, e: 153.37, n: -27.23 });
assert(JSON.stringify(a) === JSON.stringify(b), 'nudging the map lands on the same cached grid');

console.log('\n── forecast confidence: do the models agree? ──');
const DAY = 86400;
const day0 = Math.floor(Date.UTC(2026, 9, 27) / 1000 / DAY) * DAY;
// Three model runs over two local days (UTC offset 0), hour by hour.
const runs = (fn) => {
  const time = Array.from({ length: 48 }, (_, i) => day0 + i * 3600);
  return {
    time,
    runs: [0, 1, 2].map((m) => ({
      model: `m${m}`,
      temp: time.map((_, i) => fn(m, i).temp),
      rain: time.map((_, i) => fn(m, i).rain),
      wind: time.map((_, i) => fn(m, i).wind),
    })),
  };
};
const agree = runs(() => ({ temp: 20, rain: 0, wind: 10 }));
let c = dayConfidence(agree, 0, 0, day0);
assert(c.level === 'high' && c.score >= 90, 'three models saying the same thing is high confidence');
assert(/agree/.test(c.reasons[0]), 'and it says why');
const dryVsWet = runs((m) => ({ temp: 20, rain: m === 0 ? 0 : 0.5, wind: 10 }));
c = dayConfidence(dryVsWet, 0, 0, day0);
assert(c.score < 75 && c.reasons.some((r) => /whether it rains/.test(r)), 'one model dry, two wet: confidence drops, rain named as the reason');
const warmCold = runs((m) => ({ temp: 18 + m * 3, rain: 0, wind: 10 }));
c = dayConfidence(warmCold, 0, 0, day0);
assert(c.reasons.some((r) => /6\.0°C/.test(r)), 'a 6°C spread between models is reported');
assert(dayConfidence(agree, 0, 1, day0).score < dayConfidence(agree, 0, 0, day0).score, 'the same agreement a day further out scores a little lower');
assert(dayConfidence({ time: agree.time, runs: [agree.runs[0]] }, 0, 0, day0) === null, 'one model alone gives no confidence rather than a fake 100');
assert(dayConfidence(null, 0, 0, day0) === null, 'no model data, no bar');

console.log(`\n🎉 WEATHER MAPS VERIFIED — ${passed} assertions passed`);
process.exit(process.exitCode || 0);
