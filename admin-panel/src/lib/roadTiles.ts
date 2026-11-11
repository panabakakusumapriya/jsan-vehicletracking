import { offsetFrame, type RoadNet } from './roadNetwork';

/**
 * The road network cut into map tiles, each holding only what its zoom can show.
 *
 * The coverage map used to hand the GPU every road of every delivery as one buffer — 2.5 million
 * links — and draw all of it on every frame, wherever the camera was: 5 frames a second on an
 * integrated GPU, at street level as much as zoomed out to the country. Two things were wrong:
 *
 *   - zoomed IN, almost none of it is on screen, but all of it was still run through the GPU;
 *   - zoomed OUT, all of it is on screen, but a 94 m link is a hundredth of a pixel — millions of
 *     lines drawn on top of each other to colour the same few pixels.
 *
 * So the roads are served as tiles (deck.gl's TileLayer asks for the ones in view, keeps a cache
 * and shows the level it has while the next one is made). A tile at the finest level holds its
 * roads whole. A coarser tile holds what is visible at its scale: its ground is a grid of cells
 * about a pixel across, each road keeps a vertex only where it enters a new cell, and of the
 * roads that never leave one cell — or only step into the next — one per cell is kept. What is
 * drawn is the same picture to the pixel, from at most a few hundred thousand line segments.
 *
 * Links are found by tile through one sort: by the Morton code of the finest tile their middle
 * falls in, so every tile at every level is one contiguous run of that order.
 */

/** Finest tile level. From map zoom 13.5 up every road is drawn whole (tiles are 1024 px). */
export const MAX_TILE_Z = 13;
/** Tiles at or above this level answer a hover: below it one drawn line can stand for several roads. */
export const PICK_TILE_Z = 11;
/** Cells along a tile's side. A tile is 724–1448 px on screen, so a cell is 1.4–2.8 px: about the width of the line drawn (1.3–2.4 px). At half that size a city view was 39 frames a second. */
const CELLS = 512;
/** How long one slice of tile-building may hold the main thread. */
const SLICE_MS = 4;

export interface RoadPaint {
  net: RoadNet;
  /** Per link: 0 hidden, 1 still to drive, 2 driven. */
  bucketOf: Uint8Array;
  /** Per link: RGBA packed little-endian. */
  colorOf: Uint32Array;
}

export interface RoadTilePart {
  length: number;
  positions: Float32Array;
  startIndices: Uint32Array;
  colors: Uint8Array;
  /** Per drawn path: which paint (delivery) and which of its links — for the tooltip. */
  paint: Uint8Array;
  link: Uint32Array;
}

export interface RoadTileData {
  /** [lon, lat] the positions are offsets from (LNGLAT_OFFSETS, latitude bent as roadNetwork does). */
  origin: [number, number];
  todo: RoadTilePart;
  done: RoadTilePart;
  paints: RoadPaint[];
  pickable: boolean;
}

interface NetIndex {
  /** Link indices, sorted by the Morton code of their finest tile. */
  order: Uint32Array;
  /** That code, in the same order. */
  codes: Uint32Array;
}

const indexes = new WeakMap<RoadNet, NetIndex>();
const RAD = Math.PI / 180;
const UNITS = 512;

/** Spread the low 13 bits of v so there is a zero between each. */
function spread(v: number) {
  let x = v & 0x1fff;
  x = (x | (x << 8)) & 0x00ff00ff;
  x = (x | (x << 4)) & 0x0f0f0f0f;
  x = (x | (x << 2)) & 0x33333333;
  x = (x | (x << 1)) & 0x55555555;
  return x;
}
const morton = (x: number, y: number) => (spread(x) | (spread(y) << 1)) >>> 0;

/**
 * Built in slices, like the tiles: sorting one delivery is 100–350 ms, and it used to happen in
 * one piece the first time the camera reached that delivery's ground — a frozen map mid-pan.
 */
