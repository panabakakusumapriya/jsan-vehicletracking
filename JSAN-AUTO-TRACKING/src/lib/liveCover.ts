import { Directory, File, Paths } from 'expo-file-system';
import type { RoadTuple } from '@/src/components/mapTypes';

/**
 * LIVE road coverage — the phone's own answer to "which streets have I driven", computed the
 * moment each GPS fix arrives instead of after the trip closes.
 *
 * The server's post-trip link attribution stays the audited truth (it decides UKM and pay);
 * this is the driver-awareness layer over it: a street flips blue AS it is driven, because a
 * driver deciding "do I take this red street" needs the answer now, not at end of shift.
 *
 * Mechanics: the assigned network's uncovered links are grid-indexed once per roads version
 * (~220 m cells). Every recorded fix queries its 3×3 neighbourhood and marks any link whose
 * nearest segment is within HIT_M. Planar point-to-segment maths — at 25 m tolerance the
 * spherical error is noise.
 *
 * Persisted per roads-version so an app restart mid-shift does not paint the morning red
 * again; a new roads version from the server (post-trip attribution) starts a fresh set.
 */

const CELL = 0.002; // degrees, ~220 m
const HIT_M = 25;
const MAX_PERSISTED_IDS = 30000;
const PERSIST_TTL_MS = 24 * 60 * 60 * 1000;

type Seg = { id: string; ax: number; ay: number; bx: number; by: number };
export type RoadIndex = { cells: Map<string, number[]>; segs: Seg[] };

export function buildRoadIndex(roads: RoadTuple[]): RoadIndex {
  const segs: Seg[] = [];
  const cells = new Map<string, number[]>();
  for (const r of roads) {
    if (r[2] === 1) continue; // already covered — nothing left to flip
    const coords = r[3];
    if (!coords) continue;
    for (let i = 0; i + 1 < coords.length; i++) {
      const [ax, ay] = coords[i];
      const [bx, by] = coords[i + 1];
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;
      const idx = segs.length;
      segs.push({ id: r[0], ax, ay, bx, by });
      const minX = Math.floor(Math.min(ax, bx) / CELL);
      const maxX = Math.floor(Math.max(ax, bx) / CELL);
      const minY = Math.floor(Math.min(ay, by) / CELL);
      const maxY = Math.floor(Math.max(ay, by) / CELL);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
          const k = `${cx}:${cy}`;
          const arr = cells.get(k);
          if (arr) arr.push(idx);
          else cells.set(k, [idx]);
        }
      }
    }
  }
  return { cells, segs };
}

/** Cooperative variant for large assignments; yields between batches to keep first paint fluid. */
export async function buildRoadIndexAsync(
  roads: RoadTuple[],
  isCancelled: () => boolean = () => false,
): Promise<RoadIndex | null> {
  const segs: Seg[] = [];
  const cells = new Map<string, number[]>();
  const batchRoads = 250;
  for (let start = 0; start < roads.length; start += batchRoads) {
    if (isCancelled()) return null;
    const end = Math.min(roads.length, start + batchRoads);
    for (let rIndex = start; rIndex < end; rIndex++) {
      const r = roads[rIndex];
      if (r[2] === 1) continue;
      const coords = r[3];
      if (!coords) continue;
      for (let i = 0; i + 1 < coords.length; i++) {
        const [ax, ay] = coords[i];
        const [bx, by] = coords[i + 1];
        if (![ax, ay, bx, by].every(Number.isFinite)) continue;
        const idx = segs.length;
        segs.push({ id: r[0], ax, ay, bx, by });
        const minX = Math.floor(Math.min(ax, bx) / CELL);
        const maxX = Math.floor(Math.max(ax, bx) / CELL);
        const minY = Math.floor(Math.min(ay, by) / CELL);
        const maxY = Math.floor(Math.max(ay, by) / CELL);
        for (let cx = minX; cx <= maxX; cx++) for (let cy = minY; cy <= maxY; cy++) {
          const key = `${cx}:${cy}`;
          const bucket = cells.get(key);
          if (bucket) bucket.push(idx); else cells.set(key, [idx]);
        }
      }
    }
    if (end < roads.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { cells, segs };
}

function segDistM(px: number, py: number, s: Seg, mx: number, my: number): number {
  const ax = (s.ax - px) * mx, ay = (s.ay - py) * my;
  const bx = (s.bx - px) * mx, by = (s.by - py) * my;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.sqrt(qx * qx + qy * qy);
}

/** Link ids whose nearest segment lies within HIT_M of the fix. */
export function hitLinkIds(index: RoadIndex, lon: number, lat: number): string[] {
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  const my = 110540;
  const cx = Math.floor(lon / CELL);
  const cy = Math.floor(lat / CELL);
  const out: string[] = [];
  const outSet = new Set<string>();
  const seen = new Set<number>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const arr = index.cells.get(`${cx + dx}:${cy + dy}`);
      if (!arr) continue;
      for (const i of arr) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s = index.segs[i];
        if (outSet.has(s.id)) continue;
        if (segDistM(lon, lat, s, mx, my) <= HIT_M) {
          outSet.add(s.id);
          out.push(s.id);
        }
      }
    }
  }
  return out;
}

/* ── persistence: survive an app restart mid-shift ─────────────────────────── */

const ROOT_DIR_NAME = 'jsan-map';
const FILE_NAME = 'live-covered.json';

function storeFile(): File | null {
  try {
    const root = new Directory(Paths.document, ROOT_DIR_NAME);
    if (!root.exists) root.create({ intermediates: true });
    return new File(root, FILE_NAME);
  } catch {
    return null;
  }
}

export function loadLiveCovered(roadsKey: string): Set<string> {
  try {
    const f = storeFile();
    if (f && f.exists) {
      const parsed = JSON.parse(f.textSync()) as { key?: string; ts?: number; ids?: string[] };
      if (
        parsed && parsed.key === roadsKey && Array.isArray(parsed.ids) &&
        typeof parsed.ts === 'number' && Date.now() - parsed.ts < PERSIST_TTL_MS
      ) {
        return new Set(parsed.ids);
      }
    }
  } catch { /* corrupt or missing — a fresh set; the server truth is unaffected */ }
  return new Set();
}

export function saveLiveCovered(roadsKey: string, ids: Set<string>) {
  try {
    const f = storeFile();
    if (!f) return;
    if (!f.exists) f.create();
    f.write(JSON.stringify({ key: roadsKey, ts: Date.now(), ids: [...ids].slice(0, MAX_PERSISTED_IDS) }));
  } catch { /* not persisted this time — at worst a restart repaints until re-driven */ }
}
