/**
 * Deterministic checks for pickActiveArea (src/lib/activeArea.ts) — the rule that decides which
 * of the driver's allocated areas the map opens on and Navigate heads for.
 *
 * This imports the REAL module rather than a hand-kept copy of its rules: Node 24 strips the
 * types and runs the shipped source, so a case that passes here passes against the code the
 * driver gets. The rule is pure (areas in, one area out) which is why this is a pass/fail suite
 * rather than the scored rubric local-snap.sim.mjs needs — there is a right answer for every case.
 *
 * Geometry is authored in lon/lat degrees directly; Melbourne's cos(lat) ≈ 0.79 is what the
 * "ground distance, not raw degrees" case leans on.
 *
 * Run: node src/lib/__sim__/active-area.sim.mjs
 */

import { pickActiveArea, areaBbox } from '../activeArea.ts';

const LON = 145.25;
const LAT = -38.03;

/** One allocated area, as /my-areas serves it. */
const area = (id, extra = {}) => ({
  id,
  areaCode: `SA2-${id}`,
  name: `Area ${id}`,
  parentName: null,
  priority: 2,
  targetMeters: 1000,
  targetLinks: 10,
  bbox: null,
  outline: null,
  assignedAt: null,
  ...extra,
});

/** A square area centred at [lon, lat] with the given half-width in degrees. */
function square(id, lon, lat, half, extra = {}) {
  const ring = [
    [lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half],
    [lon - half, lat + half], [lon - half, lat - half],
  ];
  return area(id, {
    bbox: [lon - half, lat - half, lon + half, lat + half],
    outline: { type: 'Polygon', coordinates: [ring] },
    ...extra,
  });
}

