import { fetch as expoFetch } from 'expo/fetch';
import { Directory, File, Paths } from 'expo-file-system';
import {
  apiDropMarker, apiDropMarkers, apiMarkerPhotoUploads, apiRemoveMarker, type MapMarker, type MarkerUpload,
} from './api';

/**
 * Offline outbox for dropped markers.
 *
 * A marker is dropped precisely where connectivity is worst — that is what the feature is FOR
 * (flagging inaccessible spots) — so "no signal" must mean "saved, uploads later", never "lost".
 * File-backed like mapPrefs (expo-file-system v19 object API), one JSON array per device.
 * Delivery is retried on every map-screen open; the server dedupes by clientId, so a retry of
 * the same press can never become a second marker.
 */
export type PendingMarker = {
  clientId: string;
  lat: number;
  lon: number;
  categoryId: string;
  recordedAt: string;
  /** Why the spot was flagged (1.0.28+). */
  reason?: string;
  note?: string;
  /** Photos waiting on this phone; each gets its bucket `key` once uploaded. */
  photos?: PendingPhoto[];
  /** How many flushes have tried and failed to upload this drop's photos. */
  photoAttempts?: number;
  /**
   * The marker itself is on the server; the entry stays only for its photos, which are attached to
   * it once they are in the bucket (the server completes a drop it already has when the same
   * clientId comes again with photo keys).
   */
  sent?: boolean;
};

/** A photo of a drop, saved on the phone until it is in the bucket. */
export type PendingPhoto = { file: string; width?: number; height?: number; bytes?: number; key?: string };

const PHOTO_DIR_NAME = 'marker-photos';

function photoDir(): Directory | null {
  try {
    const dir = new Directory(Paths.document, ROOT_DIR_NAME, PHOTO_DIR_NAME);
    if (!dir.exists) dir.create({ intermediates: true });
    return dir;
  } catch {
    return null;
  }
}

/**
 * Keep a photo for a drop: copied out of the picker's cache (which Android may clear at any time)
 * into the app's own storage, where it stays until the drop is uploaded. Returns its local uri.
 */
export function keepPhoto(sourceUri: string, clientId: string, index: number): string {
  const dir = photoDir();
  if (!dir) return sourceUri;
  try {
    const dest = new File(dir, `${clientId}-${index}.jpg`);
    if (dest.exists) dest.delete();
    new File(sourceUri).copy(dest);
    return dest.uri;
  } catch {
    return sourceUri;
  }
}

/** Remove a drop's photos from the phone — once they are in the bucket, or the drop is gone. */
function forgetPhotos(p: PendingMarker | undefined) {
  for (const ph of p?.photos || []) {
    try {
      const f = new File(ph.file);
      if (f.exists) f.delete();
    } catch {
      /* already gone */
    }
  }
}

const ROOT_DIR_NAME = 'jsan-map';
const FILE_NAME = 'marker-outbox.json';
/** Markers the driver took off the map, by id or clientId, until the server has been told. */
const REMOVALS_FILE_NAME = 'marker-removals.json';

function outboxFile(name: string = FILE_NAME): File | null {
  try {
    const root = new Directory(Paths.document, ROOT_DIR_NAME);
    if (!root.exists) root.create({ intermediates: true });
    return new File(root, name);
  } catch {
    // No writable storage still leaves online drops working; only offline buffering is lost.
    return null;
  }
}

function readRemovals(): string[] {
  try {
    const f = outboxFile(REMOVALS_FILE_NAME);
    if (f && f.exists) {
      const parsed = JSON.parse(f.textSync());
      if (Array.isArray(parsed)) return parsed.filter((k) => typeof k === 'string' && k);
    }
  } catch {
    /* corrupt file = nothing waiting; at worst a removed marker shows again and can be removed again */
  }
  return [];
}

function writeRemovals(list: string[]) {
  try {
    const f = outboxFile(REMOVALS_FILE_NAME);
    if (!f) return;
    if (!f.exists) f.create();
    f.write(JSON.stringify(list));
  } catch {
    /* the next removal rewrites the whole list anyway */
  }
}

function readOutbox(): PendingMarker[] {
  try {
    const f = outboxFile();
    if (f && f.exists) {
      const parsed = JSON.parse(f.textSync());
      if (Array.isArray(parsed)) return parsed.filter((p) => p && p.clientId && p.categoryId);
    }
  } catch {
    /* corrupt file = empty outbox; markers already on the server are unaffected */
  }
  return [];
}

