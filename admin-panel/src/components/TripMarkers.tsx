import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconLayer } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { api } from '../lib/api';

/**
 * Markers the driver dropped DURING one trip, drawn on that trip's own map.
 *
 * The Markers tab answers "what got flagged across the fleet"; this answers "what happened on
 * THIS drive" — the reviewer is already looking at the route, so the flag belongs on it, with
 * the same card the driver saw: category · driver + plate · time · age · Google Maps link.
 *
 * Usage (SessionMap / TripDetail):
 *   const tripMarkers = useTripMarkers(tripId);
 *   layers: [...buildX(...), ...tripMarkers.layers]
 *   <Map3D onClick={tripMarkers.onMapClick} ... />  then render {tripMarkers.popup} inside
 *   the (position: relative) map wrapper.
 */

export type TripMarker = {
  id: string;
  lat: number;
  lon: number;
  category: { id: string; name: string; color: string } | null;
  driverName: string | null;
  vehiclePlate: string | null;
  note: string | null;
  recordedAt: string;
};

/**
 * Category-coloured map pin (teardrop + car glyph on a white disc) as an SVG data URL —
 * the same artwork the driver app rasterises in its WebView, so both sides match.
 */
const pinUrlCache = new Map<string, string>();
function pinUrl(color: string | undefined): string {
  const c = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#ef4444';
  let u = pinUrlCache.get(c);
  if (!u) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="64" viewBox="0 0 48 64">' +
      `<path d="M24 2C12.4 2 3 11.4 3 23c0 15.8 21 39 21 39s21-23.2 21-39C45 11.4 35.6 2 24 2z" fill="${c}" stroke="#ffffff" stroke-width="2.5"/>` +
      '<circle cx="24" cy="23" r="13" fill="#ffffff"/>' +
      `<path d="M16 24.5l1.9-5.4c.3-.9 1.2-1.5 2.1-1.5h8c.9 0 1.8.6 2.1 1.5l1.9 5.4c.9.3 1.5 1.2 1.5 2.1v4.5c0 .6-.5 1-1 1h-1.4c-.6 0-1-.4-1-1v-1H18v1c0 .6-.4 1-1 1h-1.4c-.5 0-1-.4-1-1v-4.5c0-.9.6-1.8 1.4-2.1z" fill="${c}"/>` +
      '<rect x="19" y="19.6" width="10" height="4.2" rx="1" fill="#ffffff"/>' +
      '<circle cx="19.6" cy="27.7" r="1.5" fill="#ffffff"/>' +
      '<circle cx="28.4" cy="27.7" r="1.5" fill="#ffffff"/>' +
      '</svg>';
    u = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    pinUrlCache.set(c, u);
  }
  return u;
}

function fmtWhen(iso: string) {
  return new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function age(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
}

export function useTripMarkers(tripId: string | undefined) {
  const [markers, setMarkers] = useState<TripMarker[]>([]);
  const [picked, setPicked] = useState<TripMarker | null>(null);

  useEffect(() => {
    if (!tripId) return;
    let alive = true;
    api
      .get<{ markers: TripMarker[] }>(`/api/markers?tripId=${encodeURIComponent(tripId)}`)
      .then((r) => { if (alive) setMarkers(r.markers); })
      .catch(() => { /* markers are auxiliary — the trip view must not degrade over them */ });
    return () => { alive = false; };
  }, [tripId]);

  const layers = useMemo<Layer[]>(() => {
    if (markers.length === 0) return [];
    return [
      new IconLayer<TripMarker>({
        id: 'trip-markers',
        data: markers,
        getPosition: (m) => [m.lon, m.lat, 3],
        getIcon: (m) => ({
          url: pinUrl(m.category?.color),
          width: 48,
          height: 64,
          // The pin's TIP marks the spot, not its centre.
          anchorY: 62,
        }),
        // Metres, not pixels: a pixel-fixed pin stays huge when the reviewer zooms out to see
        // the whole route. In metres it shrinks with the view, clamped so it can neither
        // vanish at country scale nor balloon at street scale.
        getSize: 30,
        sizeUnits: 'meters',
        sizeMinPixels: 18,
        sizeMaxPixels: 52,
        pickable: true,
        // Same always-on-top treatment as the start/end discs (TripPathLayer.ts): a marker
        // whose whole job is "be seen" must not hide behind tilted 3D buildings.
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    ];
  }, [markers]);

  const onMapClick = useCallback((info: PickingInfo) => {
    if (info.layer?.id === 'trip-markers' && info.object) {
      setPicked(info.object as TripMarker);
    } else {
      setPicked(null);
    }
  }, []);

  const popup = picked ? (
    <div
      style={{
        position: 'absolute', left: 12, bottom: 12, zIndex: 2,
        background: 'var(--panel, #ffffff)', border: '1px solid var(--line-2, #e2e8f0)',
        borderRadius: 10, padding: '10px 12px', minWidth: 220, maxWidth: 300,
        boxShadow: '0 4px 14px rgba(15,23,42,0.18)', fontSize: 13,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <b>{picked.category?.name ?? 'Marker'}</b>
        <button
          onClick={() => setPicked(null)}
          aria-label="Close"
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--muted, #64748b)', fontSize: 13 }}
        >
          ✕
        </button>
      </div>
      <div style={{ color: 'var(--muted, #64748b)', margin: '2px 0 6px' }}>
        {[
          [picked.driverName, picked.vehiclePlate].filter(Boolean).join(' '),
          fmtWhen(picked.recordedAt),
          age(picked.recordedAt),
        ].filter(Boolean).join(' · ')}
      </div>
      {picked.note && <div style={{ marginBottom: 6 }}>{picked.note}</div>}
      <a
        href={`https://www.google.com/maps/search/?api=1&query=${picked.lat},${picked.lon}`}
        target="_blank"
        rel="noreferrer"
      >
        Open in Google Maps ↗
      </a>
    </div>
  ) : null;

  return { markers, layers, onMapClick, popup };
}
