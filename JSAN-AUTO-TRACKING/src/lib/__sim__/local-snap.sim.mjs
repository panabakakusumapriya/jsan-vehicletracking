/**
 * Scored simulation of the on-device map matcher (src/lib/localSnap.ts).
 *
 * This imports the REAL module rather than a hand-kept copy of its rules, which is the whole
 * point: the older .sim.mjs files under modules/vehicle-tracker mirror Kotlin and can drift from
 * it, and have. Node 24 strips the types and runs the shipped source directly, so a scenario
 * that passes here passes against the code the driver gets.
 *
 * It is a RUBRIC, not a pass/fail suite. Map matching has no perfect answer — every tuning choice
 * trades a false positive somewhere for a false negative somewhere else — so each scenario scores
 * 0..1 on how close the result is to what a driver looking out of the windscreen would say, and
 * the total is what gets pushed up. A suite of booleans would hide that a "pass" was scraped by
 * one metre.
 *
 * What it cannot tell you: anything about the device. GPS quality under a motorway overpass, what
 * Doze does to fix cadence, whether MapLibre keeps 60 fps with the layer attached. Those need a
 * phone. What it does tell you is whether the algorithm is right when the fixes are what we think.
 *
 * Run: node src/lib/__sim__/local-snap.sim.mjs
 */

import {
  buildSnapIndex, createMatcher, createCoverStore, ingestFix, coverLines, coveredMeters,
  dropTrip, serialiseCover, deserialiseCover, sliceLink, SNAP_BUFFER_M, expireTrips, coverTripIds,
} from '../localSnap.ts';

/* ── a little world, in metres ──────────────────────────────────────────────── */

const LON0 = 153.02;
const LAT0 = -27.47;
const MX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const MY = 110540;

/** metre offset -> [lon, lat] */
const pt = (x, y) => [LON0 + x / MX, LAT0 + y / MY];
/** [lon, lat] -> metre offset, for assertions */
const un = (c) => [(c[0] - LON0) * MX, (c[1] - LAT0) * MY];

