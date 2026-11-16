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
      await apiRemoveMarker(token, key);
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
 * Put a drop's photos into the bucket: signed links from the server, then one PUT per photo straight
 * to storage, streamed from the file (never read into JS memory). Each photo's key is written back to
 * the outbox as soon as it is up, so an interrupted flush resumes where it stopped.
 *
 *   'ready'       — every photo is up (or the drop has none): send the marker.
 *   'later'       — offline, storage not set up on the server yet (503), or an upload failed: keep it.
 *   'unsupported' — a server from before photos (404): send the marker without them.
 */
async function uploadPhotos(token: string, p: PendingMarker): Promise<'ready' | 'later' | 'unsupported'> {
  const photos = (p.photos || []).filter((ph) => {
    try { return Boolean(ph.key) || new File(ph.file).exists; } catch { return false; }
  });
  if (photos.length !== (p.photos || []).length) savePhotos(p.clientId, photos);
  if (!photos.length || photos.every((ph) => ph.key)) return 'ready';
  let links: { key: string; url: string; contentType: string }[];
  try {
    links = (await apiMarkerPhotoUploads(token, p.clientId, photos.length)).uploads;
  } catch (e) {
    return (e as { status?: number }).status === 404 ? 'unsupported' : 'later';
  }
  for (let i = 0; i < photos.length; i += 1) {
    if (photos[i].key || !links[i]) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PHOTO_UPLOAD_TIMEOUT_MS);
    try {
      const res = await expoFetch(links[i].url, {
        method: 'PUT',
        headers: { 'Content-Type': links[i].contentType },
        body: new File(photos[i].file),
        signal: ctrl.signal,
      });
      if (!res.ok) return 'later';
    } catch {
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

/** A queued drop as the server takes it: local file paths stay on the phone. */
function toUpload(p: PendingMarker, withPhotos: boolean): MarkerUpload {
  const up: MarkerUpload = { lat: p.lat, lon: p.lon, categoryId: p.categoryId, clientId: p.clientId, recordedAt: p.recordedAt };
  if (p.reason) up.reason = p.reason;
  if (p.note) up.note = p.note;
  if (withPhotos) {
    const keyed = (p.photos || []).filter((ph) => ph.key);
    if (keyed.length) up.photos = keyed.map((ph) => ({ key: ph.key!, width: ph.width, height: ph.height, bytes: ph.bytes }));
  }
  return up;
}

/**
 * The drops that can go up now, photos first. A drop whose photos cannot go yet stays queued
 * (it is still drawn on the driver's map from the outbox) and is tried again on the next flush.
 */
async function readyToSend(token: string, list: PendingMarker[]): Promise<MarkerUpload[]> {
  const out: MarkerUpload[] = [];
  for (const p of list) {
    const state = await uploadPhotos(token, p);
    if (state === 'later') continue;
    const fresh = readOutbox().find((x) => x.clientId === p.clientId) || p;
    out.push(toUpload(fresh, state === 'ready'));
  }
  return out;
}

async function flushOnce(token: string): Promise<{ sent: MapMarker[]; pending: number }> {
  const queued = readOutbox();
  if (queued.length === 0) return { sent: [], pending: 0 };
  const list = await readyToSend(token, queued);
  if (list.length === 0) return { sent: [], pending: readOutbox().length };
  const sent: MapMarker[] = [];
  const done = new Set<string>();
  let batchWorks = true;
  for (let i = 0; i < list.length && batchWorks; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const r = await apiDropMarkers(token, chunk);
      for (const x of r.results || []) {
        if (x.marker) { sent.push(x.marker); done.add(x.clientId); } else if (x.permanent) done.add(x.clientId);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (/404|not found/i.test(msg)) batchWorks = false; // older server: one at a time below
      else break; // offline or 5xx: everything left stays queued for the next flush
    }
  }
  if (batchWorks) {
    // Re-read: drops made during the upload were appended meanwhile and must stay queued.
    const now = readOutbox();
    now.filter((p) => done.has(p.clientId)).forEach(forgetPhotos);
    writeOutbox(now.filter((p) => !done.has(p.clientId)));
    return { sent, pending: readOutbox().length };
  }
  return flushOneByOne(token, list);
}

async function flushOneByOne(token: string, list: MarkerUpload[]): Promise<{ sent: MapMarker[]; pending: number }> {
  const sent: MapMarker[] = [];
  const keep: MarkerUpload[] = [];
  for (const p of list) {
    try {
      const r = await apiDropMarker(token, p);
      sent.push(r.marker);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      // request() surfaces the server's error text; the only permanent one names the category.
      if (/category/i.test(msg)) continue;
      keep.push(p);
    }
  }
  // What went up leaves the outbox (photos and all); what failed, and everything not tried this
  // time (photos still waiting, drops made meanwhile), stays exactly as it was.
  const kept = new Set(keep.map((p) => p.clientId));
  const handled = new Set(list.map((p) => p.clientId).filter((id) => !kept.has(id)));
  const now = readOutbox();
  now.filter((p) => handled.has(p.clientId)).forEach(forgetPhotos);
  const left = now.filter((p) => !handled.has(p.clientId));
  writeOutbox(left);
  return { sent, pending: left.length };
}
