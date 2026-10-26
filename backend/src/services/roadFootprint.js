const polygonClipping = require('polygon-clipping');
const { simplifyGeometry } = require('../utils/geo');

/**
 * The ground a road network covers, as a polygon — for a delivery that came as roads alone.
 *
 * A customer may send only the road network, with no work-area polygons (Wellington, 2026-10-26:
 * four road files, one per road class). Everything in Atlas hangs off work areas — assignment,
 * sign-off, the driver's map — so the roads need areas. This draws ONE outline round all of them;
 * the import then cuts it into zones of the size the manager asked for, exactly as "Split into
 * zones" cuts a customer polygon (workAreaSplit.js), and the zones become the areas.
 *
 * How: the roads are rasterised onto a grid of `cellM` cells. The grid is closed (grown two cells,
 * shrunk back one), which bridges the gaps between nearby streets and leaves a one-cell margin
 * round every road; holes are filled, since a park ringed by streets is still that place; and
 * diagonal-only contacts are joined, so every outline is a simple ring. The cells' outer edges are
 * traced into rings, simplified to three quarters of a cell (the staircase becomes diagonals, still
 * a quarter of a cell clear of every road) and passed through polygon-clipping, which hands back
 * valid GeoJSON — MongoDB's 2dsphere index refuses anything else.
 *
 * The outline follows the roads: ground with no road near it is not in it. A town far from the
 * rest is a piece of its own, which the zone cutter then treats as such.
 *
 * Pure: no database, no clock. Deterministic for the same roads.
 */

const M_PER_DEG = 111194.92664455873;
const DEFAULTS = {
  /** Grid cell, metres. Coarsened automatically for a large extent — see maxCells, maxVertices. */
  cellM: 250,
  /** Grid size cap: 6M cells is 6 MB per pass. */
  maxCells: 6e6,
  /** Outline size cap; the WorkArea document holds the geometry twice (full and outline). */
  maxVertices: 60000,
};

/**
 * Collects roads, then draws their footprint.
 *   const fp = createFootprint([w, s, e, n]);
 *   for each link: fp.addLine(coords);
 *   const { geometry, pieces, cellM } = fp.finish();
 */
function createFootprint(bbox, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const [w0, s0, e0, n0] = bbox;
  const midLat = (s0 + n0) / 2;
  const cos = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  const widthM = Math.max(1, (e0 - w0) * M_PER_DEG * cos);
  const heightM = Math.max(1, (n0 - s0) * M_PER_DEG);
  let cellM = opt.cellM;
  // Room for the margin: the closing grows the roads two cells, so leave a few on every side.
  const PAD = 4;
  const sizeFor = (c) => (Math.ceil(widthM / c) + 2 * PAD) * (Math.ceil(heightM / c) + 2 * PAD);
  while (sizeFor(cellM) > opt.maxCells) cellM *= 1.25;

  let dLon = cellM / (M_PER_DEG * cos);
  let dLat = cellM / M_PER_DEG;
  let originLon = w0 - PAD * dLon;
  let originLat = s0 - PAD * dLat;
  let cols = Math.ceil(widthM / cellM) + 2 * PAD;
  let rows = Math.ceil(heightM / cellM) + 2 * PAD;
  let roads = new Uint8Array(cols * rows);
  let lines = 0;

  const mark = (lon, lat) => {
    const x = Math.floor((lon - originLon) / dLon);
    const y = Math.floor((lat - originLat) / dLat);
    if (x >= 0 && y >= 0 && x < cols && y < rows) roads[y * cols + x] = 1;
  };

  /** Every cell a road passes through, not only those its vertices fall in. */
  function addLine(coords) {
    if (!coords || !coords.length) return;
    lines++;
    mark(coords[0][0], coords[0][1]);
    for (let i = 1; i < coords.length; i++) {
      const [ax, ay] = coords[i - 1];
      const [bx, by] = coords[i];
      const steps = Math.ceil(Math.max(Math.abs(bx - ax) / dLon, Math.abs(by - ay) / dLat) * 2);
      for (let k = 1; k <= steps; k++) mark(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
    }
  }

  /** Coarser grid, twice the cell: a cell is road when any of the four under it is. */
  function coarsen() {
    const c2 = Math.ceil(cols / 2);
    const r2 = Math.ceil(rows / 2);
    const next = new Uint8Array(c2 * r2);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) if (roads[y * cols + x]) next[(y >> 1) * c2 + (x >> 1)] = 1;
    }
    roads = next;
    cols = c2;
    rows = r2;
    cellM *= 2;
    dLon *= 2;
    dLat *= 2;
  }

  function finish() {
    if (!lines) return null;
    for (;;) {
      const out = draw();
      if (!out || out.vertices <= opt.maxVertices) return out;
      coarsen();
    }
  }

  function draw() {
    const g = close(roads, cols, rows);
    for (let pass = 0; pass < 6; pass++) {
      fillHoles(g, cols, rows);
      if (!joinDiagonals(g, cols, rows)) break;
    }
    const rings = trace(g, cols, rows).map((ring) =>
      ring.map(([x, y]) => [round7(originLon + x * dLon), round7(originLat + y * dLat)])
    );
    if (!rings.length) return null;
    const traced = { type: 'MultiPolygon', coordinates: rings.map((ring) => [ring]) };
    const simple = simplifyGeometry(traced, cellM * 0.75);
    let geometry;
    try {
      geometry = valid(simple);
    } catch {
      geometry = valid(traced); // the staircase as traced is always simple
    }
    let vertices = 0;
    for (const polygon of geometry.coordinates) for (const ring of polygon) vertices += ring.length;
    return { geometry, pieces: geometry.coordinates.length, cellM, vertices, areaSqm: areaSqm(geometry) };
  }

  return { addLine, finish, get cellM() { return cellM; } };
}

