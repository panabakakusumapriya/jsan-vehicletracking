const DelaunatorModule = require('delaunator');
const polygonClipping = require('polygon-clipping');
const { bboxOf, bboxUnion, midpointOf, pointInPolygon } = require('../utils/geo');

const Delaunator = DelaunatorModule.default || DelaunatorModule;

/**
 * Splitting a work area that is too big for one driver into zones a driver can finish.
 *
 * Why it exists
 * -------------
 * One polygon is assigned to one driver. Auckland's delivery (2026-10-01) has 58 places, and the
 * city itself is ONE of them: 4,408 km of road, 60% of the whole delivery, under a single AREA_ID.
 * It could not be assigned to anybody. The customer's files carry nothing finer — no suburb, no
 * postcode — so the subdivision has to be made here.
 *
 * What it produces
 * ----------------
 * Zones of `minKm`..`maxKm` of road each — the size a manager types in when they pick the area
 * and ask for it to be split (250-300 by default). Road rarely divides evenly, so there is a
 * choice about what is left over, see zonePlan(). The zones are:
 *
 *  - NAMED after the places inside them. OpenStreetMap knows the suburbs as points; every road is
 *    given to the suburb it is nearest to BY ROAD, so a suburb is the streets you reach from its
 *    centre, not a circle that jumps a harbour.
 *  - CONTIGUOUS. A zone is built out of neighbouring suburbs and stays in one piece.
 *  - COMPACT. Among balanced answers, the one with the shortest boundaries wins, and a suburb is
 *    kept whole unless balance needs it cut.
 *  - REAL POLYGONS. Each zone gets the part of the parent polygon nearest to its own roads, so the
 *    zones tile the parent exactly — no gaps, no overlaps — and from here on they are ordinary
 *    work areas. Nothing downstream knows or cares that they were cut by us.
 *
 * How
 * ---
 *  1. Road graph: links joined at shared endpoints.
 *  2. Units: every OSM place is a seed; a multi-source shortest-path search hands each link to its
 *     nearest seed. Pieces of network no seed can reach (FC1-2 are not in the delivery, so the
 *     graph has gaps) join the nearest unit as the crow flies. Units bigger than `unitCapKm` are
 *     cut into sub-units of the same name, so balancing has something small to move.
 *  3. Zones: each zone grows outward from a centre, a unit belonging to the centre it is nearest
 *     to BY ROAD — so a zone is round where the streets are a grid and stops at an estuary where
 *     they do not cross it. Centres that end up heavy are handicapped until the zones weigh the
 *     same, and each centre moves to the middle of its zone, a few times over. Then single units
 *     change hands across boundaries until every zone is in range, and boundaries are shifted to
 *     wherever the fewest roads cross them. Every move keeps both zones in one piece.
 *  4. Polygons: a Delaunay triangulation of points sampled along every link. The Voronoi edges
 *     that separate points of different zones ARE the zone boundaries; they are traced into rings
 *     and clipped to the parent polygon.
 *
 * Deterministic: the same links, places and options give the same zones, byte for byte. The panel
 * relies on that — the split a manager previews is the split that is then written.
 *
 * Pure: no database, no network, no clock. See osmPlaces.js for where the places come from, and
 * test/areaSplit.test.js.
 */

/** OSM `place` values that name a part of a town, best first. `city` is the town itself: not a part. */
const KIND_RANK = { town: 0, suburb: 1, village: 2, quarter: 3, neighbourhood: 4, hamlet: 5, locality: 6 };
/** Kinds a zone is named after when it has any; the rest only fill in. */
const MAJOR_KIND_MAX = 2;
/** Streets of two units within this of each other make the units neighbours. */
const NEXT_DOOR_M = 250;

const DEFAULTS = {
  minKm: 250,
  maxKm: 300,
  /** What to do with road that is left over when it does not divide evenly — see zonePlan(). */
  absorbRemainder: true,
  /**
   * Units are cut down to about this, so a zone is ~18 movable pieces. Default (min+max)/36 —
   * and never more than a quarter of the range's width, or no unit would be small enough to
   * settle the last few kilometres between two zones.
   */
  unitCapKm: null,
  /** A place further than this from any road in the area names nothing. */
  snapM: 1500,
  /** Spacing of the points sampled along links for the triangulation. */
  sampleM: 40,
  /** Roads this close without meeting still share a border (it only breaks ties between cuts). */
  nearM: 400,
};

const M_PER_DEG = 111194.92664455873; // metres per degree of latitude (R = 6371008.8 m)

/* ------------------------------------------------------------------ small tools */

/** Binary min-heap of (key, value) pairs. Ties break on value, which keeps runs reproducible. */
class MinHeap {
  constructor() {
    this.keys = [];
    this.vals = [];
  }

  get size() {
    return this.keys.length;
  }

  less(i, j) {
    return this.keys[i] < this.keys[j] || (this.keys[i] === this.keys[j] && this.vals[i] < this.vals[j]);
  }

  swap(i, j) {
    const k = this.keys[i];
    this.keys[i] = this.keys[j];
    this.keys[j] = k;
    const v = this.vals[i];
    this.vals[i] = this.vals[j];
    this.vals[j] = v;
  }

  push(key, val) {
    let i = this.keys.length;
    this.keys.push(key);
    this.vals.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Removes the smallest entry and returns its value; its key is left in `lastKey`. */
  pop() {
    const top = this.vals[0];
    this.lastKey = this.keys[0];
    const k = this.keys.pop();
    const v = this.vals.pop();
    const n = this.keys.length;
    if (n > 0) {
      this.keys[0] = k;
      this.vals[0] = v;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/** Points in a plane, bucketed, for "what is the nearest one to here". */
class PointGrid {
  constructor(cell) {
    this.cell = cell;
    this.cells = new Map();
    this.count = 0;
  }

  add(x, y, id) {
    const key = `${Math.floor(x / this.cell)}:${Math.floor(y / this.cell)}`;
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(x, y, id);
    this.count++;
  }

  /** Id of the nearest point within `maxDist`, or -1. Ties break on the lower id. */
  nearest(x, y, maxDist = Infinity) {
    if (!this.count) return -1;
    const gx = Math.floor(x / this.cell);
    const gy = Math.floor(y / this.cell);
    let best = -1;
    let bestD = maxDist * maxDist;
    const maxRing = Number.isFinite(maxDist) ? Math.ceil(maxDist / this.cell) + 1 : 1e9;
    for (let ring = 0; ring <= maxRing; ring++) {
      // Nothing in a further ring can beat a hit already closer than the ring's inner edge.
      if (best >= 0 && (ring - 1) * this.cell > Math.sqrt(bestD)) break;
      if (ring > 4096) break;
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the cells ON the ring: the two full columns at its sides, the two ends otherwise.
        const step = Math.abs(dx) === ring || ring === 0 ? 1 : 2 * ring;
        for (let dy = -ring; dy <= ring; dy += step) {
          const bucket = this.cells.get(`${gx + dx}:${gy + dy}`);
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i += 3) {
            const d = (bucket[i] - x) ** 2 + (bucket[i + 1] - y) ** 2;
            if (d < bestD || (d === bestD && best >= 0 && bucket[i + 2] < best)) {
              bestD = d;
              best = bucket[i + 2];
            }
          }
        }
      }
    }
    return best;
  }
}

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2; // > 0 counter-clockwise, in the units of the coordinates
}

/** Area a ring encloses on the sphere, square metres (Chamberlain & Duquette). */
function ringSqm(ring) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[i][0] - ring[j][0]) * rad * (2 + Math.sin(ring[j][1] * rad) + Math.sin(ring[i][1] * rad));
  }
  return Math.abs((sum * R * R) / 2);
}

