// Driving-weather rules. Pure functions, so no DB and no network — run: npm run test:weather
process.env.WEATHER_WIND_CAUTION_KMH = '40';
process.env.WEATHER_GUST_UNSAFE_KMH = '60';
process.env.MONGODB_URI = 'mongodb://unused/weather_test';
process.env.JWT_SECRET = 'weather_test_secret_key_1234567890';

const {
  scoreSlot, assessDay, gridKey, localDayIndex, localTime, summariseReasons,
} = require('../src/services/drivingWeather');
const { classifyWmo } = require('../src/services/weatherCodes');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

/** A normalised hour, as the Open-Meteo adapter produces. */
const hour = (o = {}) => {
  const code = o.code ?? 0;
  const { description, severity } = classifyWmo(code);
  return {
    dt: o.dt ?? 0,
    tempC: o.temp ?? 20,
    windKmh: o.windKmh ?? 5,
    gustKmh: o.gustKmh ?? null,
    visibilityM: o.visibility ?? 10000,
    popPct: o.pop ?? 0,
    precipMm: o.precipMm ?? 0,
    severity,
    description,
    icon: 'x',
  };
};

console.log('\n── WMO condition codes ──');
assert(scoreSlot(hour({ code: 0 })).risk === 'clear', 'clear sky is clear');
assert(scoreSlot(hour({ code: 61 })).risk === 'clear', 'light rain alone does not raise a flag');
assert(scoreSlot(hour({ code: 63 })).risk === 'caution', 'moderate rain is caution');
assert(scoreSlot(hour({ code: 65 })).risk === 'unsafe', 'heavy rain is unsafe');
assert(scoreSlot(hour({ code: 95 })).risk === 'unsafe', 'thunderstorm is unsafe');
assert(scoreSlot(hour({ code: 99 })).risk === 'unsafe', 'thunderstorm with hail is unsafe');
assert(scoreSlot(hour({ code: 66 })).risk === 'unsafe', 'freezing rain is unsafe (black ice)');
assert(scoreSlot(hour({ code: 56 })).risk === 'unsafe', 'freezing drizzle is unsafe too — same ice');
assert(scoreSlot(hour({ code: 48 })).risk === 'unsafe', 'freezing fog is unsafe (fog AND ice)');
assert(scoreSlot(hour({ code: 45 })).risk === 'caution', 'ordinary fog is caution');
assert(scoreSlot(hour({ code: 71 })).risk === 'caution', 'light snow is caution');
assert(scoreSlot(hour({ code: 75 })).risk === 'unsafe', 'heavy snow is unsafe');
assert(scoreSlot(hour({ code: 82 })).risk === 'unsafe', 'violent showers are unsafe');
assert(scoreSlot(hour({ code: 51 })).risk === 'clear', 'light drizzle is not worth a warning');
assert(classifyWmo(4242).severity === 'clear', 'an unknown code is never treated as dangerous');
assert(/heavy rain/.test(scoreSlot(hour({ code: 65 })).reasons.join()), 'the reason names the condition');

console.log('\n── wind (tuned for high-sided vans) ──');
assert(scoreSlot(hour({ windKmh: 25 })).risk === 'clear', '25 km/h wind is fine');
assert(scoreSlot(hour({ windKmh: 45 })).risk === 'caution', '45 km/h wind is caution');
assert(scoreSlot(hour({ windKmh: 20, gustKmh: 65 })).risk === 'unsafe', 'a 65 km/h gust is unsafe even in light average wind');
assert(/gusts 65 km\/h/.test(scoreSlot(hour({ windKmh: 20, gustKmh: 65 })).reasons.join()), 'a gust is called a gust, matching what the slot shows');
assert(/wind 45 km\/h/.test(scoreSlot(hour({ windKmh: 45 })).reasons.join()), 'average wind is called wind');
assert(scoreSlot(hour({ code: 0, windKmh: 70 })).risk === 'unsafe', 'wind alone can make a clear sky unsafe');

