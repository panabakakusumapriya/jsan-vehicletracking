import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
  basemapUrl,
  loadMapPrefs,
  saveMapPrefs,
  type MapPrefs,
} from '@/src/lib/mapPrefs';
import { API_BASE_URL, IS_CUSTOM_API } from '@/src/lib/config';
import { TabBar } from '@/src/components/TabBar';
import { MapGL, type MapGLHandle, type MapGLTrace, type RoadTuple } from '@/src/components/MapGL';
import { apiMyAreas, type MyArea } from '@/src/lib/api';
import { getRoads, refreshRoads, resolveTrace, type RoadsResult } from '@/src/lib/roadCache';

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
   * The coverage colour contract. These three are duplicated inside MapGL, which needs them as
   * literals in the style it generates for the WebView. The duplication is deliberate but it is a
   * trap: a legend that disagrees with the map is worse than no legend, because the driver trusts
   * it. If one side ever changes, change both.
   */
  roadTodo:  '#dc2626', // assigned, not yet driven
  roadDone:  '#2563eb', // already covered
  roadTrace: '#059669', // the current drive
};

/**
 * Stable empty defaults, as module constants rather than `[]` literals.
 *
 * MapGL bakes `roads` and `areas` into the WebView's HTML, so a new array IDENTITY - not new
 * contents, identity - re-mounts the WebView: it re-downloads the map engine, re-fetches tiles and
 * resets the camera. Calling setRoads([]) twice would do exactly that. Everything below is written
 * to hand MapGL the same array back whenever nothing actually changed.
 */
const NO_ROADS: RoadTuple[] = [];
const NO_AREAS: MyArea[] = [];

/**
 * Ceiling on links actually handed to the map, across ALL of the driver's areas.
 *
 * The server caps one area at 20,000 links, which MapGL measures at ~3.8 MB of generated HTML. A
 * driver holding five areas would be ~19 MB of HTML in a phone WebView, which is not a slow map,
 * it is a dead one. So the same 20,000 is applied to the combined set, and the overflow is reported
 * rather than silently dropped. Areas fill in the order my-areas returns them.
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
}

function km(m: number) {
  if (!m) return '0 km';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
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

  /**
   * Map preferences, remembered per driver.
   *
   * `prefsReady` gates the map: MapGL bakes the opening camera and basemap into its HTML, so
   * rendering before the saved values load would open at the default view and then either stay
   * wrong or re-mount to correct itself. One short wait is better than a visible jump.
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
   * opening camera is baked into MapGL's HTML, so feeding every pan back into state would
   * regenerate that HTML and reload the map underneath the driver's finger.
   */
  const onCamera = useCallback(
    (center: [number, number], zoom: number) => {
      void saveMapPrefs(driverId, { center, zoom });
    },
    [driverId]
  );

  /** Opening camera, read once. Changing it later must not re-mount the map. */
  const initialCameraRef = useRef<{ center: [number, number]; zoom: number } | null>(null);
  if (prefsReady && initialCameraRef.current === null && prefs.center && prefs.zoom) {
    initialCameraRef.current = { center: prefs.center, zoom: prefs.zoom };
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
      // must be a no-op, not a new array identity, because a new identity re-mounts the WebView.
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
   * commits would each be a new `roads` identity and therefore a full WebView re-mount - the map
   * would reload once per area instead of drawing once.
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
     * re-mounting a WebView to redraw the same 20,000 polylines.
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

  const fetchSession = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const res  = await fetch(`${API_BASE_URL}/api/tracking/my-session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // An unchecked !res.ok used to fall through as `{ trip: undefined }`, which rendered as the
      // "no trips found" empty state - a 401 or a 500 looked exactly like an idle driver.
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

  /**
   * The trace. resolveTrace() owns the raw-vs-snapped contract - raw GPS while driving, the
   * polyline6-decoded cleanedRouteShapes once mapMatchStatus is 'matched' - and persists whichever
   * one applies, so this screen only has to decide when to re-render.
   *
   * The signature guard is that decision: the trace object is rebuilt on every 15 s poll, and
   * handing MapGL a new identity re-injects the payload into the live page. Cheap, but pointless
   * when the trip has not moved, and a parked vehicle polls just as often as a moving one.
   */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await resolveTrace(trip, points);
      if (cancelled || !mountedRef.current) return;
      const sig = t ? `${t.tripId}:${t.kind}:${t.count}` : '';
      if (sig === traceSigRef.current) return;
      traceSigRef.current = sig;
      setTrace(t);
    })();
    return () => { cancelled = true; };
  }, [trip, points]);

  /** Latest usable fix as [lon, lat] - GeoJSON order, which is what MapGL wants; the tracking API
   *  hands them over as {lat, lon}, so this is the one place they get flipped. */
  const vehicle = useMemo<[number, number] | null>(() => {
    for (let i = points.length - 1; i >= 0; i--) {
      const p = points[i];
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) return [p.lon, p.lat];
    }
    return null;
  }, [points]);

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
        <TouchableOpacity style={s.ctrlBtn} onPress={() => mapRef.current?.recenter()} accessibilityLabel="Recentre">
          <Text style={s.ctrlIcon}>◎</Text>
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
            <Text style={[s.ctrlIcon, { color: '#ffffff' }]}>➤</Text>
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
  }, [fetchSession, fetchAreas, loadRoads]);

  const notices = [
    // Which backend this build talks to, whenever it is NOT the production default. Twice now,
    // "the fix isn't working" turned out to be a client pointed at a different server than the one
    // being fixed — on the panel and again here. Cheap to show, expensive to guess.
    IS_CUSTOM_API && `Backend: ${API_BASE_URL}`,
    sessionError && `! Live session - ${sessionError}`,
    areasError   && `! Allocated areas - ${areasError}`,
    roadsError   && `! ${roadsError}`,
    // MapGL draws its own "Map unavailable" panel in place of the map, so this line does not repeat
    // the reason - it gives the driver the one number the map would have shown them.
    mapError     && `! Map unavailable - ${roadStats.todo.toLocaleString()} of ${roadStats.total.toLocaleString()} assigned roads still to drive.`,
    roadsNote    && `Note: ${roadsNote}`,
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
  if (!prefsReady) {
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

      {/* MapGL — MapLibre GL on WebGL inside a WebView. Rendered unconditionally. */}
      <View style={s.mapWrap}>
        <MapGL
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
          onUnsupported={setMapError}
        />
        {controls}
        {hint && (
          <View style={s.hintPill} pointerEvents="none">
            <Text style={s.hintText}>{hint}</Text>
          </View>
        )}
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

  mapWrap:   { flex: 1 },


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