/** Deterministic noise. A seeded LCG so a score change is always a code change. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
/** Box–Muller, so the noise looks like GPS error rather than a uniform smear. */
function gauss(r) {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** A road from metre waypoints. */
const road = (id, points, covered = 0, fc = 5) => [id, fc, covered, points.map(([x, y]) => pt(x, y))];

/** Total length in metres of a metre-space waypoint list. */
function pathLen(points) {
  let t = 0;
  for (let i = 1; i < points.length; i++) {
    t += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return t;
}

/**
 * Drive a metre-space path, emitting fixes the way TrackingService does: roughly every
 * POINT_DISTANCE_M of travel, with Gaussian error on each.
 */
function drive(points, { spacing = 10, sigma = 3, seed = 1, tripId = 'T1', accuracy = null,
  withBearing = false, from = 0, to = 1, speedKmh = 45, t0 = 1_700_000_000_000,
  driftM = 0 } = {}) {
  const r = rng(seed);
  const total = pathLen(points);
  const fixes = [];
  const start = total * from;
  const end = total * to;
  let prevTrue = null;
  // Fixes carry a clock because the matcher tells a fast vehicle from a GPS glitch by implied
  // speed, exactly as TrackingService does. A sim without time could not exercise that at all.
  const msPerM = 3600 / speedKmh;
  // Real GPS error is not independent per fix: under a tree line or between buildings it sits
  // off to one side for half a minute and then drifts back. That correlated bias, not the
  // per-fix jitter, is what actually walks a matcher onto the next street, so it is modelled as
  // a bounded random walk applied across the direction of travel (the drives here run east).
  let bias = 0;
  for (let d = start; d <= end; d += spacing) {
    // Walk the polyline to distance d.
    let rem = d;
    let x = points[0][0];
    let y = points[0][1];
    for (let i = 1; i < points.length; i++) {
      const segLen = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      if (rem <= segLen || i === points.length - 1) {
        const t = segLen > 0 ? Math.min(1, rem / segLen) : 0;
        x = points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t;
        y = points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t;
        break;
      }
      rem -= segLen;
    }
    let bearing = null;
    if (withBearing && prevTrue) {
      bearing = (Math.atan2(x - prevTrue[0], y - prevTrue[1]) * 180) / Math.PI;
      if (bearing < 0) bearing += 360;
    }
    prevTrue = [x, y];
    if (driftM > 0) {
      bias += gauss(r) * driftM * 0.35;
      bias = Math.max(-driftM, Math.min(driftM, bias));
    }
    const [lon, lat] = pt(x + gauss(r) * sigma, y + bias + gauss(r) * sigma);
    fixes.push({ lon, lat, accuracy, bearing, tripId, atMs: Math.round(t0 + d * msPerM) });
  }
  return fixes;
}

/* ── rubric plumbing ────────────────────────────────────────────────────────── */

const results = [];
function scenario(name, weight, fn) {
  let score = 0;
  let detail = '';
  try {
    const out = fn();
    score = Math.max(0, Math.min(1, out.score));
    detail = out.detail;
  } catch (e) {
    score = 0;
    detail = `threw: ${e && e.message ? e.message : e}`;
  }
  results.push({ name, weight, score, detail });
}

/** 1 when value is inside [lo, hi]; falls off linearly outside over `slack`. */
function band(value, lo, hi, slack) {
  if (value >= lo && value <= hi) return 1;
  const miss = value < lo ? lo - value : value - hi;
  return Math.max(0, 1 - miss / slack);
}

/** Covered metres for one link id, from a fresh union. */
function coveredOf(store, linkId) {
  const merged = [];
  for (const perTrip of store.byTrip.values()) {
    const list = perTrip.get(linkId);
    if (!list) continue;
    for (let i = 0; i < list.length; i += 2) merged.push([list[i], list[i + 1]]);
  }
  merged.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curLo = null;
  let curHi = null;
  for (const [lo, hi] of merged) {
    if (curHi === null || lo > curHi) {
      if (curHi !== null) total += curHi - curLo;
      curLo = lo; curHi = hi;
    } else if (hi > curHi) curHi = hi;
  }
  if (curHi !== null) total += curHi - curLo;
  return total;
}

function run(roads, fixes) {
  const index = buildSnapIndex(roads);
  const m = createMatcher(index);
  const store = createCoverStore();
  for (const f of fixes) ingestFix(m, store, f);
  return { index, store };
}

/* ── scenarios ──────────────────────────────────────────────────────────────── */

// A 600 m street running east, and its neighbours.
const MAIN = [[0, 0], [600, 0]];
const PARALLEL_18 = [[0, 18], [600, 18]];   // the classic false positive
const PARALLEL_40 = [[0, 40], [600, 40]];
const CROSS = [[300, -200], [300, 200]];    // crosses MAIN at right angles

scenario('a street driven end to end reads as fully driven', 3, () => {
  const roads = [road('main', MAIN)];
  const { index, store } = run(roads, drive(MAIN, { seed: 11 }));
  const frac = coveredOf(store, 'main') / pathLen(MAIN);
  const { fullIds } = coverLines(index, store);
  const s = 0.5 * band(frac, 0.9, 1.0, 0.25) + 0.5 * (fullIds.has('main') ? 1 : 0);
  return { score: s, detail: `${(frac * 100).toFixed(1)}% covered, full=${fullIds.has('main')}` };
});

scenario('the parallel street 18 m away is NOT painted', 3, () => {
  const roads = [road('main', MAIN), road('par', PARALLEL_18)];
  const { store } = run(roads, drive(MAIN, { seed: 12 }));
  const bleed = coveredOf(store, 'par');
  const want = coveredOf(store, 'main');
  return {
    score: band(bleed, 0, 15, 90) * (want > 400 ? 1 : 0.5),
    detail: `${bleed.toFixed(0)} m bled onto the neighbour (main got ${want.toFixed(0)} m)`,
  };
});

scenario('a cross street is not painted by driving through its junction', 3, () => {
  const roads = [road('main', MAIN), road('cross', CROSS)];
  const { store } = run(roads, drive(MAIN, { seed: 13 }));
  const bleed = coveredOf(store, 'cross');
  return { score: band(bleed, 0, 20, 100), detail: `${bleed.toFixed(0)} m painted on the cross street` };
});

scenario('driving half a road paints half, not all of it', 3, () => {
  const roads = [road('main', MAIN)];
  const { index, store } = run(roads, drive(MAIN, { seed: 14, to: 0.5 }));
  const frac = coveredOf(store, 'main') / pathLen(MAIN);
  const { fullIds } = coverLines(index, store);
  return {
    score: band(frac, 0.42, 0.6, 0.2) * (fullIds.has('main') ? 0 : 1),
    detail: `${(frac * 100).toFixed(1)}% painted, wrongly-full=${fullIds.has('main')}`,
  };
});

scenario('turning at a junction paints both arms with no notch', 3, () => {
  // Drive east along MAIN to x=300, then north up CROSS.
  const roads = [road('main', MAIN), road('cross', CROSS)];
  const turnPath = [[0, 0], [300, 0], [300, 200]];
  const { store } = run(roads, drive(turnPath, { seed: 15 }));
  const mainCov = coveredOf(store, 'main');
  const crossCov = coveredOf(store, 'cross');
  // Expect ~300 m of main (of 600) and ~200 m of cross (of 400, driven from the middle north).
  return {
    score: 0.5 * band(mainCov, 270, 330, 80) + 0.5 * band(crossCov, 170, 235, 80),
    detail: `main ${mainCov.toFixed(0)} m (want ~300), cross ${crossCov.toFixed(0)} m (want ~200)`,
  };
});

scenario('a divided carriageway paints only the side driven', 3, () => {
  // Two one-way links 20 m apart. Bearings are supplied, as a real device does.
  const roads = [
    road('nb', [[0, 0], [600, 0]]),
    road('sb', [[600, 20], [0, 20]]),
  ];
  const { store } = run(roads, drive([[0, 0], [600, 0]], { seed: 16, withBearing: true, sigma: 2.5 }));
  const right = coveredOf(store, 'nb');
  const wrong = coveredOf(store, 'sb');
  return {
    score: 0.5 * band(right, 450, 600, 200) + 0.5 * band(wrong, 0, 25, 120),
    detail: `driven side ${right.toFixed(0)} m, opposite side ${wrong.toFixed(0)} m`,
  };
});

scenario('driving an already-covered road does not paint its red neighbour', 3, () => {
  // 'done' is server-covered; 'todo' runs 16 m away and must stay red.
  const roads = [road('done', MAIN, 1), road('todo', PARALLEL_18)];
  const { store } = run(roads, drive(MAIN, { seed: 17 }));
  const bleed = coveredOf(store, 'todo');
  return { score: band(bleed, 0, 10, 80), detail: `${bleed.toFixed(0)} m wrongly painted on the red neighbour` };
});

scenario('a car park off the network paints nothing', 2, () => {
  const roads = [road('main', MAIN)];
  // Circling 120 m north of the road — well outside any buffer.
  const loop = [[100, 120], [160, 120], [160, 170], [100, 170], [100, 120]];
  const { store } = run(roads, drive(loop, { seed: 18, spacing: 6 }));
  return { score: band(coveredOf(store, 'main'), 0, 0, 30), detail: `${coveredOf(store, 'main').toFixed(0)} m claimed while off-network` };
});

scenario('a GPS outlier does not paint the rest of the street', 3, () => {
  const roads = [road('main', MAIN)];
  const fixes = drive(MAIN, { seed: 19, to: 0.25 });
  const last = fixes[fixes.length - 1];
  // One fix teleports 410 m along the road half a second later — a classic urban multipath
  // glitch, and an impossible speed. The next real fix resumes where the vehicle actually is.
  fixes.push({ ...last, lon: pt(560, 0)[0], lat: pt(560, 0)[1], atMs: last.atMs + 500 });
  const resume = drive(MAIN, { seed: 19, from: 0.25, to: 0.32 });
  const shift = last.atMs + 1500 - resume[0].atMs;
  for (const f of resume) fixes.push({ ...f, atMs: f.atMs + shift });
  const { store } = run(roads, fixes);
  const cov = coveredOf(store, 'main');
  return { score: band(cov, 120, 230, 180), detail: `${cov.toFixed(0)} m painted (want ~150–200, not ~560)` };
});

scenario('a tunnel is not painted as driven', 2, () => {
  // Signal dies at 150 m and returns at 500 m. The 350 m in between was never observed: the
  // vehicle almost certainly drove it, but "almost certainly" is not what blue means here.
  const roads = [road('main', MAIN)];
  const before = drive(MAIN, { seed: 27, to: 0.25 });
  const after = drive(MAIN, { seed: 28, from: 0.833, to: 1 });
  const gapMs = before[before.length - 1].atMs + 28_000 - after[0].atMs;
  const fixes = [...before, ...after.map((f) => ({ ...f, atMs: f.atMs + gapMs }))];
  const { store } = run(roads, fixes);
  const cov = coveredOf(store, 'main');
  return { score: band(cov, 140, 270, 150), detail: `${cov.toFixed(0)} m painted across a 350 m outage (want ~250)` };
});

scenario('a U-shaped road is not short-circuited across its mouth', 3, () => {
  // Both arms 12 m apart at the mouth — inside the buffer of each other.
  const u = [[0, 0], [200, 0], [200, 12], [0, 12]];
  const roads = [road('u', u)];
  const { store } = run(roads, drive(u, { seed: 20, sigma: 2 }));
  const frac = coveredOf(store, 'u') / pathLen(u);
  return { score: band(frac, 0.85, 1.0, 0.3), detail: `${(frac * 100).toFixed(1)}% of the U painted` };
});

scenario('poor GPS still matches rather than going blind', 2, () => {
  const roads = [road('main', MAIN), road('par', PARALLEL_40)];
  const { store } = run(roads, drive(MAIN, { seed: 21, sigma: 9, accuracy: 20, withBearing: true }));
  const cov = coveredOf(store, 'main');
  const bleed = coveredOf(store, 'par');
  return {
    score: 0.6 * band(cov, 380, 600, 250) + 0.4 * band(bleed, 0, 40, 150),
    detail: `${cov.toFixed(0)} m matched at sigma 9 m, ${bleed.toFixed(0)} m bleed`,
  };
});

scenario('the server verdict for one trip replaces only that trip', 2, () => {
  const roads = [road('main', MAIN), road('cross', CROSS)];
  const index = buildSnapIndex(roads);
  const m = createMatcher(index);
  const store = createCoverStore();
  for (const f of drive(MAIN, { seed: 22, tripId: 'A' })) ingestFix(m, store, f);
  m.prev = null;
  for (const f of drive(CROSS, { seed: 23, tripId: 'B' })) ingestFix(m, store, f);
  const beforeMain = coveredOf(store, 'main');
  const beforeCross = coveredOf(store, 'cross');
  dropTrip(store, 'A');
  const afterMain = coveredOf(store, 'main');
  const afterCross = coveredOf(store, 'cross');
  const ok = beforeMain > 400 && beforeCross > 250 && afterMain === 0
    && Math.abs(afterCross - beforeCross) < 1;
  return {
    score: ok ? 1 : 0,
    detail: `main ${beforeMain.toFixed(0)}→${afterMain.toFixed(0)}, cross ${beforeCross.toFixed(0)}→${afterCross.toFixed(0)}`,
  };
});

scenario('a restart mid-shift does not repaint the morning red', 2, () => {
  const roads = [road('main', MAIN)];
  const { index, store } = run(roads, drive(MAIN, { seed: 24, to: 0.5 }));
  const before = coveredMeters(index, store);
  const revived = deserialiseCover(JSON.parse(JSON.stringify(serialiseCover('driver-1', store))), 'driver-1');
  const after = coveredMeters(index, revived);
  return {
    score: Math.abs(before - after) < 0.5 && before > 100 ? 1 : 0,
    detail: `${before.toFixed(1)} m -> ${after.toFixed(1)} m across a save/load`,
  };
});

scenario('part-driven roads draw as the driven piece only', 2, () => {
  const roads = [road('main', MAIN)];
  const { index, store } = run(roads, drive(MAIN, { seed: 25, to: 0.4 }));
  const { partials, fullIds } = coverLines(index, store);
  const drawn = partials.reduce((acc, line) => {
    let t = 0;
    for (let i = 1; i < line.length; i++) {
      const a = un(line[i - 1]); const b = un(line[i]);
      t += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return acc + t;
  }, 0);
  const want = coveredOf(store, 'main');
  return {
    score: (fullIds.size === 0 ? 1 : 0) * band(Math.abs(drawn - want), 0, 2, 20),
    detail: `drew ${drawn.toFixed(0)} m for ${want.toFixed(0)} m covered, ${partials.length} piece(s)`,
  };
});

scenario('a slice of a link is geometrically right', 1, () => {
  const index = buildSnapIndex([road('main', [[0, 0], [100, 0], [100, 100]])]);
  const link = index.links[0];
  const piece = sliceLink(link, 50, 150);
  const a = un(piece[0]);
  const b = un(piece[piece.length - 1]);
  const okStart = Math.abs(a[0] - 50) < 0.6 && Math.abs(a[1]) < 0.6;
  const okEnd = Math.abs(b[0] - 100) < 0.6 && Math.abs(b[1] - 50) < 0.6;
  return { score: (okStart ? 0.5 : 0) + (okEnd ? 0.5 : 0), detail: `start ${a.map(n => n.toFixed(1))}, end ${b.map(n => n.toFixed(1))}` };
});

scenario('a full assignment indexes and matches inside its frame budget', 2, () => {
  // 4,000 links in a grid — a fifth of the 20,000 cap, enough to measure the shape of the cost.
  const roads = [];
  for (let i = 0; i < 2000; i++) roads.push(road(`h${i}`, [[0, i * 25], [400, i * 25]]));
  for (let i = 0; i < 2000; i++) roads.push(road(`v${i}`, [[i * 25, 0], [i * 25, 400]]));
  const t0 = Date.now();
  const index = buildSnapIndex(roads);
  const tBuild = Date.now() - t0;
  const m = createMatcher(index);
  const store = createCoverStore();
  const fixes = drive([[0, 500], [400, 500]], { seed: 26, spacing: 5 });
  const t1 = Date.now();
  for (let rep = 0; rep < 50; rep++) { m.prev = null; for (const f of fixes) ingestFix(m, store, f); }
  const perFix = (Date.now() - t1) / (fixes.length * 50);
  return {
    score: 0.5 * band(tBuild, 0, 1500, 2500) + 0.5 * band(perFix, 0, 0.5, 2),
    detail: `${index.links.length} links indexed in ${tBuild} ms, ${perFix.toFixed(3)} ms per fix`,
  };
});

/* ── the hard ones: what a real suburb actually does ────────────────────────── */

scenario('a service road 16 m from the highway stays red on a poor fix', 3, () => {
  // The worst realistic case: same bearing, so heading cannot separate them, and close enough
  // that a 20 m accuracy reading puts both inside the search radius. Only distance and the
  // preference for the link already being followed can tell them apart.
  const roads = [
    road('hwy', [[0, 0], [800, 0]], 0, 2),
    road('svc', [[0, 16], [800, 16]], 0, 5),
  ];
  const { store } = run(roads, drive([[0, 0], [800, 0]], {
    seed: 31, sigma: 5, accuracy: 18, withBearing: true,
  }));
  const right = coveredOf(store, 'hwy');
  const wrong = coveredOf(store, 'svc');
  return {
    score: 0.5 * band(right, 600, 800, 300) + 0.5 * band(wrong, 0, 40, 160),
    detail: `highway ${right.toFixed(0)} m, service road ${wrong.toFixed(0)} m`,
  };
});

scenario('a suburban grid is not smeared by driving one street', 3, () => {
  const roads = [];
  for (let i = 0; i < 8; i++) roads.push(road(`h${i}`, [[0, i * 90], [700, i * 90]]));
  for (let i = 0; i < 7; i++) roads.push(road(`v${i}`, [[i * 110, 0], [i * 110, 630]]));
  const { store } = run(roads, drive([[0, 270], [700, 270]], { seed: 32, withBearing: true }));
  let bleed = 0;
  for (const r of roads) if (r[0] !== 'h3') bleed += coveredOf(store, r[0]);
  const want = coveredOf(store, 'h3');
  return {
    score: 0.5 * band(want, 620, 700, 200) + 0.5 * band(bleed, 0, 30, 200),
    detail: `target ${want.toFixed(0)} m, everything else ${bleed.toFixed(0)} m across ${roads.length - 1} links`,
  };
});

scenario('a cul-de-sac driven in and back out reads as done once', 2, () => {
  const stub = [[0, 0], [0, 140]];
  const roads = [road('stub', stub)];
  const inAndOut = [[0, 0], [0, 140], [0, 0]];
  const { index, store } = run(roads, drive(inAndOut, { seed: 33, sigma: 2 }));
  const frac = coveredOf(store, 'stub') / pathLen(stub);
  const { fullIds } = coverLines(index, store);
  return {
    score: band(frac, 0.9, 1.0, 0.3) * (fullIds.has('stub') ? 1 : 0.4),
    detail: `${(frac * 100).toFixed(1)}% of the stub, full=${fullIds.has('stub')}`,
  };
});

scenario('a parked vehicle changes nothing', 2, () => {
  const roads = [road('main', MAIN)];
  const index = buildSnapIndex(roads);
  const m = createMatcher(index);
  const store = createCoverStore();
  for (const f of drive(MAIN, { seed: 34, to: 0.3 })) ingestFix(m, store, f);
  const settled = coveredMeters(index, store);
  // The service emits a heartbeat at the last recorded position every few seconds while stopped.
  let churn = 0;
  const parked = { lon: pt(180, 0)[0], lat: pt(180, 0)[1], tripId: 'T1', accuracy: 8, bearing: null };
  for (let i = 0; i < 200; i++) {
    if (ingestFix(m, store, { ...parked, atMs: 1_700_000_100_000 + i * 5000 })) churn++;
  }
  const after = coveredMeters(index, store);
  return {
    score: (churn <= 1 ? 1 : 0) * band(after - settled, 0, 8, 30),
    detail: `${churn} re-render(s) and ${(after - settled).toFixed(1)} m added over 200 parked fixes`,
  };
});

scenario('a crawl in traffic does not hop to the next street', 2, () => {
  // 3 m between fixes: too little movement to infer a bearing from, so distance and continuity
  // are doing all the work — the state congestion actually puts the matcher in.
  const roads = [road('main', MAIN), road('par', PARALLEL_18)];
  const { store } = run(roads, drive(MAIN, { seed: 35, spacing: 3, sigma: 4, speedKmh: 6, to: 0.3 }));
  const right = coveredOf(store, 'main');
  const wrong = coveredOf(store, 'par');
  return {
    score: 0.5 * band(right, 140, 190, 90) + 0.5 * band(wrong, 0, 25, 120),
    detail: `${right.toFixed(0)} m on the street, ${wrong.toFixed(0)} m on its neighbour`,
  };
});

scenario('a hairpin is painted, not written off as a jump', 2, () => {
  // Consecutive fixes on a switchback project far apart along the link while being close on the
  // ground — the exact shape the anti-jump guard could wrongly reject.
  const pin = [[0, 0], [120, 0], [120, 14], [0, 14], [0, 28], [120, 28]];
  const roads = [road('pin', pin)];
  const { store } = run(roads, drive(pin, { seed: 36, sigma: 1.5, speedKmh: 20 }));
  const frac = coveredOf(store, 'pin') / pathLen(pin);
  return { score: band(frac, 0.8, 1.0, 0.35), detail: `${(frac * 100).toFixed(1)}% of the switchback painted` };
});

scenario('a stub shorter than the buffer can still be completed', 2, () => {
  const roads = [road('conn', [[0, 0], [9, 0]]), road('main', [[9, 0], [400, 0]])];
  const { index, store } = run(roads, drive([[0, 0], [400, 0]], { seed: 37, sigma: 1.5, spacing: 4 }));
  const { fullIds } = coverLines(index, store);
  return {
    score: (fullIds.has('conn') ? 0.5 : 0) + (fullIds.has('main') ? 0.5 : 0),
    detail: `9 m connector full=${fullIds.has('conn')}, main full=${fullIds.has('main')}`,
  };
});

scenario('two shifts on the same street union rather than double-count', 2, () => {
  const roads = [road('main', MAIN)];
  const index = buildSnapIndex(roads);
  const m = createMatcher(index);
  const store = createCoverStore();
  for (const f of drive(MAIN, { seed: 38, to: 0.6, tripId: 'A' })) ingestFix(m, store, f);
  m.prev = null;
  for (const f of drive(MAIN, { seed: 39, from: 0.4, tripId: 'B' })) ingestFix(m, store, f);
  const cov = coveredMeters(index, store);
  return { score: band(cov, 560, 601, 120), detail: `${cov.toFixed(0)} m for a street of ${pathLen(MAIN)} m` };
});

scenario('an overpass does not paint the road beneath it', 3, () => {
  // Same place on the map, 90° apart. Only the heading test can separate these.
  const roads = [
    road('over', [[300, -150], [300, 150]]),
    road('under', [[150, 0], [450, 0]]),
  ];
  const { store } = run(roads, drive([[300, -150], [300, 150]], { seed: 40, withBearing: true, sigma: 2 }));
  const wrong = coveredOf(store, 'under');
  return { score: band(wrong, 0, 25, 110), detail: `${wrong.toFixed(0)} m painted on the road underneath` };
});

scenario('correlated GPS drift does not walk onto the next street', 3, () => {
  // The field failure this whole design exists to survive: the fix sits 10–14 m off to one side
  // for half a minute at a time, which is most of the way to the parallel street 20 m away.
  const roads = [road('main', MAIN), road('par', [[0, 20], [600, 20]])];
  let worstBleed = 0;
  let leastRight = Infinity;
  for (const seed of [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]) {
    const { store } = run(roads, drive(MAIN, { seed, sigma: 3, driftM: 13, accuracy: 12, withBearing: true }));
    worstBleed = Math.max(worstBleed, coveredOf(store, 'par'));
    leastRight = Math.min(leastRight, coveredOf(store, 'main'));
  }
  return {
    score: 0.5 * band(leastRight, 480, 600, 250) + 0.5 * band(worstBleed, 0, 60, 220),
    detail: `across 16 drifting runs: worst bleed ${worstBleed.toFixed(0)} m, least matched ${leastRight.toFixed(0)} m`,
  };
});


scenario('guesses expire per trip, not per file save', 2, () => {
  // Monday's trip was never settled by the server. Tuesday keeps driving and saving. Monday's
  // guess must still leave on schedule — a whole-file timestamp would renew it with every save.
  const roads = [road('main', MAIN), road('cross', CROSS)];
  const index = buildSnapIndex(roads);
  const m = createMatcher(index);
  const store = createCoverStore();
  for (const f of drive(MAIN, { seed: 61, tripId: 'MON' })) ingestFix(m, store, f);
  m.prev = null;
  for (const f of drive(CROSS, { seed: 62, tripId: 'TUE' })) ingestFix(m, store, f);
  const DAY = 24 * 3600 * 1000;
  store.touchedAt.set('MON', Date.now() - 2 * DAY);
  // Round-trip through disk the way every save does, then expire as a load does.
  const revived = deserialiseCover(JSON.parse(JSON.stringify(serialiseCover('driver-1', store))), 'driver-1');
  expireTrips(revived, Date.now(), 36 * 3600 * 1000);
  const left = coverTripIds(revived);
  const ok = left.length === 1 && left[0] === 'TUE' && coveredOf(revived, 'main') === 0 && coveredOf(revived, 'cross') > 250;
  return { score: ok ? 1 : 0, detail: `trips left after expiry: [${left.join(', ')}]` };
});

scenario('another driver on the same phone sees none of it', 2, () => {
  const roads = [road('main', MAIN)];
  const { store } = run(roads, drive(MAIN, { seed: 63 }));
  const snap = JSON.parse(JSON.stringify(serialiseCover('driver-A', store)));
  const asB = deserialiseCover(snap, 'driver-B');
  const asA = deserialiseCover(snap, 'driver-A');
  const ok = asB.byTrip.size === 0 && asA.byTrip.size === 1;
  return { score: ok ? 1 : 0, detail: `driver B sees ${asB.byTrip.size} trip(s), driver A sees ${asA.byTrip.size}` };
});

/* ── report ─────────────────────────────────────────────────────────────────── */

console.log(`\nON-DEVICE MAP MATCHING — RUBRIC  (buffer ${SNAP_BUFFER_M} m)\n`);
let got = 0;
let max = 0;
for (const r of results) {
  got += r.score * r.weight;
  max += r.weight;
  const pct = (r.score * 100).toFixed(0).padStart(3);
  const mark = r.score >= 0.95 ? '✅' : r.score >= 0.7 ? '🟡' : '❌';
  console.log(`${mark} ${pct}%  ${r.name}`);
  console.log(`         ${r.detail}`);
}
const overall = (got / max) * 100;
console.log(`\nSCORE ${overall.toFixed(1)}%  (${got.toFixed(2)} of ${max})\n`);
const weak = results.filter((r) => r.score < 0.95);
if (weak.length) {
  console.log('Below full marks:');
  for (const r of weak) console.log(`  · ${r.name} — ${r.detail}`);
  console.log('');
}
process.exit(overall >= 90 ? 0 : 1);
