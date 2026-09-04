import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Linking } from 'react-native';
import { useAuth } from '@/src/lib/auth';
import {
  BASEMAPS,
  DEFAULT_PREFS,
  HISTORY_OPTIONS,
  basemapUrl,
  loadMapPrefs,
  saveMapPrefs,
  type HistoryDays,
  type MapPrefs,
} from '@/src/lib/mapPrefs';
import { API_BASE_URL, IS_CUSTOM_API } from '@/src/lib/config';
import { TabBar } from '@/src/components/TabBar';
import { type MapGLHandle, type MapGLHistory, type MapGLMarkers, type MapGLTrace, type MapGLTrail, type RoadTuple } from '@/src/components/mapTypes';
import { DriverMap } from '@/src/components/DriverMap';
import {
  apiDropMarker, apiMarkerCategories, apiMyAreas, apiMyMarkers,
  type MapMarker, type MarkerCategory, type MyArea, type MyHistory,
} from '@/src/lib/api';
import { enqueueMarker, flushMarkerQueue, newClientId } from '@/src/lib/markerQueue';
import * as Location from 'expo-location';
import { decodeRouteShapeLines } from '@/src/lib/polyline';
import { getHistory, getRoads, refreshRoads, resolveTrace, type RoadsResult } from '@/src/lib/roadCache';
import * as VehicleTracker from '@/modules/vehicle-tracker';
import FontAwesome from '@expo/vector-icons/FontAwesome';

const C = {
  brand:    '#7c3aed',
  brandSoft:'#ede9fe',
  bg:       '#f7f7fb',
  surface:  '#ffffff',
  border:   '#e9ecf0',
  text:     '#0d0d12',
  muted:    '#9ca3af',
  green:    '#059669',
  greenBg:  '#ecfdf5',
  warn:     '#b45309',
  warnBg:   '#fffbeb',
  warnEdge: '#fde68a',

  /**
   * The coverage colour contract. These are duplicated inside the map engine (MapNative), which
   * needs them as layer literals. The duplication is deliberate but it is a trap: a legend that
   * disagrees with the map is worse than no legend, because the driver trusts it. If one side
   * ever changes, change both.
   */
  roadTodo:  '#dc2626', // assigned, not yet driven
  roadDone:  '#2563eb', // already covered
  roadTrace: '#059669', // the current drive
  roadHistory: '#6b7280', // earlier trips, drawn under everything
  outside:   '#f59e0b', // the current drive, outside the assigned polygon
};

/** The Layers panel cycles through the history windows; 0 is off. */
const nextHistoryDays = (d: HistoryDays): HistoryDays =>
  HISTORY_OPTIONS[(HISTORY_OPTIONS.indexOf(d) + 1) % HISTORY_OPTIONS.length];
const historyLabel = (d: HistoryDays) => (d === 0 ? 'OFF' : `${d} D`);

/**
 * Stable empty defaults, as module constants rather than `[]` literals.
 *
 * The map memoises its derived layer data on array IDENTITY - not contents, identity. A fresh
 * `[]` per render would re-derive and re-upload every layer for a map that has not changed.
 * Everything below is written to hand the map the same array back whenever nothing moved.
 */
const NO_ROADS: RoadTuple[] = [];
const NO_AREAS: MyArea[] = [];

/**
 * Ceiling on links actually handed to the map, across ALL of the driver's areas.
 *
 * The server caps one area at 20,000 links. A driver holding five areas would hand the phone's
 * GPU five times that as layer data - not a slow map, a dead one. So the same 20,000 is applied
 * to the combined set, and the overflow is reported rather than silently dropped. Areas fill in
 * the order my-areas returns them.
 */
const MAX_DRAWN_LINKS = 20000;

interface Point { lat: number; lon: number; speedKmh: number; recordedAt: string }
interface Trip {
  _id: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  distanceMeters: number;
  maxSpeedKmh: number;
  pointCount: number;
  /**
   * The Valhalla map-matching layer. /my-session returns the whole trip document, so these ride
   * along already - no extra request. They are what flips the trace from raw GPS to the snapped
   * route; see resolveTrace() in roadCache.ts, which owns that decision and the polyline6 decode.
   */
  mapMatchStatus?: string | null;
  cleanedRouteShapes?: string[] | null;
  /**
   * Assigned-network figures, written by the server after matching (see backend
   * services/linkCoverage.js). All null until then, and in/out stay null on a trip driven with no
   * polygon assigned — null means "not established", never zero.
   */
  linkCoverageStatus?: string | null;
  inAreaMeters?: number | null;
  outAreaMeters?: number | null;
  outAreaShapes?: string[] | null;
  effectiveUkmMeters?: number | null;
  ukmBasis?: 'assigned' | 'global' | null;
}