/** Area of a GeoJSON Polygon / MultiPolygon in square metres: outer rings less their holes. */
function geometryAreaSqm(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const polygon of polygons) {
    polygon.forEach((ring, index) => {
      total += index === 0 ? ringSqm(ring) : -ringSqm(ring);
    });
  }
  return total;
}

/* ------------------------------------------------------------------ how many zones */

function resolveOptions(options = {}) {
  const opt = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v != null)) };
  if (!(opt.minKm > 0) || !(opt.maxKm >= opt.minKm)) throw new Error('areaSplit: need 0 < minKm <= maxKm');
  opt.absorbRemainder = opt.absorbRemainder !== false;
  if (opt.unitCapKm == null) opt.unitCapKm = Math.max(1, (opt.minKm + opt.maxKm) / 36);
  return opt;
}

/**
 * How many zones `totalKm` of road becomes, and how much road each should hold.
 *
 * When some number of zones puts every one of them inside minKm..maxKm, that is the answer:
 * equal zones, the count whose size sits nearest the middle of the range. 4,408 km at 250-300 is
 * 16 zones of 275.
 *
 * Often no number does. 660 km at 250-300 is two zones with 60-160 km left over, and three would
 * each be too small. What happens to the leftover is the caller's choice:
 *
 *  - absorbRemainder (the default): it is shared out among the zones, which then run a little
 *    OVER the maximum — two zones of 330. Nobody is handed a 60 km crumb.
 *  - otherwise: the zones stay in range and the leftover is a smaller zone of its own —
 *    275, 275 and 110.
 *
 * @returns { count, targetsKm, leftover } — targetsKm[0] is the small one when `leftover`.
 */
function zonePlan(totalKm, options) {
  const opt = resolveOptions(options);
  const middle = (opt.minKm + opt.maxKm) / 2;
  const fewest = Math.max(1, Math.ceil(totalKm / opt.maxKm - 1e-9)); // any fewer and they exceed the maximum
  const most = Math.floor(totalKm / opt.minKm + 1e-9); // any more and they fall short of the minimum
  if (most >= fewest) {
    let best = fewest;
    for (let k = fewest; k <= most; k++) {
      if (Math.abs(totalKm / k - middle) < Math.abs(totalKm / best - middle)) best = k;
    }
    return { count: best, targetsKm: new Array(best).fill(totalKm / best), leftover: false };
  }
  if (opt.absorbRemainder || most < 1) {
    const count = Math.max(1, most);
    return { count, targetsKm: new Array(count).fill(totalKm / count), leftover: false };
  }
  return {
    count: most + 1,
    targetsKm: [totalKm - most * middle, ...new Array(most).fill(middle)],
    leftover: true,
  };
}

/** Whether there is enough road to make at least two zones of the size asked for. */
function shouldSplit(totalKm, options) {
  return zonePlan(totalKm, options).count >= 2;
}

/* ------------------------------------------------------------------ the split */

/**
 * @param area    { code, name, geometry (Polygon|MultiPolygon), priority?, props? }
 * @param links   [{ coords: [[lon, lat], ...], meters }] — the links INSIDE the area
 * @param places  [{ name, kind, lon, lat }] — OSM place points; may be empty (zones are then
 *                numbered but not named)
 * @returns { zones, linkZone, stats }
 *   zones[i]    { code, name, parentName, priority, geometry, bbox, areaSqm, targetMeters,
 *                 targetLinks, props }  — shaped like the areas networkImport builds
 *   linkZone    Int32Array: links[i] belongs to zones[linkZone[i]]
 */
