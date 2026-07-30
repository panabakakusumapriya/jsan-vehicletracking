import { useEffect } from 'react';
import { useMap } from 'react-leaflet';

/**
 * Keeps a Leaflet map filling its container.
 *
 * Leaflet caches its pixel size and only recomputes on a window `resize`. Collapsing the
 * sidebar changes the map's width without the window changing at all, so the canvas keeps its
 * old width and the map is left with a blank strip down one side — and clicks land in the
 * wrong place, because Leaflet is still converting coordinates against the stale size.
 *
 * A ResizeObserver on the container covers every cause: the sidebar rail, the mobile drawer,
 * a window resize, and the panel being shown after being hidden.
 *
 * Drop `<MapAutoResize />` inside any <MapContainer>.
 */
export function MapAutoResize() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    let frame = 0;

    const settle = () => {
      // Coalesce the burst of callbacks a CSS transition produces into one invalidate per
      // frame; invalidateSize itself is cheap but it also fires `moveend` listeners.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => map.invalidateSize({ animate: false }));
    };

    const observer = new ResizeObserver(settle);
    observer.observe(container);
    // The sidebar animates for ~180ms, and the observer fires throughout; this catches the
    // final size in case the last callback lands mid-transition.
    const done = window.setTimeout(settle, 260);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(done);
    };
  }, [map]);

  return null;
}
