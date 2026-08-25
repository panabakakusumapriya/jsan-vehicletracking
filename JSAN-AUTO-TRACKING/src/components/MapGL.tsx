import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

/**
 * MapGL — the driver's coverage map.
 *
 * Replaces LeafletMap. Same integration shape (a WebView whose HTML is built from props) but the
 * renderer is MapLibre GL JS on WebGL instead of Leaflet on a 2D canvas. The reason is arithmetic:
 * a work area can hold ~21,500 road links, and Leaflet would need ~21,500 live objects, each with
 * its own event and layout bookkeeping, to draw them. Here the whole network is two GeoJSON
 * sources and four layers, and the GPU draws it.
 *
 * The vector style is https://tiles.openfreemap.org/styles/liberty — deliberately the same style
 * the admin panel uses (admin-panel/src/lib/map3d/Map3D.tsx), so a driver and their manager are
 * looking at the same basemap when they disagree about where a road is.
 */

/* --------------------------------------------------------------------------------------------
 * Colour contract — user-specified, do not change.
 * ------------------------------------------------------------------------------------------ */
/** Assigned but not yet driven. This is the driver's to-do list. */
const COLOR_UNCOVERED = '#dc2626';
/** Already driven — present in LinkCoverage. */
const COLOR_COVERED = '#2563eb';
/** The current drive. Green so it can never be mistaken for either road state. */
const COLOR_TRACE = '#059669';
/** Work-area boundary. Brand violet, matching the app's existing area styling. */
const COLOR_AREA = '#7c3aed';
/** Live position dot — violet too, so the dot is never read as a fragment of trace. */
const COLOR_VEHICLE = '#7c3aed';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

// Pinned, not floating. A ranged CDN URL means an upstream release can change what a phone in the
// field loads with no build, no review, and no way to roll back short of shipping an app update.
// 5.24.0 is the version the admin panel already runs against this style.
const MAPLIBRE_VERSION = '5.24.0';

// Only used when there is nothing at all to frame — no trace, no areas, no roads.
const DEFAULT_CENTER: [number, number] = [78.45, 17.42];
const DEFAULT_ZOOM = 11;

/* --------------------------------------------------------------------------------------------
 * Props
 * ------------------------------------------------------------------------------------------ */

/**
 * One road exactly as GET /api/tracking/my-roads puts it on the wire — positional, not an object,
 * because 20,000 of these travel over mobile data:
 *   [linkId, funcClass, covered (0 | 1), [[lon, lat], [lon, lat], ...]]
 * Coordinates arrive already rounded to 5 dp (~1 m) by the server.
 */
export type RoadTuple = [string, number, 0 | 1, [number, number][]];

/**
 * A work area to outline. Structurally a subset of MyArea from src/lib/api.ts, so the response of
 * apiMyAreas can be passed straight through with no mapping step.
 */
export interface MapGLArea {
  id: string;
  name: string;
  outline: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  } | null;
  bbox?: [number, number, number, number] | null;
}

/**
 * The current drive.
 *
 * `lines` is one entry per unbroken run of positions rather than one flat path, because both
 * sources of a trace come in pieces and the pieces mean something:
 *  - raw GPS has gaps (tunnel, dead battery, permission revoked), and joining across a gap draws a
 *    straight line through streets nobody drove;
 *  - a snapped route is Trip.cleanedRouteShapes, one polyline6 string per matched chunk, and the
 *    space between two chunks is exactly the stretch Valhalla refused to match.
 * decodeRouteShapeLines() in src/lib/polyline.ts produces this shape from cleanedRouteShapes.
 *
 * `kind` drives the visual: raw is dashed to read as provisional, snapped is solid. Per the trace
 * contract the caller switches to 'snapped' once trip.mapMatchStatus === 'matched' and
 * cleanedRouteShapes is non-empty, and drops its cached raw copy at that point.
 */
export interface MapGLTrace {
  kind: 'raw' | 'snapped';
  lines: [number, number][][];
  /**
   * Which trip this trace belongs to. Optional, and only ever used to decide whether the camera
   * may move: the map frames itself on the first trace it sees and then leaves the camera alone,
   * because re-framing on every 15 s poll would fight a driver who has panned ahead. That rule is
   * right within one trip and wrong across two — a phone left open on yesterday's finished trip
   * stays framed on yesterday's suburb when a new trip starts, with the live position off-screen
   * and nothing on the map to say so. A changed tripId is the one signal that re-framing is
   * wanted rather than intrusive. roadCache's TripTrace already carries this field, so callers
   * passing that straight through get the behaviour for free.
   */
  tripId?: string;
}

export interface MapGLProps {
  /**
   * Roads from my-roads.
   *
   * IMPORTANT: keep this array reference stable across renders. Roads are baked into the WebView's
   * HTML, so a new identity re-mounts the WebView — re-downloading the map engine, re-fetching
   * tiles and resetting the camera. Building it fresh inside the parent's render (say
   * `roads={data.links.map(...)}`) turns a 15-second refresh into a 15-second map reload. The
   * my-roads response is client-cached by `version` precisely so this can stay stable.
   */
  roads?: RoadTuple[];
  /** Work-area outlines. Same stability rule as `roads`. */
  areas?: MapGLArea[];
  /** Current drive. Safe to pass a new object every poll — this is injected, not re-rendered. */
  trace?: MapGLTrace | null;
  /** Live position, [lon, lat]. Injected like the trace. */
  vehicle?: [number, number] | null;
  style?: StyleProp<ViewStyle>;
  /**
   * Fires when the map cannot be drawn at all (no WebGL, engine download failed, tiles
   * unreachable). The component already shows its own readable message; this exists so the screen
   * can react — e.g. offer a plain list of the area's roads instead.
   */
  onUnsupported?: (reason: string) => void;

