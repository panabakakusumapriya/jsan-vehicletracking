/**
 * Persistent, per-area cache of the driver's assigned road network — plus the current trip's
 * drawn trace.
 *
 * WHY THIS EXISTS AT ALL: one work area is up to 20,000 links, ~253 KB gzipped and a few MB once
 * parsed. This fleet has just come off a 25 GB month caused by a tracking bug, so re-fetching that
 * every time the map screen mounts (or worse, on the 15 s session timer) is not an option. The
 * geometry for an area is also almost entirely static — what actually changes is the
 * covered/not-covered flag, and the server signals that by handing back a different `version`. So
 * the rule is "fetch once, keep it, and only go back to the server when something asks us to".
 *
 * COORDINATE ORDER: everything geometric here is [lon, lat] — GeoJSON order, the order the
 * my-roads payload uses and the order the rest of this codebase's map layers use. The tracking
 * API's own points are {lat, lon}; that conversion boundary is kept here, at the edge, rather than
 * scattered through the screens. Leaflet wants [lat, lon], so whoever draws these flips them once
 * at the renderer — the same place LeafletMap already flips area outlines.
 *
 * NOTHING IN HERE THROWS BECAUSE OF THE FILESYSTEM. If storage is unavailable — web builds, a
 * device with no free space, a permissions oddity — every cache operation degrades to memory-only
 * and the module keeps working; the driver just pays for a re-fetch next launch. The only error
 * that escapes is a network error on a fetch that had no cached copy to fall back on.
 *
 * expo-file-system v19 NOTE: the legacy `FileSystem.documentDirectory` / `writeAsStringAsync`
 * surface is gone. Those names are still exported, but they THROW AT RUNTIME (see the module's
 * legacyWarnings.d.ts) — a v19 upgrade does not fail to compile, it fails on the device. v19 is
 * the object API: `Paths.document` / `Paths.cache` are `Directory` instances, and `File` /
 * `Directory` carry the operations as methods. `create()` must be called before `write()`. Reads
 * have async (`text()`) and sync (`textSync()`) forms; WRITES ARE SYNCHRONOUS ONLY (`write()`
 * returns void, there is no async variant), which is why the write paths below are careful about
 * how often they run — every one of them blocks the JS thread.
 */
import { Directory, File, Paths } from 'expo-file-system';

import { apiMyRoads, type MyRoads } from './api';
import { decodeRouteShapeLines } from './polyline';

// ---------------------------------------------------------------------------------------------
// Storage location
// ---------------------------------------------------------------------------------------------

const ROOT_DIR_NAME = 'road-cache';
const AREAS_DIR_NAME = 'areas';
const TRACE_FILE_NAME = 'trace.json';

/**
 * Bump to invalidate every cached file at once.
 *
 * Without it, changing the stored shape in a future release would leave old files parsing cleanly
 * into the wrong type — a silent, device-specific bug that only appears on handsets that happened
 * to hold a cache from the previous build, which is the worst kind to reproduce.
 */
const CACHE_SCHEMA = 1;

type Dirs = { root: Directory; areas: Directory };

// undefined = never probed, null = probed and unavailable (memory-only mode).
let dirs: Dirs | null | undefined;

/**
 * Lazily resolve (and create) the cache directories, once.
 *
 * Deliberately under `Paths.document`, not `Paths.cache`: the OS may purge the cache directory
 * whenever storage runs low, and a purge here costs the driver a ~253 KB re-download on mobile
 * data — precisely what this module exists to prevent. The price is a few MB of durable storage
 * per area, which is the cheaper side of that trade.
 */
function fs(): Dirs | null {
  if (dirs !== undefined) return dirs;
  try {
    const root = new Directory(Paths.document, ROOT_DIR_NAME);
    root.create({ intermediates: true, idempotent: true });
    const areas = new Directory(root, AREAS_DIR_NAME);
    areas.create({ intermediates: true, idempotent: true });
    dirs = { root, areas };
  } catch {
    // Web build, or storage we cannot touch. Memory-only from here; never fatal.
    dirs = null;
  }
  return dirs;
}

