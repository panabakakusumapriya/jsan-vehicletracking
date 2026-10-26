/**
 * Roads with no polygons: the outline drawn round them (services/roadFootprint.js), and the name
 * the drawn area gets (networkImport.drawnAreaName). Pure — no database.
 */
const polygonClipping = require('polygon-clipping');
const { createFootprint } = require('../src/services/roadFootprint');
const { drawnAreaName, isDrawn } = require('../src/services/networkImport');
const { pointInPolygon, midpointOf } = require('../src/utils/geo');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { failures++; console.error(`  ✗ ${msg}`); }
}

const M = 111194.92664455873;
/** A street grid of n×n blocks of `blockM`, its south-west corner at [lon, lat]. */
function grid(lon, lat, n, blockM) {
  const dLon = blockM / (M * Math.cos((lat * Math.PI) / 180));
  const dLat = blockM / M;
  const lines = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j < n; j++) {
      lines.push([[lon + i * dLon, lat + j * dLat], [lon + i * dLon, lat + (j + 1) * dLat]]);
      lines.push([[lon + j * dLon, lat + i * dLat], [lon + (j + 1) * dLon, lat + i * dLat]]);
    }
  }
  return lines;
}
const inside = (geometry, pt) => geometry.coordinates.some((polygon) => pointInPolygon(pt, polygon));

console.log('\n-- two towns 20 km apart, joined by nothing --');
const townA = grid(174.70, -41.30, 10, 120);
const townB = grid(174.94, -41.30, 6, 120);
const lines = [...townA, ...townB];
const all = lines.flat();
const bbox = [
  Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])),
  Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1])),
];
const fp = createFootprint(bbox);
lines.forEach((l) => fp.addLine(l));
const out = fp.finish();
assert(out && out.geometry.type === 'MultiPolygon', 'a MultiPolygon comes back');
assert(out.pieces === 2, `one piece per town (${out.pieces})`);
assert(lines.every((l) => inside(out.geometry, midpointOf(l))), 'every road is inside the outline');
assert(out.geometry.coordinates.every((polygon) => polygon.length === 1), 'no holes');
const again = polygonClipping.union(...out.geometry.coordinates.map((p) => [p]));
assert(again.length === out.pieces, 'the outline is valid: a union of itself changes nothing');
const farPoint = [174.82, -41.29]; // between the towns
assert(!inside(out.geometry, farPoint), 'ground between the towns, with no road, is outside');

console.log('\n-- a street with a gap in it is still one piece --');
const street = [[[175.0, -41.0], [175.01, -41.0]], [[175.0115, -41.0], [175.03, -41.0]]];
const fp2 = createFootprint([175.0, -41.0, 175.03, -41.0]);
street.forEach((l) => fp2.addLine(l));
assert(fp2.finish().pieces === 1, 'a 130 m gap does not cut it in two');

console.log('\n-- the outline stays small for a large extent --');
const wide = createFootprint([170, -46, 178, -38], { maxVertices: 400 });
for (let k = 0; k < 40; k++) wide.addLine([[170 + k * 0.2, -46], [170 + k * 0.2, -38]]);
const w = wide.finish();
assert(w.vertices <= 400, `coarsened until it fits (${w.vertices} points at ${Math.round(w.cellM)} m cells)`);

console.log('\n-- nothing to draw --');
assert(createFootprint([0, 0, 1, 1]).finish() === null, 'no roads, no outline');

console.log('\n-- names --');
const parts = (...names) => ({ parts: names.map((name) => ({ name })) });
assert(drawnAreaName({}, parts('Wellington_FC1-2_Nav', 'Wellington_FC3_Nav', 'Wellington_FC5_Nav')) === 'Wellington', 'road-class files -> the place');
assert(drawnAreaName({}, { name: 'Auckland_FC345_Nav' }) === 'Auckland', 'one file -> the place');
assert(drawnAreaName({ label: 'HE Drive network' }, { name: 'FC5_Nav' }) === 'HE Drive network', 'nothing in the file name -> the label');

console.log('\n-- when it applies --');
assert(isDrawn({ drawZones: { minKm: 250, maxKm: 300 } }, { boundary: null, network: {} }), 'roads, no polygons, asked for');
assert(!isDrawn({ drawZones: null }, { boundary: null, network: {} }), 'not asked: roads join the active areas as before');
assert(!isDrawn({ drawZones: { minKm: 250, maxKm: 300 } }, { boundary: {}, network: {} }), 'polygons supplied: they win');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nroadFootprint: all passed');