const round7 = (v) => Math.round(v * 1e7) / 1e7;

/** Union of the pieces through polygon-clipping: non-overlapping, correctly wound, closed rings. */
function valid(geometry) {
  const merged = polygonClipping.union(...geometry.coordinates.map((polygon) => [polygon]));
  return { type: 'MultiPolygon', coordinates: merged };
}

/** Grow every road cell by 2 (square), then shrink back by 1: gaps of up to ~2 cells close. */
function close(src, cols, rows) {
  return erode(dilate(src, cols, rows, 2), cols, rows, 1);
}

/** Square dilation, separable: rows then columns, a running count over the window. */
function dilate(src, cols, rows, r) {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < rows; y++) {
    const o = y * cols;
    let count = 0;
    for (let x = 0; x < Math.min(cols, r); x++) count += src[o + x];
    for (let x = 0; x < cols; x++) {
      if (x + r < cols) count += src[o + x + r];
      if (x - r - 1 >= 0) count -= src[o + x - r - 1];
      tmp[o + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < cols; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(rows, r); y++) count += tmp[y * cols + x];
    for (let y = 0; y < rows; y++) {
      if (y + r < rows) count += tmp[(y + r) * cols + x];
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * cols + x];
      out[y * cols + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Square erosion: a cell survives when its whole window is set (outside the grid counts as empty). */
function erode(src, cols, rows, r) {
  const inv = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) inv[i] = src[i] ? 0 : 1;
  // Outside the grid is empty, so the border band erodes too.
  const grown = dilate(inv, cols, rows, r);
  const out = new Uint8Array(src.length);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const edge = x < r || y < r || x >= cols - r || y >= rows - r;
      out[i] = !grown[i] && !edge ? 1 : 0;
    }
  }
  return out;
}

/** Empty cells no path from the border reaches are holes: filled. */
function fillHoles(g, cols, rows) {
  const seen = new Uint8Array(g.length);
  const queue = new Int32Array(g.length);
  let head = 0;
  let tail = 0;
  const push = (i) => {
    if (!g[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; }
  };
  for (let x = 0; x < cols; x++) { push(x); push((rows - 1) * cols + x); }
  for (let y = 0; y < rows; y++) { push(y * cols); push(y * cols + cols - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % cols;
    if (x > 0) push(i - 1);
    if (x < cols - 1) push(i + 1);
    if (i >= cols) push(i - cols);
    if (i < g.length - cols) push(i + cols);
  }
  for (let i = 0; i < g.length; i++) if (!g[i] && !seen[i]) g[i] = 1;
}

/**
 * Two cells that touch only at a corner would make an outline that touches itself — not a valid
 * polygon. Each such corner gets one of its empty cells filled. Returns whether anything changed.
 */
function joinDiagonals(g, cols, rows) {
  let changed = false;
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const a = y * cols + x;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      if (g[a] && g[d] && !g[b] && !g[c]) { g[b] = 1; changed = true; }
      else if (g[b] && g[c] && !g[a] && !g[d]) { g[a] = 1; changed = true; }
    }
  }
  return changed;
}

/**
 * The outer edges of the set cells, chained into closed rings of grid corners, anticlockwise
 * (GeoJSON's outer-ring order), with straight runs collapsed to their ends. After fillHoles and
 * joinDiagonals every ring is the simple outline of one piece.
 */
function trace(g, cols, rows) {
  const W = cols + 1;
  const next = new Map(); // corner -> next corner along an edge with the piece on its left
  const at = (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : g[y * cols + x]);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!g[y * cols + x]) continue;
      if (!at(x, y - 1)) next.set(y * W + x, y * W + x + 1); // south side, eastward
      if (!at(x + 1, y)) next.set(y * W + x + 1, (y + 1) * W + x + 1); // east side, northward
      if (!at(x, y + 1)) next.set((y + 1) * W + x + 1, (y + 1) * W + x); // north side, westward
      if (!at(x - 1, y)) next.set((y + 1) * W + x, y * W + x); // west side, southward
    }
  }
  const rings = [];
  for (const start of [...next.keys()].sort((p, q) => p - q)) {
    if (!next.has(start)) continue;
    const ring = [];
    let corner = start;
    do {
      ring.push([corner % W, Math.floor(corner / W)]);
      const to = next.get(corner);
      next.delete(corner);
      corner = to;
    } while (corner !== start && corner !== undefined);
    if (ring.length < 4) continue;
    const kept = ring.filter((p, i) => {
      const prev = ring[(i - 1 + ring.length) % ring.length];
      const nxt = ring[(i + 1) % ring.length];
      return !((prev[0] === p[0] && p[0] === nxt[0]) || (prev[1] === p[1] && p[1] === nxt[1]));
    });
    kept.push(kept[0].slice());
    rings.push(kept);
  }
  return rings;
}

/** Area of a lon/lat MultiPolygon in square metres (equirectangular per ring; fine at city scale). */
function areaSqm(geometry) {
  let total = 0;
  for (const polygon of geometry.coordinates) {
    polygon.forEach((ring, k) => {
      const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
      const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
      let a = 0;
      for (let i = 1; i < ring.length; i++) a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
      total += (k === 0 ? 1 : -1) * Math.abs(a / 2) * kx * M_PER_DEG;
    });
  }
  return total;
}

module.exports = { createFootprint, DEFAULTS };