console.log('\n── visibility ──');
assert(scoreSlot(hour({ visibility: 9000 })).risk === 'clear', '9 km visibility is fine');
assert(scoreSlot(hour({ visibility: 3000 })).risk === 'caution', '3 km visibility is caution');
assert(scoreSlot(hour({ visibility: 500 })).risk === 'unsafe', '500 m visibility is unsafe');

console.log('\n── probability of rain ──');
assert(scoreSlot(hour({ pop: 70 })).risk === 'caution', 'a 70% chance of rain is caution on its own');
assert(scoreSlot(hour({ code: 65, pop: 90 })).risk === 'unsafe', 'pop never downgrades a worse signal');

console.log('\n── repeated reasons collapse to the worst ──');
const collapsed = summariseReasons(['wind 44 km/h', 'wind 49 km/h', 'moderate rain']);
assert(collapsed.length === 2, 'two kinds of reason survive, not three lines');
assert(collapsed.includes('wind 49 km/h') && !collapsed.includes('wind 44 km/h'), 'the worst wind value is the one kept');

console.log('\n── a day is judged by its worst hour ──');
const DAY = 86400;
const midnight = Math.floor(1786000000 / DAY) * DAY;
const fullDay = (badHours = {}) =>
  Array.from({ length: 24 }, (_, i) => hour({ dt: midnight + i * 3600, code: badHours[i] ?? 0 }));

let day = assessDay(fullDay(), 0, 0, midnight);
assert(day.verdict === 'clear', 'a calm day is clear');
assert(/Good driving conditions/.test(day.headline), 'clear days say so plainly');
assert(day.slots.length === 8, '24 scored hours become 8 readable 3-hour blocks');

day = assessDay(fullDay({ 15: 95 }), 0, 0, midnight);
assert(day.verdict === 'unsafe', 'one bad hour condemns the day');
assert(day.worstWindowFrom === '15:00' && day.worstWindowTo === '16:00', 'the risk window is reported to the hour');
const stormBlock = day.slots.find((b) => b.risk === 'unsafe');
assert(stormBlock && stormBlock.at === '15:00', 'the block containing the bad hour is flagged, at 3-hour granularity');
assert(day.slots.filter((b) => b.risk === 'unsafe').length === 1, 'and only that block');

console.log('\n── only the REMAINING part of today counts ──');
day = assessDay(fullDay({ 6: 95 }), 0, 0, midnight + 12 * 3600);
assert(day.verdict === 'clear', 'a storm that already passed does not condemn the afternoon');
day = assessDay(fullDay({ 6: 95 }), 0, 0, midnight + 6 * 3600 + 1800);
assert(day.verdict === 'unsafe', 'the hour in progress still counts');

console.log('\n── timezone: "today" is the DRIVER\'s day ──');
const sydney = 10 * 3600;
const paris = 2 * 3600;
const instant = midnight + 20 * 3600;
assert(localDayIndex(instant, sydney) === localDayIndex(instant, paris) + 1,
  'at 20:00 UTC it is already tomorrow in Sydney but still today in Paris');
assert(localTime(instant, sydney) === '06:00', 'local time is rendered at the location, not the server');
const spanning = [hour({ dt: midnight + 22 * 3600 }), hour({ dt: midnight + 25 * 3600, code: 95 })];
assert(assessDay(spanning, 0, 0, midnight + 21 * 3600).verdict === 'clear', "tomorrow's storm stays out of today");
assert(assessDay(spanning, 0, 1, midnight + 21 * 3600).verdict === 'unsafe', 'and shows up when tomorrow is asked for');

console.log('\n── clustering keeps lookups down ──');
assert(gridKey(17.4123, 78.4456) === gridKey(17.4500, 78.5000), 'drivers a few km apart share one forecast');
assert(gridKey(17.41, 78.44) !== gridKey(19.07, 72.87), 'Hyderabad and Mumbai do not');
const depot = [[17.41, 78.44], [17.43, 78.46], [17.39, 78.42], [17.45, 78.49]];
assert(new Set(depot.map(([a, b]) => gridKey(a, b))).size === 1, 'a depot of four drivers costs a single lookup');

console.log(`\n🎉 DRIVING WEATHER RULES VERIFIED — ${passed} assertions passed`);
process.exit(process.exitCode || 0);