function km(m: number) {
  if (!m) return '0 km';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function fmtMarkerTime(iso: string) {
  return new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function elapsed(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function errMsg(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

export default function MapScreen() {
  const { token, user } = useAuth();
  const [trip,    setTrip]    = useState<Trip | null>(null);
  const [points,  setPoints]  = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt]   = useState<Date | null>(null);
  // The session fetch used to swallow every failure into `catch {}`, which made "the backend is
  // down" indistinguishable from "you have not driven today". Same rule as the areas error below.
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [areas,   setAreas]   = useState<MyArea[]>(NO_AREAS);
  // Distinguishes "you have no areas" from "we could not ask". Swallowing this made a failing
  // request look exactly like an empty allocation, which is a long way to chase a ghost.
  const [areasError, setAreasError] = useState<string | null>(null);

  const [roads,        setRoads]        = useState<RoadTuple[]>(NO_ROADS);
  const [roadsError,   setRoadsError]   = useState<string | null>(null);
  const [roadsNote,    setRoadsNote]    = useState<string | null>(null);
  const [roadsLoading, setRoadsLoading] = useState(false);

  const [trace,    setTrace]    = useState<MapGLTrace | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  /** The phone's own latest GPS fix, [lon, lat]. Position lives in state (deduped — identical
   *  coordinates keep their identity, so a parked phone is not a full render every 5 s);
   *  freshness lives in the ref, updated on every event without causing a render. The `vehicle`
   *  memo combines the two. */
  const [liveFix, setLiveFix] = useState<[number, number] | null>(null);
  const liveFixAtRef = useRef(0);
  /** Last native upload failure. Each event replaces the object, re-arming the 90 s expiry timer
   *  beside the listener that sets it. */
  const [uploadErr, setUploadErr] = useState<{ msg: string; at: number } | null>(null);

  /** Driver-dropped markers: categories from the admin portal, drops from this screen. */
  const [markerCats, setMarkerCats] = useState<MarkerCategory[]>([]);
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Category being POSITIONED: the picker chose the flag, now the map centre is the pin. */
  const [placing, setPlacing] = useState<MarkerCategory | null>(null);
  const [tappedMarker, setTappedMarker] = useState<MapMarker | null>(null);
  const [markerNote, setMarkerNote] = useState<string | null>(null);

  /** Live local breadcrumb of the CURRENT trip, straight from the service's fixes. */
  const [trail, setTrail] = useState<MapGLTrail>({ version: 0, line: [] });
  const trailLineRef = useRef<[number, number][]>([]);
  const trailTripRef = useRef<string | null>(null);

  /**
   * Route history: every closed trip in the chosen window, drawn grey under the current route.
   * `history` carries the figures for the summary line; `historyLines` is the decoded geometry,
   * rebuilt only when the server's version moves — decoding a month of polylines on every poll
   * would be wasted work, and handing the map a new object would re-upload megabytes.
   */
  const [history, setHistory] = useState<MyHistory | null>(null);
  const [historyLines, setHistoryLines] = useState<MapGLHistory | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyStale, setHistoryStale] = useState(false);
  const historyKeyRef = useRef<string | null>(null);
  const historyDaysRef = useRef<HistoryDays>(DEFAULT_PREFS.historyDays);

  /**
   * Map preferences, remembered per driver.
   *
   * `prefsReady` gates the map: the opening camera is applied exactly once at map creation, so
   * rendering before the saved values load would open at the default view and stay there. One
   * short wait is better than a visible jump.
   */
  const [prefs, setPrefs] = useState<MapPrefs>(DEFAULT_PREFS);
  const [prefsReady, setPrefsReady] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const mapRef = useRef<MapGLHandle>(null);
  const driverId = user?._id ?? null;

  useEffect(() => {
    let alive = true;
    loadMapPrefs(driverId).then((p) => {
      if (!alive) return;
      setPrefs(p);
      setPrefsReady(true);
    });
    return () => { alive = false; };
  }, [driverId]);

  /** Persist a preference change immediately; the map reacts to the state, not to the write. */
  const updatePrefs = useCallback(
    (patch: Partial<MapPrefs>) => {
      setPrefs((cur) => ({ ...cur, ...patch }));
      void saveMapPrefs(driverId, patch);
    },
    [driverId]
  );

  /**
   * Camera persistence. Written straight to storage WITHOUT going through React state — the
   * opening camera is read exactly once at mount, so state has nothing to react to, and a
   * per-pan setState would re-render the whole screen for a value only the disk cares about.
   */
  /** Where the camera last settled — the placement pin drops at this point. */
  const lastCameraRef = useRef<[number, number] | null>(null);

  const onCamera = useCallback(
    (center: [number, number], zoom: number) => {
      lastCameraRef.current = center;
      void saveMapPrefs(driverId, { center, zoom });
    },
    [driverId]
  );

  /**
   * Opening camera, read once. Changing it later must not re-mount the map.
   *
   * The driver's CURRENT position wins: a shift starts wherever the vehicle is, and opening on
   * the assigned polygon (or yesterday's pan) framed a place the driver may be an hour away
   * from. The polygon is still drawn — it slides into view as they approach it. Last-known
   * position is used because it answers instantly; the live dot corrects within seconds.
   */
  const [locReady, setLocReady] = useState(false);
  const startPosRef = useRef<[number, number] | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.granted) {
          const fix = await Location.getLastKnownPositionAsync();
          if (alive && fix) startPosRef.current = [fix.coords.longitude, fix.coords.latitude];
        }
      } catch { /* no position — the saved camera or auto-framing takes over */ }
      if (alive) setLocReady(true);
    })();
    return () => { alive = false; };
  }, []);

  const initialCameraRef = useRef<{ center: [number, number]; zoom: number } | null>(null);
  if (prefsReady && locReady && initialCameraRef.current === null) {
    if (startPosRef.current) {
      initialCameraRef.current = { center: startPosRef.current, zoom: 15 };
    } else if (prefs.center && prefs.zoom) {
      initialCameraRef.current = { center: prefs.center, zoom: prefs.zoom };
    }
  }

  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  /**
   * The areas list, kept in a ref as well as in state, because pull-to-refresh needs the list that
   * fetchAreas has just settled on and cannot wait for a render to observe it in state.
   */
  const areasRef    = useRef<MyArea[]>(NO_AREAS);
  const areasSigRef = useRef<string | null>(null);

  const roadsSeqRef = useRef(0);
  const roadsKeyRef = useRef<string | null>(null);
  const clippedRef  = useRef(false);
  const pendingForceKeyRef = useRef<string | null>(null);
  const traceSigRef = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /**
   * The driver's allocated areas. Fetched once on mount and on pull-to-refresh - deliberately NOT
   * on the 15 s session timer. An allocation changes when a manager changes it, so polling it
   * every 15 seconds would be pure mobile data for a value that is the same all day.
   *
   * Returns the list it settled on so the caller can act on it immediately. The identity guard
   * matters: without it, every refresh would hand MapGL a fresh array and re-mount the map.
   */
  const fetchAreas = useCallback(async (): Promise<MyArea[]> => {
    if (!token) return areasRef.current;
    try {
      const res  = await apiMyAreas(token);
      const list = res.areas ?? [];
      // updatedAt is the newest assignment stamp, which the server documents as a cache key; the
      // ids are in the signature too, because an area being released does not move updatedAt on
      // the ones that remain and would otherwise go unnoticed.
      const sig  = `${res.updatedAt ?? ''}|${list.map((a) => a.id).join(',')}`;
      setAreasError(null);
      if (sig === areasSigRef.current) return areasRef.current;
      areasSigRef.current = sig;
      const next = list.length ? list : NO_AREAS;
      areasRef.current = next;
      setAreas(next);
      return next;
    } catch (e) {
      // Non-fatal - the route still renders - but it must be visible, not silent.
      //
      // The last known allocation is KEPT here rather than cleared. Clearing it read as tidy and
      // was a real bug: setAreas(NO_AREAS) drives the roads effect into its empty-list branch,
      // which wipes `roads` - so one blipped my-areas request mid-shift blanked the map of every
      // polygon AND every red/blue street, all of which were already sitting on the device. The
      // whole point of roadCache is that losing the network does not cost the driver their map;
      // discarding the areas list here handed that loss straight back.
      //
      // The signature is kept for the same reason: a retry that returns the identical allocation
      // must be a no-op, not a new array identity, because identity is what the map keys on.
      setAreasError(errMsg(e, 'Could not load your allocated areas'));
      return areasRef.current;
    }
  }, [token]);

  /**
   * The road network for every allocated area, red/blue-flagged, via the on-device cache.
   *
   * NOT on the poll timer and never will be: one area is ~253 KB gzipped and this fleet has just
   * come off a 25 GB month. getRoads() serves from disk without touching the network for 12 h;
   * `force` (pull-to-refresh) is the only thing that revalidates sooner.
   *
   * Every area is loaded, and the result is committed once, when all of them have settled. Per-area
   * commits would each be a new `roads` identity and therefore a fresh layer rebuild - the map
   * would redraw once per area instead of once.
   */
  const loadRoads = useCallback(async (list: MyArea[], force: boolean) => {
    if (!token) return;

    const areaKey = list.map((a) => a.id).join(',');

    // A forced load is the driver saying "I just drove that street, recolour it". A non-forced load
    // for the same areas finishing afterwards answers straight out of the cache and would overwrite
    // the fresh result, making pull-to-refresh look broken. Only the identical request is skipped -
    // a changed allocation still has to load, forced request in flight or not.
    if (!force && pendingForceKeyRef.current === areaKey) return;

    const seq = ++roadsSeqRef.current;

    if (list.length === 0) {
      roadsKeyRef.current = '';
      clippedRef.current = false;
      setRoads(NO_ROADS);
      setRoadsError(null);
      setRoadsNote(null);
      setRoadsLoading(false);
      return;
    }

    setRoadsLoading(true);
    if (force) pendingForceKeyRef.current = areaKey;

    let settled: PromiseSettledResult<RoadsResult>[];
    try {
      // allSettled, not all: one area 403-ing (an assignment released mid-shift) must not blank the
      // other four. The failures are reported, the successes are drawn.
      settled = await Promise.allSettled(
        list.map((a) => (force ? refreshRoads(token, a.id) : getRoads(token, a.id)))
      );
    } finally {
      if (force && pendingForceKeyRef.current === areaKey) pendingForceKeyRef.current = null;
    }

    // A newer load started while this one was in flight, or the screen went away.
    if (!mountedRef.current || seq !== roadsSeqRef.current) return;

    const ok: RoadsResult[] = [];
    const failed: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') ok.push(r.value);
      else failed.push(`${list[i].areaCode || list[i].name}: ${errMsg(r.reason, 'request failed')}`);
    });

    /**
     * `version` is the server's own coverage cache key - it moves when, and only when, something in
     * the area changed colour. Comparing the joined versions is how a refresh that found nothing
     * new leaves the `roads` array identity alone, and so leaves the map alone, instead of
     * re-uploading the same 20,000 polylines to the GPU.
     */
    const key = ok.map((r) => `${r.data.areaId}@${r.data.version}`).join('|');
    if (key !== roadsKeyRef.current) {
      roadsKeyRef.current = key;
      const links: RoadTuple[] = [];
      let clipped = false;
      for (const r of ok) {
        for (const link of r.data.links) {
          if (links.length >= MAX_DRAWN_LINKS) { clipped = true; break; }
          links.push(link);
        }
        if (clipped) break;
      }
      clippedRef.current = clipped;
      setRoads(links.length ? links : NO_ROADS);
    }

    if (failed.length === 0) setRoadsError(null);
    else if (ok.length === 0) setRoadsError(`Roads unavailable - ${failed[0]}`);
    else setRoadsError(`Roads missing for ${failed.length} of ${list.length} areas - ${failed[0]}`);

    // Not errors, but the driver is entitled to know when what they are looking at is incomplete or
    // old - both change what "this street is still red" means.
    const notes: string[] = [];
    if (ok.some((r) => r.stale)) notes.push('offline - showing your last saved copy');
    if (clippedRef.current || ok.some((r) => r.data.truncated)) {
      notes.push(`too many roads to draw - only the first ${MAX_DRAWN_LINKS.toLocaleString()} are shown`);
    }
    setRoadsNote(notes.length ? notes.join(' / ') : null);
    setRoadsLoading(false);
  }, [token]);

  /**
   * The driver's route history, via the on-device cache. Fetched on open, on refresh, when the
   * window changes, and when the current trip finishes its server-side processing — never on the
   * 15 s poll. Days = 0 means the layer is off and nothing is held.
   */
  const loadHistory = useCallback(async (days: HistoryDays, force: boolean) => {
    if (!token || !driverId || days === 0) {
      historyKeyRef.current = null;
      setHistory(null);
      setHistoryLines(null);
      setHistoryError(null);
      setHistoryStale(false);
      return;
    }
    try {
      const r = await getHistory(token, driverId, days, { force });
      // The window may have moved while this was in flight (OFF -> 7 d -> 30 d in quick taps, or
      // the saved preference arriving after the default fired). A superseded answer is dropped
      // rather than overwriting the state the current window already set.
      if (!mountedRef.current || historyDaysRef.current !== days) return;
      setHistoryError(null);
      setHistoryStale(r.stale);
      setHistory(r.data);
      const key = `${days}:${r.data.version}`;
      if (key !== historyKeyRef.current) {
        historyKeyRef.current = key;
        const lines: [number, number][][] = [];
        for (const t of r.data.trips) for (const line of decodeRouteShapeLines(t.shapes)) lines.push(line);
        setHistoryLines({ version: key, lines });
      }
    } catch (e) {
      // The last known history stays drawn; the failure is stated, not swallowed.
      if (mountedRef.current && historyDaysRef.current === days) {
        setHistoryError(errMsg(e, 'Could not load your route history'));
      }
    }
  }, [token, driverId]);

  const fetchSession = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const res  = await fetch(`${API_BASE_URL}/api/tracking/my-session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // An unchecked !res.ok used to fall through as `{ trip: undefined }`, which rendered as the
      // "no trips found" empty state - a 401 or a 500 looked exactly like an idle driver.
      // A dead token (session superseded, or expiry) must READ as one — not as a generic
      // network hiccup the driver keeps waiting out.
      if (res.status === 401) throw new Error('Session expired — sign out and sign in again.');
      if (!res.ok) throw new Error(`Session request failed (${res.status})`);
      const data: { trip: Trip | null; points: Point[] } = await res.json();
      setTrip(data.trip ?? null);
      setPoints(data.points ?? []);
      setUpdatedAt(new Date());
      setSessionError(null);
    } catch (e) {
      // The last known trip stays on screen - a driver mid-shift needs their route far more than
      // they need a blank map - but the failure is stated rather than swallowed.
      setSessionError(errMsg(e, 'Could not refresh your session'));
    }
    finally { setLoading(false); setRefreshing(false); }
  }, [token]);

  useEffect(() => {
    fetchSession();
    fetchAreas();
    timerRef.current = setInterval(() => fetchSession(true), 15_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fetchSession, fetchAreas]);

  /**
   * Roads follow the areas list. Kept separate from the areas fetch so first paint does not wait on
   * them: the polygons and the trace are on screen the moment my-session and my-areas answer, and
   * the (far heavier) road network fills in behind them.
   */
  useEffect(() => { loadRoads(areas, false); }, [areas, loadRoads]);

  historyDaysRef.current = prefs.historyDays;
  // Not before the saved preferences are in: firing on the default window and then again on the
  // real one would download a month a driver had switched off.
  useEffect(() => {
    if (!prefsReady) return;
    loadHistory(prefs.historyDays, false);
  }, [prefsReady, prefs.historyDays, loadHistory]);

  /**
   * The moments the server's answer actually changes, read off the session poll:
   *   - the current trip finishes map-matching, and then finishes link attribution — that is when
   *     the streets it drove turn blue and its in/out-of-area split appears, so the roads are
   *     force-refreshed rather than waiting up to 12 h;
   *   - the trip on screen is replaced (a new one started) — the old one is history now.
   * Both are transitions, not states: a key that has not moved does nothing, and the first poll
   * after mount only records where things stand.
   */
  const pipelineKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = trip
      ? `${trip._id}:${trip.status}:${trip.mapMatchStatus ?? ''}:${trip.linkCoverageStatus ?? ''}`
      : '';
    const prev = pipelineKeyRef.current;
    pipelineKeyRef.current = key;
    // No trip before (mount, or the first poll landing) and no trip after are not transitions —
    // the first session answer must not be read as "a new trip started" and cost a forced download.
    if (!prev || !key || prev === key) return;
    const [prevTrip, , prevMatch, prevLinks] = prev.split(':');
    if (prevTrip !== key.split(':')[0]) { loadHistory(historyDaysRef.current, true); return; }

    const LINKS_DONE = ['computed', 'review', 'no_network', 'failed'];
    const matchedNow = trip?.mapMatchStatus === 'matched' && prevMatch !== 'matched';
    const linksDoneNow =
      LINKS_DONE.includes(trip?.linkCoverageStatus ?? '') && !LINKS_DONE.includes(prevLinks ?? '');

    // History changes at both moments (raw squiggle -> snapped route, then the figures land). The
    // roads only change at the second: nothing turns blue until the links have been attributed,
    // and a ~250 KB re-download on the first would find the same version every time.
    if (matchedNow || linksDoneNow) loadHistory(historyDaysRef.current, true);
    if (linksDoneNow) loadRoads(areasRef.current, true);
  }, [trip, loadRoads, loadHistory]);

  /**
   * A slow revalidation for the case the poll cannot see: yesterday's trip finishing attribution
   * while today's is on screen. getHistory() only touches the network once its copy is older than
   * its own max age, so this is a check, not a download.
   */
  useEffect(() => {
    const t = setInterval(() => {
      if (historyDaysRef.current > 0) loadHistory(historyDaysRef.current, false);
    }, 10 * 60_000);
    return () => clearInterval(t);
  }, [loadHistory]);

  /**
   * The trace. resolveTrace() owns the raw-vs-snapped contract - raw GPS while driving, the
   * polyline6-decoded cleanedRouteShapes once mapMatchStatus is 'matched' - and persists whichever
   * one applies, so this screen only has to decide when to re-render.
   *
   * The signature guard is that decision: the trace object is rebuilt on every 15 s poll, and
   * handing the map a new identity re-derives the trace layer. Cheap, but pointless when the
   * trip has not moved, and a parked vehicle polls just as often as a moving one.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await resolveTrace(trip, points);
      if (cancelled || !mountedRef.current) return;
      // The out-of-area stretches are decided server-side after snapping, so they belong to the
      // snapped trace only — a live raw trace has no such thing yet.
      const outsideLines = t && t.kind === 'snapped' ? decodeRouteShapeLines(trip?.outAreaShapes) : [];
      const sig = t ? `${t.tripId}:${t.kind}:${t.count}:${outsideLines.length}` : '';
      if (sig === traceSigRef.current) return;
      traceSigRef.current = sig;
      setTrace(t ? { ...t, outsideLines } : null);
    })();
    return () => { cancelled = true; };
  }, [trip, points]);

  /**
   * The dot is the PHONE's GPS, not the server's copy of it.
   *
   * It used to be the last point of the 15 s /my-session poll, which put an upload batch, the
   * network, the database and a poll interval between the vehicle and its own dot. Whenever any
   * link stalled — upload backoff, a superseded token, no signal, or simply the trip-start gate
   * (30 m at 10 km/h) before which nothing uploads at all — the dot froze at the last uploaded
   * point while the driver kept driving. Every "stale dot" report was one of those stalls.
   *
   * The service already emits each recorded fix (and now idle fixes) as a JS event; the driver's
   * own map is exactly what those events are for. Zero extra network, zero battery: the fixes
   * exist either way.
   */
  useEffect(() => {
    const subs = [
      VehicleTracker.addLocationListener((e) => {
        if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) return;
        liveFixAtRef.current = Date.now();
        // Functional + deduped: a parked vehicle emits identical coordinates every 5-30 s, and
        // each fresh array identity would otherwise be a full screen render plus a WebView
        // injection for a dot that has not moved.
        setLiveFix((prev) => (prev && prev[0] === e.lon && prev[1] === e.lat ? prev : [e.lon, e.lat]));

        // Live breadcrumb: draw the road AS IT IS DRIVEN, no upload + poll round trip. Trip
        // fixes only — idle fixes would sketch the walk to the car. ~12 m gate (1e-4 deg is
        // ~11 m): tighter bloats the line, looser cuts corners. Bounded to the recent stretch;
        // the server's raw trace carries the full route within a poll or two anyway.
        if (e.tripStatus === 'active' && e.tripId) {
          if (trailTripRef.current !== e.tripId) {
            trailTripRef.current = e.tripId;
            trailLineRef.current = [];
          }
          const line = trailLineRef.current;
          const last = line[line.length - 1];
          const moved = !last
            || Math.abs(last[0] - e.lon) > 1.1e-4 || Math.abs(last[1] - e.lat) > 1.1e-4;
          if (moved) {
            line.push([e.lon, e.lat]);
            if (line.length > 600) line.splice(0, line.length - 600);
            setTrail({ version: Date.now(), line: [...line] });
          }
        }
      }),
      // Trip over: the breadcrumb's job is done — the server trace (and soon the snapped
      // route) owns the drawing from here.
      VehicleTracker.addTripEndListener(() => {
        trailTripRef.current = null;
        trailLineRef.current = [];
        setTrail({ version: Date.now(), line: [] });
      }),
      // Upload failures were only ever shown on the home screen; drivers live on this one.
      VehicleTracker.addUploadErrorListener((e) => setUploadErr({ msg: e.message, at: Date.now() })),
    ].filter(Boolean);
    return () => subs.forEach((s) => s?.remove());
  }, []);

  // The notice owns its own lifetime. Failures re-fire on every failed flush (~10-30 s), each
  // replacing the event object and re-arming this timer — the banner stays up exactly while
  // failures continue and clears itself 90 s after the last one, with no reliance on anything
  // else happening to re-render the screen.
  useEffect(() => {
    if (!uploadErr) return;
    const t = setTimeout(() => setUploadErr(null), 90_000);
    return () => clearTimeout(t);
  }, [uploadErr]);

  /** How long a native fix stays authoritative. The longest healthy emit gap is the 30 s
   *  stationary heartbeat, so 90 s of silence means the local stream is dead — service stopped,
   *  permissions revoked, or this handset is only VIEWING a trip another device is recording —
   *  and the server's copy is the better answer. */
  const LIVE_FIX_MAX_AGE_MS = 90_000;

  /** Latest usable fix as [lon, lat] - GeoJSON order, which is what the map wants (server points
   *  arrive as {lat, lon} and are flipped here; native fixes were flipped in the listener). A
   *  FRESH native fix wins — it is where this phone actually is. A stale one yields back to the
   *  server points, so a dead local stream falls back instead of pinning the dot forever; the
   *  freshness is re-read on every render, and the 15 s poll guarantees renders keep coming. */
  const vehicle = useMemo<[number, number] | null>(() => {
    const localFresh = liveFix && Date.now() - liveFixAtRef.current < LIVE_FIX_MAX_AGE_MS;
    if (localFresh) return liveFix;
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return [p.lon, p.lat];
    }
    return liveFix; // a stale local fix still beats no dot at all
  }, [liveFix, points]);

  /* ── Markers ──────────────────────────────────────────────────────────────
   * Dropped exactly where connectivity is worst — that is the point of the feature — so
   * delivery is outbox-based: try now, queue on failure, flush on the next screen open.
   * Categories come from the admin portal; the colour is the flag.
   */
  const loadMarkers = useCallback(async () => {
    if (!token) return;
    try {
      const [cats, mine] = await Promise.all([apiMarkerCategories(token), apiMyMarkers(token)]);
      setMarkerCats(cats.categories.filter((c) => c.active !== false));
      setMarkers(mine.markers);
    } catch { /* auxiliary layer — the map must not degrade over it */ }
  }, [token]);

  useEffect(() => {
    loadMarkers();
    if (token) {
      flushMarkerQueue(token)
        .then((r) => { if (r.sent.length > 0) loadMarkers(); })
        .catch(() => {});
    }
  }, [loadMarkers, token]);

  // Transient toast-like note; self-clearing so it cannot go stale.
  useEffect(() => {
    if (!markerNote) return;
    const t = setTimeout(() => setMarkerNote(null), 6000);
    return () => clearTimeout(t);
  }, [markerNote]);

  /** The actual drop, at an explicit position — placement decides WHERE, this only delivers. */
  const dropAt = useCallback(async (cat: MarkerCategory, pos: [number, number]) => {
    const pending = {
      clientId: newClientId(),
      lat: pos[1],
      lon: pos[0],
      categoryId: cat.id,
      recordedAt: new Date().toISOString(),
    };
    // On the map immediately — the driver must SEE the drop landed; delivery is separate.
    setMarkers((cur) => [
      ...cur,
      { id: pending.clientId, lat: pending.lat, lon: pending.lon, category: cat,
        driverName: user?.name ?? null, vehiclePlate: null, recordedAt: pending.recordedAt },
    ]);
    try {
      if (!token) throw new Error('no session');
      await apiDropMarker(token, pending);
      setMarkerNote(`Marker dropped: ${cat.name}`);
    } catch {
      enqueueMarker(pending);
      setMarkerNote('No signal — marker saved on this phone, it uploads automatically later.');
    }
  }, [token, user]);

  /** Colour chosen — now the driver positions the pin: the map centre IS the marker. */
  const beginPlacing = useCallback((cat: MarkerCategory) => {
    setPickerOpen(false);
    setTappedMarker(null);
    setPlacing(cat);
    // Start from where the driver IS, and seed the camera ref with the same position: the
    // confirm below reads that ref, and a programmatic recentre does not fire onCamera — so
    // without the seed, confirming untouched could drop the marker at a minutes-old pan
    // instead of under the pin the driver is looking at.
    if (liveFix && Date.now() - liveFixAtRef.current < 30_000) {
      lastCameraRef.current = liveFix;
      mapRef.current?.flyTo(liveFix, 16);
    } else {
      mapRef.current?.recenter();
    }
  }, [liveFix]);

  const confirmPlace = useCallback(async () => {
    if (!placing) return;
    const cat = placing;
    // The camera centre the driver settled on; before any pan it falls back to the opening
    // position, and failing even that, to one honest GPS reading (Expo Go first-run case).
    let pos: [number, number] | null =
      lastCameraRef.current ?? initialCameraRef.current?.center ?? null;
    if (!pos) {
      setMarkerNote('Getting GPS position…');
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        const granted = perm.granted || (await Location.requestForegroundPermissionsAsync()).granted;
        if (granted) {
          const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          pos = [fix.coords.longitude, fix.coords.latitude];
        }
      } catch { /* falls through to the message below */ }
    }
    setPlacing(null);
    if (!pos) { setMarkerNote('No GPS position yet — cannot drop a marker.'); return; }
    await dropAt(cat, pos);
  }, [placing, dropAt]);

  /** Markers in the map's layer shape; the id doubles as the tap key back into `markers`. */
  const markersLayer = useMemo<MapGLMarkers>(() => ({
    version: markers.map((m) => m.id).join(','),
    points: markers.map((m) => ({
      id: m.id, lon: m.lon, lat: m.lat, color: m.category?.color ?? '#ef4444',
    })),
  }), [markers]);

  const onMarkerTap = useCallback((id: string) => {
    const m = markers.find((x) => x.id === id);
    if (m) setTappedMarker(m);
  }, [markers]);

  /** The my-location button: land on where the phone IS, not where the map last was. */
  const goToMyLocation = useCallback(async () => {
    // Fresh native fix — instant. Otherwise one honest GPS read (the Expo Go path).
    if (liveFix && Date.now() - liveFixAtRef.current < 30_000) {
      mapRef.current?.flyTo(liveFix, 16);
      return;
    }
    try {
      const perm = await Location.getForegroundPermissionsAsync();
      const granted = perm.granted || (await Location.requestForegroundPermissionsAsync()).granted;
      if (granted) {
        const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const pos: [number, number] = [fix.coords.longitude, fix.coords.latitude];
        liveFixAtRef.current = Date.now();
        setLiveFix(pos);
        mapRef.current?.flyTo(pos, 16);
        return;
      }
    } catch { /* fall back to whatever the map already knows */ }
    mapRef.current?.recenter();
  }, [liveFix]);

  /**
   * Hand the driver off to real turn-by-turn navigation.
   *
   * This app deliberately does NOT try to be a navigation app — it shows which streets still need
   * driving. Getting to them is a solved problem, so target the device's own navigator.
   * `google.navigation:` starts guidance directly on Android; `geo:` is the cross-platform
   * fallback that at least opens a map at the point.
   */
  const navigateTo = useCallback(async (lon: number, lat: number, label?: string) => {
    const q = `${lat},${lon}`;
    const candidates = [
      `google.navigation:q=${q}`,
      `geo:${q}?q=${q}${label ? `(${encodeURIComponent(label)})` : ''}`,
      `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    ];
    for (const url of candidates) {
      try {
        if (await Linking.canOpenURL(url)) { await Linking.openURL(url); return; }
      } catch { /* try the next one */ }
    }
    setMapError('No navigation app is available on this device.');
  }, []);

  /** Where "Navigate" goes: the centre of the first allocated area. */
  const navTarget = useMemo(() => {
    const withBox = areas.find((a) => a.bbox && a.bbox.length === 4);
    if (!withBox || !withBox.bbox) return null;
    const [w, sN, e, n] = withBox.bbox;
    return { lon: (w + e) / 2, lat: (sN + n) / 2, name: withBox.name };
  }, [areas]);

  /**
   * Map controls. Deliberately an overlay on the map rather than a separate screen: a driver
   * checking their patch should not have to navigate away to change what they are looking at.
   */
  const controls = (
    <View style={s.ctrlWrap} pointerEvents="box-none">
      <View style={s.ctrlStack}>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => mapRef.current?.zoomIn()} accessibilityLabel="Zoom in">
          <Text style={s.ctrlIcon}>＋</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.ctrlBtn} onPress={() => mapRef.current?.zoomOut()} accessibilityLabel="Zoom out">
          <Text style={s.ctrlIcon}>−</Text>
        </TouchableOpacity>
        {/* THE my-location button — the standard GPS arrow, because that is the icon every
            driver's thumb already knows. The Google-Maps handoff below gets signposts instead:
            two arrow-ish buttons is how "center on me" opens another app. */}
        <TouchableOpacity style={s.ctrlBtn} onPress={goToMyLocation} accessibilityLabel="Go to my location">
          <FontAwesome name="location-arrow" size={17} color="#0f172a" />
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.ctrlBtn, s.ctrlBtnFlag]}
          onPress={() => setPickerOpen(true)}
          accessibilityLabel="Drop a marker here"
        >
          <Text style={[s.ctrlIcon, { color: '#dc2626' }]}>⚑</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.ctrlBtn, showControls && s.ctrlBtnOn]}
          onPress={() => setShowControls((v) => !v)}
          accessibilityLabel="Map layers"
        >
          <Text style={s.ctrlIcon}>☰</Text>
        </TouchableOpacity>
        {navTarget && (
          <TouchableOpacity
            style={[s.ctrlBtn, s.ctrlBtnNav]}
            onPress={() => navigateTo(navTarget.lon, navTarget.lat, navTarget.name)}
            accessibilityLabel="Navigate to my area"
          >
            <FontAwesome name="map-signs" size={16} color="#ffffff" />
          </TouchableOpacity>
        )}
      </View>

      {showControls && (
        <View style={s.panel}>
          <Text style={s.panelTitle}>Layers</Text>
          <TouchableOpacity style={s.panelRow} onPress={() => updatePrefs({ showAreas: !prefs.showAreas })}>
            <Text style={s.panelLabel}>Geofences</Text>
            <Text style={[s.panelState, prefs.showAreas && s.panelStateOn]}>{prefs.showAreas ? 'ON' : 'OFF'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.panelRow} onPress={() => updatePrefs({ showRoads: !prefs.showRoads })}>
            <Text style={s.panelLabel}>Roads</Text>
            <Text style={[s.panelState, prefs.showRoads && s.panelStateOn]}>{prefs.showRoads ? 'ON' : 'OFF'}</Text>
          </TouchableOpacity>
          {/* Cycles Off → 7 d → 30 d → 90 d. A window, not a toggle, because "everything I have ever
              driven" is megabytes on a metered plan and a month is what a driver actually asks for. */}
          <TouchableOpacity
            style={s.panelRow}
            onPress={() => updatePrefs({ historyDays: nextHistoryDays(prefs.historyDays) })}
            accessibilityLabel="Route history window"
          >
            <Text style={s.panelLabel}>History</Text>
            <Text style={[s.panelState, prefs.historyDays > 0 && s.panelStateOn]}>{historyLabel(prefs.historyDays)}</Text>
          </TouchableOpacity>

          {/* The background-map picker is hidden while there is only one style to pick. It renders
              again automatically if another is added to BASEMAPS — see src/lib/mapPrefs.ts. */}
          {BASEMAPS.length > 1 && (
            <>
              <Text style={[s.panelTitle, { marginTop: 10 }]}>Background map</Text>
              {BASEMAPS.map((b) => (
                <TouchableOpacity key={b.id} style={s.panelRow} onPress={() => updatePrefs({ basemap: b.id })}>
                  <Text style={s.panelLabel}>{b.label}</Text>
                  <Text style={[s.panelState, prefs.basemap === b.id && s.panelStateOn]}>
                    {prefs.basemap === b.id ? '●' : '○'}
                  </Text>
                </TouchableOpacity>
              ))}
            </>
          )}
        </View>
      )}
    </View>
  );

  /** Counts for the legend, and the only thing left to show if the map itself cannot be drawn. */
  const roadStats = useMemo(() => {
    let covered = 0;
    for (const r of roads) if (r[2] === 1) covered += 1;
    return { total: roads.length, covered, todo: roads.length - covered };
  }, [roads]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setMapError(null);
    fetchSession(true);
    // Areas first: if the allocation changed, the forced road load must be for the new list.
    fetchAreas().then((list) => loadRoads(list, true));
    loadHistory(historyDaysRef.current, true);
  }, [fetchSession, fetchAreas, loadRoads, loadHistory]);

  // Lifetime is owned by the expiry timer beside the listener — a non-null uploadErr is current
  // by definition when this renders.
  const uploadNotice = uploadErr?.msg ?? null;

  const notices = [
    // Which backend this build talks to, whenever it is NOT the production default. Twice now,
    // "the fix isn't working" turned out to be a client pointed at a different server than the one
    // being fixed — on the panel and again here. Cheap to show, expensive to guess.
    IS_CUSTOM_API && `Backend: ${API_BASE_URL}`,
    sessionError && `! Live session - ${sessionError}`,
    areasError   && `! Allocated areas - ${areasError}`,
    roadsError   && `! ${roadsError}`,
    uploadNotice && `! Tracking upload - ${uploadNotice}`,
    markerNote   && `Note: ${markerNote}`,
    // The map draws its own "unavailable" panel in place of itself, so this line does not repeat
    // the reason - it gives the driver the one number the map would have shown them.
    mapError     && `! Map unavailable - ${roadStats.todo.toLocaleString()} of ${roadStats.total.toLocaleString()} assigned roads still to drive.`,
    roadsNote    && `Note: ${roadsNote}`,
    prefs.historyDays > 0 && historyError && `! Route history - ${historyError}`,
    prefs.historyDays > 0 && historyStale && !historyError && 'Note: route history is your last saved copy',
    prefs.historyDays > 0 && history?.truncated && `Note: only the most recent trips are drawn - ${history.days} days of routes is too much to show in full`,
  ].filter((n): n is string => Boolean(n));

  const banner = notices.length > 0 ? (
    <View style={s.banner}>
      {notices.map((n) => <Text key={n} style={s.bannerText} numberOfLines={2}>{n}</Text>)}
    </View>
  ) : null;

  /**
   * Coverage legend. The colours are the whole point of the screen - a driver looking at a city of
   * red and blue lines needs one line of text saying which is which, and the counts turn it into a
   * progress indicator for the shift.
   *
   * This replaced the old speed legend (green/amber/red by km/h), which is now actively wrong: the
   * trace is one colour, and red no longer means "fast", it means "not driven yet".
   */
  const legend = (
    <View style={s.legend}>
      <View style={s.legendItem}>
        <View style={[s.legendDot, { backgroundColor: C.roadTodo }]} />
        <Text style={s.legendText}>To drive{roadStats.total ? ` ${roadStats.todo.toLocaleString()}` : ''}</Text>
      </View>
      <View style={s.legendItem}>
        <View style={[s.legendDot, { backgroundColor: C.roadDone }]} />
        <Text style={s.legendText}>Covered{roadStats.total ? ` ${roadStats.covered.toLocaleString()}` : ''}</Text>
      </View>
      <View style={s.legendItem}>
        <View style={[s.legendDot, { backgroundColor: C.roadTrace }]} />
        <Text style={s.legendText}>Your route</Text>
      </View>
      {(trace?.outsideLines?.length ?? 0) > 0 && (
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: C.outside }]} />
          <Text style={s.legendText}>Outside your area</Text>
        </View>
      )}
      {prefs.historyDays > 0 && (
        <View style={s.legendItem}>
          <View style={[s.legendDot, { backgroundColor: C.roadHistory }]} />
          <Text style={s.legendText}>Earlier trips ({prefs.historyDays} d)</Text>
        </View>
      )}
      {roadsLoading && (
        <View style={s.legendItem}>
          <ActivityIndicator size="small" color={C.muted} />
          <Text style={s.legendText}>Loading roads...</Text>
        </View>
      )}
    </View>
  );

  /**
   * ONE render path. The map is always on screen.
   *
   * This screen used to have three branches, two of which replaced the map with a card: "No trips
   * found" when there was no trip and no allocation, and "Waiting for GPS points" when a trip had
   * no drawable geometry. Both were literally true and both were the wrong thing to show — the
   * driver opened the Map tab and got no map, on a screen whose entire purpose is the map.
   *
   * Emptiness is now a NOTE OVER the map, never a replacement for it. Even with no trip, no
   * allocation and no GPS, the basemap still tells the driver where they are, and the layer and
   * basemap controls still work.
   *
   * The only thing still gated is `prefsReady`, and only because MapGL bakes the opening camera
   * into its HTML: rendering before the saved camera is read would either lose it or force a
   * visible jump. It is a local file read — milliseconds — not a network call.
   */
  if (!prefsReady || !locReady) {
    return (
      <View style={{ flex: 1 }}>
        <View style={s.center}>
          <ActivityIndicator color={C.brand} size="large" />
          <Text style={s.loadText}>Loading map…</Text>
        </View>
        <TabBar />
      </View>
    );
  }

  /** What, if anything, to say over the map. Null when there is real content to look at. */
  const hint = (() => {
    if (mapError) return null;             // MapGL draws its own failure panel; do not double up
    if (loading && !trip && areas.length === 0) return 'Loading…';
    if (trace && trace.lines.length > 0) return null;
    if (historyLines && historyLines.lines.length > 0) return null; // earlier trips are content too
    if (roads.length > 0 || areas.length > 0) {
      return trip
        ? (trip.status === 'active' ? 'Waiting for GPS…' : null)
        : null;
    }
    // Errors are the banner's job — repeating them here would say the same thing twice on one
    // screen. The hint only ever explains an EMPTY map that is working correctly.
    if (areasError) return null;
    return 'No work areas allocated to you yet';
  })();

  const badgeLive = trip?.status === 'active';

  return (
    <View style={{ flex: 1 }}>
      {/* Trip statistics, only when there is a trip to describe. */}
      {trip && (
        <View style={s.statsGrid}>
          <View style={s.statCard}><Text style={s.statV}>{points.length}</Text><Text style={s.statK}>Points</Text></View>
          <View style={s.statCard}><Text style={s.statV}>{km(trip.distanceMeters)}</Text><Text style={s.statK}>Distance</Text></View>
          <View style={s.statCard}><Text style={s.statV}>{Math.round(trip.maxSpeedKmh)} km/h</Text><Text style={s.statK}>Top speed</Text></View>
          <View style={s.statCard}><Text style={s.statV}>{elapsed(trip.startedAt)}</Text><Text style={s.statK}>Started</Text></View>
          {/* Where the driving happened — only once the server has split it, and only for a trip
              driven with a polygon assigned (no polygon: nothing to be inside of). */}
          {trip.inAreaMeters != null && (
            <>
              <View style={s.statCard}>
                <Text style={s.statV}>{km(trip.inAreaMeters)}</Text>
                <Text style={s.statK}>In your area</Text>
              </View>
              <View style={s.statCard}>
                <Text style={[s.statV, (trip.outAreaMeters ?? 0) > 0 && { color: C.warn }]}>{km(trip.outAreaMeters ?? 0)}</Text>
                <Text style={s.statK}>Outside area</Text>
              </View>
            </>
          )}
          {/* UKM is a post-trip figure; showing "pending" on a live trip would only invite the
              driver to keep checking a number that cannot move until they stop. */}
          {trip.status !== 'active' && (
            <View style={s.statCard}>
              <Text style={s.statV}>{trip.effectiveUkmMeters != null ? km(trip.effectiveUkmMeters) : '…'}</Text>
              <Text style={s.statK}>
                {trip.effectiveUkmMeters == null
                  ? 'UKM · calculating'
                  : trip.ukmBasis === 'assigned' ? 'UKM · assigned roads'
                  : trip.ukmBasis === 'global' ? 'UKM · all roads'
                  : 'UKM'}
              </Text>
            </View>
          )}
        </View>
      )}

      {/* Status strip. Always present, because it carries the refresh control — there is no pull
          gesture over a full-bleed map, so this button is the driver's only way to ask for fresh
          data. */}
      <View style={[s.liveBadge, !badgeLive && s.lastBadge]}>
        <View style={[s.liveDot, !badgeLive && s.lastDot]} />
        <Text style={[s.liveText, !badgeLive && s.lastText]} numberOfLines={1}>
          {trip
            ? badgeLive
              ? `Live session${updatedAt ? ` · updated ${elapsed(updatedAt.toISOString())}` : ''}`
              : `Last trip · ended ${trip.endedAt ? elapsed(trip.endedAt) : ''}`
            : areas.length > 0
              ? `${areas.length} area${areas.length === 1 ? '' : 's'} allocated · no trip yet`
              : 'No trip yet'}
          {trace?.kind === 'snapped' ? ' · snapped route' : ''}
        </Text>
        <TouchableOpacity onPress={onRefresh} style={{ padding: 4 }} accessibilityLabel="Refresh">
          {refreshing
            ? <ActivityIndicator size="small" color={badgeLive ? C.green : C.muted} />
            : <Text style={{ color: badgeLive ? C.green : C.muted, fontSize: 16 }}>↻</Text>}
        </TouchableOpacity>
      </View>

      {banner}
      {legend}

      {/* One line for the window: how much was driven, how much of it was new. Pending trips are
          named rather than folded in as zero — a UKM that has not been worked out yet is not 0. */}
      {prefs.historyDays > 0 && history && (
        <View style={s.historyRow}>
          <Text style={s.historyText} numberOfLines={1}>
            {`Last ${history.days} d · ${history.totals.trips} trip${history.totals.trips === 1 ? '' : 's'} · ${km(history.totals.distanceMeters)} driven · ${km(history.totals.ukmMeters)} UKM`}
            {history.totals.ukmPendingTrips ? ` (${history.totals.ukmPendingTrips} pending)` : ''}
            {history.totals.outAreaMeters > 0 ? ` · ${km(history.totals.outAreaMeters)} outside area` : ''}
          </Text>
        </View>
      )}

      {/* DriverMap — native MapLibre; Expo Go (no native module) gets a build-needed notice. */}
      <View style={s.mapWrap}>
        <DriverMap
          ref={mapRef}
          styleUrl={basemapUrl(prefs.basemap)}
          initialCamera={initialCameraRef.current}
          showAreas={prefs.showAreas}
          showRoads={prefs.showRoads}
          onCamera={onCamera}
          roads={roads}
          areas={areas}
          trace={trace}
          vehicle={vehicle}
          history={historyLines}
          showHistory={prefs.historyDays > 0}
          markers={markersLayer}
          onMarkerTap={onMarkerTap}
          trail={trail}
          onUnsupported={setMapError}
        />
        {controls}
        {hint && (
          <View style={s.hintPill} pointerEvents="none">
            <Text style={s.hintText}>{hint}</Text>
          </View>
        )}

        {/* Marker details — the reviewed popup: what, who, when, and a straight Google link. */}
        {tappedMarker && !placing && (
          <View style={s.markerCard}>
            <View style={s.markerHead}>
              <Text style={s.markerTitle}>{tappedMarker.category?.name ?? 'Marker'}</Text>
              <TouchableOpacity onPress={() => setTappedMarker(null)} accessibilityLabel="Close">
                <Text style={s.markerClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.markerMeta}>
              {[
                [tappedMarker.driverName, tappedMarker.vehiclePlate].filter(Boolean).join(' '),
                fmtMarkerTime(tappedMarker.recordedAt),
                elapsed(tappedMarker.recordedAt),
              ].filter(Boolean).join(' · ')}
            </Text>
            <TouchableOpacity
              onPress={() => Linking.openURL(
                `https://www.google.com/maps/search/?api=1&query=${tappedMarker.lat},${tappedMarker.lon}`
              )}
            >
              <Text style={s.markerLink}>Open in Google Maps ↗</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Placement mode: the pin rides the map centre — pan to position, then drop. */}
        {placing && (
          <View pointerEvents="none" style={s.placeWrap}>
            <View style={{ alignItems: 'center', transform: [{ translateY: -24 }] }}>
              <View style={[s.placeHead, { backgroundColor: placing.color }]} />
              <View style={s.placeStick} />
            </View>
          </View>
        )}
        {placing && (
          <View style={s.placeBar}>
            <Text style={s.placeText} numberOfLines={1}>
              {placing.name} — move the map, the pin marks the spot
            </Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity style={s.placeCancel} onPress={() => setPlacing(null)}>
                <Text style={s.placeCancelTxt}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.placeDrop} onPress={confirmPlace}>
                <Text style={s.placeDropTxt}>Drop marker here</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Category picker — which flag is this? Defined by admins, coloured like the dots. */}
        <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
          <TouchableOpacity style={s.sheetBackdrop} activeOpacity={1} onPress={() => setPickerOpen(false)}>
            <View style={s.sheet}>
              <Text style={s.sheetTitle}>Drop a marker here</Text>
              <Text style={s.sheetSub}>Pick the flag — then position the pin and drop it.</Text>
              {markerCats.map((c) => (
                <TouchableOpacity key={c.id} style={s.sheetRow} onPress={() => beginPlacing(c)}>
                  <View style={[s.sheetDot, { backgroundColor: c.color }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.sheetLabel}>{c.name}</Text>
                    {!!c.description && (
                      <Text style={s.sheetDesc} numberOfLines={2}>{c.description}</Text>
                    )}
                  </View>
                </TouchableOpacity>
              ))}
              {markerCats.length === 0 && (
                <Text style={s.sheetEmpty}>No marker categories defined yet — ask your manager to add them in the portal.</Text>
              )}
            </View>
          </TouchableOpacity>
        </Modal>
      </View>

      <TabBar />
    </View>
  );
}

const s = StyleSheet.create({
  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  loadText:  { marginTop: 12, color: C.muted, fontSize: 14 },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: C.bg },
  statCard:  { flexGrow: 1, flexBasis: '22%', alignItems: 'center', backgroundColor: C.surface, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 6, borderWidth: 1, borderColor: C.border },
  statV:     { fontSize: 14, fontWeight: '800', color: C.text },
  statK:     { fontSize: 9, color: C.muted, marginTop: 3, textTransform: 'uppercase', letterSpacing: 0.4 },

  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: C.greenBg, borderBottomWidth: 1, borderBottomColor: '#a7f3d0' },
  liveDot:   { width: 7, height: 7, borderRadius: 4, backgroundColor: C.green },
  liveText:  { flex: 1, fontSize: 12, color: C.green, fontWeight: '600' },
  lastBadge: { backgroundColor: '#f8fafc', borderBottomColor: '#e2e8f0' },
  lastDot:   { backgroundColor: '#94a3b8' },
  lastText:  { color: '#64748b' },

  banner:     { paddingHorizontal: 14, paddingVertical: 6, gap: 2, backgroundColor: C.warnBg, borderBottomWidth: 1, borderBottomColor: C.warnEdge },
  bannerText: { fontSize: 11, lineHeight: 15, color: C.warn },

  legend:     { flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingHorizontal: 14, paddingVertical: 6, backgroundColor: C.surface, borderBottomWidth: 1, borderBottomColor: C.border },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot:  { width: 22, height: 4, borderRadius: 2 },
  legendText: { fontSize: 11, color: C.muted },

  historyRow:  { paddingHorizontal: 14, paddingVertical: 5, backgroundColor: C.bg, borderBottomWidth: 1, borderBottomColor: C.border },
  historyText: { fontSize: 11, color: '#4b5563', fontWeight: '600' },

  mapWrap:   { flex: 1 },

  /* ---- markers ---- */
  ctrlBtnFlag: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  markerCard: {
    position: 'absolute', left: 12, right: 60, bottom: 14,
    backgroundColor: 'rgba(255,255,255,0.98)', borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: '#e2e8f0',
    shadowColor: '#0f172a', shadowOpacity: 0.2, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  markerHead:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  markerTitle: { fontSize: 14.5, fontWeight: '800', color: '#0f172a' },
  markerClose: { fontSize: 14, color: '#64748b', paddingHorizontal: 4 },
  markerMeta:  { fontSize: 12.5, color: '#64748b', marginTop: 3 },
  markerLink:  { fontSize: 13.5, color: '#2563eb', fontWeight: '700', marginTop: 8 },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#ffffff', borderTopLeftRadius: 16, borderTopRightRadius: 16,
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 28,
  },
  sheetTitle: { fontSize: 15, fontWeight: '800', color: '#0f172a' },
  sheetSub:   { fontSize: 12, color: '#64748b', marginTop: 2, marginBottom: 8 },
  sheetRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: '#f1f5f9',
  },
  sheetDot: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#ffffff',
    shadowColor: '#0f172a', shadowOpacity: 0.25, shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 }, elevation: 2,
  },
  sheetLabel: { fontSize: 14.5, color: '#0f172a', fontWeight: '700' },
  sheetDesc:  { fontSize: 11.5, color: '#64748b', marginTop: 2, lineHeight: 15 },
  sheetEmpty: { fontSize: 13, color: '#64748b', paddingVertical: 10 },

  /* ---- marker placement ---- */
  placeWrap: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  placeHead: {
    width: 26, height: 26, borderRadius: 13, borderWidth: 3, borderColor: '#ffffff',
    shadowColor: '#0f172a', shadowOpacity: 0.35, shadowRadius: 3,
    shadowOffset: { width: 0, height: 2 }, elevation: 4,
  },
  placeStick: { width: 3, height: 22, backgroundColor: '#0f172a', borderRadius: 2, opacity: 0.75 },
  placeBar: {
    position: 'absolute', left: 12, right: 60, bottom: 14,
    backgroundColor: 'rgba(255,255,255,0.98)', borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: '#e2e8f0',
    shadowColor: '#0f172a', shadowOpacity: 0.2, shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }, elevation: 4,
  },
  placeText:      { fontSize: 12.5, fontWeight: '700', color: '#0f172a' },
  placeCancel:    { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 9, backgroundColor: '#f1f5f9' },
  placeCancelTxt: { fontSize: 13, fontWeight: '700', color: '#475569' },
  placeDrop:      { flex: 2, alignItems: 'center', paddingVertical: 9, borderRadius: 9, backgroundColor: '#7c3aed' },
  placeDropTxt:   { fontSize: 13, fontWeight: '700', color: '#ffffff' },


  /* ---- map controls overlay ---- */
  ctrlWrap:  { position: 'absolute', right: 10, top: 10, bottom: 10, alignItems: 'flex-end' },
  ctrlStack: { gap: 8 },
  ctrlBtn: {
    width: 40, height: 40, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.96)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#e2e8f0',
    shadowColor: '#0f172a', shadowOpacity: 0.18, shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  ctrlBtnOn:  { backgroundColor: '#ede9fe', borderColor: '#7c3aed' },
  ctrlBtnNav: { backgroundColor: '#7c3aed', borderColor: '#5b21b6' },
  ctrlIcon:   { fontSize: 18, fontWeight: '700', color: '#0f172a' },
  panel: {
    marginTop: 8, minWidth: 178,
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0',
    paddingVertical: 8, paddingHorizontal: 10,
    shadowColor: '#0f172a', shadowOpacity: 0.2, shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 }, elevation: 5,
  },
  panelTitle: {
    fontSize: 10, fontWeight: '800', color: '#94a3b8',
    letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 4,
  },
  panelRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 7,
  },
  panelLabel:   { fontSize: 13.5, color: '#0f172a', fontWeight: '600' },
  panelState:   { fontSize: 12, fontWeight: '800', color: '#94a3b8' },
  panelStateOn: { color: '#7c3aed' },

  /* Emptiness as a note OVER the map, never instead of it. Bottom-left so it does not collide with
     the control stack on the right, and pointerEvents:none so it can never swallow a map gesture. */
  hintPill: {
    position: 'absolute', left: 10, bottom: 10,
    maxWidth: '72%',
    backgroundColor: 'rgba(15,23,42,0.82)',
    borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7,
  },
  hintText: { color: '#ffffff', fontSize: 12, fontWeight: '600' },
});