function writeOutbox(list: PendingMarker[]) {
  try {
    const f = outboxFile();
    if (!f) return;
    if (!f.exists) f.create();
    f.write(JSON.stringify(list));
  } catch {
    /* nothing to do — the next enqueue rewrites the whole list anyway */
  }
}

export function newClientId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function enqueueMarker(p: PendingMarker) {
  const list = readOutbox();
  if (!list.some((x) => x.clientId === p.clientId)) list.push(p);
  writeOutbox(list);
}

/** Drops still to upload plus removals still to tell the server — what the Sync tab counts. */
export function pendingMarkerCount(): number {
  return readOutbox().length + readRemovals().length;
}

/**
 * The driver took a marker off the map. `key` is its id; for a drop still waiting to upload that
 * id IS its clientId, and the drop is taken out of the outbox so it never uploads. The removal is
 * queued either way: the drop may already be on its way up (a flush in flight), and the server
 * answers a removal of something it never got with a quiet { removed: false }.
 */
export function removeMarker(key: string) {
  const outbox = readOutbox();
  forgetPhotos(outbox.find((p) => p.clientId === key));
  writeOutbox(outbox.filter((p) => p.clientId !== key));
  const list = readRemovals();
  if (!list.includes(key)) list.push(key);
  writeRemovals(list);
}

/** Keys of markers removed on this phone that the server has not confirmed yet — kept off the map. */
export function pendingRemovals(): string[] {
  return readRemovals();
}

/** The drops still waiting to upload — drawn on the driver's map so a queued marker never vanishes. */
export function pendingMarkers(): PendingMarker[] {
  return readOutbox();
}

/**
 * Try to deliver everything queued. A category error is permanent (retrying a retired category
 * forever cannot succeed) and drops the entry; anything else — offline, 5xx — keeps it for the
 * next flush.
 */
let flushing: Promise<{ sent: MapMarker[]; pending: number }> | null = null;
/** A drop or removal arrived while a flush was running: run once more when it ends. */
let again = false;

/**
 * Deliver the outbox: in batches of up to 50 (POST /api/markers/batch), one request instead of one
 * per drop. A server without the batch route (older backend) gets them one at a time. Only one
 * flush runs at once — a drop made while one is in flight waits in the outbox for the next.
 */
export function flushMarkerQueue(token: string): Promise<{ sent: MapMarker[]; pending: number }> {
  if (flushing) {
    // Something changed while a flush is running (a drop or a removal): run once more after it,
    // rather than leaving it for the next minute's flush.
    again = true;
    return flushing;
  }
  flushing = (async () => {
    let out = { sent: [] as MapMarker[], pending: 0 };
    do {
      again = false;
      // Drops first, then removals: a removal must never overtake the upload of its own drop.
      const r = await flushOnce(token);
      const left = await flushRemovals(token);
      out = { sent: [...out.sent, ...r.sent], pending: r.pending + left };
    } while (again);
    return out;
  })().finally(() => { flushing = null; });
  return flushing;
}

/**
 * Tell the server about the markers taken off the map, one request each (removals are rare). A
 * 400 is permanent (a key it can never accept), and so is a 404 — a server too old to have the
 * route: sign-out waits for this outbox to empty, so a removal that can never go through must not
 * hold it forever (the marker simply shows again on the next map load). Offline and 5xx keep the
 * removal for the next flush. Returns how many are still waiting.
 */
async function flushRemovals(token: string): Promise<number> {
  const list = readRemovals();
  if (list.length === 0) return 0;
  const done = new Set<string>();
  for (const key of list) {
    try {
      await withTimeout(apiRemoveMarker(token, key), REQUEST_TIMEOUT_MS);
      done.add(key);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 400 || status === 404) done.add(key);
      else break; // offline or 5xx: try the rest next time
    }
  }
  // Re-read: a removal made during the requests must stay queued.
  const left = readRemovals().filter((k) => !done.has(k));
  writeRemovals(left);
  return left.length;
}

/** How long one photo may take to upload before it is left for the next flush. */
const PHOTO_UPLOAD_TIMEOUT_MS = 90_000;
/**
 * How long one request to our own server may take. Without a limit, one request that never got an
 * answer (a dead mobile connection that never errors) held the flush open for good — and every
 * later flush waits on the one running, so no marker went up again until the app was restarted.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Flushes that may fail to put a drop's photos in the bucket before the photos are given up. The
 * marker itself went up long before; only its pictures are lost, never the drop.
 */
const MAX_PHOTO_ATTEMPTS = 10;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('The server did not answer in time'), { status: 0 })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * The last thing that stopped a marker or a photo going up, in words — shown on the Sync tab so a
 * stuck queue explains itself instead of just counting. Cleared when a flush delivers everything.
 */