async function indexOf(net: RoadNet): Promise<NetIndex> {
  const hit = indexes.get(net);
  if (hit) return hit;
  const n = net.linkCount;
  const size = 1 << MAX_TILE_Z;
  const raw = new Uint32Array(n);
  let t0 = performance.now();
  const breathe = async (i: number) => {
    if ((i & 4095) === 0 && performance.now() - t0 > SLICE_MS) {
      await yieldToBrowser();
      t0 = performance.now();
    }
  };
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    if ((i & 4095) === 0) await breathe(i);
    const lon = net.mid[2 * i];
    const lat = Math.max(-85, Math.min(85, net.mid[2 * i + 1])) * RAD;
    const x = Math.min(size - 1, Math.max(0, Math.floor(((lon + 180) / 360) * size)));
    const y = Math.min(size - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * size)));
    raw[i] = morton(x, y);
  }
  // Radix sort, 13 bits a pass: two passes over a typed array, where a comparison sort of
  // 650,000 links would be a visible pause.
  let from = new Uint32Array(n);
  for (let i = 0; i < n; i++) from[i] = i;
  let to = new Uint32Array(n);
  for (const shift of [0, 13]) {
    const count = new Uint32Array(8193);
    for (let i = 0; i < n; i++) count[((raw[from[i]] >>> shift) & 8191) + 1] += 1;
    for (let k = 0; k < 8192; k++) count[k + 1] += count[k];
    // eslint-disable-next-line no-await-in-loop
    await breathe(0);
    for (let i = 0; i < n; i++) {
      const li = from[i];
      to[count[(raw[li] >>> shift) & 8191]++] = li;
    }
    [from, to] = [to, from];
  }
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) codes[i] = raw[from[i]];
  const made = indexes.get(net) || { order: from, codes };
  indexes.set(net, made);
  return made;
}

function lowerBound(a: Uint32Array, v: number) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** A typed array that grows — a tile's size is not known until its roads have been walked. */
class Grow<T extends Float32Array | Uint32Array | Uint8Array> {
  a: T;
  n = 0;
  constructor(private make: (n: number) => T, capacity: number) { this.a = make(capacity); }
  need(extra: number) {
    if (this.n + extra <= this.a.length) return;
    const next = this.make(Math.max(this.a.length * 2, this.n + extra));
    next.set(this.a.subarray(0, this.n) as never);
    this.a = next;
  }
  done(): T { return this.a.subarray(0, this.n) as T; }
}

class Part {
  pos = new Grow((n) => new Float32Array(n), 4096);
  col = new Grow((n) => new Uint8Array(n), 8192);
  starts = new Grow((n) => new Uint32Array(n), 1024);
  paint = new Grow((n) => new Uint8Array(n), 1024);
  link = new Grow((n) => new Uint32Array(n), 1024);
  verts = 0;
  paths = 0;
  /** One road per cell, of those that never leave it; and one per pair of neighbouring cells. */
  dot: Uint8Array | null = null;
  step: Uint8Array | null = null;
  finish(): RoadTilePart {
    this.starts.need(1);
    this.starts.a[this.starts.n++] = this.verts;
    return {
      length: this.paths,
      positions: this.pos.done(),
      startIndices: this.starts.done(),
      colors: this.col.done(),
      paint: this.paint.done(),
      link: this.link.done(),
    };
  }
}

// A macrotask, not scheduler.yield(): a yield's continuation runs ahead of rendering, so a long
// build kept its slices back to back and the map froze for the whole of it (700 ms on a zoom).
const channel = new MessageChannel();
const waiting: (() => void)[] = [];
channel.port1.onmessage = () => waiting.shift()?.();
const yieldToBrowser = () =>
  new Promise<void>((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });

/** One tile is built at a time: two at once would each take their slice out of the same frame. */
let queue: Promise<unknown> = Promise.resolve();

