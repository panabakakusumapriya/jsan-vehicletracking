const env = require('../config/env');
const { haversineMeters } = require('../utils/geo');

/**
 * Valhalla map matching (HMM snap-to-road), against the free FOSSGIS community instance by
 * default — see VALHALLA_URL in config/env.js for how to swap to a self-hosted one.
 *
 * Two capabilities:
 *   - matchTrace(points): snap an already-recorded GPS trace onto the road network and total
 *     up its real length. This is the "cleaned distance" layer — see services/mapMatcher.js.
 *   - routeBetween(a, b): route between two points, used for gap-filling across a signal
 *     dropout. Implemented here but only ever called when GAP_FILL_ENABLED is true.
 *
 * Community-server etiquette: requests are spaced out (politeDelay), carry an identifying
 * User-Agent, and are retried with backoff on transient failures only — a trace Valhalla
 * genuinely can't match (off-road, too sparse) fails immediately rather than hammering the
 * server with retries that will never succeed.
 *
 * The matching request is deliberately NOT left on Valhalla's stock settings — see
 * traceOptions() below and the MAP_MATCH_* block in config/env.js. On the defaults, drivers'
 * U-turns were being dropped from snapped routes, and some traces collapsed almost entirely.
 */

let lastCallAt = 0; // one shared queue for both trace and route calls