  /** Basemap style URL. Changing it swaps the style in place — it does NOT re-mount the WebView. */
  styleUrl?: string;
  /** Camera to open at, from the driver's saved preferences. Overrides auto-framing. */
  initialCamera?: { center: [number, number]; zoom: number } | null;
  /** Layer visibility. Applied live; also re-applied after a basemap swap. */
  showAreas?: boolean;
  showRoads?: boolean;
  /**
   * Fires when the driver stops moving the map, so the caller can persist the view. Debounced to
   * 'moveend' in the page — it is not a per-frame callback.
   */
  onCamera?: (center: [number, number], zoom: number) => void;
}

/** Imperative controls, for on-screen zoom and recentre buttons. */
export interface MapGLHandle {
  zoomIn(): void;
  zoomOut(): void;
  /** Centre on the live vehicle if there is one, otherwise frame the whole allocation. */
  recenter(): void;
}

/* --------------------------------------------------------------------------------------------
 * Stable empty defaults.
 *
 * NOT `roads = []` in the destructure: a literal default allocates a new array on every render,
 * which changes the useMemo dependency, which rebuilds the HTML, which re-mounts the WebView — a
 * map that reloads forever and never finishes drawing. Module constants have stable identity.
 * ------------------------------------------------------------------------------------------ */
const NO_ROADS: RoadTuple[] = [];
const NO_AREAS: MapGLArea[] = [];

/* --------------------------------------------------------------------------------------------
 * Geometry helpers.
 *
 * All of this runs on the React Native side on purpose. Everything that crosses into the WebView
 * crosses as a string, so any conversion left for the page is paid for twice: once to serialise
 * the raw form, once to rebuild it inside a slower JS engine on the phone's UI thread.
 * ------------------------------------------------------------------------------------------ */

/** [west, south, east, north] */
type Bounds = [number, number, number, number];

type GeoJson = { type: 'FeatureCollection'; features: unknown[] };

const EMPTY_FC: GeoJson = { type: 'FeatureCollection', features: [] };

/** ~1 m — the precision the my-roads contract already rounds roads to. */
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

function accumulateBounds(lines: [number, number][][], into: Bounds | null): Bounds | null {
  let b = into;
  for (const line of lines) {
    for (const p of line) {
      const lon = p[0];
      const lat = p[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (!b) b = [lon, lat, lon, lat];
      else {
        if (lon < b[0]) b[0] = lon;
        if (lat < b[1]) b[1] = lat;
        if (lon > b[2]) b[2] = lon;
        if (lat > b[3]) b[3] = lat;
      }
    }
  }
  return b;
}

/**
 * Splits roads into the two draw groups. Each group becomes ONE MultiLineString feature rather
 * than one Feature per road: a Feature wrapper costs ~60 bytes of JSON boilerplate, so 20,000 of
 * them would add well over a megabyte to a payload that is otherwise ~250 KB gzipped. The cost is
 * that an individual road cannot be tapped — which nothing in the driver flow asks for.
 *
 * Coordinates are passed through by reference, never copied or re-rounded: the server already
 * emits 5 dp, and re-rounding would allocate a fresh copy of ~200,000 coordinate pairs on the JS
 * thread for a change nobody can see.
 */
function splitRoads(roads: RoadTuple[]) {
  const covered: [number, number][][] = [];
  const uncovered: [number, number][][] = [];
  for (const r of roads) {
    const coords = r[3];
    // A one-point "line" is not drawable and MapLibre logs a warning for each one. At this volume
    // the console traffic alone is enough to stall the WebView.
    if (!coords || coords.length < 2) continue;
    if (r[2]) covered.push(coords);
    else uncovered.push(coords);
  }
  // funcClass (r[1]) is deliberately dropped. Carrying it as a feature property to vary line width
  // would mean giving up the single-feature packing above and re-adding per-feature JSON, for a
  // distinction that is barely legible at phone zoom levels anyway.
  return { covered, uncovered };
}

function multiLineFC(lines: [number, number][][]): GeoJson {
  if (!lines.length) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'MultiLineString', coordinates: lines },
      },
    ],
  };
}

/**
 * Areas as real Polygon/MultiPolygon features. The old Leaflet map flattened a MultiPolygon's
 * rings into a single ring list because Leaflet's polygon API takes rings, not geometries;
 * MapLibre takes GeoJSON directly, so keep the geometry intact — flattening loses the distinction
 * between a second island and a hole, and fills the holes in.
 */
function areasFC(areas: MapGLArea[]): GeoJson {
  const features: unknown[] = [];
  for (const a of areas) {
    const g = a.outline;
    let geometry: { type: string; coordinates: unknown } | null = null;
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && g.coordinates) {
      geometry = { type: g.type, coordinates: g.coordinates };
    } else if (a.bbox) {
      // No outline delivered yet (import still running). The bbox is a blunt but truthful
      // stand-in, and far better than an allocated area the driver cannot see at all.
      const [w, s, e, n] = a.bbox;
      geometry = {
        type: 'Polygon',
        coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
      };
    }
    if (!geometry) continue;
    features.push({ type: 'Feature', properties: { name: a.name || '' }, geometry });
  }
  return features.length ? { type: 'FeatureCollection', features } : EMPTY_FC;
}

