import { Directory, File, Paths } from 'expo-file-system';
import { deserialiseCover, expireTrips, serialiseCover, type CoverStore } from './localSnap';

/**
 * Disk for the on-device coverage in localSnap.ts.
 *
 * Split out so the matcher itself stays free of Expo imports and can be run — and scored —
 * straight from Node by src/lib/__sim__/local-snap.sim.mjs.
 *
 * The guesses held here are TEMPORARY by design. Each one belongs to a trip, and leaves in one of
 * two ways:
 *   - the normal way: the server finishes that trip, the phone downloads the audited roads, and
 *     only then drops its own guess (see reconcileSettled in app/(tabs)/map.tsx). From that point
 *     the blue on the map is the server's snapped answer, cached with the roads, and that is what
 *     the driver opens to the next day.
 *   - the backstop: no verdict arrives within TTL_MS of the trip last painting anything, because
 *     the match failed and nothing retried it, or the points never reached the server.
 *
 * One file PER DRIVER, with the owner also written inside it and checked on load. A phone is
 * sometimes handed from one driver to the next; a single shared file showed the second driver the
 * first one's streets as covered.
 */

const ROOT_DIR_NAME = 'jsan-map';

/** A day and a half: long enough to outlast a slow attribution queue overnight, short enough
 *  that an unverified guess never becomes part of the furniture. */
export const COVER_TTL_MS = 36 * 60 * 60 * 1000;

function safeName(driverId: string): string {
  return driverId.replace(/[^\w-]/g, '_').slice(0, 64);
}

function storeFile(driverId: string): File | null {
  try {
    const root = new Directory(Paths.document, ROOT_DIR_NAME);
    if (!root.exists) root.create({ intermediates: true });
    return new File(root, `local-snap-${safeName(driverId)}.json`);
  } catch {
    return null;
  }
}

/** This driver's surviving guesses, already expired per trip. Null when there are none. */
export function loadCover(driverId: string | null): CoverStore | null {
  if (!driverId) return null;
  try {
    const f = storeFile(driverId);
    if (!f || !f.exists) return null;
    const store = deserialiseCover(JSON.parse(f.textSync()), driverId);
    expireTrips(store, Date.now(), COVER_TTL_MS);
    return store.byTrip.size ? store : null;
  } catch {
    // Corrupt or unreadable. The server's answer is untouched either way; at worst the map
    // repaints the last unattributed stretch red until it is driven again.
    return null;
  }
}

export function saveCover(driverId: string | null, store: CoverStore): void {
  if (!driverId) return;
  try {
    const f = storeFile(driverId);
    if (!f) return;
    if (!store.byTrip.size) {
      // Nothing left to remember — every trip was settled or expired. Leaving the file behind
      // would only give the next load something to parse and throw away.
      if (f.exists) f.delete();
      return;
    }
    if (!f.exists) f.create();
    f.write(JSON.stringify(serialiseCover(driverId, store)));
  } catch {
    /* not persisted this time — nothing downstream depends on it having worked */
  }
}