async function politeDelay() {
  const since = Date.now() - lastCallAt;
  const wait = Math.max(0, env.VALHALLA_MIN_INTERVAL_MS - since);
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function isRetryable(status) {
  return status === 429 || status >= 500;
}

/** POST to a Valhalla endpoint with retry/backoff on transient failures only. */
async function postValhalla(path, body, { attempts = 3 } = {}) {
  const url = `${env.VALHALLA_URL}${path}`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await politeDelay();

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': env.VALHALLA_USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(env.VALHALLA_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout — always worth a retry.
      if (attempt === attempts) throw new Error(`Valhalla ${path} unreachable: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }

    if (res.ok) return res.json();

    const text = await res.text().catch(() => '');
    const message = `Valhalla ${path} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`;
    if (isRetryable(res.status)) {
      if (attempt < attempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      // Retries exhausted on a transient failure. Emphatically NOT `unmatchable`: the server was
      // overloaded, it never gave a verdict on this trace. Flagging it would let an outage bake
      // raw geometry in as the cleaned layer across the whole fleet.
      throw new Error(message);
    }
    // Valhalla has looked at this trace and cannot match it (442 "no path could be found",
    // 443 "exact route match failed", other 4xx). Flagged so callers can tell this apart from the
    // server being unavailable: this one is a permanent fact about the trace, so keeping the raw
    // geometry is the correct final answer. See matchSegment().
    const err = new Error(message);
    err.unmatchable = true;
    throw err;
  }
  throw new Error(`Valhalla ${path}: exhausted retries`);
}

/** Split an ordered point list into consecutive chunks of at most `size`. */
function chunkPoints(points, size) {
  if (points.length <= size) return [points];
  const chunks = [];
  for (let i = 0; i < points.length; i += size) {
    chunks.push(points.slice(i, i + size));
  }
  return chunks;
}

/**
 * Per-request matcher tuning. Both settings exist because Valhalla's stock defaults quietly
 * discard U-turns — see MAP_MATCH_SEARCH_RADIUS / MAP_MATCH_GPS_ACCURACY in config/env.js for
 * the measurements behind the values.
 *
 * `turn_penalty_factor` is deliberately NOT set here: Valhalla defaults it to 200 for auto
 * costing (vs 0 for every other mode), which looks like the obvious U-turn culprit, but
 * overriding it to 0 changed the matched result in none of the traces tested. Leaving it at
 * the server's default keeps the request honest about what actually makes a difference.
 */
function traceOptions() {
  return {
    search_radius: env.MAP_MATCH_SEARCH_RADIUS,
    gps_accuracy: env.MAP_MATCH_GPS_ACCURACY,
  };
}

/** Straight-line length of a raw trace, used as the yardstick a match is judged against. */
function traceLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

/**
 * Encode raw points as a precision-6 polyline, the same format Valhalla returns and the admin
 * panel already decodes (lib/polyline.ts). Lets an unmatchable stretch be handed back as ordinary
 * route geometry, so the caller never has to care which stretches were snapped and which weren't.
 */
function encodePolyline6(points) {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  const chunk = (v) => {
    let num = v < 0 ? ~(v << 1) : v << 1;
    while (num >= 0x20) {
      out += String.fromCharCode((0x20 | (num & 0x1f)) + 63);
      num >>= 5;
    }
    out += String.fromCharCode(num + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e6);
    const lon = Math.round(p.lon * 1e6);
    chunk(lat - prevLat);
    chunk(lon - prevLon);
    prevLat = lat;
    prevLon = lon;
  }
  return out;
}

/** Inverse of encodePolyline6 — needed to check where a returned match actually goes. */
function decodePolyline6(encoded) {
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    out.push({ lat: lat * 1e-6, lon: lon * 1e-6 });
  }
  return out;
}

/**
 * Fraction of `points` lying within MAP_MATCH_MAX_DEVIATION_METERS of the matched geometry.
 *
 * Length coverage alone is not enough to trust a match, and this is the check that catches what
 * it misses. A trace can be snapped onto the wrong streets entirely and still come back the right
 * total length — a real trip with clean 2-second fixes did exactly that, passing the coverage
 * gate on both its chunks while 14.4% of its points sat over 100 m from the road it had been
 * snapped to, wandering onto parallel streets for stretches of 300-1200 m. Measuring where the
 * result goes, not just how long it is, is what makes "snapped to the NEAREST road" true rather
 * than merely plausible.
 *
 * Points are bucketed into a coarse grid so this stays linear-ish rather than comparing every
 * fix against every vertex; the shape is densified first so a long straight leg between two
 * distant vertices still counts as nearby.
 */
function onRouteFraction(points, shapes) {
  const vertices = shapes.flatMap((s) => decodePolyline6(s));
  if (vertices.length < 2) return 0;

  const dense = [];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    dense.push(a);
    const d = haversineMeters(a, b);
    if (d > 25) {
      const n = Math.min(400, Math.ceil(d / 25));
      for (let k = 1; k < n; k++) {
        dense.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
      }
    }
  }
  dense.push(vertices[vertices.length - 1]);

  const CELL = 0.002; // ~220 m, comfortably wider than the deviation we care about
  const grid = new Map();
  dense.forEach((p, i) => {
    const k = `${Math.floor(p.lat / CELL)}:${Math.floor(p.lon / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });

  const limit = env.MAP_MATCH_MAX_DEVIATION_METERS;
  let near = 0;
  for (const p of points) {
    const ci = Math.floor(p.lat / CELL);
    const cj = Math.floor(p.lon / CELL);
    let best = Infinity;
    for (let a = -1; a <= 1 && best > limit; a++) {
      for (let b = -1; b <= 1 && best > limit; b++) {
        const arr = grid.get(`${ci + a}:${cj + b}`);
        if (!arr) continue;
        for (const idx of arr) {
          const d = haversineMeters(p, dense[idx]);
          if (d < best) best = d;
          if (best <= limit) break;
        }
      }
    }
    if (best <= limit) near++;
  }
  return near / points.length;
}

/** One /trace_route call. Returns null when Valhalla answers but matched nothing usable. */
async function traceRoute(points) {
  // Timestamps are OFF by default — see MAP_MATCH_SEND_TIMESTAMPS in config/env.js. They are
  // measured to destroy matches (whole trips collapsing to a ~60m stub) and buy this code
  // nothing: only leg.summary.length is ever read, never a duration.
  const t0 = new Date(points[0].recordedAt).getTime();
  const shape = points.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    ...(env.MAP_MATCH_SEND_TIMESTAMPS
      ? { time: Math.round((new Date(p.recordedAt).getTime() - t0) / 1000) }
      : {}),
  }));

  const json = await postValhalla('/trace_route', {
    shape,
    costing: 'auto',
    shape_match: 'map_snap',
    trace_options: traceOptions(),
  });

  const legs = json.trip?.legs;
  if (!legs || !legs.length) return null;
  let distanceMeters = 0;
  const shapes = [];
  for (const leg of legs) {
    distanceMeters += (leg.summary?.length || 0) * 1000; // km -> m
    if (leg.shape) shapes.push(leg.shape);
  }
  return shapes.length ? { distanceMeters, shapes } : null;
}

