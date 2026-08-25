import { Directory, File, Paths } from 'expo-file-system';

/**
 * Per-driver map preferences: which basemap, which layers, and where the camera was left.
 *
 * Stored per driver id rather than per device because handsets get shared between shifts — a
 * driver picking up yesterday's phone should get their own view back, not the previous driver's.
 *
 * Uses the expo-file-system v19 object API (`Paths.document` / `File`), the same as roadCache.ts.
 * The legacy `FileSystem.documentDirectory` + `writeAsStringAsync` shape was removed in v19 and
 * silently resolves to `undefined` if you reach for it.
 *
 * SecureStore was the obvious alternative and is the wrong tool: it is for secrets, it is slower,
 * and it has a ~2 KB value ceiling. These are preferences, not credentials.
 */

export type Basemap = 'liberty' | 'bright' | 'positron';

/**
 * All three are OpenFreeMap styles — the same provider the app already uses, so this adds no API
 * key, no account and no billing relationship. That constraint is deliberate: see Map3D.tsx in the
 * admin panel, which chose OpenFreeMap over Mapbox/MapTiler for exactly this reason.
 *
 * Satellite imagery is NOT offered here. Every no-key source for it (Esri World Imagery, Google
 * tiles) is licensed in a way that does not clearly permit this use, and quietly shipping tiles we
 * have no right to is not a decision to make by default.
 */
export const BASEMAPS: { id: Basemap; label: string; url: string }[] = [
  { id: 'liberty', label: 'Streets', url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'bright', label: 'Bright', url: 'https://tiles.openfreemap.org/styles/bright' },
  { id: 'positron', label: 'Muted', url: 'https://tiles.openfreemap.org/styles/positron' },
];

export const basemapUrl = (id: Basemap): string =>
  (BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0]).url;

export interface MapPrefs {
  basemap: Basemap;
  showAreas: boolean;
  showRoads: boolean;
  /** Last camera position, [lon, lat]. Undefined until the driver has moved the map once. */
  center?: [number, number];
  zoom?: number;
}

export const DEFAULT_PREFS: MapPrefs = {
  basemap: 'liberty',
  showAreas: true,
  showRoads: true,
};

const ROOT_DIR_NAME = 'jsan-map';
const FILE_NAME = (driverId: string) => `prefs-${driverId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;

/** In-memory mirror so a rapid pinch does not hit the filesystem on every frame. */
const memory = new Map<string, MapPrefs>();

function prefsFile(driverId: string): File | null {
  try {
    const root = new Directory(Paths.document, ROOT_DIR_NAME);
    if (!root.exists) root.create({ intermediates: true });
    return new File(root, FILE_NAME(driverId));
  } catch {
    // A device with no writable document directory still gets a working map, just not a
    // remembered one. Never fatal.
    return null;
  }
}

/**
 * Validate on read rather than trusting the file.
 *
 * A half-written file, a downgrade, or a hand-edited value would otherwise put a NaN zoom or a
 * garbage basemap id into the map constructor, where it fails as a blank screen rather than as an
 * obviously bad preference.
 */
function coerce(raw: unknown): MapPrefs {
  const p = (raw ?? {}) as Partial<MapPrefs>;
  const basemap = BASEMAPS.some((b) => b.id === p.basemap) ? (p.basemap as Basemap) : DEFAULT_PREFS.basemap;

  let center: [number, number] | undefined;
  if (
    Array.isArray(p.center) &&
    p.center.length === 2 &&
    Number.isFinite(p.center[0]) &&
    Number.isFinite(p.center[1]) &&
    Math.abs(p.center[0]) <= 180 &&
    Math.abs(p.center[1]) <= 90
  ) {
    center = [p.center[0], p.center[1]];
  }

  const zoom =
    typeof p.zoom === 'number' && Number.isFinite(p.zoom) && p.zoom >= 1 && p.zoom <= 22
      ? p.zoom
      : undefined;

  return {
    basemap,
    showAreas: typeof p.showAreas === 'boolean' ? p.showAreas : DEFAULT_PREFS.showAreas,
    showRoads: typeof p.showRoads === 'boolean' ? p.showRoads : DEFAULT_PREFS.showRoads,
    center,
    zoom,
  };
}

export async function loadMapPrefs(driverId: string | null | undefined): Promise<MapPrefs> {
  if (!driverId) return { ...DEFAULT_PREFS };
  const cached = memory.get(driverId);
  if (cached) return cached;

  try {
    const file = prefsFile(driverId);
    if (file && file.exists) {
      const prefs = coerce(JSON.parse(file.textSync()));
      memory.set(driverId, prefs);
      return prefs;
    }
  } catch {
    /* unreadable or corrupt — fall through to defaults rather than blocking the map */
  }
  const fresh = { ...DEFAULT_PREFS };
  memory.set(driverId, fresh);
  return fresh;
}

/**
 * Merge and persist. Returns the merged result so callers can drive state from it directly.
 *
 * Writes are fire-and-forget on purpose: losing the last camera position is a non-event, and
 * making the driver's pan gesture await a disk write is not.
 */
export async function saveMapPrefs(
  driverId: string | null | undefined,
  patch: Partial<MapPrefs>
): Promise<MapPrefs> {
  const current = await loadMapPrefs(driverId);
  const next = coerce({ ...current, ...patch });
  if (!driverId) return next;

  memory.set(driverId, next);
  try {
    const file = prefsFile(driverId);
    if (file) {
      if (!file.exists) file.create();
      file.write(JSON.stringify(next));
    }
  } catch {
    /* preference not remembered this time; the map is unaffected */
  }
  return next;
}

/** Forget one driver's preferences — used on logout so a shared handset does not leak a view. */
export async function clearMapPrefs(driverId: string | null | undefined): Promise<void> {
  if (!driverId) return;
  memory.delete(driverId);
  try {
    const file = prefsFile(driverId);
    if (file && file.exists) file.delete();
  } catch {
    /* nothing to clean up */
  }
}