let lastProblem: string | null = null;
export function markerSyncProblem(): string | null {
  return readOutbox().length + readRemovals().length > 0 ? lastProblem : null;
}

/**
 * Put a drop's photos into the bucket: signed links from the server, then one PUT per photo straight
 * to storage. Each photo's key is written back to the outbox as soon as it is up, so an interrupted
 * flush resumes where it stopped.
 *
 * The body is the JPEG's bytes with our own Content-Type. Handed the File object itself, expo/fetch
 * REPLACES the request's Content-Type with the type it guesses for the file — and the type is part
 * of the link's signature, so the bucket refuses any other value.
 *
 *   'ready'       — every photo is up (or the drop has none).
 *   'later'       — offline, storage not set up on the server yet (503), or an upload failed.
 *   'unsupported' — a server from before photos (404): the drop goes without them.
 */
async function uploadPhotos(token: string, p: PendingMarker): Promise<'ready' | 'later' | 'unsupported'> {
  const photos = (p.photos || []).filter((ph) => {
    try { return Boolean(ph.key) || new File(ph.file).exists; } catch { return false; }
  });
  if (photos.length !== (p.photos || []).length) savePhotos(p.clientId, photos);
  if (!photos.length || photos.every((ph) => ph.key)) return 'ready';
  let links: { key: string; url: string; contentType: string }[];
  try {
    links = (await withTimeout(apiMarkerPhotoUploads(token, p.clientId, photos.length), REQUEST_TIMEOUT_MS)).uploads;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) return 'unsupported';
    lastProblem = status === 503
      ? 'Photo storage is not set up on the server yet'
      : `Could not get a photo upload link: ${e instanceof Error ? e.message : 'unknown error'}`;
    return 'later';
  }
  for (let i = 0; i < photos.length; i += 1) {
    if (photos[i].key || !links[i]) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PHOTO_UPLOAD_TIMEOUT_MS);
    try {
      const bytes = await new File(photos[i].file).bytes();
      const res = await expoFetch(links[i].url, {
        method: 'PUT',
        headers: { 'Content-Type': links[i].contentType },
        body: bytes,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).match(/<Code>([^<]+)<\/Code>/)?.[1] ?? ''; } catch { /* no body */ }
        lastProblem = `Photo upload refused by storage (${res.status}${detail ? ` ${detail}` : ''})`;
        return 'later';
      }
    } catch (e) {
      lastProblem = `Photo upload failed: ${e instanceof Error ? e.message : 'unknown error'}`;
      return 'later';
    } finally {
      clearTimeout(timer);
    }
    photos[i] = { ...photos[i], key: links[i].key };
    savePhotos(p.clientId, photos);
  }
  return photos.every((ph) => ph.key) ? 'ready' : 'later';
}

/** Write a drop's photo list back into the outbox (re-read: drops may have been added meanwhile). */
function savePhotos(clientId: string, photos: PendingPhoto[]) {
  writeOutbox(readOutbox().map((x) => (x.clientId === clientId ? { ...x, photos } : x)));
}

const hasPhotos = (p: PendingMarker) => (p.photos || []).length > 0;
const allPhotosUp = (p: PendingMarker) => (p.photos || []).every((ph) => ph.key);

/**
 * A queued drop as the server takes it: local file paths stay on the phone. Photo keys go only when
 * EVERY photo is up — the server attaches photos to a marker that has none, once, so sending some
 * now would lose the rest.
 */
function toUpload(p: PendingMarker): MarkerUpload {
  const up: MarkerUpload = { lat: p.lat, lon: p.lon, categoryId: p.categoryId, clientId: p.clientId, recordedAt: p.recordedAt };
  if (p.reason) up.reason = p.reason;
  if (p.note) up.note = p.note;
  if (hasPhotos(p) && allPhotosUp(p)) {
    up.photos = p.photos!.map((ph) => ({ key: ph.key!, width: ph.width, height: ph.height, bytes: ph.bytes }));
  }
  return up;
}

type Delivery = { sent: MapMarker[]; delivered: Set<string>; dropped: Set<string> };

/**
 * Send drops to the server: batches of up to 50 (POST /api/markers/batch), or one at a time on a
 * server without the batch route. `delivered` is on the server; `dropped` never can be (a retired
 * category). Null when nothing reached the server (offline, 5xx, no answer) — all of it stays queued.
 */
