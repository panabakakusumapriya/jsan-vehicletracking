import { Directory, File, Paths } from 'expo-file-system';
import { apiDropMarker, apiDropMarkers, apiRemoveMarker, type MapMarker } from './api';

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
};

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
  writeOutbox(readOutbox().filter((p) => p.clientId !== key));
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

async function flushOnce(token: string): Promise<{ sent: MapMarker[]; pending: number }> {
  const list = readOutbox();
  if (list.length === 0) return { sent: [], pending: 0 };
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
    writeOutbox(readOutbox().filter((p) => !done.has(p.clientId)));
    return { sent, pending: readOutbox().length };
  }
  return flushOneByOne(token, list);
}

async function flushOneByOne(token: string, list: PendingMarker[]): Promise<{ sent: MapMarker[]; pending: number }> {
  const sent: MapMarker[] = [];
  const keep: PendingMarker[] = [];
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
  const handled = new Set(list.map((p) => p.clientId));
  const added = readOutbox().filter((p) => !handled.has(p.clientId));
  writeOutbox([...keep, ...added]);
  return { sent, pending: keep.length + added.length };
}
