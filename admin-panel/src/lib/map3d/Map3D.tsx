import type { Layer, PickingInfo } from '@deck.gl/core';
import { MapboxOverlay } from '@deck.gl/mapbox';
// Named imports rather than `import * as maplibregl` -- a namespace import's
// runtime shape depends on how the bundler interops maplibre-gl's CJS/UMD
// build, which isn't consistent across its major versions (broke silently
// switching from v5 to v6: "maplibregl.Map is not a constructor"). Named
// imports of the documented exports are reliable across both.
import { Map as MaplibreMap, NavigationControl } from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

// Free, no-API-key, no-billing vector tiles with 3D building extrusion --
// chosen over Mapbox/MapTiler specifically to avoid a new account/cost
// dependency for this internal tool.
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const DEFAULT_PITCH = 55;

export interface Map3DHandle {
  flyTo(center: [number, number], zoom?: number): void;
  /** Adjusts the camera so the whole route is on screen -- without this, the
   * fixed initial center/zoom often leaves most of a recorded path off-screen. */
  fitToRoute(coords: [number, number][]): void;
  /** Smooth camera follow that rotates the map to face the driving direction. */
  driveTo(center: [number, number], bearing: number): void;
  /** Frame a [west, south, east, north] extent -- used to jump to a work area. */
  fitBounds(bbox: [number, number, number, number], maxZoom?: number): void;
}

interface Map3DProps {
  /** Initial camera center, [lon, lat] -- only applied once, at creation. */
  center: [number, number];
  zoom?: number;
  layers: Layer[];
  onClick?: (info: PickingInfo) => void;
  getTooltip?: (info: PickingInfo) => { html: string } | null;
  /** Camera tilt. Trip playback wants the default 55; a coverage choropleth is
   *  read as a plan and wants 0, where tilt only distorts relative area. */
  pitch?: number;
  /** Fires after the camera settles, with the visible [w, s, e, n] and zoom.
   *  The coverage map loads road links per viewport off this -- 654k links can
   *  never all be on screen, so what is drawn is decided by where you are. */
  onMoveEnd?: (bbox: [number, number, number, number], zoom: number) => void;
}

export const Map3D = forwardRef<Map3DHandle, Map3DProps>(function Map3D(
  { center, zoom = 14, layers, onClick, getTooltip, pitch = DEFAULT_PITCH, onMoveEnd },
  ref
) {
  // Read through refs inside the map effect and the imperative handle: both run once, so a
  // captured prop would freeze at its first value.
  const pitchRef = useRef(pitch);
  pitchRef.current = pitch;
  const moveEndRef = useRef(onMoveEnd);
  moveEndRef.current = onMoveEnd;
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  // Starts optimistic; flips false if WebGL init fails synchronously or the
  // GPU/context fails to come up (maplibre-gl v6 has no upfront capability
  // check, so failures only surface via a thrown error or an 'error' event).
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    if (!containerRef.current) return;

    let map: MaplibreMap;
    try {
      map = new MaplibreMap({
        container: containerRef.current,
        style: MAP_STYLE,
        center,
        zoom,
        pitch: pitchRef.current,
      });
    } catch (err) {
      console.error('Map3D: maplibre-gl failed to initialize', err);
      setSupported(false);
      return;
    }

    const handleError = (e: { error?: { name?: string; message?: string } }) => {
      console.error('Map3D: maplibre-gl error event', e.error);
      if (e.error?.name === 'GPUInitializationError') setSupported(false);
    };
    map.on('error', handleError);
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');

    // 'moveend' rather than 'move': a viewport-driven fetch on every animation frame of a pan
    // would fire dozens of requests for camera positions nobody stopped at.
    const handleMoveEnd = () => {
      const cb = moveEndRef.current;
      if (!cb) return;
      const b = map.getBounds();
      cb([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], map.getZoom());
    };
    map.on('moveend', handleMoveEnd);
    map.once('load', handleMoveEnd);

    const overlay = new MapboxOverlay({ interleaved: true, layers, onClick, getTooltip });
    map.addControl(overlay);

    mapRef.current = map;
    overlayRef.current = overlay;

    // MapLibre sizes its canvas once and then only on a window `resize`. Collapsing the
    // sidebar changes this container's width with no window event, leaving a blank strip and
    // a canvas whose coordinates no longer line up with the pointer. Observing the container
    // catches the sidebar rail, the mobile drawer and ordinary window resizes alike.
    let frame = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => map.resize());
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(frame);
      map.off('error', handleError);
      map.off('moveend', handleMoveEnd);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
    // Only ever created once -- center/zoom below are initial values only,
    // camera moves after that go through the imperative flyTo handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    overlayRef.current?.setProps({ layers, onClick, getTooltip });
    // Interleaved mode draws through MapLibre's own paint cycle, which only
    // repaints on camera/style changes by default. Without an explicit nudge
    // here, a layer that's animating (e.g. the replay vehicle) while the
    // camera sits still could update its data every frame but never actually
    // get redrawn to the screen.
    mapRef.current?.triggerRepaint();
  }, [layers, onClick, getTooltip]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(target, targetZoom) {
        const map = mapRef.current;
        if (!map) return;
        map.flyTo({ center: target, zoom: targetZoom ?? map.getZoom(), pitch: pitchRef.current, essential: true });
      },
      driveTo(target, bearing) {
        const map = mapRef.current;
        if (!map) return;
        map.easeTo({ center: target, zoom: 17.5, pitch: 65, bearing, duration: 600, essential: true });
      },
      fitToRoute(coords) {
        const map = mapRef.current;
        if (!map || coords.length === 0) return;
        if (coords.length === 1) {
          map.flyTo({ center: coords[0], zoom: 15, pitch: pitchRef.current, essential: true });
          return;
        }
        let minLon = coords[0][0];
        let maxLon = coords[0][0];
        let minLat = coords[0][1];
        let maxLat = coords[0][1];
        for (const [lon, lat] of coords) {
          if (lon < minLon) minLon = lon;
          if (lon > maxLon) maxLon = lon;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
        map.fitBounds(
          [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
          { padding: 60, maxZoom: 17, pitch: pitchRef.current, duration: 800 }
        );
      },
      fitBounds(bbox, maxZoom = 15) {
        const map = mapRef.current;
        if (!map) return;
        const [w, s, e, n] = bbox;
        if (![w, s, e, n].every(Number.isFinite)) return;
        map.fitBounds(
          [
            [w, s],
            [e, n],
          ],
          { padding: 48, maxZoom, pitch: pitchRef.current, duration: 700 }
        );
      },
    }),
    []
  );

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      {!supported && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--panel)',
            color: 'var(--muted)',
            fontSize: 13,
            textAlign: 'center',
            padding: 24,
          }}
        >
          3D view isn't supported in this browser. Try a recent Chrome, Edge, or Firefox.
        </div>
      )}
    </div>
  );
});
