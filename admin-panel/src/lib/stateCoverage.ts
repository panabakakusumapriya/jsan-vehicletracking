import { NO_AREA, type RoadNet, type RoadState } from './roadNetwork';

/**
 * Coverage by state or territory (and NZ region), every delivery in view combined.
 *
 * Worked out in the browser from what the coverage map has already loaded — every road of every
 * delivery (lib/roadNetwork) and which of them are driven (road-state) — so it costs no request.
 * Each road is placed in the state its middle lies in, using Natural Earth's admin-1 boundaries
 * (public domain, simplified to ~300 m: lib/regions/auNzStates.json, loaded only when needed).
 *
 * "Combined" means each road ONCE: deliveries overlap (Queensland's main delivery, its P2 top-up
 * and the highways delivery share links), and a road in two of them is counted one time, as
 * driven when either has it driven. So a state's figures can add up to less than the headline,
 * which sums the deliveries as they are. Driven is the ledger's (LinkCoverage), as in the
 * headline: an area signed off without a trip on its roads does not count.
 *
 * And only the roads a delivery counts towards its target: a delivery imported without its roads
 * outside the work areas (QLD-P2, VIC-P2) leaves those out of its target, one imported with them
 * (QLD-P1) counts them. Which a delivery did is read off its target — the caller passes it.
 */

export interface StateRow {
  name: string;
  country: string;
  code: string;
  /** [west, south, east, north] of the state itself, for "show it on the map". */
  bbox: [number, number, number, number];
  links: number;
  meters: number;
  coveredLinks: number;
  coveredMeters: number;
}

export interface StateCoverage {
  rows: StateRow[];
  /** Roads further than ~50 km from every state (offshore, or a boundary gap). */
  elsewhere: { links: number; meters: number; coveredMeters: number };
  /** Links that appear in more than one delivery in view, counted once. */
  sharedLinks: number;
}

interface Region {
  name: string;
  country: string;
  code: string;
  bbox: [number, number, number, number];
  /** Edges [x1, y1, x2, y2] grouped by latitude band, for a ray cast that reads a few dozen. */
  bands: Float64Array[];
  minLat: number;
  /** Every vertex, for the nearest-state fallback. */
  vertices: Float64Array;
}

const BAND = 0.05; // degrees of latitude per band
let regionsPromise: Promise<Region[]> | null = null;

function loadRegions(): Promise<Region[]> {
  if (!regionsPromise) {
    regionsPromise = import('./regions/auNzStates.json').then((mod) => {
      const data = (mod as unknown as { default: { states: { name: string; country: string; code: string; polygons: number[][][][] }[] } }).default;
      return data.states.map((s) => {
        let w = Infinity; let so = Infinity; let e = -Infinity; let n = -Infinity;
        const edges: number[] = [];
        const verts: number[] = [];
        for (const polygon of s.polygons) {
          for (const ring of polygon) {
            for (let i = 0; i < ring.length; i++) {
              const [x, y] = ring[i];
              if (x < w) w = x;
              if (x > e) e = x;
              if (y < so) so = y;
              if (y > n) n = y;
              verts.push(x, y);
              const [x2, y2] = ring[(i + 1) % ring.length];
              edges.push(x, y, x2, y2);
            }
          }
        }
        const bandCount = Math.max(1, Math.ceil((n - so) / BAND) + 1);
        const lists: number[][] = Array.from({ length: bandCount }, () => []);
        for (let k = 0; k < edges.length; k += 4) {
          const lo = Math.min(edges[k + 1], edges[k + 3]);
          const hi = Math.max(edges[k + 1], edges[k + 3]);
          for (let b = Math.floor((lo - so) / BAND); b <= Math.floor((hi - so) / BAND); b++) {
            lists[b].push(edges[k], edges[k + 1], edges[k + 2], edges[k + 3]);
          }
        }
        return {
          name: s.name,
          country: s.country,
          code: s.code,
          bbox: [w, so, e, n] as [number, number, number, number],
          bands: lists.map((l) => Float64Array.from(l)),
          minLat: so,
          vertices: Float64Array.from(verts),
        };
      });
    });
  }
  return regionsPromise;
}

/** Even-odd ray cast over the region's edges in the point's latitude band. */
function inside(r: Region, x: number, y: number): boolean {
  if (x < r.bbox[0] || x > r.bbox[2] || y < r.bbox[1] || y > r.bbox[3]) return false;
  const band = r.bands[Math.floor((y - r.minLat) / BAND)];
  if (!band) return false;
  let odd = false;
  for (let k = 0; k < band.length; k += 4) {
    const y1 = band[k + 1];
    const y2 = band[k + 3];
    if ((y1 > y) === (y2 > y)) continue;
    const x1 = band[k];
    const x2 = band[k + 2];
    if (x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) odd = !odd;
  }
  return odd;
}

