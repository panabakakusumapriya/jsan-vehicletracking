// End-to-end weather pipeline against an in-memory Mongo and a STUBBED OpenWeather.
// Proves the parts that cost money or break quietly: clustering, caching, driver grouping,
// scoping and the "no recent position" split. Run: npm run test:weather:pipeline
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('weather_pipeline');
  process.env.JWT_SECRET = 'weather_pipeline_secret_1234567890';
  // Must be set before config/env is first required.
  process.env.WEATHER_CACHE_MINUTES = '30';
  process.env.WEATHER_ACTIVE_DAYS = '7';

  const { connectDB } = require('../src/config/db');
  await connectDB();

  const mongoose = require('mongoose');
  const User = require('../src/models/User');
  const Trip = require('../src/models/Trip');
  await Promise.all([User.init(), Trip.init()]);

  /* ── a stub standing in for OpenWeather ── */
  const calls = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const midnightUtc = Math.floor(nowSec / 86400) * 86400;

  /** 24 hourly points for today in Open-Meteo's columnar shape. */
  function payload({ badHour = -1, gustKmh = 10 } = {}) {
    const hours = Array.from({ length: 24 }, (_, i) => midnightUtc + i * 3600);
    return {
      latitude: 17.4, longitude: 78.4, utc_offset_seconds: 0, timezone: 'UTC',
      hourly: {
        time: hours,
        temperature_2m: hours.map(() => 26),
        apparent_temperature: hours.map(() => 27),
        weather_code: hours.map((_, i) => (i === badHour ? 95 : 0)),
        wind_speed_10m: hours.map(() => 11),
        wind_gusts_10m: hours.map(() => gustKmh),
        visibility: hours.map(() => 10000),
        precipitation: hours.map(() => 0),
        precipitation_probability: hours.map(() => 0),
        is_day: hours.map(() => 1),
      },
    };
  }

  const responses = new Map();
  globalThis.fetch = async (url) => {
    // Geocoding is a separate service; keep it out of the forecast call count.
    if (String(url).includes('nominatim')) {
      return { ok: true, status: 200, json: async () => ({ address: { city: 'Testville', country_code: 'in' } }) };
    }
    calls.push(url);
    const lat = Number(new URL(url).searchParams.get('latitude'));
    const body = lat > 30 ? responses.get('north') : responses.get('south');
    return { ok: true, status: 200, json: async () => body };
  };
  responses.set('south', payload({ badHour: -1 }));
  responses.set('north', payload({ badHour: 14, gustKmh: 75 }));

  /* ── seed a fleet ── */
  const manager = new User({ name: 'Mgr', email: 'm@w.com', role: 'manager' });
  await manager.setPassword('pw123456'); await manager.save();
  const other = new User({ name: 'OtherMgr', email: 'o@w.com', role: 'manager' });
  await other.setPassword('pw123456'); await other.save();

  const mk = async (name, email, managerId) => {
    const d = new User({ name, email, role: 'user', managerId, active: true });
    await d.setPassword('pw123456'); await d.save(); return d;
  };
  // Three drivers in one depot (within ~25 km), one far north, one with no recent trip.
  const a = await mk('Depot A1', 'a1@w.com', manager._id);
  const b = await mk('Depot A2', 'a2@w.com', manager._id);
  const c = await mk('Depot A3', 'a3@w.com', manager._id);
  const north = await mk('Northerner', 'n@w.com', manager._id);
  const idle = await mk('Never Driven', 'i@w.com', manager._id);
  const foreign = await mk('Someone Elses', 'x@w.com', other._id);

  const trip = (driver, lat, lon, daysAgo) => Trip.create({
    driverId: driver._id, managerId: driver.managerId, status: 'completed',
    startedAt: new Date(Date.now() - daysAgo * 86400_000),
    lastLocation: { lat, lon, speed: 0, heading: 0, recordedAt: new Date(Date.now() - daysAgo * 86400_000) },
  });

  await trip(a, 17.41, 78.44, 1);
  await trip(b, 17.43, 78.46, 2);   // same grid square as A
  await trip(c, 17.39, 78.42, 3);   // same grid square as A
  await trip(north, 40.10, 78.40, 1);
  await trip(idle, 17.41, 78.44, 30); // too old to trust
  await trip(foreign, 17.41, 78.44, 1);

  const { drivingConditions, _cache } = require('../src/services/weather');

  console.log('\n── clustering: many drivers, few API calls ──');
  let out = await drivingConditions({ scope: {}, dayOffset: 0 });
  assert(out.configured === true, 'Open-Meteo needs no key, so the feature is always available');
  assert(out.groups.length === 2, `four placed drivers collapse to 2 locations (got ${out.groups.length})`);
  assert(calls.length === 2, `only 2 API calls were made, not one per driver (got ${calls.length})`);
  // Unscoped (admin) view, so the other manager's driver — parked at the same depot — is
  // in here too: four drivers, one forecast.
  const depot = out.groups.find(g => g.drivers.some(d => d.name === 'Depot A1'));
  assert(depot && depot.drivers.length === 4,
    `every driver at the depot shares one forecast (got ${depot ? depot.drivers.length : 0})`);
  assert(['Depot A1', 'Depot A2', 'Depot A3'].every(n => depot.drivers.some(d => d.name === n)),
    'all three depot drivers are grouped together');
  assert(calls.every(u => u.includes('wind_speed_unit=kmh')), 'asks for km/h so no conversion is needed');
  assert(calls.every(u => u.includes('timeformat=unixtime')), 'asks for UTC epoch times so local-day maths stays exact');

  console.log('\n── caching ──');
  out = await drivingConditions({ scope: {}, dayOffset: 0 });
  assert(calls.length === 2, 'a second load hits the cache and makes no further calls');
  assert(out.totals.apiCalls === 0, 'and reports that nothing was refetched');

  console.log('\n── verdicts reach the right drivers ──');
  const bad = out.groups.find(g => g.verdict === 'unsafe');
  assert(bad && bad.drivers.length === 1 && bad.drivers[0].name === 'Northerner',
    'the thunderstorm/75 km/h-gust location is flagged unsafe, and only its driver is in it');
  assert(/thunderstorm|gust/i.test(bad.headline), `the headline says why (${bad.headline})`);
  assert(out.groups[0].verdict === 'unsafe', 'worst location is sorted first');
  const good = out.groups.find(g => g.verdict === 'clear');
  assert(good && good.drivers.length === 4, 'the calm depot is clear, with everyone parked there');

  console.log('\n── drivers we cannot place are said so, not guessed ──');
  const names = out.unplaced.map(u => u.name);
  assert(names.includes('Never Driven'), 'a driver whose last trip is 30 days old is unplaced');
  assert(!names.includes('Depot A1'), 'recently-active drivers are not in the unplaced list');
  assert(out.totals.unplaced === out.unplaced.length, 'the unplaced total matches the list');

  console.log('\n── manager scoping ──');
  const scoped = await drivingConditions({ scope: { driverId: { $in: [a._id, b._id] } }, dayOffset: 0 });
  const scopedNames = scoped.groups.flatMap(g => g.drivers.map(d => d.name)).concat(scoped.unplaced.map(u => u.name));
  assert(!scopedNames.includes('Someone Elses'), "another manager's driver never appears");
  assert(!scopedNames.includes('Northerner'), 'out-of-scope drivers are excluded entirely');

  console.log('\n── a weather outage serves stale data rather than an error ──');
  _cache.forEach((v) => { v.at = Date.now() - 60 * 60_000; }); // force expiry
  globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'upstream down' });
  out = await drivingConditions({ scope: {}, dayOffset: 0 });
  assert(out.groups.length === 2, 'both locations still render during an outage');
  assert(out.groups.every(g => g.stale), 'and are marked stale so nobody trusts them blindly');

  console.log(`\n🎉 WEATHER PIPELINE VERIFIED — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
