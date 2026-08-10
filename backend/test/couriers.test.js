// Courier-location search tests — mapping, distance, caching, budget.
// Run: npm run test:couriers   (no DB, no network — fetch is stubbed)
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/couriers_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'couriers_test_secret_key_1234567890';
process.env.SERPER_API_KEY = 'test-key';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (got ${a})`);

const serper = require('../src/services/serperCouriers');
const { mapPlace, cacheKey } = serper;

// A place shaped like a live Serper Places payload.
const RAW = {
  position: 2,
  title: 'fedex dhl courier services',
  address: 'ISB Rd, Madhava Reddy Colony, Gachibowli, Telangana 500032',
  latitude: 17.422503,
  longitude: 78.34758,
  category: 'Shipping and mailing service',
  phoneNumber: '077803 60577',
  website: 'http://www.fedex.com/',
  cid: '6544209254278472921',
};
const ORIGIN = { lat: 17.385044, lon: 78.486671 };

(async () => {
  console.log('\n── place mapping ──');
  const p = mapPlace(RAW, ORIGIN);
  assert(p.id === '6544209254278472921', 'cid carried through as id');
  assert(p.name === 'fedex dhl courier services', 'title mapped to name');
  assert(p.address.includes('Gachibowli'), 'address carried through');
  assert(p.category === 'Shipping and mailing service', 'category carried through');
  assert(p.phone === '077803 60577', 'phone carried through');
  assert(mapPlace({ ...RAW, cid: undefined, placeId: 'p1' }, ORIGIN).id === 'p1', 'placeId used when cid is absent');
  assert(mapPlace({ title: undefined }, ORIGIN).name === 'Unnamed location', 'a place with no title still gets a name');

  console.log('\n── distance (the API gives none) ──');
  near(p.distanceKm, 15.3, 0.2, 'distance computed from coordinates');
  assert(mapPlace({ ...RAW, latitude: null, longitude: null }, ORIGIN).distanceKm === null,
    'a place with no coordinates has no distance rather than a wrong one');

  console.log('\n── cache keys ──');
  const q = { lat: 17.385, lon: 78.4867, locationName: 'Hyderabad, India', query: 'courier' };
  assert(cacheKey(q) === cacheKey({ ...q, lat: 17.3851, lon: 78.4868 }),
    'drivers a few hundred metres apart share one cached search');
  assert(cacheKey(q) !== cacheKey({ ...q, lat: 28.6 }), 'a different city is a different key');
  assert(cacheKey(q) !== cacheKey({ ...q, locationName: 'Secunderabad, India' }),
    'a different resolved place name is a different key');

  console.log('\n── live call path (fetch stubbed) ──');
  const realFetch = global.fetch;
  let calls = 0;
  let lastBody = null;
  const reply = (body, status = 200) => {
    global.fetch = async (url, opts) => {
      calls += 1;
      lastBody = JSON.parse(opts.body);
      return { ok: status < 400, status, json: async () => body };
    };
  };

  serper._cache.clear();
  serper._budget.day = null;
  const baseQ = { lat: 17.385, lon: 78.4867, locationName: 'Hyderabad, Telangana, India', query: 'courier OR FedEx' };

  reply({ places: [RAW, { ...RAW, cid: 'x2' }], credits: 1 });
  const ok = await serper.searchNearby(baseQ);
  assert(ok.places.length === 2, 'places array is mapped');
  assert(ok.totalFound === 2, 'totalFound reflects what came back');
  assert(ok.fromCache === false, 'a fresh fetch is flagged as such');
  assert(lastBody.location === 'Hyderabad, Telangana, India', 'resolved place name is sent as location');
  assert(lastBody.q === 'courier OR FedEx', 'query text is sent');

  const before = calls;
  const again = await serper.searchNearby(baseQ);
  assert(calls === before, 'an identical search is served from cache with no second paid call');
  assert(again.fromCache === true, 'cached responses say so explicitly');

  // Budget guard
  serper._budget.used = 9999;
  let caught = null;
  try { await serper.searchNearby({ ...baseQ, locationName: 'Somewhere else, India' }); }
  catch (e) { caught = e; }
  assert(caught && caught.status === 429, 'the daily call budget refuses further paid calls');
  serper._budget.used = 0;

  reply({}, 401);
  caught = null;
  try { await serper.searchNearby({ ...baseQ, locationName: 'A third place, India' }); }
  catch (e) { caught = e; }
  assert(caught && caught.message.includes('key'), 'a rejected API key says so plainly');

  global.fetch = realFetch;
  console.log(`\n🎉 COURIER SEARCH — ${passed} assertions passed\n`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
