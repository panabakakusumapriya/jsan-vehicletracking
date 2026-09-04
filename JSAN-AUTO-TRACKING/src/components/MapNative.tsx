import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { View } from 'react-native';
import type { NativeSyntheticEvent } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MLMap,
  type CameraRef,
  type MapRef,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import type { MapGLArea, MapGLHandle, MapGLProps, MapGLTrail } from './mapTypes';

/**
 * MapNative — the driver map on @maplibre/maplibre-react-native (native MapLibre).
 *
 * The one and only map engine (DriverMap selects it; Expo Go, which cannot load the native
 * module, gets a build-needed notice instead). Sources take GeoJSON straight from props and
 * the library diffs updates natively — no bridge, no injected payloads, no version keys.
 *
 * The colours are the coverage contract shared with the legend in app/map.tsx — if one side
 * ever changes, change both.
 */

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

const COLOR_UNCOVERED = '#dc2626';
const COLOR_COVERED = '#2563eb';
const COLOR_TRACE = '#059669';
const COLOR_AREA = '#7c3aed';
const COLOR_VEHICLE = '#7c3aed';
const COLOR_HISTORY = '#6b7280';
const COLOR_OUTSIDE = '#f59e0b';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

function multiLineFC(lines: [number, number][][]): GeoJSON.FeatureCollection {
  if (!lines.length) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } },
    ],
  };
}

function pointFC(p: [number, number] | null | undefined): GeoJSON.FeatureCollection {
  if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return EMPTY_FC;
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }],
  };
}

function areasFC(areas: MapGLArea[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const a of areas) {
    const g = a.outline;
    let geometry: GeoJSON.Geometry | null = null;
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && g.coordinates) {
      geometry = { type: g.type, coordinates: g.coordinates } as GeoJSON.Geometry;
    } else if (a.bbox) {
      const [w, s, e, n] = a.bbox;
      geometry = { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
    }
    if (!geometry) continue;
    features.push({ type: 'Feature', properties: { name: a.name }, geometry });
  }
  return { type: 'FeatureCollection', features };
}

type Bounds = [number, number, number, number];

function accumulate(bounds: Bounds | null, lon: number, lat: number): Bounds {
  if (!bounds) return [lon, lat, lon, lat];
  return [
    Math.min(bounds[0], lon), Math.min(bounds[1], lat),
    Math.max(bounds[2], lon), Math.max(bounds[3], lat),
  ];
}

function linesBounds(lines: [number, number][][], start: Bounds | null): Bounds | null {
  let b = start;
  for (const line of lines) for (const [lon, lat] of line) {
    if (Number.isFinite(lon) && Number.isFinite(lat)) b = accumulate(b, lon, lat);
  }
  return b;
}

function fcBounds(fc: GeoJSON.FeatureCollection, start: Bounds | null): Bounds | null {
  let b = start;
  const walk = (coords: unknown) => {
    if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === 'number') {
      b = accumulate(b, coords[0] as number, coords[1] as number);
    } else if (Array.isArray(coords)) {
      for (const c of coords) walk(c);
    }
  };
  for (const f of fc.features) walk((f.geometry as { coordinates?: unknown }).coordinates);
  return b;
}

const lineWidthByZoom = (a: number, b: number, c: number, d: number) =>
  ['interpolate', ['linear'], ['zoom'], 10, a, 13, b, 16, c, 19, d] as unknown as number;