/**
 * An areaId is a Mongo ObjectId in practice, but it arrives over the network, so it is never
 * pasted into a path unfiltered — a stray `../` would write outside the cache directory. The
 * unsanitised id is also stored inside the envelope and checked on read, so the (vanishingly
 * unlikely) case of two ids sanitising to the same filename reads as a miss rather than as
 * another area's roads.
 */
function safeKey(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function deleteQuietly(target: File | Directory | null): void {
  if (!target) return;
  try {
    if (target.exists) target.delete();
  } catch {
    /* already gone, or not ours to delete */
  }
}

// ---------------------------------------------------------------------------------------------
// Area cache
// ---------------------------------------------------------------------------------------------

type AreaEnvelope = {
  schema: number;
  areaId: string;
  version: string;
  /** Epoch ms of the fetch that produced this copy — the input to the age rule. */
  fetchedAt: number;
  data: MyRoads;
};

export type RoadsSource = 'memory' | 'disk' | 'network';

export type RoadsResult = {
  data: MyRoads;
  source: RoadsSource;
  fetchedAt: number;
  /**
   * True only when this call reached the server AND the returned `version` differed from the
   * cached one — i.e. coverage in this area actually moved. Lets a screen skip rebuilding its
   * map layers (20,000 polylines) when nothing changed.
   */
  changed: boolean;
  /**
   * True when the network was tried and failed, so this is the last good copy rather than a fresh
   * one. Worth surfacing: the red/blue coverage the driver is looking at may be hours old.
   */
  stale: boolean;
};

export type GetRoadsOptions = {
  /** Treat a cached copy older than this as needing revalidation. Default 12 h. */
  maxAgeMs?: number;
  /** Skip the age check and always ask the server. */
  force?: boolean;
};

/**
 * One shift. Coverage does change during a drive — including from the driver's own driving — but
 * revalidating means re-downloading the whole area, so an *automatic* revalidation happens once
 * per shift and anything more frequent has to be a deliberate act: pull-to-refresh calling
 * refreshRoads(), not a shorter maxAgeMs sprinkled through the screens.
 */
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * When a forced refresh returns the SAME version, the bytes on disk are already correct and a
 * rewrite would only move `fetchedAt`. Writing a few MB synchronously to update a timestamp is
 * pointless flash wear, and a driver can tap pull-to-refresh as often as they like — so it is only
 * worth doing once the stored copy has aged enough for the timestamp to mean anything.
 */
const REWRITE_AFTER_MS = 60 * 60 * 1000;

/**
 * Decoded areas held in memory. Capped because each is several MB of JS arrays, and a driver with
 * a dozen allocated areas on a low-end handset would otherwise walk into an OOM. Two = the area
 * being viewed plus the one they came from; the rest stay on disk, which is fast enough.
 */
const MEMORY_LIMIT = 2;
const memory = new Map<string, AreaEnvelope>();

function remember(env: AreaEnvelope): void {
  memory.delete(env.areaId); // re-insert so Map iteration order stays least-recently-used first
  memory.set(env.areaId, env);
  while (memory.size > MEMORY_LIMIT) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

function areaFile(areaId: string): File | null {
  const d = fs();
  if (!d) return null;
  try {
    return new File(d.areas, `${safeKey(areaId)}.json`);
  } catch {
    return null;
  }
}

/**
 * Read one area's envelope from disk, or null for any reason whatsoever.
 *
 * Every failure mode collapses to "cache miss": no file, unreadable file, JSON truncated by a
 * crash or a full disk mid-write, an envelope from an older schema, a filename collision. That is
 * why the validation is as blunt as it is — writes are not atomic, and a half-written file that
 * still happens to parse would otherwise be handed to the map as a real, and wrong, road network.
 */
async function readEnvelope(areaId: string): Promise<AreaEnvelope | null> {
  const file = areaFile(areaId);
  if (!file) return null;
  try {
    if (!file.exists) return null;
    const parsed = JSON.parse(await file.text()) as AreaEnvelope;
    if (!parsed || parsed.schema !== CACHE_SCHEMA) return null;
    if (parsed.areaId !== areaId) return null;
    if (typeof parsed.version !== 'string' || typeof parsed.fetchedAt !== 'number') return null;
    if (!parsed.data || !Array.isArray(parsed.data.links)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist one area. Synchronous by necessity (v19 has no async write), hence every caller's care
 * about how rarely this runs. Silent on failure: a cache that cannot be written is not a reason to
 * fail the driver's map.
 */
function writeEnvelope(env: AreaEnvelope): void {
  const file = areaFile(env.areaId);
  if (!file) return;
  try {
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(env));
  } catch {
    /* out of space, or storage revoked — the memory copy still serves this session */
  }
}

/**
 * In-flight fetches, keyed by area.
 *
 * Two effects mounting at once, or a re-mount mid-request, must not put two ~253 KB downloads on
 * the wire for the same area. Everyone joins the first one.
 */
const inFlight = new Map<string, Promise<RoadsResult>>();

async function fetchAndStore(token: string, areaId: string): Promise<RoadsResult> {
  const cached = memory.get(areaId);
  const previous = cached ?? (await readEnvelope(areaId));
  const previousSource: RoadsSource = cached ? 'memory' : 'disk';

  try {
    const data = await apiMyRoads(token, areaId);
    // Check the shape before it reaches the cache: persisting a malformed response would leave one
    // bad deploy sitting on the device long after the server was fixed.
    if (!data || typeof data.version !== 'string' || !Array.isArray(data.links)) {
      throw new Error('Malformed my-roads response');
    }

    const now = Date.now();
    const changed = !previous || previous.version !== data.version;
    const env: AreaEnvelope = {
      schema: CACHE_SCHEMA,
      areaId,
      version: data.version,
      fetchedAt: now,
      data,
    };
    remember(env);
    if (changed || !previous || now - previous.fetchedAt > REWRITE_AFTER_MS) writeEnvelope(env);

    return { data, source: 'network', fetchedAt: now, changed, stale: false };
  } catch (err) {
    // Offline, or the backend is down. A driver mid-shift needs the roads they already have far
    // more than they need an error, so the last good copy wins and only the flag says otherwise.
    if (previous) {
      remember(previous);
      return {
        data: previous.data,
        source: previousSource,
        fetchedAt: previous.fetchedAt,
        changed: false,
        stale: true,
      };
    }
    throw err;
  }
}

/**
 * The driver's road network for one area: the cached copy if it is still good, otherwise fetched
 * and stored.
 *
 * "Still good" is age-based rather than always-revalidate because there is no cheap way to ask
 * "did the version change?" — the only endpoint that answers also sends the entire payload. A
 * caller that knows something changed (pull-to-refresh, a trip just ended) should call
 * refreshRoads() rather than shortening maxAgeMs.
 *
 * Throws only when there is no cached copy AND the network fails.
 */
export async function getRoads(
  token: string,
  areaId: string,
  opts: GetRoadsOptions = {},
): Promise<RoadsResult> {
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = Date.now();

  if (!opts.force) {
    const mem = memory.get(areaId);
    if (mem && now - mem.fetchedAt < maxAge) {
      return { data: mem.data, source: 'memory', fetchedAt: mem.fetchedAt, changed: false, stale: false };
    }
    const disk = await readEnvelope(areaId);
    if (disk) {
      // Promoted to memory either way: even when too old to serve, it is what the fetch below
      // falls back to on failure, and re-reading it from disk then would be wasted work.
      remember(disk);
      if (now - disk.fetchedAt < maxAge) {
        return { data: disk.data, source: 'disk', fetchedAt: disk.fetchedAt, changed: false, stale: false };
      }
    }
  }

  const pending = inFlight.get(areaId);
  if (pending) return pending;

  const p = fetchAndStore(token, areaId);
  inFlight.set(areaId, p);
  try {
    return await p;
  } finally {
    inFlight.delete(areaId);
  }
}

/**
 * Force a revalidation — pull-to-refresh, or after a trip ends and coverage has moved. `changed`
 * in the result tells the caller whether the map layers actually need rebuilding.
 */
export function refreshRoads(token: string, areaId: string): Promise<RoadsResult> {
  return getRoads(token, areaId, { force: true });
}

/**
 * Whatever is cached for this area, with no network call and no age check — or null.
 *
 * For the first paint: draw the roads the device already holds while getRoads() works out in the
 * background whether they are current. Reported as `stale` because nothing has been revalidated.
 * Never throws.
 */
export async function peekRoads(areaId: string): Promise<RoadsResult | null> {
  const mem = memory.get(areaId);
  if (mem) {
    return { data: mem.data, source: 'memory', fetchedAt: mem.fetchedAt, changed: false, stale: true };
  }
  const disk = await readEnvelope(areaId);
  if (!disk) return null;
  remember(disk);
  return { data: disk.data, source: 'disk', fetchedAt: disk.fetchedAt, changed: false, stale: true };
}

/** Drop one area — e.g. a manager un-assigned it, so its roads are now just wasted storage. */
export async function clearRoads(areaId: string): Promise<void> {
  memory.delete(areaId);
  deleteQuietly(areaFile(areaId));
}

/** Drop every cached area, keeping the trip trace. */
export async function clearAllRoads(): Promise<void> {
  memory.clear();
  const d = fs();
  if (!d) return;
  deleteQuietly(d.areas);
  dirs = undefined; // re-created lazily on next use
}

/**
 * Everything this module owns. Call on sign-out: the cache holds one driver's assignment data, and
 * leaving it on the device would show the next person to sign in someone else's roads and someone
 * else's route.
 */
export async function clearRoadCache(): Promise<void> {
  memory.clear();
  resetTraceState();
  const d = fs();
  if (!d) return;
  deleteQuietly(d.root);
  dirs = undefined;
}

/** Size of the on-device cache, for a data-usage or settings screen. Never throws. */
export async function roadCacheInfo(): Promise<{ available: boolean; areas: number; bytes: number }> {
  const d = fs();
  if (!d) return { available: false, areas: 0, bytes: 0 };
  try {
    let areas = 0;
    let bytes = 0;
    for (const entry of d.areas.list()) {
      if (entry instanceof File) {
        areas += 1;
        bytes += entry.size ?? 0;
      }
    }
    return { available: true, areas, bytes };
  } catch {
    return { available: true, areas: 0, bytes: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Trip trace (raw GPS while driving -> snapped route once matched)
// ---------------------------------------------------------------------------------------------

export type TraceKind = 'raw' | 'snapped';

export type TripTrace = {
  tripId: string;
  kind: TraceKind;
  /**
   * One polyline per continuous stretch, each a list of [lon, lat] pairs — NOT one flat path.
   *
   * Snapped routes arrive from the server as one encoded chunk per matched piece, and flattening
   * them welds the end of one chunk to the start of the next; where the matcher gave up on a
   * stretch, that weld is a straight line through buildings that was never driven. Raw traces
   * split on the gap markers the tracking API leaves behind for the same reason.
   */
  lines: [number, number][][];
  /** Total vertices across all lines — cheap change detection for a renderer, and the input to
   *  the write throttle below. */
  count: number;
  savedAt: number;
};

/**
 * The fields resolveTrace() needs off a /my-session trip. Loosely typed on purpose: that endpoint
 * returns the whole Mongo document and callers should not have to model all of it.
 */
export type TraceTrip = {
  _id: string;
  mapMatchStatus?: string | null;
  cleanedRouteShapes?: string[] | null;
};

/** A raw GPS point as the tracking API sends it — {lat, lon}, the opposite of this module's
 *  internal order. Converted on the way in; see the note at the top of the file. */
export type TracePoint = { lat: number; lon: number };

/**
 * One slot, not one file per trip.
 *
 * The screen only ever draws the current (or most recent) trip, and the contract says a matched
 * trip's raw trace is discarded — so a single slot makes both the bound on disk usage and the
 * discard automatic: writing the snapped version over the raw one IS the discard, and yesterday's
 * trips cannot quietly accumulate a file a day for the life of the install.
 */
let traceSlot: TripTrace | null | undefined; // undefined = not yet read from disk
let persistedTrace: { tripId: string; kind: TraceKind; count: number } | null = null;
let lastTraceWriteAt = 0;

/**
 * A live trace grows on every 15 s poll, and v19 writes are synchronous on the JS thread. Writing
 * each time would be ~1,900 blocking multi-hundred-KB writes over an eight-hour shift, for data
 * whose only job is to survive an app restart. Once a minute is plenty; memory stays current
 * regardless, and a trip changing — or finishing and becoming snapped — bypasses the throttle.
 */
const TRACE_WRITE_INTERVAL_MS = 60_000;

function resetTraceState(): void {
  traceSlot = null;
  persistedTrace = null;
  lastTraceWriteAt = 0;
}

function traceFile(): File | null {
  const d = fs();
  if (!d) return null;
  try {
    return new File(d.root, TRACE_FILE_NAME);
  } catch {
    return null;
  }
}

async function loadTraceSlot(): Promise<TripTrace | null> {
  if (traceSlot !== undefined) return traceSlot;
  traceSlot = null; // remember that we have probed, so a missing file is not re-read every poll
  const file = traceFile();
  if (!file) return null;
  try {
    if (!file.exists) return null;
    const parsed = JSON.parse(await file.text()) as TripTrace & { schema?: number };
    if (!parsed || parsed.schema !== CACHE_SCHEMA) return null;
    if (typeof parsed.tripId !== 'string' || !Array.isArray(parsed.lines)) return null;
    if (parsed.kind !== 'raw' && parsed.kind !== 'snapped') return null;
    const count = parsed.lines.reduce((n, line) => n + (Array.isArray(line) ? line.length : 0), 0);
    traceSlot = { tripId: parsed.tripId, kind: parsed.kind, lines: parsed.lines, count, savedAt: parsed.savedAt ?? 0 };
    persistedTrace = { tripId: parsed.tripId, kind: parsed.kind, count };
    return traceSlot;
  } catch {
    return null;
  }
}

function saveTraceSlot(trace: TripTrace, force = false): void {
  traceSlot = trace; // memory is always current; only the disk copy is throttled
  const now = Date.now();
  const sameShape = persistedTrace?.tripId === trace.tripId && persistedTrace?.kind === trace.kind;
  const grew = trace.count !== (persistedTrace?.count ?? -1);
  if (!force && sameShape && (!grew || now - lastTraceWriteAt < TRACE_WRITE_INTERVAL_MS)) return;

  const file = traceFile();
  if (!file) return;
  try {
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify({ schema: CACHE_SCHEMA, ...trace }));
    persistedTrace = { tripId: trace.tripId, kind: trace.kind, count: trace.count };
    lastTraceWriteAt = now;
  } catch {
    /* the memory copy still serves this session */
  }
}

/**
 * Split raw GPS points into continuous [lon, lat] lines.
 *
 * The tracking API's point arrays can carry nulls as deliberate gap markers (LeafletMap already
 * breaks its polyline on them), and a fix with a non-finite coordinate would drag the line to
 * (0, 0) in the Gulf of Guinea. Both end a line rather than being quietly skipped, because the
 * gap is real information: the driver was not there.
 */
function rawToLines(points: readonly (TracePoint | null | undefined)[]): [number, number][][] {
  const lines: [number, number][][] = [];
  let current: [number, number][] = [];
  for (const p of points) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      if (current.length > 1) lines.push(current);
      current = [];
      continue;
    }
    current.push([p.lon, p.lat]);
  }
  if (current.length > 1) lines.push(current);
  return lines;
}

/**
 * Decide which trace to draw for a trip, and keep the device's stored copy in step.
 *
 * The contract, implemented once here so no screen has to re-derive it:
 *   - while the trip is being driven, or map matching has not finished, draw the RAW GPS trace;
 *   - once mapMatchStatus is 'matched' AND cleanedRouteShapes is non-empty, draw the SNAPPED route
 *     instead and discard the cached raw version of that trip.
 *
 * Passing no raw points — a /my-session call that failed, or a cold start before it answers —
 * falls back to the stored trace for that trip, so the driver's route does not blink out of
 * existence every time the network does.
 *
 * Returns null when there is no trip, and never throws.
 */
export async function resolveTrace(
  trip: TraceTrip | null | undefined,
  rawPoints: readonly (TracePoint | null | undefined)[] = [],
): Promise<TripTrace | null> {
  if (!trip || !trip._id) return null;
  const tripId = String(trip._id);
  const shapes = trip.cleanedRouteShapes;

  if (trip.mapMatchStatus === 'matched' && Array.isArray(shapes) && shapes.length > 0) {
    // Decoding 20-odd chunks on every 15 s poll is wasted work once it is already done, and the
    // snapped route for a finished trip never changes again.
    const cached = await loadTraceSlot();
    if (cached && cached.tripId === tripId && cached.kind === 'snapped') return cached;

    const lines = decodeRouteShapeLines(shapes);
    const count = lines.reduce((n, line) => n + line.length, 0);
    if (count >= 2) {
      const trace: TripTrace = { tripId, kind: 'snapped', lines, count, savedAt: Date.now() };
      saveTraceSlot(trace, true); // forced: this write is what discards the raw copy
      return trace;
    }
    // A 'matched' trip whose shapes decode to nothing is a server-side oddity, not a reason to
    // show the driver an empty map — fall through and keep drawing raw.
  }

  if (rawPoints.length > 0) {
    const lines = rawToLines(rawPoints);
    const count = lines.reduce((n, line) => n + line.length, 0);
    // Same >= 2 guard as the snapped branch, and for a sharper reason: an undrawable trace is not
    // just useless, saving it is destructive. The slot holds ONE trip, so writing a zero-vertex raw
    // trace over a good snapped one is how a trip that had a route on screen loses it. That is a
    // reachable sequence, not a theoretical one - a re-match backfill can put mapMatchStatus back
    // to 'pending' for a trip that is already cached as snapped, and a first fix or a run of
    // gap-marked points yields no line at all. Falling through instead keeps the stored copy.
    if (count >= 2) {
      const trace: TripTrace = { tripId, kind: 'raw', lines, count, savedAt: Date.now() };
      saveTraceSlot(trace);
      return trace;
    }
  }

  const cached = await loadTraceSlot();
  return cached && cached.tripId === tripId ? cached : null;
}

/**
 * The stored trace for a trip, with no decisions and no network — for the first paint on a cold
 * start, before /my-session has answered. Null when the cache holds a different trip.
 */
export async function getCachedTrace(tripId: string): Promise<TripTrace | null> {
  const cached = await loadTraceSlot();
  return cached && cached.tripId === tripId ? cached : null;
}

/** Forget the stored trace. With a tripId, only if that is the trip currently held. */
export async function clearTrace(tripId?: string): Promise<void> {
  if (tripId) {
    const cached = await loadTraceSlot();
    if (!cached || cached.tripId !== tripId) return;
  }
  resetTraceState();
  deleteQuietly(traceFile());
}