let all = true;
function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const out = fn();
    ok = out.ok;
    detail = out.detail || '';
  } catch (e) {
    detail = `threw: ${e && e.message ? e.message : e}`;
  }
  all = all && ok;
  console.log(`${ok ? 'PASS ✅' : 'FAIL ❌'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ── the cases ──────────────────────────────────────────────────────────────── */

check('standing in one area picks it, from a grid of 25', () => {
  const areas = [];
  for (let i = 0; i < 25; i++) {
    areas.push(square(`g${i}`, LON + (i % 5) * 0.1, LAT + Math.floor(i / 5) * 0.1, 0.04));
  }
  const pick = pickActiveArea(areas, [LON + 0.02, LAT + 0.02]);
  return { ok: pick?.area.id === 'g0' && pick.inside === true, detail: `${pick?.area.id} inside=${pick?.inside}` };
});

check('inside a nested pair, the smaller area wins whatever the order', () => {
  const suburb = square('suburb', LON, LAT, 0.01);
  const region = square('region', LON, LAT, 0.08);
  const p = [LON + 0.002, LAT + 0.002];
  const fwd = pickActiveArea([region, suburb], p);
  const rev = pickActiveArea([suburb, region], p);
  return {
    ok: fwd?.area.id === 'suburb' && rev?.area.id === 'suburb' && fwd.inside === true,
    detail: `fwd=${fwd?.area.id} rev=${rev?.area.id}`,
  };
});

check('inside two overlapping areas, the smaller wins', () => {
  const a = square('a', LON, LAT, 0.02);
  const b = square('b', LON + 0.015, LAT, 0.01); // overlaps a's east half
  const p = [LON + 0.012, LAT]; // in both
  const pick = pickActiveArea([a, b], p);
  return { ok: pick?.area.id === 'b' && pick.inside === true, detail: `${pick?.area.id}` };
});

check('outside every area, the nearest by box distance wins', () => {
  const near = square('near', LON + 0.02, LAT, 0.01);
  const far = square('far', LON + 0.1, LAT, 0.01);
  const pick = pickActiveArea([far, near], [LON, LAT]);
  return { ok: pick?.area.id === 'near' && pick.inside === false, detail: `${pick?.area.id} inside=${pick?.inside}` };
});

check('"nearest" is ground distance: longitude is scaled by cos(lat)', () => {
  // Half a suburb south is 0.001° of latitude; half a suburb east is 0.0012° of longitude.
  // In raw degrees the south one is nearer; on the ground at -38° the east one is (~0.0012×0.79).
  const east = square('east', LON + 0.0012, LAT, 0.0001);
  const south = square('south', LON, LAT + 0.001, 0.0001);
  const pick = pickActiveArea([south, east], [LON, LAT]);
  return {
    ok: pick?.area.id === 'east',
    detail: `picked ${pick?.area.id} (raw degrees would say south)`,
  };
});

check('no fix at all: the most recently assigned area is the one framed', () => {
  const older = square('older', LON, LAT, 0.01, { assignedAt: '2026-09-01T00:00:00Z' });
  const fresh = square('fresh', LON + 0.1, LAT, 0.01, { assignedAt: '2026-09-28T00:00:00Z' });
  const pick = pickActiveArea([fresh, older], null);
  return { ok: pick?.area.id === 'fresh', detail: `${pick?.area.id}` };
});

check('a live fix outranks the newest assignment', () => {
  const standingIn = square('standingIn', LON, LAT, 0.01, { assignedAt: '2026-09-01T00:00:00Z' });
  const handedOutLater = square('handedOutLater', LON + 0.1, LAT, 0.01, { assignedAt: '2026-09-28T00:00:00Z' });
  const pick = pickActiveArea([handedOutLater, standingIn], [LON + 0.001, LAT + 0.001]);
  return { ok: pick?.area.id === 'standingIn' && pick.inside === true, detail: `${pick?.area.id}` };
});

check('a bbox-only area (imported before outlines were stored) still matches inside it', () => {
  const boxOnly = area('boxOnly', { bbox: [LON - 0.01, LAT - 0.01, LON + 0.01, LAT + 0.01] });
  const pick = pickActiveArea([boxOnly], [LON, LAT]);
  return { ok: pick?.area.id === 'boxOnly' && pick.inside === true, detail: `${pick?.area.id} inside=${pick?.inside}` };
});

check('a courtyard hole is NOT inside: the small area in the hole wins', () => {
  const outer = [
    [LON - 0.01, LAT - 0.01], [LON + 0.01, LAT - 0.01], [LON + 0.01, LAT + 0.01],
    [LON - 0.01, LAT + 0.01], [LON - 0.01, LAT - 0.01],
  ];
  const hole = [
    [LON - 0.002, LAT - 0.002], [LON + 0.002, LAT - 0.002], [LON + 0.002, LAT + 0.002],
    [LON - 0.002, LAT + 0.002], [LON - 0.002, LAT - 0.002],
  ];
  const holed = area('holed', {
    bbox: [LON - 0.01, LAT - 0.01, LON + 0.01, LAT + 0.01],
    outline: { type: 'Polygon', coordinates: [outer, hole] },
  });
  const inHole = square('inHole', LON, LAT, 0.0005);
  const both = pickActiveArea([holed, inHole], [LON, LAT]);
  const only = pickActiveArea([holed], [LON, LAT]);
  return {
    ok: both?.area.id === 'inHole' && both.inside === true && only?.area.id === 'holed' && only.inside === false,
    detail: `with neighbour=${both?.area.id}/${both?.inside}, alone=${only?.area.id}/${only?.inside}`,
  };
});

check('a MultiPolygon area is inside wherever any of its parts is', () => {
  const partA = [[LON, LAT], [LON + 0.001, LAT], [LON + 0.001, LAT + 0.001], [LON, LAT + 0.001], [LON, LAT]];
  // The second part is half a degree away — the driver can only be in one of them.
  const partB = [[LON + 0.5, LAT], [LON + 0.501, LAT], [LON + 0.501, LAT + 0.001], [LON + 0.5, LAT + 0.001], [LON + 0.5, LAT]];
  const multi = area('multi', {
    bbox: [LON, LAT, LON + 0.501, LAT + 0.001],
    outline: { type: 'MultiPolygon', coordinates: [[partA], [partB]] },
  });
  const pick = pickActiveArea([multi], [LON + 0.5 + 0.0005, LAT + 0.0005]);
  return { ok: pick?.area.id === 'multi' && pick.inside === true, detail: `inside=${pick?.inside}` };
});

check('no bbox shipped: it is derived from the outline and used', () => {
  const ring = [
    [LON - 0.01, LAT - 0.01], [LON + 0.01, LAT - 0.01], [LON + 0.01, LAT + 0.01],
    [LON - 0.01, LAT + 0.01], [LON - 0.01, LAT - 0.01],
  ];
  const noBox = area('noBox', { outline: { type: 'Polygon', coordinates: [ring] } });
  const b = areaBbox(noBox);
  const want = [LON - 0.01, LAT - 0.01, LON + 0.01, LAT + 0.01];
  const same = b && want.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const pick = pickActiveArea([noBox], [LON, LAT]);
  return { ok: same && pick?.area.id === 'noBox' && pick.inside === true, detail: `bbox=${JSON.stringify(b)}` };
});

check('areas with no usable geometry are skipped; nothing usable returns null', () => {
  const empty = area('empty');
  const junkBox = area('junkBox', { bbox: [1, 2, 3, NaN] });
  const none = pickActiveArea([empty, junkBox], [LON, LAT]);
  const withReal = pickActiveArea([empty, square('real', LON, LAT, 0.01)], [LON, LAT]);
  return {
    ok: none === null && withReal?.area.id === 'real',
    detail: `none=${none === null ? 'null' : 'not-null'} withReal=${withReal?.area.id}`,
  };
});

check('a junk fix (NaN) falls back to the newest assignment, never throws', () => {
  const a = square('a', LON, LAT, 0.01, { assignedAt: '2026-09-01T00:00:00Z' });
  const b = square('b', LON + 0.1, LAT, 0.01, { assignedAt: '2026-09-28T00:00:00Z' });
  const pick = pickActiveArea([a, b], [NaN, NaN]);
  return { ok: pick?.area.id === 'b', detail: `${pick?.area.id}` };
});

console.log(`\n${all ? 'ALL ACTIVE-AREA SCENARIOS PASS' : 'SOME ACTIVE-AREA SCENARIOS FAILED'}`);
process.exit(all ? 0 : 1);