export const MapNative = forwardRef<MapGLHandle, MapGLProps>(function MapNative(
  {
    roads = [],
    areas = [],
    trace = null,
    vehicle = null,
    history = null,
    showHistory = true,
    style,
    onUnsupported,
    styleUrl = MAP_STYLE,
    initialCamera = null,
    showAreas = true,
    showRoads = true,
    onCamera,
    markers = null,
    onMarkerTap,
    trail = null,
  }: MapGLProps,
  ref
) {
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  const vehicleRef = useRef(vehicle);
  vehicleRef.current = vehicle;

  /* ── derived GeoJSON (memoised — the library diffs on identity) ── */

  const { coveredFC, uncoveredFC } = useMemo(() => {
    const covered: [number, number][][] = [];
    const uncovered: [number, number][][] = [];
    for (const r of roads) {
      const coords = r[3];
      if (!coords || coords.length < 2) continue;
      if (r[2]) covered.push(coords);
      else uncovered.push(coords);
    }
    return { coveredFC: multiLineFC(covered), uncoveredFC: multiLineFC(uncovered) };
  }, [roads]);

  const areasData = useMemo(() => areasFC(areas), [areas]);
  const historyFC = useMemo(() => multiLineFC(history?.lines ?? []), [history]);
  const traceFC = useMemo(() => multiLineFC(trace?.lines ?? []), [trace]);
  const outsideFC = useMemo(() => multiLineFC(trace?.outsideLines ?? []), [trace]);
  const snapped = trace?.kind === 'snapped';
  const trailFC = useMemo(() => {
    const line = (trail as MapGLTrail | null)?.line ?? [];
    return multiLineFC(line.length >= 2 ? [line] : []);
  }, [trail]);
  const vehicleFC = useMemo(() => pointFC(vehicle), [vehicle]);
  const markersFC = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: (markers?.points ?? [])
      .filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))
      .map((p) => ({
        type: 'Feature' as const,
        properties: { id: p.id, color: p.color },
        geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
      })),
  }), [markers]);

  /* ── camera ── */

  // Framing priority when there is no remembered/current-position camera: the trace, then the
  // allocation, then the roads — once, like the WebView's first-paint framing.
  const framedRef = useRef(false);
  const initialView = useMemo(() => {
    if (initialCamera) {
      framedRef.current = true;
      return { center: initialCamera.center, zoom: initialCamera.zoom };
    }
    let b: Bounds | null = linesBounds(trace?.lines ?? [], null);
    if (!b) b = fcBounds(areasData, null);
    // (roads-extent fallback deliberately omitted: with neither trace nor areas the default view below is honest)
    return b ? { bounds: [b[0], b[1], b[2], b[3]] as [number, number, number, number] } : { center: [78.45, 17.42] as [number, number], zoom: 11 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // initial only — later framing is the driver's own business

  const armedRef = useRef(false);
  const onRegionDidChange = useCallback(
    (e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
      const v = e.nativeEvent;
      // Only after the driver has touched the map: auto-framing at load must not overwrite
      // the remembered camera (same rule as the WebView's cameraArmed gate).
      if (v.userInteraction) armedRef.current = true;
      if (!armedRef.current) return;
      onCamera?.([v.center[0], v.center[1]], v.zoom);
    },
    [onCamera]
  );

  useImperativeHandle(ref, () => ({
    zoomIn: () => {
      mapRef.current?.getZoom().then((z) => cameraRef.current?.zoomTo(z + 1, { duration: 220 })).catch(() => {});
    },
    zoomOut: () => {
      mapRef.current?.getZoom().then((z) => cameraRef.current?.zoomTo(z - 1, { duration: 220 })).catch(() => {});
    },
    recenter: () => {
      const v = vehicleRef.current;
      if (v) {
        mapRef.current?.getZoom()
          .then((z) => cameraRef.current?.easeTo({ center: v, zoom: Math.max(z, 15), duration: 500 }))
          .catch(() => cameraRef.current?.easeTo({ center: v, zoom: 15, duration: 500 }));
      }
    },
    flyTo: (center: [number, number], zoom?: number) => {
      cameraRef.current?.easeTo({ center, zoom: zoom ?? 15, duration: 500 });
    },
  }), []);

  const failedRef = useRef(false);
  const onFail = useCallback(() => {
    if (failedRef.current) return;
    failedRef.current = true;
    onUnsupported?.('The map style could not be loaded. Check your connection, then try again.');
  }, [onUnsupported]);

  /* ── render ── */

  return (
    <View style={[{ flex: 1 }, style]}>
      <MLMap
        ref={mapRef}
        style={{ flex: 1 }}
        mapStyle={styleUrl}
        touchPitch={false}
        onRegionDidChange={onRegionDidChange}
        onDidFailLoadingMap={onFail}
        logo={false}
      >
        <Camera ref={cameraRef} initialViewState={initialView} />

        {/* Allocated polygons under everything */}
        <GeoJSONSource id="areas" data={areasData}>
          <Layer
            type="fill" id="area-fill"
            paint={{ 'fill-color': COLOR_AREA, 'fill-opacity': 0.07 }}
            layout={{ visibility: showAreas ? 'visible' : 'none' }}
          />
          <Layer
            type="line" id="area-outline"
            paint={{ 'line-color': COLOR_AREA, 'line-width': 2, 'line-opacity': 0.85, 'line-dasharray': [3, 2] }}
            layout={{ visibility: showAreas ? 'visible' : 'none' }}
          />
        </GeoJSONSource>

        {/* Roads: covered first, remaining work stays on top at junctions */}
        <GeoJSONSource id="roads-covered" data={coveredFC}>
          <Layer
            type="line" id="roads-covered"
            paint={{ 'line-color': COLOR_COVERED, 'line-width': lineWidthByZoom(0.7, 1.6, 3.4, 6), 'line-opacity': 0.9 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round', visibility: showRoads ? 'visible' : 'none' }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="roads-uncovered" data={uncoveredFC}>
          <Layer
            type="line" id="roads-uncovered"
            paint={{ 'line-color': COLOR_UNCOVERED, 'line-width': lineWidthByZoom(0.7, 1.6, 3.4, 6), 'line-opacity': 0.95 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round', visibility: showRoads ? 'visible' : 'none' }}
          />
        </GeoJSONSource>

        {/* Earlier trips: thin grey context */}
        <GeoJSONSource id="history" data={historyFC}>
          <Layer
            type="line" id="history-line"
            paint={{ 'line-color': COLOR_HISTORY, 'line-width': lineWidthByZoom(1.2, 2, 3.2, 4.5), 'line-opacity': 0.55 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round', visibility: showHistory ? 'visible' : 'none' }}
          />
        </GeoJSONSource>

        {/* Live local breadcrumb — the road as it is driven, before the server hears of it */}
        <GeoJSONSource id="trail" data={trailFC}>
          <Layer
            type="line" id="trail-line"
            paint={{
              'line-color': COLOR_TRACE, 'line-width': lineWidthByZoom(2, 3, 4.5, 5.5),
              'line-opacity': 0.65, 'line-dasharray': [1.6, 1.2],
            }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </GeoJSONSource>

        {/* Server trace: dashed while raw, solid once snapped */}
        <GeoJSONSource id="trace" data={traceFC}>
          <Layer
            type="line" id="trace-raw"
            paint={{ 'line-color': COLOR_TRACE, 'line-width': lineWidthByZoom(2.5, 3.5, 5.5, 7), 'line-opacity': 0.9, 'line-dasharray': [2, 1.4] }}
            layout={{ 'line-cap': 'round', 'line-join': 'round', visibility: !snapped ? 'visible' : 'none' }}
          />
          <Layer
            type="line" id="trace-snapped"
            paint={{ 'line-color': COLOR_TRACE, 'line-width': lineWidthByZoom(2.5, 3.5, 5.5, 7), 'line-opacity': 1 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round', visibility: snapped ? 'visible' : 'none' }}
          />
        </GeoJSONSource>
        <GeoJSONSource id="trace-outside" data={snapped ? outsideFC : EMPTY_FC}>
          <Layer
            type="line" id="trace-outside"
            paint={{ 'line-color': COLOR_OUTSIDE, 'line-width': lineWidthByZoom(2.5, 3.5, 5.5, 7), 'line-opacity': 1 }}
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
          />
        </GeoJSONSource>

        {/* Driver-dropped markers: colour-coded dots with white ring; tap → details card.
            Circle rather than the WebView's canvas pin — no canvas natively; the colour and
            the tap-card carry the meaning, and the size matches the pin's head. */}
        <GeoJSONSource
          id="markers"
          data={markersFC}
          onPress={(e) => {
            const f = e.nativeEvent.features?.[0];
            const id = (f?.properties as { id?: string } | null)?.id;
            if (id) onMarkerTap?.(String(id));
          }}
        >
          <Layer
            type="circle" id="marker-dots"
            paint={{
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 13, 9, 17, 12] as unknown as number,
              'circle-color': ['get', 'color'] as unknown as string,
              'circle-stroke-width': 2.5,
              'circle-stroke-color': '#ffffff',
            }}
          />
        </GeoJSONSource>

        {/* The driver — always on top */}
        <GeoJSONSource id="vehicle" data={vehicleFC}>
          <Layer
            type="circle" id="vehicle-dot"
            paint={{
              'circle-radius': 7, 'circle-color': COLOR_VEHICLE,
              'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff',
            }}
          />
        </GeoJSONSource>

        {/* Area names over everything */}
        <GeoJSONSource id="area-labels" data={areasData}>
          <Layer
            type="symbol" id="area-label"
            paint={{ 'text-color': COLOR_AREA, 'text-halo-color': '#ffffff', 'text-halo-width': 1.6 }}
            layout={{
              'text-field': ['get', 'name'] as unknown as string,
              'text-font': ['Noto Sans Bold'],
              'text-size': 12,
              visibility: showAreas ? 'visible' : 'none',
            }}
          />
        </GeoJSONSource>
      </MLMap>
    </View>
  );
});