async function sendMarkers(token: string, list: MarkerUpload[]): Promise<Delivery | null> {
  const out: Delivery = { sent: [], delivered: new Set(), dropped: new Set() };
  let reached = false;
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const r = await withTimeout(apiDropMarkers(token, chunk), REQUEST_TIMEOUT_MS);
      reached = true;
      for (const x of r.results || []) {
        if (x.marker) { out.sent.push(x.marker); out.delivered.add(x.clientId); }
        else if (x.permanent) out.dropped.add(x.clientId);
        else if (x.error) lastProblem = `Marker refused by the server: ${x.error}`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      const status = (e as { status?: number }).status;
      if (status === 404 || /404|not found/i.test(msg)) return sendOneByOne(token, list.slice(i), out, reached);
      lastProblem = `Markers could not be sent: ${msg || 'no connection'}`;
      break;
    }
  }
  return reached ? out : null;
}

async function sendOneByOne(token: string, list: MarkerUpload[], out: Delivery, reachedBefore: boolean): Promise<Delivery | null> {
  let reached = reachedBefore;
  for (const p of list) {
    try {
      const r = await withTimeout(apiDropMarker(token, p), REQUEST_TIMEOUT_MS);
      reached = true;
      out.sent.push(r.marker);
      out.delivered.add(p.clientId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      // request() surfaces the server's error text; the only permanent one names the category.
      if (/category/i.test(msg)) { out.dropped.add(p.clientId); reached = true; continue; }
      lastProblem = `Markers could not be sent: ${msg || 'no connection'}`;
      break;
    }
  }
  return reached ? out : null;
}

/** Take finished drops out of the outbox, photos and all (re-read: drops made meanwhile stay). */
function finish(clientIds: Set<string>) {
  if (!clientIds.size) return;
  const now = readOutbox();
  now.filter((p) => clientIds.has(p.clientId)).forEach(forgetPhotos);
  writeOutbox(now.filter((p) => !clientIds.has(p.clientId)));
}

/**
 * One pass over the outbox, in two steps.
 *
 *  1. Every drop not yet on the server goes up NOW, photos or not. In the first 1.0.28 build a drop
 *     waited for its photos to reach the bucket before the marker was sent at all — so when the
 *     photo upload failed, the marker never arrived, however good the signal was for trip points.
 *  2. Then the photos of drops already on the server: into the bucket, then attached to the marker
 *     (the same clientId again, now with the photo keys). Given up after MAX_PHOTO_ATTEMPTS failed
 *     flushes — the marker is safe either way.
 */
async function flushOnce(token: string): Promise<{ sent: MapMarker[]; pending: number }> {
  const sent: MapMarker[] = [];
  let problem = false;

  const unsent = readOutbox().filter((p) => !p.sent);
  if (unsent.length) {
    const r = await sendMarkers(token, unsent.map(toUpload));
    if (!r) return { sent, pending: readOutbox().length };
    sent.push(...r.sent);
    const done = new Set(r.dropped);
    const forPhotos = new Set<string>();
    for (const p of unsent) {
      if (!r.delivered.has(p.clientId)) { if (!r.dropped.has(p.clientId)) problem = true; continue; }
      // Up with all its photos (or it has none): finished. Otherwise it stays, for the photos.
      if (!hasPhotos(p) || allPhotosUp(p)) done.add(p.clientId);
      else forPhotos.add(p.clientId);
    }
    finish(done);
    if (forPhotos.size) writeOutbox(readOutbox().map((x) => (forPhotos.has(x.clientId) ? { ...x, sent: true } : x)));
  }

  for (const p of readOutbox().filter((x) => x.sent)) {
    const state = hasPhotos(p) ? await uploadPhotos(token, p) : 'unsupported';
    const fresh = readOutbox().find((x) => x.clientId === p.clientId);
    if (!fresh) continue; // taken off the map meanwhile
    if (state === 'unsupported' || !hasPhotos(fresh)) { finish(new Set([p.clientId])); continue; }
    if (state === 'ready') {
      const r = await sendMarkers(token, [toUpload(fresh)]);
      if (r && r.delivered.has(p.clientId)) {
        if (r.sent[0]) sent.push(r.sent[0]);
        finish(new Set([p.clientId]));
        continue;
      }
    }
    problem = true;
    const attempts = (fresh.photoAttempts || 0) + 1;
    if (attempts >= MAX_PHOTO_ATTEMPTS) finish(new Set([p.clientId]));
    else writeOutbox(readOutbox().map((x) => (x.clientId === p.clientId ? { ...x, photoAttempts: attempts } : x)));
  }

  const pending = readOutbox().length;
  if (!problem && pending === 0) lastProblem = null;
  return { sent, pending };
}