function splitArea({ area, links, places = [], options = {} }) {
  const opt = resolveOptions(options);
  const n = links.length;
  if (!n) throw new Error('areaSplit: no links');

  /* ---- a local plane, in metres ---- */
  let box = null;
  for (const link of links) box = box ? bboxUnion(box, bboxOf(link.coords)) : bboxOf(link.coords);
  const lon0 = (box[0] + box[2]) / 2;
  const lat0 = (box[1] + box[3]) / 2;
  const kx = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const X = (lon) => (lon - lon0) * kx;
  const Y = (lat) => (lat - lat0) * M_PER_DEG;
  const lonOf = (x) => x / kx + lon0;
  const latOf = (y) => y / M_PER_DEG + lat0;

  const parentPolygons = area.geometry.type === 'Polygon' ? [area.geometry.coordinates] : area.geometry.coordinates;
  const parentBoxes = parentPolygons.map((p) => bboxOf(p[0]));
  const insideParent = (pt) => {
    for (let i = 0; i < parentPolygons.length; i++) {
      const b = parentBoxes[i];
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      if (pointInPolygon(pt, parentPolygons[i])) return true;
    }
    return false;
  };

  /* ---- 1. road graph ---- */
  const nodeIndex = new Map();
  const nodeX = [];
  const nodeY = [];
  const nodeOf = (c) => {
    const key = `${Math.round(c[0] * 1e6)}:${Math.round(c[1] * 1e6)}`;
    let i = nodeIndex.get(key);
    if (i === undefined) {
      i = nodeX.length;
      nodeIndex.set(key, i);
      nodeX.push(X(c[0]));
      nodeY.push(Y(c[1]));
    }
    return i;
  };
  const la = new Int32Array(n);
  const lb = new Int32Array(n);
  const lm = new Float64Array(n);
  let totalM = 0;
  for (let i = 0; i < n; i++) {
    const { coords } = links[i];
    la[i] = nodeOf(coords[0]);
    lb[i] = nodeOf(coords[coords.length - 1]);
    lm[i] = Math.max(0, Number(links[i].meters) || 0);
    totalM += lm[i];
  }
  const N = nodeX.length;
  const adjStart = new Int32Array(N + 1);
  for (let i = 0; i < n; i++) {
    adjStart[la[i] + 1]++;
    adjStart[lb[i] + 1]++;
  }
  for (let i = 0; i < N; i++) adjStart[i + 1] += adjStart[i];
  const adjLink = new Int32Array(2 * n);
  {
    const fill = adjStart.slice(0, N);
    for (let i = 0; i < n; i++) {
      adjLink[fill[la[i]]++] = i;
      adjLink[fill[lb[i]]++] = i;
    }
  }

  /**
   * Shortest road distance from the nearest of `sources` ([node, owner] pairs) to every node,
   * optionally only along links for which `allow(link)` holds.
   */
  const dijkstra = (sources, allow = null) => {
    const dist = new Float64Array(N).fill(Infinity);
    const owner = new Int32Array(N).fill(-1);
    const heap = new MinHeap();
    for (const [node, own] of sources) {
      if (dist[node] === 0) continue;
      dist[node] = 0;
      owner[node] = own;
      heap.push(0, node);
    }
    while (heap.size) {
      const u = heap.pop();
      const d = heap.lastKey;
      if (d > dist[u]) continue;
      for (let e = adjStart[u]; e < adjStart[u + 1]; e++) {
        const link = adjLink[e];
        if (allow && !allow(link)) continue;
        const v = la[link] === u ? lb[link] : la[link];
        const nd = d + lm[link];
        if (nd < dist[v]) {
          dist[v] = nd;
          owner[v] = owner[u];
          heap.push(nd, v);
        }
      }
    }
    return { dist, owner };
  };

  /* ---- 2. units: every link to its nearest place, by road ---- */
  const nodeGrid = new PointGrid(250);
  for (let i = 0; i < N; i++) nodeGrid.add(nodeX[i], nodeY[i], i);

  const usable = [];
  places.forEach((p, index) => {
    if (!p || !p.name || !(p.kind in KIND_RANK)) return;
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return;
    if (!insideParent([p.lon, p.lat])) return;
    const node = nodeGrid.nearest(X(p.lon), Y(p.lat), opt.snapM);
    if (node < 0) return;
    usable.push({ index, node, name: String(p.name).trim(), kind: p.kind });
  });
  // One seed per junction: the better kind keeps it, then the name, so the order OSM happened to
  // answer in cannot change the result.
  usable.sort((a, b) => a.node - b.node || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.localeCompare(b.name));
  const seeds = usable.filter((s, i) => i === 0 || usable[i - 1].node !== s.node);
  seeds.sort((a, b) => a.name.localeCompare(b.name) || a.node - b.node);

  /** Per unit: the place it is named after (null when OSM gave nothing). */
  const unitName = [];
  const unitKind = [];
  const sources = [];
  if (seeds.length) {
    seeds.forEach((s, u) => {
      unitName.push(s.name);
      unitKind.push(s.kind);
      sources.push([s.node, u]);
    });
  } else {
    // No names to work with: one nameless unit, cut down to size below.
    unitName.push(null);
    unitKind.push(null);
  }

  /** link -> unit */
  const lu = new Int32Array(n).fill(-1);
  const first = seeds.length ? dijkstra(sources) : null;
  if (first) {
    for (let i = 0; i < n; i++) {
      const a = la[i];
      const b = lb[i];
      lu[i] = first.dist[a] <= first.dist[b] ? first.owner[a] : first.owner[b];
    }
  } else {
    lu.fill(0);
  }

  /**
   * Hand every link `isLoose(link)` — a piece of network the search could not reach — to the unit
   * of the nearest reached junction, one connected piece at a time so a piece is never divided.
   */
  const attachLoose = (isLoose, reachedGrid, unitOfNode) => {
    const seen = new Uint8Array(n);
    for (let start = 0; start < n; start++) {
      if (seen[start] || !isLoose(start)) continue;
      const piece = [start];
      seen[start] = 1;
      for (let head = 0; head < piece.length; head++) {
        const link = piece[head];
        for (const node of [la[link], lb[link]]) {
          for (let e = adjStart[node]; e < adjStart[node + 1]; e++) {
            const other = adjLink[e];
            if (!seen[other] && isLoose(other)) {
              seen[other] = 1;
              piece.push(other);
            }
          }
        }
      }
      let best = -1;
      let bestD = Infinity;
      for (const link of piece) {
        for (const node of [la[link], lb[link]]) {
          const near = reachedGrid.nearest(nodeX[node], nodeY[node]);
          if (near < 0) continue;
          const d = (nodeX[near] - nodeX[node]) ** 2 + (nodeY[near] - nodeY[node]) ** 2;
          if (d < bestD || (d === bestD && near < best)) {
            bestD = d;
            best = near;
          }
        }
      }
      const unit = best >= 0 ? unitOfNode(best) : 0;
      for (const link of piece) lu[link] = unit;
    }
  };
  if (first) {
    const reached = new PointGrid(500);
    for (let i = 0; i < N; i++) if (first.owner[i] >= 0) reached.add(nodeX[i], nodeY[i], i);
    attachLoose((link) => lu[link] < 0, reached, (node) => first.owner[node]);
  }

  /* ---- 2b. cut big units down, so there is something small enough to balance with ---- */
  /**
   * By position, not along the network: halve the unit across its longer side at the point
   * where half its road lies either side, and again, until every piece is under the cap. The
   * network is no guide here — a delivery of FC3-5 only comes in thousands of disconnected
   * fragments (Auckland: 2,068), and a cut that follows connectivity peels them off one crumb at
   * a time. Halving by position gives compact pieces of even weight whatever the network does.
   */
  const plan = zonePlan(totalM / 1000, opt);
  // The width of the range the zones must land in: max - min, or 4% either side of the size when
  // one exact size was asked for.
  const half = Math.max(((opt.maxKm - opt.minKm) * 1000) / 2, 0.04 * (totalM / plan.count));
  const capM = Math.max(500, Math.min(opt.unitCapKm * 1000, half / 2));
  {
    const midX = (i) => (nodeX[la[i]] + nodeX[lb[i]]) / 2;
    const midY = (i) => (nodeY[la[i]] + nodeY[lb[i]]) / 2;
    const unitLinks = unitName.map(() => []);
    for (let i = 0; i < n; i++) unitLinks[lu[i]].push(i);
    const originalUnits = unitName.length;
    for (let u = 0; u < originalUnits; u++) {
      const stack = [unitLinks[u]];
      let firstPiece = true;
      while (stack.length) {
        const mine = stack.pop();
        const weight = mine.reduce((sum, i) => sum + lm[i], 0);
        if (weight > capM && mine.length > 1) {
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          for (const i of mine) {
            const x = midX(i);
            const y = midY(i);
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          const along = maxX - minX >= maxY - minY ? midX : midY;
          const sorted = mine.slice().sort((p, q) => along(p) - along(q) || p - q);
          let acc = 0;
          let cut = 0;
          while (cut < sorted.length - 1 && acc + lm[sorted[cut]] / 2 < weight / 2) acc += lm[sorted[cut++]];
          cut = Math.max(1, Math.min(sorted.length - 1, cut));
          stack.push(sorted.slice(cut), sorted.slice(0, cut));
          continue;
        }
        if (firstPiece) {
          firstPiece = false; // keeps the unit's own id
          continue;
        }
        unitName.push(unitName[u]);
        unitKind.push(unitKind[u]);
        for (const i of mine) lu[i] = unitName.length - 1;
      }
    }
  }

  // Drop units that ended up with no links, and renumber.
  let U = 0;
  {
    const used = new Int32Array(unitName.length).fill(-1);
    for (let i = 0; i < n; i++) if (used[lu[i]] < 0) used[lu[i]] = 0;
    const names = [];
    const kinds = [];
    for (let u = 0; u < unitName.length; u++) {
      if (used[u] < 0) continue;
      used[u] = U++;
      names.push(unitName[u]);
      kinds.push(unitKind[u]);
    }
    for (let i = 0; i < n; i++) lu[i] = used[lu[i]];
    unitName.length = 0;
    unitKind.length = 0;
    unitName.push(...names);
    unitKind.push(...kinds);
  }

  const uw = new Float64Array(U); // metres of road
  const ux = new Float64Array(U);
  const uy = new Float64Array(U);
  for (let i = 0; i < n; i++) {
    const w = lm[i] || 1e-6;
    uw[lu[i]] += lm[i];
    ux[lu[i]] += ((nodeX[la[i]] + nodeX[lb[i]]) / 2) * w;
    uy[lu[i]] += ((nodeY[la[i]] + nodeY[lb[i]]) / 2) * w;
  }
  {
    const wsum = new Float64Array(U);
    for (let i = 0; i < n; i++) wsum[lu[i]] += lm[i] || 1e-6;
    for (let u = 0; u < U; u++) {
      ux[u] /= wsum[u];
      uy[u] /= wsum[u];
    }
  }

  /* ---- sample points along every link, and triangulate them ---- */
  const sx = [];
  const sy = [];
  const sLink = [];
  {
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const pts = links[i].coords.map((c) => [X(c[0]), Y(c[1])]);
      let length = 0;
      const cum = [0];
      for (let j = 1; j < pts.length; j++) {
        length += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
        cum.push(length);
      }
      // An odd count, so one of the points is the link's midpoint — the very point the import
      // uses to decide which area a link is in. It then always lies inside its own zone.
      let count = Math.max(1, Math.ceil(length / opt.sampleM));
      if (count % 2 === 0) count++;
      let seg = 1;
      for (let j = 0; j < count; j++) {
        const at = ((j + 0.5) / count) * length;
        while (seg < pts.length - 1 && cum[seg] < at) seg++;
        const span = cum[seg] - cum[seg - 1];
        const t = span > 0 ? (at - cum[seg - 1]) / span : 0;
        const x = pts[seg - 1][0] + (pts[seg][0] - pts[seg - 1][0]) * t;
        const y = pts[seg - 1][1] + (pts[seg][1] - pts[seg - 1][1]) * t;
        const key = `${Math.round(x * 100)}:${Math.round(y * 100)}`;
        if (seen.has(key)) continue; // two links on top of each other: the first one's point stands
        seen.add(key);
        sx.push(x);
        sy.push(y);
        sLink.push(i);
      }
    }
  }
  const realSites = sx.length;
  {
    // A ring of points well outside everything, belonging to no zone: every zone's region is then
    // closed off by finite Voronoi edges, and the convex hull is made of guard points only.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < realSites; i++) {
      if (sx[i] < minX) minX = sx[i];
      if (sx[i] > maxX) maxX = sx[i];
      if (sy[i] < minY) minY = sy[i];
      if (sy[i] > maxY) maxY = sy[i];
    }
    // The parent polygon may reach far beyond its roads (islands, parks): cover it too.
    for (const polygon of parentPolygons) {
      for (const c of polygon[0]) {
        const x = X(c[0]);
        const y = Y(c[1]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    // Further out than the area is wide: no point of the parent can then be nearer to a guard
    // than to a road, so the zones tile the parent completely — roadless bush included.
    const margin = 1.5 * Math.hypot(maxX - minX, maxY - minY) + 1000;
    minX -= margin;
    minY -= margin;
    maxX += margin;
    maxY += margin;
    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const fx = minX + ((maxX - minX) * i) / steps;
      const fy = minY + ((maxY - minY) * i) / steps;
      sx.push(fx, maxX - (fx - minX), maxX, minX);
      sy.push(minY, maxY, fy, maxY - (fy - minY));
      sLink.push(-1, -1, -1, -1);
    }
  }
  const siteCoords = new Float64Array(sx.length * 2);
  for (let i = 0; i < sx.length; i++) {
    siteCoords[2 * i] = sx[i];
    siteCoords[2 * i + 1] = sy[i];
  }
  const delaunay = new Delaunator(siteCoords);
  const { triangles, halfedges } = delaunay;
  const nextEdge = (e) => (e % 3 === 2 ? e - 2 : e + 1);

  /* ---- 3a. which units touch ---- */
  /**
   * Two graphs over the units.
   *
   *  `adj`  what a boundary between two units COSTS: the junctions they share (roads the
   *         boundary would cut) and how much of their streets run side by side. A boundary along
   *         a river, a motorway or a railway has little of either — the boundary to prefer.
   *  `conn` which units are next to each other, and how far apart: units that share a junction
   *         or whose streets come within NEXT_DOOR_M, plus the shortest gaps needed to tie in
   *         whatever that still leaves cut off (islands). Zones are kept in one piece over this.
   *
   * Nearness has to count, not just shared junctions: the delivery's network is in fragments
   * (see 2b), so "can drive from one to the other on these links" is true of almost nothing,
   * while the streets either side of a missing collector road are plainly the same neighbourhood.
   */
  const adj = Array.from({ length: U }, () => new Map());
  const conn = Array.from({ length: U }, () => new Map());
  const addCost = (a, b, w) => {
    adj[a].set(b, (adj[a].get(b) || 0) + w);
    adj[b].set(a, (adj[b].get(a) || 0) + w);
  };
  const centreGap = (a, b) => Math.hypot(ux[a] - ux[b], uy[a] - uy[b]);
  for (let node = 0; node < N; node++) {
    const here = [];
    for (let e = adjStart[node]; e < adjStart[node + 1]; e++) {
      const u = lu[adjLink[e]];
      if (!here.includes(u)) here.push(u);
    }
    for (let i = 0; i < here.length; i++) {
      for (let j = i + 1; j < here.length; j++) {
        addCost(here[i], here[j], 1);
        conn[here[i]].set(here[j], centreGap(here[i], here[j]));
        conn[here[j]].set(here[i], centreGap(here[i], here[j]));
      }
    }
  }
  // Delaunay edges between sample points of different units: how close their roads run.
  const gaps = []; // [length, unitA, unitB]
  for (let e = 0; e < halfedges.length; e++) {
    const o = halfedges[e];
    if (o < e) continue; // each pair once; -1 is the hull, which is guard points only
    const p = triangles[e];
    const q = triangles[nextEdge(e)];
    if (sLink[p] < 0 || sLink[q] < 0) continue;
    const a = lu[sLink[p]];
    const b = lu[sLink[q]];
    if (a === b) continue;
    const length = Math.hypot(sx[p] - sx[q], sy[p] - sy[q]);
    if (length <= NEXT_DOOR_M) {
      // Streets a back fence apart. One such edge per ~40 m of shared border.
      addCost(a, b, 0.1);
      if (!conn[a].has(b)) {
        conn[a].set(b, centreGap(a, b));
        conn[b].set(a, centreGap(a, b));
      }
    } else if (length <= opt.nearM && conn[a].has(b)) {
      addCost(a, b, 0.02);
    }
    gaps.push([length, Math.min(a, b), Math.max(a, b)]);
  }
  // Whatever is still cut off is tied to its nearest neighbour, shortest gaps first, until the
  // whole area is one piece.
  {
    const parent = Int32Array.from({ length: U }, (_, i) => i);
    const find = (x) => {
      let r = x;
      while (parent[r] !== r) r = parent[r];
      while (parent[x] !== r) {
        const next = parent[x];
        parent[x] = r;
        x = next;
      }
      return r;
    };
    for (let u = 0; u < U; u++) for (const v of conn[u].keys()) parent[find(u)] = find(v);
    gaps.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    for (const [length, a, b] of gaps) {
      if (find(a) === find(b)) continue;
      parent[find(a)] = find(b);
      const hop = Math.max(length, centreGap(a, b));
      conn[a].set(b, hop);
      conn[b].set(a, hop);
      addCost(a, b, 0.05);
    }
  }
  // Two pieces of the same suburb belong together more than two different suburbs do.
  for (let u = 0; u < U; u++) {
    if (!unitName[u]) continue;
    for (const [v, w] of adj[u]) if (unitName[v] === unitName[u]) adj[u].set(v, w * 3);
  }
  /**
   * How far apart two neighbours are, for growing zones: the distance between their centres,
   * stretched by how LITTLE joins them. Two units with twenty streets running between them are
   * as close as they look; two that meet at a single bridge are not — and without this a zone
   * growing from one bank takes the bridgehead on the other, because across a bridge is "near".
   * Weakly joined neighbours being far apart is what makes zones stop at rivers and motorways.
   *
   * Steep on purpose (the square): a single crossing counts four times its length, three shared
   * streets or 100 m of back fences barely count at all. The delivery's network is in fragments,
   * so most neighbours are joined by nearness alone, and they must not all look like islands.
   */
  for (let u = 0; u < U; u++) {
    for (const [v, length] of conn[u]) {
      if (v < u) continue;
      const strength = Math.max(adj[u].get(v) || 0, 0.5);
      const stretched = length * (1 + 3 / (strength * strength));
      conn[u].set(v, stretched);
      conn[v].set(u, stretched);
    }
  }
  const neighbours = conn.map((m) => [...m.keys()].sort((a, b) => a - b));

  // Road distance between every pair of units, hopping between neighbours' centres.
  const D = new Float64Array(U * U).fill(Infinity);
  for (let from = 0; from < U; from++) {
    const row = from * U;
    const heap = new MinHeap();
    D[row + from] = 0;
    heap.push(0, from);
    while (heap.size) {
      const u = heap.pop();
      if (heap.lastKey > D[row + u]) continue;
      for (const [v, len] of conn[u]) {
        const nd = D[row + u] + len;
        if (nd < D[row + v]) {
          D[row + v] = nd;
          heap.push(nd, v);
        }
      }
    }
  }

  /* ---- 3b. zones ---- */
  const Z = Math.max(1, Math.min(U, plan.count));
  const zoneOf = new Int32Array(U).fill(-1);
  const zw = new Float64Array(Z);
  const zsize = new Int32Array(Z);
  const centre = new Int32Array(Z);

  // What each zone should weigh, and the range it has to land in. A zone whose target sits
  // inside min..max gets exactly that range; one that cannot (the leftover shared out, or the
  // leftover kept apart) gets a range of the same width centred on its target.
  const meanTarget = totalM / Z;
  const tz = Float64Array.from({ length: Z }, (_, z) =>
    (Z === plan.count ? plan.targetsKm[z] * 1000 : meanTarget));
  const lo = new Float64Array(Z);
  const hi = new Float64Array(Z);
  for (let z = 0; z < Z; z++) {
    lo[z] = tz[z] < opt.minKm * 1000 + half * 0.2 ? Math.max(0, tz[z] - half) : opt.minKm * 1000;
    hi[z] = tz[z] > opt.maxKm * 1000 - half * 0.2 ? tz[z] + half : opt.maxKm * 1000;
  }
  const spare = half * 0.25;

  const recount = () => {
    zw.fill(0);
    zsize.fill(0);
    for (let u = 0; u < U; u++) {
      zw[zoneOf[u]] += uw[u];
      zsize[zoneOf[u]]++;
    }
  };
  /** The unit of zone `z` from which the rest of the zone is, weight for weight, nearest. */
  const middleOf = (z) => {
    let best = -1;
    let bestCost = Infinity;
    for (let u = 0; u < U; u++) {
      if (zoneOf[u] !== z) continue;
      let cost = 0;
      for (let v = 0; v < U; v++) if (zoneOf[v] === z) cost += uw[v] * D[u * U + v];
      if (cost < bestCost) {
        bestCost = cost;
        best = u;
      }
    }
    return best;
  };
  /** Is the set `flags` still one piece with `without` taken out? `size` counts `without`. */
  const staysWhole = (flags, size, without) => {
    if (size <= 1) return false;
    let start = -1;
    for (const v of neighbours[without]) {
      if (flags(v)) {
        start = v;
        break;
      }
    }
    if (start < 0) return false;
    const seen = new Set([start]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      for (const v of neighbours[queue[head]]) {
        if (v === without || seen.has(v) || !flags(v)) continue;
        seen.add(v);
        queue.push(v);
      }
    }
    return seen.size === size - 1;
  };

  // Starting centres: where the ROAD is, not where the map is empty. The area is halved by
  // position across its longer side, each half taking the share of road its zones should hold,
  // and again, down to one cell per zone; a cell's centre is the unit nearest the middle of its
  // road. (Picking the units furthest apart instead puts centres on islands and at the ends of
  // rural roads, each with a zone that has nowhere to grow.) With a leftover zone, that is cell 0
  // — the first cut off, so it sits at an edge of the area.
  {
    const cells = [];
    const cut = (ids, from, to) => {
      if (to - from === 1) {
        cells[from] = ids;
        return;
      }
      const mid = from + Math.max(1, Math.floor((to - from) / 2));
      let share = 0;
      let all = 0;
      for (let z = from; z < to; z++) {
        all += tz[z];
        if (z < mid) share += tz[z];
      }
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let weight = 0;
      for (const u of ids) {
        if (ux[u] < minX) minX = ux[u];
        if (ux[u] > maxX) maxX = ux[u];
        if (uy[u] < minY) minY = uy[u];
        if (uy[u] > maxY) maxY = uy[u];
        weight += uw[u];
      }
      const along = maxX - minX >= maxY - minY ? ux : uy;
      const sorted = ids.slice().sort((p, q) => along[p] - along[q] || p - q);
      const want = (weight * share) / all;
      let acc = 0;
      let at = 0;
      while (at < sorted.length - (to - mid) && (at < mid - from || acc + uw[sorted[at]] / 2 < want)) acc += uw[sorted[at++]];
      cut(sorted.slice(0, at), from, mid);
      cut(sorted.slice(at), mid, to);
    };
    cut(Array.from({ length: U }, (_, u) => u), 0, Z);
    for (let z = 0; z < Z; z++) {
      let mx = 0;
      let my = 0;
      let w = 0;
      for (const u of cells[z]) {
        mx += ux[u] * uw[u];
        my += uy[u] * uw[u];
        w += uw[u];
      }
      mx /= w || 1;
      my /= w || 1;
      let best = cells[z][0];
      let bestD = Infinity;
      for (const u of cells[z]) {
        const d = (ux[u] - mx) ** 2 + (uy[u] - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      centre[z] = best;
    }
  }

  // Grow, handicap, re-centre.
  const offset = new Float64Array(Z);
  const assign = () => {
    for (let u = 0; u < U; u++) {
      let best = 0;
      let bestD = Infinity;
      for (let z = 0; z < Z; z++) {
        const d = offset[z] + D[centre[z] * U + u];
        if (d < bestD) {
          bestD = d;
          best = z;
        }
      }
      zoneOf[u] = best;
    }
    for (let z = 0; z < Z; z++) zoneOf[centre[z]] = z; // a centre is always in its own zone
    recount();
  };
  let bestRound = null;
  for (let round = 0; round < 24; round++) {
    // The handicap: a heavy zone's centre is pushed "further away" from every unit, a light
    // one's pulled closer, until they weigh about the same. Units are lumps, so "about" is as
    // good as this gets — the finishing passes below do the rest one unit at a time.
    let reach = 0;
    {
      offset.fill(0);
      assign();
      let total = 0;
      for (let u = 0; u < U; u++) total += uw[u] * D[centre[zoneOf[u]] * U + u];
      reach = total / totalM || 1;
    }
    let best = { miss: Infinity, zones: null };
    let rate = 0.4;
    for (let it = 0; it < 250; it++) {
      assign();
      let miss = 0;
      for (let z = 0; z < Z; z++) miss = Math.max(miss, Math.abs(zw[z] - tz[z]));
      if (miss < best.miss) best = { miss, zones: zoneOf.slice() };
      if (miss <= half * 0.5) break;
      for (let z = 0; z < Z; z++) offset[z] += rate * reach * ((zw[z] - tz[z]) / meanTarget);
      rate = Math.max(0.05, rate * 0.985);
    }
    zoneOf.set(best.zones);
    recount();
    if (!bestRound || best.miss < bestRound.miss) bestRound = { miss: best.miss, zones: zoneOf.slice(), centre: centre.slice() };

    let moved = false;
    for (let z = 0; z < Z; z++) {
      const middle = middleOf(z);
      if (middle >= 0 && middle !== centre[z]) {
        centre[z] = middle;
        moved = true;
      }
    }
    if (!moved) break;
  }
  zoneOf.set(bestRound.zones);
  centre.set(bestRound.centre);
  recount();

  // One piece each. Any part of a zone its centre cannot reach from inside the zone goes to the
  // neighbouring zone it shares most with — repeated, since a piece handed over can itself be
  // stranded from its new zone's centre.
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    const reached = new Uint8Array(U);
    for (let z = 0; z < Z; z++) {
      const queue = [centre[z]];
      reached[centre[z]] = 1;
      for (let head = 0; head < queue.length; head++) {
        for (const v of neighbours[queue[head]]) {
          if (zoneOf[v] === z && !reached[v]) {
            reached[v] = 1;
            queue.push(v);
          }
        }
      }
    }
    for (let u = 0; u < U; u++) {
      if (reached[u]) continue;
      let to = -1;
      let weight = -1;
      for (const v of neighbours[u]) {
        if (!reached[v] || zoneOf[v] === zoneOf[u]) continue;
        const w = adj[u].get(v) || 0;
        if (w > weight) {
          weight = w;
          to = zoneOf[v];
        }
      }
      if (to >= 0) {
        zoneOf[u] = to;
        changed = true;
      }
    }
    if (!changed) break;
  }
  recount();

  const move = (u, to) => {
    const from = zoneOf[u];
    zoneOf[u] = to;
    zw[from] -= uw[u];
    zw[to] += uw[u];
    zsize[from]--;
    zsize[to]++;
  };
  const canLeave = (u) => {
    const z = zoneOf[u];
    return u !== centre[z] && staysWhole((v) => zoneOf[v] === z, zsize[z], u);
  };
  /** How many fewer roads the boundaries cut if `u` moves to zone `to`. */
  const cutGain = (u, to) => {
    let gain = 0;
    for (const [v, w] of adj[u]) {
      if (zoneOf[v] === to) gain += w;
      else if (zoneOf[v] === zoneOf[u]) gain -= w;
    }
    return gain;
  };
  /** How much further `u` is from zone `to`'s centre than from its own: small = a natural move. */
  const detour = (u, to) => D[centre[to] * U + u] - D[centre[zoneOf[u]] * U + u];
  const zonesNextTo = (u) => {
    const out = [];
    for (const v of neighbours[u]) if (zoneOf[v] !== zoneOf[u] && !out.includes(zoneOf[v])) out.push(zoneOf[v]);
    return out;
  };

  // Balance: a zone over its target hands a boundary unit to a neighbour further under its own
  // — the unit that sits nearest that neighbour's centre. Each move lowers the sum of squared
  // misses, so it cannot cycle; it stops once every zone is in range with a little to spare for
  // the tidying below.
  const over = (z) => zw[z] - tz[z];
  for (let guard = 0; guard < U * 20; guard++) {
    let need = false;
    for (let z = 0; z < Z; z++) if (zw[z] < lo[z] + spare || zw[z] > hi[z] - spare) need = true;
    if (!need) break;
    let best = null;
    for (const relief of [true, false]) {
      for (let u = 0; u < U; u++) {
        const from = zoneOf[u];
        for (const to of zonesNextTo(u)) {
          if (over(from) - over(to) - uw[u] <= 1e-6) continue;
          // First choice: moves that relieve a zone which is actually out of range. Failing
          // that, any downhill move — it passes the weight along towards one that is.
          if (relief && !(zw[from] > hi[from] - spare || zw[to] < lo[to] + spare)) continue;
          const score = detour(u, to) - 200 * cutGain(u, to);
          if ((!best || score < best.score) && canLeave(u)) best = { u, to, score };
        }
      }
      if (best) break;
    }
    if (!best) break;
    move(best.u, best.to);
  }

  // Tidy: move a unit wherever that cuts fewer roads (and brings a suburb's pieces back
  // together), never taking a zone out of range or further out than it already is. When no
  // single move is left, two zones may EXCHANGE a unit each — the fix for a pair of bridgeheads
  // held by the wrong bank, where either move alone would break the range. Every step lowers the
  // total cut, so this ends.
  {
    const missOf = (z, w) => Math.max(0, lo[z] - w, w - hi[z]);
    const fits = (z, w) => missOf(z, w) <= missOf(z, zw[z]);
    for (let guard = 0; guard < U * 20; guard++) {
      let best = null;
      for (let u = 0; u < U; u++) {
        const from = zoneOf[u];
        for (const to of zonesNextTo(u)) {
          const gain = cutGain(u, to);
          if (gain <= 1e-9) continue;
          if (!fits(from, zw[from] - uw[u]) || !fits(to, zw[to] + uw[u])) continue;
          if ((!best || gain > best.gain) && canLeave(u)) best = { u, to, gain };
        }
      }
      if (best) {
        move(best.u, best.to);
        continue;
      }

      // No single move: look for a pair.
      const movers = []; // [unit, to, gain] — every boundary unit and where it could go
      for (let u = 0; u < U; u++) for (const to of zonesNextTo(u)) movers.push([u, to, cutGain(u, to)]);
      let swap = null;
      for (let i = 0; i < movers.length; i++) {
        const [u, b, gu] = movers[i];
        const a = zoneOf[u];
        for (let j = i + 1; j < movers.length; j++) {
          const [v, to, gv] = movers[j];
          if (zoneOf[v] !== b || to !== a) continue;
          // An edge between the two stays cut after they change places: each gain counted it.
          const gain = gu + gv - 2 * (adj[u].get(v) || 0);
          if (gain <= 1e-9 || (swap && gain <= swap.gain)) continue;
          if (!fits(a, zw[a] - uw[u] + uw[v]) || !fits(b, zw[b] - uw[v] + uw[u])) continue;
          // Each must be able to leave, and must land next to something other than its partner.
          if (!neighbours[u].some((x) => x !== v && zoneOf[x] === b)) continue;
          if (!neighbours[v].some((x) => x !== u && zoneOf[x] === a)) continue;
          if (!canLeave(u) || !canLeave(v)) continue;
          swap = { u, v, a, b, gain };
        }
      }
      if (!swap) break;
      move(swap.u, swap.b);
      move(swap.v, swap.a);
    }
  }

  /* ---- 3c. order and name the zones ---- */
  // North to south, then west to east: the numbers then read down the map.
  const zx = new Float64Array(Z);
  const zy = new Float64Array(Z);
  for (let u = 0; u < U; u++) {
    zx[zoneOf[u]] += ux[u] * uw[u];
    zy[zoneOf[u]] += uy[u] * uw[u];
  }
  for (let z = 0; z < Z; z++) {
    zx[z] /= zw[z] || 1;
    zy[z] /= zw[z] || 1;
  }
  const order = Array.from({ length: Z }, (_, z) => z).sort((p, q) => zy[q] - zy[p] || zx[p] - zx[q]);
  const rank = new Int32Array(Z);
  order.forEach((z, i) => (rank[z] = i));
  const linkZone = new Int32Array(n);
  for (let i = 0; i < n; i++) linkZone[i] = rank[zoneOf[lu[i]]];

  // What each place weighs in each zone. A place headlines only the zone that holds most of it,
  // so two neighbouring zones are not both called after the suburb they share.
  const placeKm = new Map(); // name -> { kind, perZone: Float64Array }
  for (let u = 0; u < U; u++) {
    if (!unitName[u]) continue;
    let row = placeKm.get(unitName[u]);
    if (!row) {
      row = { name: unitName[u], kind: unitKind[u], perZone: new Float64Array(Z) };
      placeKm.set(unitName[u], row);
    }
    row.perZone[zoneOf[u]] += uw[u] / 1000;
    if (KIND_RANK[unitKind[u]] < KIND_RANK[row.kind]) row.kind = unitKind[u];
  }
  for (const row of placeKm.values()) {
    row.home = 0;
    for (let z = 1; z < Z; z++) if (row.perZone[z] > row.perZone[row.home]) row.home = z;
  }

  const digits = Math.max(2, String(Z).length);
  const zones = order.map((z, i) => {
    const all = [...placeKm.values()]
      .filter((row) => row.perZone[z] > 0)
      .map((row) => ({ name: row.name, kind: row.kind, km: row.perZone[z], home: row.home === z }))
      .sort((p, q) => q.km - p.km || p.name.localeCompare(q.name));
    const byPreference = [
      ...all.filter((p) => p.home && KIND_RANK[p.kind] <= MAJOR_KIND_MAX),
      ...all.filter((p) => p.home && KIND_RANK[p.kind] > MAJOR_KIND_MAX),
      ...all.filter((p) => !p.home),
    ];
    const headline = byPreference.slice(0, 3).map((p) => p.name);
    const number = String(i + 1).padStart(digits, '0');
    return {
      code: `${area.code}-${number}`,
      name: headline.length ? `${area.name} ${number} – ${headline.join(', ')}` : `${area.name} ${number}`,
      parentName: area.name,
      priority: area.priority ?? 0,
      geometry: null,
      bbox: null,
      areaSqm: 0,
      targetMeters: 0,
      targetLinks: 0,
      props: {
        ...(area.props || {}),
        splitFrom: { code: area.code, name: area.name },
        zone: i + 1,
        zones: Z,
        places: all.map((p) => ({ name: p.name, km: Math.round(p.km * 10) / 10 })),
      },
    };
  });
  for (let i = 0; i < n; i++) {
    zones[linkZone[i]].targetLinks++;
    zones[linkZone[i]].targetMeters += lm[i];
  }

  /* ---- 4. polygons ---- */
  const T = triangles.length / 3;
  const cx = new Float64Array(T);
  const cy = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const i = triangles[3 * t];
    const j = triangles[3 * t + 1];
    const m = triangles[3 * t + 2];
    const dx = sx[j] - sx[i];
    const dy = sy[j] - sy[i];
    const ex = sx[m] - sx[i];
    const ey = sy[m] - sy[i];
    const bl = dx * dx + dy * dy;
    const cl = ex * ex + ey * ey;
    const d = 2 * (dx * ey - dy * ex);
    if (Math.abs(d) < 1e-9) {
      cx[t] = (sx[i] + sx[j] + sx[m]) / 3;
      cy[t] = (sy[i] + sy[j] + sy[m]) / 3;
    } else {
      cx[t] = sx[i] + (ey * bl - dy * cl) / d;
      cy[t] = sy[i] + (dx * cl - ex * bl) / d;
    }
  }
  const siteZone = (s) => (sLink[s] < 0 ? -1 : linkZone[sLink[s]]);
  /** Per zone: Voronoi vertex (a triangle) -> its two neighbours along the zone's boundary. */
  const boundary = zones.map(() => new Map());
  const addEdge = (z, a, b) => {
    const map = boundary[z];
    if (!map.has(a)) map.set(a, []);
    if (!map.has(b)) map.set(b, []);
    map.get(a).push(b);
    map.get(b).push(a);
  };
  for (let e = 0; e < halfedges.length; e++) {
    const o = halfedges[e];
    if (o < e) continue;
    const zp = siteZone(triangles[e]);
    const zq = siteZone(triangles[nextEdge(e)]);
    if (zp === zq) continue;
    const t1 = Math.floor(e / 3);
    const t2 = Math.floor(o / 3);
    if (zp >= 0) addEdge(zp, t1, t2);
    if (zq >= 0) addEdge(zq, t1, t2);
  }

  /**
   * The parent may come in many pieces (Auckland: 154 — the mainland, islands, harbour slivers).
   * A piece with no road in it is not divided: an island cut three ways by which shore is
   * nearest is a strange thing to hand a driver. It goes whole to the zone whose roads are
   * nearest. Only the pieces that hold roads are cut along the zone boundaries.
   */
  const partOrder = parentPolygons
    .map((polygon, i) => ({ polygon, box: parentBoxes[i] }))
    .sort((p, q) => (q.box[2] - q.box[0]) * (q.box[3] - q.box[1]) - (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]));
  const hasRoad = new Uint8Array(partOrder.length);
  for (let s = 0; s < realSites; s++) {
    if (s > 0 && sLink[s - 1] === sLink[s]) continue; // one probe per link
    const pt = [lonOf(sx[s]), latOf(sy[s])];
    let found = 0; // the largest piece, unless a smaller one claims the point
    for (let i = 1; i < partOrder.length; i++) {
      const b = partOrder[i].box;
      if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
      if (pointInPolygon(pt, partOrder[i].polygon)) {
        found = i;
        break;
      }
    }
    hasRoad[found] = 1;
  }
  const parentCoords = partOrder.filter((_, i) => hasRoad[i]).map((part) => part.polygon);
  const wholeParts = zones.map(() => []);
  {
    const siteGrid = new PointGrid(500);
    for (let s = 0; s < realSites; s++) siteGrid.add(sx[s], sy[s], s);
    partOrder.forEach((part, i) => {
      if (hasRoad[i]) return;
      const ring = part.polygon[0];
      let px = 0;
      let py = 0;
      for (const c of ring) {
        px += X(c[0]);
        py += Y(c[1]);
      }
      const near = siteGrid.nearest(px / ring.length, py / ring.length);
      wholeParts[linkZone[sLink[near]]].push(part.polygon);
    });
  }
  let midpointsOutside = 0;
  zones.forEach((zone, z) => {
    const map = boundary[z];
    const visited = new Set();
    const rings = [];
    for (const start of [...map.keys()].sort((p, q) => p - q)) {
      if (visited.has(start)) continue;
      const ring = [];
      let prev = -1;
      let cur = start;
      for (let guard = 0; guard <= map.size; guard++) {
        visited.add(cur);
        const lon = lonOf(cx[cur]);
        const lat = latOf(cy[cur]);
        const last = ring[ring.length - 1];
        if (!last || last[0] !== lon || last[1] !== lat) ring.push([lon, lat]);
        const nb = map.get(cur);
        const next = nb[0] !== prev ? nb[0] : nb[1];
        prev = cur;
        cur = next;
        if (cur === start) break;
      }
      if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
      if (ring.length < 3) continue;
      ring.push([ring[0][0], ring[0][1]]);
      rings.push(ring);
    }
    if (!rings.length) throw new Error(`areaSplit: zone ${zone.code} has no boundary`);
    // Nested rings are holes, and holes in holes are land again: exclusive-or says exactly that.
    const region = rings.length === 1 ? [[rings[0]]] : polygonClipping.xor(...rings.map((r) => [[r]]));
    const clipped = polygonClipping.intersection(region, parentCoords);

    const polygons = [];
    for (const polygon of clipped) {
      const out = [];
      polygon.forEach((ring, index) => {
        const clean = [];
        for (const c of ring) {
          const p = [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7];
          const last = clean[clean.length - 1];
          if (!last || last[0] !== p[0] || last[1] !== p[1]) clean.push(p);
        }
        if (clean.length && (clean[0][0] !== clean[clean.length - 1][0] || clean[0][1] !== clean[clean.length - 1][1])) {
          clean.push([clean[0][0], clean[0][1]]);
        }
        if (clean.length < 4) return;
        const signed = ringArea(clean);
        if (Math.abs(signed) * kx * M_PER_DEG < 1) return; // under a square metre: a clipping crumb
        // GeoJSON winding: outer ring counter-clockwise, holes clockwise.
        if ((index === 0) !== signed > 0) clean.reverse();
        if (index === 0 || out.length) out.push(clean);
      });
      if (out.length) polygons.push(out);
    }
    // The roadless pieces this zone was given, as they are (outer ring counter-clockwise).
    for (const polygon of wholeParts[z]) {
      polygons.push(polygon.map((ring, index) => {
        const copy = ring.map((c) => [c[0], c[1]]);
        if ((index === 0) !== ringArea(copy) > 0) copy.reverse();
        return copy;
      }));
    }
    if (!polygons.length) throw new Error(`areaSplit: zone ${zone.code} has no polygon inside ${area.name}`);
    zone.geometry = polygons.length === 1
      ? { type: 'Polygon', coordinates: polygons[0] }
      : { type: 'MultiPolygon', coordinates: polygons };
    zone.bbox = polygons.map((p) => bboxOf(p[0])).reduce((acc, b) => bboxUnion(acc, b));
    zone.areaSqm = Math.round(geometryAreaSqm(zone.geometry));
  });

  // The promise the import leans on: a link's midpoint lies in the polygon of its own zone —
  // checked with the very probe the import uses (utils/geo.midpointOf).
  {
    const boxes = zones.map((zone) => zone.bbox);
    const polysOf = zones.map((zone) =>
      (zone.geometry.type === 'Polygon' ? [zone.geometry.coordinates] : zone.geometry.coordinates));
    for (let i = 0; i < n; i++) {
      const pt = midpointOf(links[i].coords);
      const z = linkZone[i];
      const b = boxes[z];
      const inside = pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] &&
        polysOf[z].some((polygon) => pointInPolygon(pt, polygon));
      if (!inside) midpointsOutside++;
    }
  }

  const kms = zones.map((zone) => zone.targetMeters / 1000);
  return {
    zones,
    linkZone,
    stats: {
      totalKm: totalM / 1000,
      zones: Z,
      minKm: Math.min(...kms),
      maxKm: Math.max(...kms),
      inRange: kms.filter((km) => km >= opt.minKm && km <= opt.maxKm).length,
      // What the plan asked of the zones: equal shares, or equal shares and a leftover.
      leftover: plan.leftover,
      plannedKm: [...new Set(plan.targetsKm.map((km) => Math.round(km * 10) / 10))],
      units: U,
      places: seeds.length,
      named: zones.filter((zone) => zone.props.places.length).length,
      parentAreaSqm: Math.round(geometryAreaSqm(area.geometry)),
      zonesAreaSqm: zones.reduce((s, zone) => s + zone.areaSqm, 0),
      midpointsOutside,
    },
  };
}

module.exports = {
  DEFAULTS,
  KIND_RANK,
  resolveOptions,
  zonePlan,
  shouldSplit,
  splitArea,
  geometryAreaSqm,
};
