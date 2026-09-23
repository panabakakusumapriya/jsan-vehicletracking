const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'hotel-search-test-secret';
process.env.MONGODB_URI = 'mongodb://127.0.0.1/hotel-search-test';
const stub = (path, exports) => { require.cache[require.resolve(path)] = { id: require.resolve(path), filename: require.resolve(path), loaded: true, exports }; };
let filter;
let search;
let total = 1;
const now = Date.now();
Date.now = () => now;
let aliceAt = new Date(now - 49 * 60 * 60 * 1000);
stub('../src/models/User', { find: f => { filter = f; return { select: () => ({ sort: async () => [
  { _id: 'a', name: 'Alice', project: 'Alpha' },
  { _id: 'b', name: 'Bob', project: 'Beta' },
] }) }; } });
stub('../src/utils/driverPositions', { recentDriverPositions: async (scope, days) => {
  assert.equal(days, null);
  assert.deepEqual(scope, { driverId: { $in: ['a', 'b'] } });
  return [{ _id: 'a', lat: 17, lon: 78, at: aliceAt }, { _id: 'b', lat: 18, lon: 79, at: new Date(now) }];
} });
stub('../src/services/hotelLocations', {
  datasetStatus: async () => ({ total, metered: false }),
  nearbyHotels: async opts => { search = opts; return { places: [], totalFound: 0 }; },
});
stub('../src/services/geocode', { reverseGeocodeMany: async () => { assert.fail('Hotel lookup must not call external geocoding'); } });
stub('../src/services/drivingWeather', { gridKey: () => 'test' });
const { hotelsForDrivers } = require('../src/services/hotelSearch');
(async () => {
  const scope = { driverId: { $in: ['a', 'b'] } };
  const first = await hotelsForDrivers({ scope });
  assert.deepEqual(filter._id, scope.driverId);
  assert.deepEqual(first.projects, ['Alpha', 'Beta']);
  assert.equal(first.selected._id, 'b');
  assert.deepEqual(first.drivers.map(d => d._id), ['b']);
  assert.equal(first.unplaced.length, 0);
  assert.equal(first.search.locationName, null);
  assert.match(first.message, /No accommodation/);
  const beta = await hotelsForDrivers({ scope, project: 'Beta', driverId: 'a', category: 'hostel', radiusKm: 500 });
  assert.equal(beta.drivers.length, 1);
  assert.equal(beta.selected._id, 'b');
  assert.equal(beta.selected.stale, false);
  assert.equal(search.category, 'hostel');
  assert.equal(search.radiusKm, 200);
  assert.equal(beta.search.project, 'Beta');
  const empty = await hotelsForDrivers({ scope, project: 'Missing' });
  assert.equal(empty.selected, null);
  assert.deepEqual(empty.properties, []);
  for (const [at, included] of [
    [new Date(now - 48 * 60 * 60 * 1000), true],
    [new Date(now - 48 * 60 * 60 * 1000 - 1), false],
    [null, false],
    ['invalid', false],
    [new Date(now + 1000), false],
  ]) {
    aliceAt = at;
    const result = await hotelsForDrivers({ scope, driverId: 'a' });
    assert.equal(result.drivers.some(d => d._id === 'a'), included);
    assert.equal(result.selected._id, included ? 'a' : 'b');
  }
  total = 0;
  assert.equal((await hotelsForDrivers({ scope })).configured, false);
  console.log('Hotel search: project filtering, scope, 48-hour position cutoff, empty results and offline geocoding passed');
})().catch(err => { console.error(err); process.exitCode = 1; });
