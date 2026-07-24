import 'leaflet/dist/leaflet.css';
import 'leaflet-defaulticon-compatibility';
import 'leaflet-defaulticon-compatibility/dist/leaflet-defaulticon-compatibility.css';

import { useEffect } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet';

export interface MapPoint {
  lat: number;
  lon: number;
  speedKmh: number;
  recordedAt: string;
}

function FitBounds({ line }: { line: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (line.length > 1) map.fitBounds(line, { padding: [28, 28], maxZoom: 17 });
    else if (line.length === 1) map.setView(line[0], 15);
  }, [line, map]);
  return null;
}

function segmentColor(speedKmh: number) {
  if (speedKmh < 40) return '#059669';
  if (speedKmh < 80) return '#d97706';
  return '#dc2626';
}

export function LeafletMap({ points }: { points: (MapPoint | null)[] }) {
  // Filter out null gap markers
  const valid = points.filter((p): p is MapPoint => p != null);
  const line: [number, number][] = valid.map(p => [p.lat, p.lon]);
  const center: [number, number] = line.length
    ? line[Math.floor(line.length / 2)]
    : [17.42, 78.45];

  // Build gap-aware speed-coloured segments
  type Seg = { from: [number, number]; to: [number, number]; color: string };
  const segs: Seg[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a == null || b == null) continue;
    segs.push({
      from: [a.lat, a.lon],
      to: [b.lat, b.lon],
      color: segmentColor(a.speedKmh),
    });
  }

  return (
    <MapContainer
      center={center}
      zoom={14}
      scrollWheelZoom
      style={{ height: '100%', width: '100%' }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="© OpenStreetMap contributors"
      />
      <FitBounds line={line} />

      {/* Speed-coloured polyline segments (gap-aware) */}
      {segs.map((s, i) => (
        <Polyline
          key={i}
          positions={[s.from, s.to]}
          pathOptions={{ color: s.color, weight: 5, opacity: 0.9 }}
        />
      ))}

      {/* Start — green */}
      {line.length > 0 && (
        <CircleMarker
          center={line[0]}
          radius={9}
          pathOptions={{ color: '#fff', weight: 2.5, fillColor: '#059669', fillOpacity: 1 }}
        >
          <Popup><b>Trip start</b><br />{new Date(valid[0].recordedAt).toLocaleTimeString()}</Popup>
        </CircleMarker>
      )}

      {/* Current position — violet */}
      {line.length > 0 && (
        <CircleMarker
          center={line[line.length - 1]}
          radius={10}
          pathOptions={{ color: '#fff', weight: 2.5, fillColor: '#7c3aed', fillOpacity: 1 }}
        >
          <Popup>
            <b>Current position</b><br />
            {Math.round(valid[valid.length - 1].speedKmh)} km/h<br />
            {new Date(valid[valid.length - 1].recordedAt).toLocaleTimeString()}
          </Popup>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
