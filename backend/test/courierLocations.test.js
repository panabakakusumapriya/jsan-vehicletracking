// Database-backed courier lookup: services/courierLocations.js + models/CourierLocation.js.
// The courier page used to call a metered Places API; it now answers from our own imported
// dataset. Run: npm run test:courier-locations
process.env.JWT_SECRET = process.env.JWT_SECRET || 'courier_loc_test_secret_1234567890';
process.env.VALHALLA_ENABLED = 'false';

let passed = 0;
function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  passed += 1;
  console.log('✅', msg);
}

(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('courier_loc_test');

  const { connectDB } = require('../src/config/db');
  await connectDB();
  const mongoose = require('mongoose');
  const CourierLocation = require('../src/models/CourierLocation');
  const { nearbyCouriers, datasetStatus } = require('../src/services/courierLocations');

  // Central London as the origin. Offsets in degrees of longitude at this latitude are roughly
  // 69 m per 0.001, so the fixtures sit at known, checkable distances.
  const ORIGIN = { lat: 51.5072, lon: -0.1276 };

  let n = 0;
  const place = (props) => ({
    sourceId: `fixture-${++n}`,
    name: props.name,
    brand: props.brand ?? null,
    category: props.category ?? 'courier_and_delivery_service',
    basicCategory: props.basicCategory ?? 'shipping_or_delivery_service',
    confidence: props.confidence ?? 0.99,
    phone: props.phone ?? '+441234567890',
    website: props.website ?? 'https://example.com',
    address: props.address ?? '1 Test Street',
    isoCountry: props.isoCountry ?? 'GB',
    addrCountry: 'GB',
    continent: 'europe',
    location: { type: 'Point', coordinates: [props.lon, props.lat] },
    sourceFile: 'test-fixture.geojson',
  });

  // A spread of distances, plus one deliberately far away.
  await CourierLocation.insertMany([
    place({ name: 'Nearest locker', lat: 51.5074, lon: -0.1278, brand: null, category: 'package_locker' }),
    place({ name: 'The UPS Store Holborn', lat: 51.5100, lon: -0.1300, brand: 'The UPS Store' }),
    place({ name: 'FedEx Office Print & Ship', lat: 51.5150, lon: -0.1400, brand: 'FedEx Ship Center', category: 'printing_service' }),
    // THE case that decided the design: a real DHL drop-off the provider filed under a
    // business-services category. Any category allow-list would silently discard it.
    place({ name: 'DHL Express Service Point (Pall Mall)', lat: 51.5060, lon: -0.1350, brand: 'DHL', category: 'b2b_business_management_service' }),
    place({ name: 'Doubtful depot', lat: 51.5090, lon: -0.1290, confidence: 0.42 }),
    // ~163 km away: outside any sane "near the driver" radius, but inside the 200 km ceiling
    // the service clamps to, so both the radius and the clamp can be tested against it.
    place({ name: 'Far away Birmingham', lat: 52.4862, lon: -1.8904, brand: 'The UPS Store' }),
  ]);
  await CourierLocation.syncIndexes();

  console.log('\n── the dataset reports itself ──');
  {
    const s = await datasetStatus();
    assert(s.total === 6, `datasetStatus counts the rows (got ${s.total})`);
    assert(s.metered === false, 'and says plainly that it is not metered — nothing here costs a quota');
  }

  console.log('\n── nearest first, within the radius ──');
  {
    const r = await nearbyCouriers({ ...ORIGIN, radiusKm: 10 });
    assert(r.places.length === 5, `the 5 London points are inside 10 km, Birmingham is not (got ${r.places.length})`);
    assert(r.places[0].name === 'Nearest locker', 'results come back nearest first');
    const ds = r.places.map((p) => p.distanceKm);
    assert(ds.every((d, i) => i === 0 || d >= ds[i - 1]), 'and the ordering holds all the way down');
    assert(r.places.every((p) => p.distanceKm <= 10), 'nothing outside the requested radius survives');
  }

  console.log('\n── the radius is really enforced, not just requested ──');
  {
    const tight = await nearbyCouriers({ ...ORIGIN, radiusKm: 1 });
    assert(tight.places.length < 5, `a 1 km radius returns fewer than a 10 km one (got ${tight.places.length})`);
    assert(tight.places.every((p) => p.distanceKm <= 1), 'and every survivor is genuinely within 1 km');

    const wide = await nearbyCouriers({ ...ORIGIN, radiusKm: 200 });
    assert(wide.places.length === 6, 'a 200 km radius reaches Birmingham');
  }

  console.log('\n── an absurd radius is clamped, not obeyed ──');
  {
    // 200 km is the ceiling. Without it, a caller passing radiusKm=20000 would ask the database
    // to sort the entire planet by distance and then throw almost all of it away — and the answer
    // would not be useful anyway: "where can this driver post a parcel" has no sensible answer
    // three countries away.
    const absurd = await nearbyCouriers({ ...ORIGIN, radiusKm: 20000 });
    assert(absurd.radiusKm === 200, `radius is clamped to 200 km (got ${absurd.radiusKm})`);
    assert(absurd.places.length === 6, 'and the clamped search still returns everything inside it');
  }

  console.log('\n── the result limit caps the list without disturbing the ordering ──');
  {
    const r = await nearbyCouriers({ ...ORIGIN, radiusKm: 500, limit: 2 });
    assert(r.places.length === 2, 'limit is honoured');
    assert(r.places[0].name === 'Nearest locker', 'and it keeps the NEAREST, not an arbitrary two');
  }

  console.log('\n── categories are never filtered silently ──');
  {
    const r = await nearbyCouriers({ ...ORIGIN, radiusKm: 10 });
    const names = r.places.map((p) => p.name);
    assert(names.some((x) => x.includes('DHL Express Service Point')),
      'a real DHL point filed under b2b_business_management_service is still returned — a category allow-list would have dropped it');
    assert(names.some((x) => x.includes('FedEx Office')),
      'and a FedEx Office filed under printing_service too');
  }

  console.log('\n── but a caller can ask for a filter explicitly ──');
  {
    const ups = await nearbyCouriers({ ...ORIGIN, radiusKm: 200, brand: 'The UPS Store' });
    assert(ups.places.length === 2, `brand filter narrows to the two UPS Stores (got ${ups.places.length})`);
    assert(ups.places[0].distanceKm < ups.places[1].distanceKm, 'still nearest first');

    const lockers = await nearbyCouriers({ ...ORIGIN, radiusKm: 10, category: 'package_locker' });
    assert(lockers.places.length === 1, 'category filter works when asked for');
  }

  console.log('\n── the place shape is exactly what the page renders ──');
  {
    const r = await nearbyCouriers({ ...ORIGIN, radiusKm: 10 });
    const p = r.places[0];
    for (const k of ['id', 'name', 'address', 'category', 'phone', 'website', 'rating',
      'ratingCount', 'lat', 'lon', 'distanceKm', 'brand', 'confidence', 'isoCountry']) {
      assert(k in p, `place carries "${k}"`);
    }
    assert(p.rating === null && p.ratingCount === 0,
      'rating is null: this dataset has no reviews, and confidence must NOT be dressed up as one — ' +
      '"we are sure it exists" is not "customers liked it"');
    assert(p.category === 'package locker',
      'the provider slug package_locker is humanised for display');
    assert(r.places.every((x) => !x.category || !x.category.includes('_')),
      'and no underscored slug reaches the page on any row');
    assert(typeof p.lat === 'number' && typeof p.lon === 'number', 'coordinates come back as numbers the map can use');
  }

  console.log('\n── an area we hold nothing for returns empty, not an error ──');
  {
    const r = await nearbyCouriers({ lat: -33.8688, lon: 151.2093, radiusKm: 25 }); // Sydney
    assert(Array.isArray(r.places) && r.places.length === 0,
      'no coverage is an empty list — the caller decides how to say "we do not hold this area"');
    assert(r.totalFound === 0, 'and totalFound agrees');
  }

  console.log('\n── re-importing the same point updates it rather than duplicating it ──');
  {
    const before = await CourierLocation.countDocuments();
    await CourierLocation.bulkWrite([{
      updateOne: {
        filter: { sourceId: 'fixture-1' },
        update: { $set: { name: 'Nearest locker (renamed)', phone: '+440000000000' } },
        upsert: true,
      },
    }]);
    const after = await CourierLocation.countDocuments();
    assert(after === before, `upserting an existing sourceId does not add a row (${before} -> ${after})`);
    const row = await CourierLocation.findOne({ sourceId: 'fixture-1' }).lean();
    assert(row.name === 'Nearest locker (renamed)', 'it updates the existing one in place');
  }

  console.log(`\n🎉 COURIER LOCATIONS (database-backed) — ${passed} assertions passed`);
  await mongoose.disconnect();
  await mongod.stop();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