/**
 * Match one stretch, and — this is the point of the function — refuse to believe a result that
 * plainly did not match.
 *
 * Valhalla does not report failure by erroring. Handed driving it cannot resolve, /trace_route
 * returns HTTP 200 with a perfectly well-formed trip whose legs cover a tiny fraction of the
 * input: a real trip in this fleet fed 1000 points covering 14.71 km and got back a single
 * 40-metre leg, which the old code summed and stored as though it were the answer. The whole
 * 14.71 km simply vanished from the map and from cleanedDistanceMeters, and nothing anywhere
 * recorded that it had. That is what "roads are missing" looked like from the inside.
 *
 * So every result is measured against the straight-line length of the points that produced it.
 * Under MAP_MATCH_MIN_COVERAGE the result is discarded and the stretch is halved and retried,
 * because the failure is usually local — in that same trip, 100-point windows scored 3%, 21%,
 * 101%, 91%, 16%, 92%, 84%, 44%, 13%, 100%, so splitting rescues the half that is matchable
 * instead of throwing away the lot.
 *
 * When a stretch is too small to split further and still won't match, its raw points are encoded
 * as route geometry and returned as-is. Drawing the GPS trace for 200 m of an underground car
 * park is honest and continuous; silently omitting it is neither. `matchedMeters` tracks how much
 * of the total was genuinely snapped so callers can tell the difference.
 *
 * Tuning cannot substitute for this. Across search_radius 30/50/60, gps_accuracy 5/8/15,
 * turn_penalty_factor 0, interpolation_distance 0 and beta/sigma_z changes, the failing windows
 * returned the same 3% / 16% / 13% every time — the vehicle was circling a residential block,
 * 1.31 km of driving inside a 408 m box, which is simply beyond what an HMM matcher resolves.
 */
async function matchSegment(points, depth = 0) {
  const totalMeters = traceLength(points);

  if (points.length >= 2) {
    let result = null;
    try {
      result = await traceRoute(points);
    } catch (err) {
      // Only a verdict from Valhalla ("I cannot match this trace") is allowed to end in raw
      // geometry. A timeout, a 5xx, or an unreachable host says nothing about the trace, and
      // treating it as unmatchable would quietly rewrite good trips as 0%-snapped for the duration
      // of an outage — permanently, since nothing would mark them for another look. Those
      // propagate instead, so the trip stays 'failed' and gets retried later.
      if (!err.unmatchable) throw err;
      result = null;
    }

    // Two independent gates, because they fail differently. Coverage catches a match that
    // collapsed to nothing; proximity catches one that is the right LENGTH but on the wrong
    // streets. A result has to be both long enough and in the right place to be believed.
    if (result && result.distanceMeters >= totalMeters * env.MAP_MATCH_MIN_COVERAGE) {
      const onRoute = onRouteFraction(points, result.shapes);
      if (onRoute >= env.MAP_MATCH_MIN_POINTS_ON_ROUTE) {
        return { distanceMeters: result.distanceMeters, shapes: result.shapes, matchedMeters: totalMeters, totalMeters };
      }
    }
  }

  const canSplit =
    points.length >= env.MAP_MATCH_MIN_SPLIT_POINTS * 2 && depth < env.MAP_MATCH_MAX_SPLIT_DEPTH;

  if (canSplit) {
    // Overlap by one point so the two halves stay geometrically continuous across the seam.
    const mid = Math.floor(points.length / 2);
    const left = await matchSegment(points.slice(0, mid + 1), depth + 1);
    const right = await matchSegment(points.slice(mid), depth + 1);
    return {
      distanceMeters: left.distanceMeters + right.distanceMeters,
      shapes: [...left.shapes, ...right.shapes],
      matchedMeters: left.matchedMeters + right.matchedMeters,
      totalMeters,
    };
  }

  // Unmatchable and unsplittable: keep the raw geometry so the route stays whole.
  return {
    distanceMeters: totalMeters,
    shapes: points.length >= 2 ? [encodePolyline6(points)] : [],
    matchedMeters: 0,
    totalMeters,
  };
}

/** Match one dense run of points (no internal gap splitting) — chunked by point count only. */
async function matchDenseRun(points) {
  const chunks = chunkPoints(points, env.MAP_MATCH_CHUNK_SIZE);
  let distanceMeters = 0;
  let matchedMeters = 0;
  let totalMeters = 0;
  const shapes = [];

  for (const chunk of chunks) {
    if (chunk.length < 2) continue; // a trailing 1-point chunk has nothing to match
    const r = await matchSegment(chunk);
    distanceMeters += r.distanceMeters;
    matchedMeters += r.matchedMeters;
    totalMeters += r.totalMeters;
    shapes.push(...r.shapes);
  }

  if (!shapes.length) throw new Error('Valhalla matched no legs for this trace');
  return { distanceMeters, shapes, matchedMeters, totalMeters };
}

