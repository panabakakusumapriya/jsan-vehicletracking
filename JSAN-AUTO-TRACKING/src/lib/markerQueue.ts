import { Directory, File, Paths } from 'expo-file-system';
import { apiDropMarker, type MapMarker } from './api';

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

function outboxFile(): File | null {
  try {
    const root = new Directory(Paths.document, ROOT_DIR_NAME);
    if (!root.exists) root.create({ intermediates: true });
    return new File(root, FILE_NAME);
  } catch {
    // No writable storage still leaves online drops working; only offline buffering is lost.
    return null;
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

export function pendingMarkerCount(): number {
  return readOutbox().length;
}

/**
 * Try to deliver everything queued. A category error is permanent (retrying a retired category
 * forever cannot succeed) and drops the entry; anything else — offline, 5xx — keeps it for the
 * next flush.
 */
export async function flushMarkerQueue(token: string): Promise<{ sent: MapMarker[]; pending: number }> {
  const list = readOutbox();
  if (list.length === 0) return { sent: [], pending: 0 };
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
  writeOutbox(keep);
  return { sent, pending: keep.length };
}