function areasBounds(areas: MapGLArea[]): Bounds | null {
  let b: Bounds | null = null;
  for (const a of areas) {
    // Prefer the precomputed bbox: walking a simplified outline is thousands of comparisons per
    // area for a number the server already worked out and shipped.
    if (a.bbox && a.bbox.every(Number.isFinite)) {
      b = accumulateBounds([[[a.bbox[0], a.bbox[1]], [a.bbox[2], a.bbox[3]]]], b);
      continue;
    }
    const g = a.outline;
    if (!g || !g.coordinates) continue;
    const rings =
      g.type === 'Polygon'
        ? (g.coordinates as number[][][])
        : (g.coordinates as number[][][][]).flat();
    b = accumulateBounds(rings as [number, number][][], b);
  }
  return b;
}

/**
 * Trace geometry, rounded to 5 dp. Unlike roads this IS worth rounding: raw GPS arrives as full
 * doubles (17.421123456789012), roughly 18 characters per ordinate, and a whole shift's trace is
 * re-injected on every poll. Rounding roughly halves the string for a ~1 m difference.
 */
function traceLines(trace: MapGLTrace | null | undefined): [number, number][][] {
  if (!trace || !trace.lines) return [];
  const out: [number, number][][] = [];
  for (const line of trace.lines) {
    if (!line || line.length < 2) continue;
    // A bad point BREAKS the line, it does not get skipped over. Dropping it and carrying on would
    // join the fix before it to the fix after it, and that join is a straight line across whatever
    // lies between — which is the exact artefact the one-line-per-unbroken-run shape of `lines`
    // exists to prevent. roadCache.rawToLines splits for the same reason; matching it here means a
    // trace does not change shape depending on which of the two built it.
    let run: [number, number][] = [];
    for (const p of line) {
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        if (run.length > 1) out.push(run);
        run = [];
        continue;
      }
      run.push([round5(p[0]), round5(p[1])]);
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

function vehiclePoint(vehicle: [number, number] | null | undefined): [number, number] | null {
  if (!vehicle || !Number.isFinite(vehicle[0]) || !Number.isFinite(vehicle[1])) return null;
  return [round5(vehicle[0]), round5(vehicle[1])];
}

/**
 * Serialise a value for embedding inside a <script> block.
 *
 * A bare JSON.stringify is NOT safe here. Area names are customer-supplied strings that reach this
 * component straight from the database, and one containing the characters that close a script tag
 * would end the block early and leave the rest of the payload rendering as page text. Escaping '<'
 * removes that possibility entirely. U+2028/U+2029 are legal inside JSON but were historically
 * illegal raw in JS source, and are a syntax error in the older WebViews this fleet still runs.
 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The payload pushed into an already-loaded page (and embedded on a cold start). */
function updatePayload(
  trace: MapGLTrace | null | undefined,
  vehicle: [number, number] | null | undefined
) {
  const lines = traceLines(trace);
  return {
    trace: multiLineFC(lines),
    traceKind: trace?.kind === 'snapped' ? 'snapped' : 'raw',
    traceBounds: accumulateBounds(lines, null),
    traceTrip: trace?.tripId ? String(trace.tripId) : '',
    vehicle: vehiclePoint(vehicle),
  };
}

/* --------------------------------------------------------------------------------------------
 * The page
 * ------------------------------------------------------------------------------------------ */

function buildHtml(
  roads: RoadTuple[],
  areas: MapGLArea[],
  trace: MapGLTrace | null | undefined,
  vehicle: [number, number] | null | undefined,
  /**
   * These four are baked into the page rather than pushed over the bridge because they are needed
   * BEFORE the map is constructed — the style URL and the opening camera are constructor options,
   * and visibility must be right on the first paint so a hidden layer never flashes into view.
   *
   * Consequence: changing them changes the HTML, which re-mounts the WebView. The component
   * therefore only re-derives the HTML for styleUrl (a deliberate, rare user action) and drives
   * visibility/camera changes through __mapglCommand instead. See the html useMemo.
   */
  styleUrl: string,
  initialCamera: { center: [number, number]; zoom: number } | null,
  showAreas: boolean,
  showRoads: boolean
): string {
  const { covered, uncovered } = splitRoads(roads);
  const initial = updatePayload(trace, vehicle);

  // Framing priority: the trace, then the allocation, then the roads. Where the driver has already
  // been beats where they were told to go, which beats the raw extent of the network — and with a
  // trace present, framing the roads instead would zoom out to the whole area and lose them.
  let bounds: Bounds | null = initial.traceBounds;
  if (!bounds) bounds = areasBounds(areas);
  if (!bounds) bounds = accumulateBounds(uncovered, accumulateBounds(covered, null));

  const cdn = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl`;

  return `<!DOCTYPE html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<link rel="stylesheet" href="${cdn}.css"/>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body,#map{width:100%;height:100%;overflow:hidden}
body{background:#eef1f5}
#fallback{display:none;position:absolute;inset:0;align-items:center;justify-content:center;padding:28px;
  background:#f7f7fb;text-align:center;color:#64748b;
  font:14px/1.55 -apple-system,BlinkMacSystemFont,Roboto,'Helvetica Neue',sans-serif}
#fallback b{display:block;font-size:15px;color:#0d0d12;margin-bottom:6px}
.maplibregl-ctrl-attrib{font-size:9px}
.maplibregl-ctrl-bottom-left{display:none}
</style>
</head><body>
<div id="map"></div>
<div id="fallback"><div><b>Map unavailable</b><span id="fallback-msg"></span></div></div>
<script src="${cdn}.js" onerror="window.__mapglEngineFailed=true"></script>
<script>
(function(){
  var COVERED   = ${jsonForScript(multiLineFC(covered))};
  var UNCOVERED = ${jsonForScript(multiLineFC(uncovered))};
  var AREAS     = ${jsonForScript(areasFC(areas))};
  var INITIAL   = ${jsonForScript(initial)};
  // The most recent payload seen, starting from the one baked into this page. Read back whenever
  // layers have to be re-installed (see installLayers) so the redraw shows the current trace.
  var LAST      = INITIAL;
  var BOUNDS    = ${jsonForScript(bounds)};
  var STYLE     = ${jsonForScript(styleUrl)};
  var CAMERA    = ${jsonForScript(initialCamera ?? null)};
  var VISIBLE   = ${jsonForScript({ areas: showAreas !== false, roads: showRoads !== false })};

  function post(o){ try { window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch(e){} }

  // Shows the message in-page AND tells React Native. Both, not either: the in-page copy is what a
  // driver sees if onMessage never arrives (an old WebView that failed before ReactNativeWebView
  // was injected), and the native copy is the one the screen can style and act on.
  function fail(reason){
    var el = document.getElementById('fallback');
    if (el) {
      el.style.display = 'flex';
      document.getElementById('fallback-msg').textContent = reason;
    }
    var m = document.getElementById('map');
    if (m) m.style.display = 'none';
    post({ t: 'unsupported', reason: reason });
  }

  // A cheap, allocation-only probe. It catches the total-absence case (hardware acceleration off,
  // an emulator with no GPU, a stripped Android System WebView) before anything downloads.
  // MapLibre's own error path below is the authoritative check for everything subtler.
  function hasWebGL(){
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch(e){ return false; }
  }

  var NO_GL = 'This device cannot draw the map: WebGL is unavailable. Updating Android System WebView usually fixes it.';

  if (window.__mapglEngineFailed || typeof maplibregl === 'undefined') {
    fail('The map engine could not be downloaded. Check your connection, then try again.');
    return;
  }
  if (!hasWebGL()) { fail(NO_GL); return; }
  // maplibregl.supported() exists on some builds and not others; feature-detect, do not assume.
  if (typeof maplibregl.supported === 'function' && !maplibregl.supported()) { fail(NO_GL); return; }

  var opts = {
    container: 'map',
    style: STYLE,
    attributionControl: { compact: true },
    // Flat and north-up, and it stays that way. Coverage is read as a plan — which streets are
    // still red — and tilt distorts exactly that. Worse, a driver who two-finger-rotates the map
    // by accident mid-shift has no obvious way to get north back.
    pitch: 0,
    bearing: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false
  };
  if (CAMERA && CAMERA.center) {
    // A remembered camera beats auto-framing. The driver put the map where they wanted it last
    // shift; re-fitting to the whole allocation every morning would undo that every time.
    opts.center = CAMERA.center;
    opts.zoom = CAMERA.zoom;
  } else if (BOUNDS) {
    // Framing through the constructor rather than a fitBounds() after load: this lands before the
    // first paint, so the driver never sees the map at one place and then jump to another.
    opts.bounds = [[BOUNDS[0], BOUNDS[1]], [BOUNDS[2], BOUNDS[3]]];
    opts.fitBoundsOptions = { padding: 36, maxZoom: 16 };
  } else {
    opts.center = ${jsonForScript(DEFAULT_CENTER)};
    opts.zoom = ${DEFAULT_ZOOM};
  }

  var map;
  try {
    map = new maplibregl.Map(opts);
  } catch (e) {
    fail('The map could not start on this device. ' + (e && e.message ? e.message : ''));
    return;
  }
  if (map.touchZoomRotate && map.touchZoomRotate.disableRotation) map.touchZoomRotate.disableRotation();

  var ready = false;
  var installed = false;
  var blankStyle = false;

  // A basemap-less style. Roads and areas are on the device already (roadCache keeps them for 12 h
  // precisely so a driver out of coverage can still work), but they were being thrown away with
  // the basemap: if the style JSON never arrives, 'load' never fires, no layer is ever added, and
  // the 30 s watchdog below declares the whole map dead. A driver in a signal hole then sees
  // nothing at all, when what they needed — which of these streets are still red — was sitting in
  // local storage the whole time. Grey background, real roads, no labels.
  function makeBlankStyle(){
    return { version: 8, sources: {}, layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#e8eaee' } }
    ]};
  }

  map.on('error', function(e){
    var err = e && e.error;
    // Tile 404s and one-off fetch failures fire here constantly on a patchy mobile connection and
    // are not fatal — the map still works, it just has holes in it. Only a GPU failure means there
    // is nothing to show at all.
    if (err && err.name === 'GPUInitializationError') {
      fail('This device cannot draw the map: the graphics context failed to start.');
      return;
    }
    post({ t: 'error', message: err && err.message ? err.message : 'map error' });
  });

  // Two watchdogs, because "the basemap is slow" and "this map is never going to draw" deserve
  // different answers.
  //
  // At 20s, drop the remote basemap and redraw on a blank one. The driver keeps their roads. 20s,
  // not the 10-15s that feels right for a web page, because on the rural mobile data this fleet
  // actually drives on "slow" routinely means fifteen seconds, and a real basemap is worth waiting
  // for. This is not destructive: nothing is torn down, layers are re-added by the style.load
  // handler below.
  setTimeout(function(){
    if (installed) return;
    blankStyle = true;
    // Cleared here rather than in a style event: setStyle() drops every source and layer, so this
    // page is definitively un-installed the moment the call is made, and the installer must be
    // allowed to run again whichever style event happens to arrive first.
    installed = false;
    post({ t: 'error', message: 'basemap timed out; drawing roads without it' });
    try { map.setStyle(makeBlankStyle()); } catch (e) {}
  }, 20000);

  // At 30s, with even a zero-request style failing to come up, there is nothing left to try and
  // the driver is owed an explanation rather than a grey rectangle. Unlike the fallback above this
  // one IS terminal for this page — React Native swaps the WebView for its own message — so it has
  // to be the genuinely hopeless case.
  setTimeout(function(){
    if (!ready) fail('The map could not be loaded. Check your connection, then try again.');
  }, 30000);

  // The camera is framed on the first trace of a TRIP and never again for that trip. A driver pans
  // and zooms to look ahead; snapping the camera back on every 15-second poll would make the map
  // unusable exactly while it is being used. A new trip is the exception — see MapGLTrace.tripId.
  var framedTrace = false;
  var framedTripId = null;

  function apply(p, isInitial){
    if (!p) return;
    // Sources and layers only exist after 'load'. React Native does not inject before the ready
    // message, so this should be unreachable — but an update that did arrive early would throw on
    // the first setLayoutProperty below, and the catch in __mapglUpdate would swallow it, leaving
    // the trace silently unset for the rest of the session.
    if (!map.getLayer || !map.getLayer('trace-raw')) return;
    var src = map.getSource('trace');
    if (src) src.setData(p.trace);

    var hasTrace = !!(p.trace && p.trace.features && p.trace.features.length);
    var snapped = p.traceKind === 'snapped';
    map.setLayoutProperty('trace-raw', 'visibility', hasTrace && !snapped ? 'visible' : 'none');
    map.setLayoutProperty('trace-snapped', 'visibility', hasTrace && snapped ? 'visible' : 'none');

    var vsrc = map.getSource('vehicle');
    if (vsrc) {
      vsrc.setData(p.vehicle
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {},
            geometry: { type: 'Point', coordinates: p.vehicle } }] }
        : { type: 'FeatureCollection', features: [] });
    }

    if (p.traceBounds) {
      var trip = p.traceTrip || '';
      // A different trip means the driver is looking at the wrong place, not that they panned
      // there. Only a CHANGE counts: a caller that never sends tripId keeps the old
      // frame-once-per-mount behaviour rather than re-framing on every poll.
      if (framedTrace && trip && framedTripId && trip !== framedTripId) framedTrace = false;
      if (trip) framedTripId = trip;

      if (isInitial) {
        // Already framed by the constructor's bounds option above; just record that it happened so
        // the first injected update does not re-frame and undo the driver's own panning.
        framedTrace = true;
      } else if (!framedTrace) {
        framedTrace = true;
        map.fitBounds(
          [[p.traceBounds[0], p.traceBounds[1]], [p.traceBounds[2], p.traceBounds[3]]],
          { padding: 36, maxZoom: 16, duration: 600 }
        );
      }
    }
  }

  // Runs on EVERY style load, not once on 'load'. setStyle() throws away every source and layer on
  // the map, so the blank-style fallback above would otherwise leave a correctly-running map with
  // nothing drawn on it at all.
  function installLayers(){
    // Three guards. The flag is the cheap path. getSource is the truthful one — addSource on a
    // name that already exists throws, and this runs from several events that can each fire more
    // than once. isStyleLoaded is the ordering one: styledata fires while a style is still
    // arriving, and adding a source then throws too.
    if (installed || !map.getSource || !map.isStyleLoaded || !map.isStyleLoaded()) return;
    if (map.getSource('areas')) return;
    installed = true;
    ready = true;

    map.addSource('areas', { type: 'geojson', data: AREAS });
    map.addSource('roads-covered', { type: 'geojson', data: COVERED });
    map.addSource('roads-uncovered', { type: 'geojson', data: UNCOVERED });
    // LAST, not INITIAL — on a re-install after a style swap the baked-in trace is minutes old.
    map.addSource('trace', { type: 'geojson', data: LAST.trace });
    map.addSource('vehicle', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    map.addLayer({
      id: 'area-fill', type: 'fill', source: 'areas',
      paint: { 'fill-color': '${COLOR_AREA}', 'fill-opacity': 0.07 }
    });
    map.addLayer({
      id: 'area-outline', type: 'line', source: 'areas',
      paint: { 'line-color': '${COLOR_AREA}', 'line-width': 2, 'line-opacity': 0.85 }
    });

    // Road width by zoom, not by road class: at phone zooms the useful signal is "is there a line
    // here and what colour is it", and a hairline at zoom 11 is what keeps a whole area legible.
    var roadWidth = ['interpolate', ['linear'], ['zoom'], 10, 0.7, 13, 1.6, 16, 3.4, 19, 6];

    // Covered first, uncovered on top. The two sets are disjoint so this is not about overlap — it
    // is that where they meet at a junction, the driver's remaining work stays the visible one.
    map.addLayer({
      id: 'roads-covered', type: 'line', source: 'roads-covered',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '${COLOR_COVERED}', 'line-width': roadWidth, 'line-opacity': 0.9 }
    });
    map.addLayer({
      id: 'roads-uncovered', type: 'line', source: 'roads-uncovered',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '${COLOR_UNCOVERED}', 'line-width': roadWidth, 'line-opacity': 0.95 }
    });

    var traceWidth = ['interpolate', ['linear'], ['zoom'], 10, 2.5, 14, 4, 18, 7];

    // Two layers over one source rather than one layer whose dash is repainted. line-dasharray has
    // no "solid" value to set it back to, so a layer that has ever been dashed cannot cleanly stop
    // being dashed — and this map switches raw -> snapped mid-session, every session.
    map.addLayer({
      id: 'trace-raw', type: 'line', source: 'trace',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: {
        'line-color': '${COLOR_TRACE}', 'line-width': traceWidth,
        'line-opacity': 0.9, 'line-dasharray': [2, 1.4]
      }
    });
    map.addLayer({
      id: 'trace-snapped', type: 'line', source: 'trace',
      layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
      paint: { 'line-color': '${COLOR_TRACE}', 'line-width': traceWidth, 'line-opacity': 1 }
    });

    map.addLayer({
      id: 'vehicle-dot', type: 'circle', source: 'vehicle',
      paint: {
        'circle-radius': 7, 'circle-color': '${COLOR_VEHICLE}',
        'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff'
      }
    });

    // Area labels last, so they sit above every line. The font is named explicitly: MapLibre's
    // built-in default asks the glyph server for an Open Sans face this style does not host, and
    // the labels then silently never appear.
    //
    // Skipped entirely on the blank fallback style: that style has no glyphs endpoint, and a
    // symbol layer without one does not degrade to unlabelled — it raises a style error on every
    // frame, which is exactly the flood the map error handler is not equipped to distinguish from
    // a real failure. The basemap being gone is the bigger loss anyway.
    if (!blankStyle) {
      map.addLayer({
        id: 'area-label', type: 'symbol', source: 'areas',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12
        },
        paint: { 'text-color': '${COLOR_AREA}', 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 }
      });
    }

    // LAST, not INITIAL: a style swap can happen 20 seconds in, by which time the trace baked into
    // the page at build time is stale and re-applying it would rewind the driver's route.
    //
    // isInitial=true in both cases. It means "do not move the camera", which is right on the first
    // install (the constructor's bounds option already framed it) and right on a re-install
    // (setStyle preserves the camera, so moving it now would undo wherever the driver panned).
    apply(LAST, true);
    post({ t: 'ready' });
  }

  // Three triggers for one idempotent installer, because no single one is guaranteed here.
  // 'load' fires once and only for the first style, so it cannot cover the fallback swap.
  // 'style.load' does cover the swap and is what MapLibre uses internally, but it is absent from
  // the public typings and is not contractually stable. 'styledata' is the documented one but
  // fires while a style is still arriving, hence the isStyleLoaded guard above. Between them the
  // layers get installed on any MapLibre build; the guards make the overlap free.
  map.on('load', installLayers);
  map.on('style.load', installLayers);

  /**
   * Layer visibility, re-applied on every install.
   *
   * setStyle() discards all sources and layers, so a basemap change re-runs installLayers — and
   * without re-applying here, toggling the basemap would silently switch hidden layers back on.
   */
  function applyVisibility(){
    if (!installed) return;
    var pairs = [
      ['area-fill', VISIBLE.areas], ['area-outline', VISIBLE.areas],
      ['roads-covered', VISIBLE.roads], ['roads-uncovered', VISIBLE.roads]
    ];
    for (var i = 0; i < pairs.length; i++) {
      try {
        if (map.getLayer(pairs[i][0])) {
          map.setLayoutProperty(pairs[i][0], 'visibility', pairs[i][1] ? 'visible' : 'none');
        }
      } catch (e) {}
    }
  }
  map.on('load', applyVisibility);
  map.on('style.load', applyVisibility);

  /**
   * Report the camera so the driver's position and zoom survive to the next shift.
   *
   * 'moveend' rather than 'move': persisting on every frame of a pinch would be hundreds of writes
   * for one gesture. Also skipped while the map is still settling into its initial camera, so an
   * auto-fit never overwrites the remembered one before the driver has touched anything.
   */
  var cameraArmed = false;
  map.on('idle', function(){ cameraArmed = true; });
  map.on('moveend', function(){
    if (!cameraArmed) return;
    try {
      var c = map.getCenter();
      post({ t: 'camera', center: [c.lng, c.lat], zoom: map.getZoom() });
    } catch (e) {}
  });

  /**
   * Commands from React Native: zoom buttons, recentre, layer toggles, basemap swap.
   *
   * A command channel rather than more props, because these are imperative one-shot actions. Doing
   * them through props would mean re-generating the HTML, which re-mounts the WebView and throws
   * away the very camera the driver is trying to adjust.
   */
  window.__mapglCommand = function(c){
    try {
      if (!c || !c.cmd) return;
      if (c.cmd === 'zoomIn')  { map.zoomIn({ duration: 220 }); return; }
      if (c.cmd === 'zoomOut') { map.zoomOut({ duration: 220 }); return; }
      if (c.cmd === 'recenter') {
        // Prefer the live vehicle position; fall back to the allocation extent.
        if (LAST.vehicle) { map.easeTo({ center: LAST.vehicle, zoom: Math.max(map.getZoom(), 15), duration: 500 }); }
        else if (BOUNDS)  { map.fitBounds([[BOUNDS[0], BOUNDS[1]], [BOUNDS[2], BOUNDS[3]]], { padding: 36, maxZoom: 16, duration: 500 }); }
        return;
      }
      if (c.cmd === 'visibility') {
        VISIBLE.areas = !!c.areas;
        VISIBLE.roads = !!c.roads;
        applyVisibility();
        return;
      }
      if (c.cmd === 'basemap' && c.url && c.url !== STYLE) {
        STYLE = c.url;
        // installed=false first: setStyle wipes every source and layer, and installLayers must be
        // allowed to put them back when 'style.load' fires.
        installed = false;
        map.setStyle(c.url);
        return;
      }
    } catch (e) {}
  };
  map.on('styledata', installLayers);

  window.__mapglUpdate = function(p){
    // Remembered even when the map is not up yet, so a style swap — or a first install that lands
    // after several updates have already been pushed — redraws the CURRENT trace rather than the
    // one that happened to be baked into the HTML.
    if (p) LAST = p;
    try { apply(p, false); } catch(e){ post({ t: 'error', message: String((e && e.message) || e) }); }
  };
})();
</script></body></html>`;
}

/* --------------------------------------------------------------------------------------------
 * Component
 * ------------------------------------------------------------------------------------------ */

type Status = 'loading' | 'ready' | 'unsupported';

export const MapGL = forwardRef<MapGLHandle, MapGLProps>(function MapGL({
  roads = NO_ROADS,
  areas = NO_AREAS,
  trace = null,
  vehicle = null,
  style,
  onUnsupported,
  styleUrl = MAP_STYLE,
  initialCamera = null,
  showAreas = true,
  showRoads = true,
  onCamera,
}: MapGLProps, ref) {
  const webRef = useRef<WebView>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [reason, setReason] = useState('');

  /**
   * Bumped to force a fresh WebView. This is the ONLY way back from 'unsupported'.
   *
   * The obvious recovery — "pull down to refresh" — provably does not work on its own, and the
   * reason is subtle enough to be worth writing down. The reset effect below keys on `html`, which
   * is a string, and effect dependencies are compared with Object.is: two identical strings are
   * the same value. Meanwhile the whole point of the my-roads `version` cache is that a refresh
   * which finds no new coverage hands back the SAME roads, so the rebuilt html is character-for-
   * character identical and the effect never re-runs. A driver who lost the map to a ten-second
   * signal drop was therefore stuck with a dead map for the rest of the app session, tapping a
   * refresh button that could not possibly help. The key forces the remount regardless.
   */
  const [attempt, setAttempt] = useState(0);

  // The page tells us when it is ready; until then injectJavaScript would run against a document
  // that has no map in it yet. Kept in a ref rather than state because the 'ready' handler has to
  // both flip it and read the current trace in the same tick.
  const readyRef = useRef(false);
  const traceRef = useRef(trace);
  traceRef.current = trace;
  const vehicleRef = useRef(vehicle);
  vehicleRef.current = vehicle;
  const onUnsupportedRef = useRef(onUnsupported);
  onUnsupportedRef.current = onUnsupported;

  // Only roads and areas are baked into the HTML — they are the heavy, rarely-changing half of the
  // payload (megabytes of coordinate text before compression). The trace deliberately is not:
  // rebuilding the HTML for a trace tick would re-mount the WebView every 15 seconds, re-download
  // the map engine and reset the camera. The trace is read from a ref so a cold start still opens
  // with whatever trace existed at build time and frames itself on it.
  // The refs are deliberately absent from the dependency list and the lint rule agrees — reading a
  // ref is not a dependency. Adding `trace` here would rebuild the HTML on every poll.
  /**
   * Snapshot refs for the values baked into the HTML.
   *
   * They must be read at BUILD time but must not be dependencies, or changing the basemap would
   * regenerate the document and reload the map engine — the exact thing the command channel exists
   * to avoid.
   */
  // Held in a ref so onMessage — created once — always calls the CURRENT callback. Capturing the
  // prop directly would pin the first render's closure and silently stop persisting the camera
  // after any parent re-render.
  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;

  const styleUrlRef = useRef(styleUrl);
  const initialCameraRef = useRef(initialCamera);
  const showAreasRef = useRef(showAreas);
  const showRoadsRef = useRef(showRoads);

  /** Fire-and-forget command into the live page. No-op until the page says it is ready. */
  const command = useCallback((cmd: Record<string, unknown>) => {
    if (!readyRef.current) return;
    webRef.current?.injectJavaScript(
      `if(window.__mapglCommand)window.__mapglCommand(${jsonForScript(cmd)});true;`
    );
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => command({ cmd: 'zoomIn' }),
      zoomOut: () => command({ cmd: 'zoomOut' }),
      recenter: () => command({ cmd: 'recenter' }),
    }),
    [command]
  );

  // Layer toggles and basemap swaps go over the bridge, not through the HTML. Skipped on the first
  // render because the page was already built with these values.
  const firstToggle = useRef(true);
  useEffect(() => {
    if (firstToggle.current) { firstToggle.current = false; return; }
    command({ cmd: 'visibility', areas: showAreas, roads: showRoads });
  }, [showAreas, showRoads, command]);

  const firstStyle = useRef(true);
  useEffect(() => {
    if (firstStyle.current) { firstStyle.current = false; return; }
    styleUrlRef.current = styleUrl;
    command({ cmd: 'basemap', url: styleUrl });
  }, [styleUrl, command]);

  const html = useMemo(
    // NOTE the dependency list below: styleUrl is intentionally NOT in it. A basemap swap goes
    // through __mapglCommand so the driver keeps their camera; re-deriving the HTML would reload
    // the whole engine. The values passed here are only ever the INITIAL ones.
    () =>
      buildHtml(
        roads,
        areas,
        traceRef.current,
        vehicleRef.current,
        styleUrlRef.current,
        initialCameraRef.current,
        showAreasRef.current,
        showRoadsRef.current
      ),
    [roads, areas]
  );

  // A new HTML string, or a manual retry, is a fresh document: nothing the old page told us
  // still applies.
  useEffect(() => {
    readyRef.current = false;
    setStatus('loading');
    setReason('');
  }, [html, attempt]);

  const retry = useCallback(() => {
    readyRef.current = false;
    setStatus('loading');
    setReason('');
    setAttempt((n) => n + 1);
  }, []);

  /**
   * A WebView that says nothing at all is its own failure mode, and until now it was the one that
   * looked most like a bug in the app: no 'ready', no 'unsupported', no onError — just the
   * spinner, forever. It happens when the page's own JS never runs (a WebView process killed under
   * memory pressure, a load that stalls without erroring), which is exactly when the in-page
   * watchdogs cannot fire either.
   *
   * 45s is deliberately longer than the page's own 30s watchdog, so this only ever catches the
   * cases the page could not report on its own.
   */
  useEffect(() => {
    if (status !== 'loading') return;
    const t = setTimeout(() => {
      if (readyRef.current) return;
      const why = 'The map did not finish loading. Check your connection, then try again.';
      setStatus('unsupported');
      setReason(why);
      onUnsupportedRef.current?.(why);
    }, 45_000);
    return () => clearTimeout(t);
  }, [status, html, attempt]);

  const push = useCallback(
    (t: MapGLTrace | null | undefined, v: [number, number] | null | undefined) => {
      // The trailing `true;` is required: without it iOS warns about the injected script's return
      // value on every call, and this is called on every poll.
      webRef.current?.injectJavaScript(
        `if(window.__mapglUpdate)window.__mapglUpdate(${jsonForScript(updatePayload(t, v))});true;`
      );
    },
    []
  );

  useEffect(() => {
    if (!readyRef.current) return; // buffered — the ready handler flushes the current values
    push(trace, vehicle);
  }, [trace, vehicle, push]);

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: { t?: string; reason?: string; message?: string };
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.t === 'ready') {
        readyRef.current = true;
        setStatus('ready');
        push(traceRef.current, vehicleRef.current);
      } else if (msg.t === 'camera') {
        const c = (msg as { center?: [number, number]; zoom?: number });
        if (Array.isArray(c.center) && typeof c.zoom === 'number') {
          onCameraRef.current?.(c.center, c.zoom);
        }
      } else if (msg.t === 'unsupported') {
        readyRef.current = false;
        const why = msg.reason || 'The map could not be drawn on this device.';
        setStatus('unsupported');
        setReason(why);
        onUnsupportedRef.current?.(why);
      }
      // 't: error' is non-fatal map noise (a missing tile, a failed glyph) and is swallowed on
      // purpose — surfacing it would put an alarming banner over a working map.
    },
    [push]
  );

  const onLoadError = useCallback(() => {
    readyRef.current = false;
    const why = 'The map could not be loaded. Check your connection, then try again.';
    setStatus('unsupported');
    setReason(why);
    onUnsupportedRef.current?.(why);
  }, []);

  const onLoadStart = useCallback(() => {
    readyRef.current = false;
  }, []);

  if (status === 'unsupported') {
    return (
      <View style={[styles.root, styles.fallback, style]}>
        <Text style={styles.fallbackTitle}>Map unavailable</Text>
        <Text style={styles.fallbackBody}>{reason}</Text>
        {/* Most of what lands here is transient — a signal drop while the map engine was
            downloading — and without this button the only cure was restarting the app. */}
        <TouchableOpacity style={styles.retryBtn} onPress={retry} accessibilityRole="button">
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.root, style]}>
      <WebView
        // Forces a genuinely new WebView on retry. Changing `source` alone is not enough: an
        // identical html string is not a prop change, so nothing would reload.
        key={attempt}
        ref={webRef}
        // baseUrl is not cosmetic. Android gives HTML-string content the `about:blank` origin, and
        // some WebView builds then refuse the fetch/XHR that MapLibre uses for every style, glyph
        // and tile request. A real https base gives the document a normal secure origin and the
        // requests go through; the tile hosts send a wildcard CORS header, so the host is arbitrary.
        source={{ html, baseUrl: 'https://localhost/' }}
        style={styles.web}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        // Without an explicit hardware layer some Android builds composite the WebView in software,
        // where the WebGL canvas comes up blank with nothing anywhere to explain why.
        androidLayerType="hardware"
        // The map does its own panning; letting the WebView scroll as well means a drag sometimes
        // moves the page instead of the map.
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        onMessage={onMessage}
        onError={onLoadError}
        onHttpError={onLoadError}
        onLoadStart={onLoadStart}
      />
      {status === 'loading' && (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={COLOR_AREA} />
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#eef1f5' },
  web: { flex: 1, backgroundColor: 'transparent' },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
    backgroundColor: '#f7f7fb',
  },
  fallbackTitle: { fontSize: 15, fontWeight: '800', color: '#0d0d12', marginBottom: 6 },
  fallbackBody: { fontSize: 13, lineHeight: 20, color: '#64748b', textAlign: 'center' },
  retryBtn: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: 10,
    backgroundColor: COLOR_AREA,
  },
  retryText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
});