/** Split an ordered point list into dense runs wherever two consecutive fixes are more than `gapMs` apart. */
function splitAtGaps(points, gapMs) {
  const runs = [[points[0]]];
  for (let i = 1; i < points.length; i++) {
    const dt = new Date(points[i].recordedAt).getTime() - new Date(points[i - 1].recordedAt).getTime();
    if (dt > gapMs) runs.push([]);
    runs[runs.length - 1].push(points[i]);
  }
  return runs;
}

/**
 * Snap a recorded GPS trace onto the road network and return its real (matched) length.
 * `points` must be ordered oldest -> newest: [{ lat, lon, recordedAt }].
 * Long traces are matched in chunks (MAP_MATCH_CHUNK_SIZE); the tiny discontinuity at each
 * chunk boundary is negligible next to the GPS noise this is already correcting for.
 *
 * With `gapFill: true`, a signal dropout (two consecutive fixes further apart than
 * `gapFillMinMs`) is bridged with a routed segment (Valhalla's /route) instead of being fed
 * straight into the matcher as one big sparse jump — the dense runs either side are matched
 * independently and the bridging segment is routed once, so the crossing is never counted in
 * both a matched leg AND a routed one.
 */
async function matchTrace(points, { gapFill = false, gapFillMinMs = 90_000 } = {}) {
  if (points.length < 2) throw new Error('need at least 2 points to map-match');

  // Split at silences ALWAYS, not just when gap-filling. A pause is a genuine discontinuity in
  // the evidence: handing the matcher a 5-minute silence as though it were one continuous trace
  // makes it reason about a jump nothing observed, and that reasoning fails across the whole
  // request rather than just the gap. Splitting first raised end-to-end coverage on the trip that
  // exposed this from 76% to 93% before the subdivide-and-fallback layer even ran.
  //
  // gapFill only decides what happens ACROSS a gap: routed bridge geometry when on, nothing when
  // off (the panel then draws the same straight line the raw trail does). Either way the split
  // itself always happens, so a dropout can no longer poison the runs either side of it.
  const splitMs = Math.min(gapFillMinMs, env.MAP_MATCH_SPLIT_GAP_SECONDS * 1000);
  const runs = splitAtGaps(points, splitMs);
  let distanceMeters = 0;
  let matchedMeters = 0;
  const shapes = [];

  // Measured against the WHOLE trace, gaps included — not just the stretches worth attempting.
  // Summing only the attempted runs would report a trip as "100% snapped" when the device only
  // recorded a fifth of the journey, which is exactly backwards: the stretches missing from the
  // trace are the ones a reader most needs flagged. A real trip here logged 197 fixes across
  // 75 km and every attempted run matched perfectly — the honest figure is 16%, not 100%.
  const totalMeters = traceLength(points);

  for (let i = 0; i < runs.length; i++) {
    if (runs[i].length >= 2) {
      const r = await matchDenseRun(runs[i]);
      distanceMeters += r.distanceMeters;
      matchedMeters += r.matchedMeters;
      shapes.push(...r.shapes);
    }
    if (gapFill && i < runs.length - 1) {
      const a = runs[i][runs[i].length - 1];
      const b = runs[i + 1][0];
      const bridge = await routeBetween(a, b);
      distanceMeters += bridge.distanceMeters;
      shapes.push(...bridge.shapes);
    }
  }

  if (!shapes.length) throw new Error('Valhalla matched no legs for this trace');
  return { distanceMeters, shapes, matchedMeters, totalMeters };
}

/**
 * Route between two points (gap-filling across a signal dropout). Only ever called from the
 * map-matcher when GAP_FILL_ENABLED is true.
 */
async function routeBetween(a, b) {
  const json = await postValhalla('/route', {
    locations: [
      { lat: a.lat, lon: a.lon },
      { lat: b.lat, lon: b.lon },
    ],
    costing: 'auto',
  });

  const trip = json.trip;
  if (!trip || !trip.legs || !trip.legs.length) {
    throw new Error('Valhalla returned no route between these points');
  }
  const distanceMeters = trip.legs.reduce((sum, leg) => sum + (leg.summary?.length || 0) * 1000, 0);
  const shapes = trip.legs.map((leg) => leg.shape).filter(Boolean);
  return { distanceMeters, shapes };
}

module.exports = {
  matchTrace,
  routeBetween,
  chunkPoints,
  splitAtGaps,
  traceOptions,
  encodePolyline6,
  traceLength,
};