export function buildRoadTile(
  paints: RoadPaint[],
  index: { x: number; y: number; z: number },
  bbox: { west: number; south: number; east: number; north: number },
  signal?: AbortSignal
): Promise<RoadTileData | null> {
  const run = () => build(paints, index, bbox, signal);
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

async function build(
  paints: RoadPaint[],
  { x, y, z }: { x: number; y: number; z: number },
  bbox: { west: number; south: number; east: number; north: number },
  signal?: AbortSignal
): Promise<RoadTileData | null> {
  if (signal?.aborted || z > MAX_TILE_Z) return null;
  const shift = 2 * (MAX_TILE_Z - z);
  const lo = (morton(x, y) << shift) >>> 0;
  const span = 2 ** shift;
  const whole = z === MAX_TILE_Z;

  const origin: [number, number] = [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2];
  const out = offsetFrame(origin[1]);
  // The tile in map units (the world is 512 wide), for the cell a vertex falls in.
  const yOf = (lat: number) => (UNITS / (2 * Math.PI)) * Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
  const ySouth = yOf(bbox.south);
  const cellsPerLon = CELLS / (bbox.east - bbox.west);
  const cellsPerY = CELLS / (yOf(bbox.north) - ySouth);
  // About how many metres a cell is, to skip walking the vertices of a road too short to leave one.
  const cellMetres = (40075016 * Math.cos(origin[1] * RAD)) / 2 ** z / CELLS;

  const parts = [new Part(), new Part()];
  if (!whole) {
    for (const p of parts) {
      p.dot = new Uint8Array(CELLS * CELLS);
      p.step = new Uint8Array(CELLS * CELLS);
    }
  }

  let sliceStart = performance.now();
  for (let pi = 0; pi < paints.length; pi++) {
    const { net, bucketOf, colorOf } = paints[pi];
    // eslint-disable-next-line no-await-in-loop
    const idx = await indexOf(net);
    if (signal?.aborted) return null;
    sliceStart = performance.now();
    const first = lowerBound(idx.codes, lo);
    const end = lo + span > 0xffffffff ? idx.codes.length : lowerBound(idx.codes, lo + span);
    if (first >= end) continue;
    const src = net.positions;
    const starts = net.startIndices;
    const frame = offsetFrame(net.origin[1]);
    const lonShift = net.origin[0] - origin[0];
    const lonWest = net.origin[0] - bbox.west;
    const yShift = frame.y0 - out.y0;
    const ySouthShift = frame.y0 - ySouth;

    for (let k = first; k < end; k++) {
      if ((k & 255) === 0 && performance.now() - sliceStart > SLICE_MS) {
        // eslint-disable-next-line no-await-in-loop
        await yieldToBrowser();
        if (signal?.aborted) return null;
        sliceStart = performance.now();
      }
      const li = idx.order[k];
      const b = bucketOf[li];
      if (!b) continue;
      const part = parts[b - 1];
      const v0 = starts[li];
      const v1 = starts[li + 1];
      const n = v1 - v0;
      part.pos.need((n + 1) * 2);
      part.col.need((n + 1) * 4);
      const pos = part.pos.a;
      const wStart = part.verts;
      let w = wStart;
      // A vertex moved from the delivery's origin to the tile's (see offsetFrame).
      const put = (v: number) => {
        const d = src[2 * v + 1];
        const t = d * (frame.b + frame.a * d) + yShift;
        pos[2 * w] = src[2 * v] + lonShift;
        pos[2 * w + 1] = (2 * t) / (out.b + Math.sqrt(Math.max(0, out.b * out.b + 4 * out.a * t)));
        w += 1;
      };

      if (whole) {
        for (let v = v0; v < v1; v++) put(v);
      } else {
        const cellOf = (v: number) => {
          const d = src[2 * v + 1];
          let cx = ((src[2 * v] + lonWest) * cellsPerLon) | 0;
          let cy = ((d * (frame.b + frame.a * d) + ySouthShift) * cellsPerY) | 0;
          if (cx < 0) cx = 0; else if (cx >= CELLS) cx = CELLS - 1;
          if (cy < 0) cy = 0; else if (cy >= CELLS) cy = CELLS - 1;
          return cy * CELLS + cx;
        };
        const c0 = cellOf(v0);
        const cLast = cellOf(v1 - 1);
        let kept = 1;
        let c1 = c0;
        put(v0);
        // A road much shorter than a cell that starts and ends in one cannot have left it.
        if (!(c0 === cLast && net.lengthM[li] < cellMetres * 0.75)) {
          let prev = c0;
          for (let v = v0 + 1; v < v1; v++) {
            const c = v === v1 - 1 ? cLast : cellOf(v);
            if (c === prev) continue;
            put(v);
            prev = c;
            c1 = c;
            kept += 1;
          }
        }
        if (kept === 1) {
          // Never left its cell: one such road stands for all of them, drawn as it lies.
          if (part.dot![c0]) continue;
          part.dot![c0] = 1;
          put(v1 - 1);
        } else if (kept === 2) {
          // One step into a neighbouring cell: one road per pair of neighbours.
          const a = Math.min(c0, c1);
          const dx = (Math.max(c0, c1) % CELLS) - (a % CELLS);
          const dy = ((Math.max(c0, c1) / CELLS) | 0) - ((a / CELLS) | 0);
          if (dx >= -1 && dx <= 1 && dy >= 0 && dy <= 1) {
            const bit = 1 << (dy * 3 + dx + 1);
            if (part.step![a] & bit) continue;
            part.step![a] |= bit;
          }
        }
      }

      const col = part.col.a;
      const c = colorOf[li];
      for (let q = wStart; q < w; q++) {
        const o = q * 4;
        col[o] = c & 255;
        col[o + 1] = (c >>> 8) & 255;
        col[o + 2] = (c >>> 16) & 255;
        col[o + 3] = c >>> 24;
      }
      part.starts.need(1);
      part.paint.need(1);
      part.link.need(1);
      part.starts.a[part.starts.n++] = wStart;
      part.paint.a[part.paint.n++] = pi;
      part.link.a[part.link.n++] = li;
      part.pos.n = w * 2;
      part.col.n = w * 4;
      part.verts = w;
      part.paths += 1;
    }
  }
  if (!parts[0].paths && !parts[1].paths) return null;
  return { origin, todo: parts[0].finish(), done: parts[1].finish(), paints, pickable: z >= PICK_TILE_Z };
}