/** Which region a point is in: the one containing it, else the nearest within ~50 km, else -1. */
function regionFinder(regions: Region[]) {
  const nearCache = new Map<number, number>(); // ~1 km cell -> region, for points in no polygon
  return (x: number, y: number): number => {
    for (let i = 0; i < regions.length; i++) if (inside(regions[i], x, y)) return i;
    // On the water side of a simplified coastline, or a tiny island left out of the file.
    const cell = Math.round(x * 100) * 100000 + Math.round(y * 100);
    const hit = nearCache.get(cell);
    if (hit !== undefined) return hit;
    let best = -1;
    let bestD = 0.5 * 0.5; // degrees², ~50 km
    const cos = Math.cos((y * Math.PI) / 180);
    for (let i = 0; i < regions.length; i++) {
      const b = regions[i].bbox;
      if (x < b[0] - 0.5 || x > b[2] + 0.5 || y < b[1] - 0.5 || y > b[3] + 0.5) continue;
      const v = regions[i].vertices;
      for (let k = 0; k < v.length; k += 2) {
        const d = ((v[k] - x) * cos) ** 2 + (v[k + 1] - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    nearCache.set(cell, best);
    return best;
  };
}

/** Which state each link of a net is in, worked out once per road file (they never change). */
const placed = new WeakMap<RoadNet, Int16Array>();

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function placeLinks(net: RoadNet, find: (x: number, y: number) => number, alive: () => boolean) {
  const hit = placed.get(net);
  if (hit) return hit;
  const out = new Int16Array(net.linkCount);
  const CHUNK = 40000; // a slice at a time, so the page keeps moving while it works
  for (let start = 0; start < net.linkCount; start += CHUNK) {
    const end = Math.min(net.linkCount, start + CHUNK);
    for (let i = start; i < end; i++) out[i] = find(net.mid[2 * i], net.mid[2 * i + 1]);
    // eslint-disable-next-line no-await-in-loop
    await pause();
    if (!alive()) return null;
  }
  placed.set(net, out);
  return out;
}

function lowerBound(sorted: Float64Array, v: number) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}
const has = (sorted: Float64Array, v: number) => {
  const i = lowerBound(sorted, v);
  return i < sorted.length && sorted[i] === v;
};

/**
 * The figures for every state the roads in view touch. `alive` lets the caller abandon a run
 * whose deliveries changed; the answer is then null.
 */
export async function stateCoverage(
  nets: RoadNet[],
  state: RoadState,
  alive: () => boolean = () => true,
  /** versionId -> the delivery's targetMeters (the headline's denominator). */
  targets: Record<string, number> = {},
): Promise<StateCoverage | null> {
  const regions = await loadRegions();
  if (!alive()) return null;
  const find = regionFinder(regions);

  // Driven anywhere: every driven link id of every delivery, sorted for lookups.
  const coveredNum: number[] = [];
  const coveredStr = new Set<string>();
  for (const net of nets) {
    const per = state.coveredBy.get(net.versionId);
    if (!per) continue;
    for (let i = 0; i < net.linkCount; i++) {
      if (per[i] < 0) continue;
      if (Array.isArray(net.ids)) coveredStr.add(net.ids[i]);
      else coveredNum.push((net.ids as Float64Array)[i]);
    }
  }
  const coveredIds = Float64Array.from(coveredNum).sort();

  const acc = regions.map(() => ({ links: 0, meters: 0, coveredLinks: 0, coveredMeters: 0 }));
  const elsewhere = { links: 0, meters: 0, coveredMeters: 0 };
  let sharedLinks = 0;
  let seenNum = new Float64Array(0); // ids of the deliveries already counted, sorted
  const seenStr = new Set<string>();

  for (const net of nets) {
    // eslint-disable-next-line no-await-in-loop
    const where = await placeLinks(net, find, alive);
    if (!where) return null;
    const numeric = !Array.isArray(net.ids);
    const ids = net.ids;
    // Does this delivery's target hold its roads outside the work areas? Whichever total is nearer.
    let all = 0;
    let inAreas = 0;
    for (let i = 0; i < net.linkCount; i++) {
      all += net.lengthM[i];
      if (net.area[i] !== NO_AREA) inAreas += net.lengthM[i];
    }
    const target = targets[net.versionId];
    const outsideCounts = !(target > 0) || Math.abs(target - all) <= Math.abs(target - inAreas);
    const counted: number[] = [];
    for (let i = 0; i < net.linkCount; i++) {
      if (!outsideCounts && net.area[i] === NO_AREA) continue;
      let covered: boolean;
      if (numeric) {
        const id = (ids as Float64Array)[i];
        if (has(seenNum, id)) { sharedLinks++; continue; }
        counted.push(id);
        covered = has(coveredIds, id);
      } else {
        const id = (ids as string[])[i];
        if (seenStr.has(id)) { sharedLinks++; continue; }
        seenStr.add(id);
        covered = coveredStr.has(id);
      }
      const m = net.lengthM[i];
      const r = where[i];
      if (r < 0) {
        elsewhere.links++;
        elsewhere.meters += m;
        if (covered) elsewhere.coveredMeters += m;
        continue;
      }
      const a = acc[r];
      a.links++;
      a.meters += m;
      if (covered) {
        a.coveredLinks++;
        a.coveredMeters += m;
      }
    }
    // The roads it counted join the counted ones (a sorted merge), for the deliveries after it.
    if (numeric) {
      const mine = Float64Array.from(counted).sort();
      const merged = new Float64Array(seenNum.length + mine.length);
      let p = 0; let q = 0; let k = 0;
      while (p < seenNum.length || q < mine.length) {
        if (q >= mine.length || (p < seenNum.length && seenNum[p] <= mine[q])) merged[k++] = seenNum[p++];
        else merged[k++] = mine[q++];
      }
      seenNum = merged;
    }
    // eslint-disable-next-line no-await-in-loop
    await pause();
    if (!alive()) return null;
  }

  const rows: StateRow[] = regions
    .map((r, i) => ({ name: r.name, country: r.country, code: r.code, bbox: r.bbox, ...acc[i] }))
    .filter((r) => r.links > 0)
    .sort((a, b) => b.meters - a.meters);
  return { rows, elsewhere, sharedLinks };
}
