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

export function LeafletMap({ points }: { points: MapPoint[] }) {
  const line: [number, number][] = points.map(p => [p.lat, p.lon]);
  const center: [number, number] = line.length
    ? line[Math.floor(line.length / 2)]
    : [17.42, 78.45];

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

      {/* Speed-coloured polyline segments */}
      {line.length > 1 && line.slice(1).map((_, i) => (
        <Polyline
          key={i}
          positions={[line[i], line[i + 1]]}
          pathOptions={{ color: segmentColor(points[i].speedKmh), weight: 5, opacity: 0.9 }}
        />
      ))}

      {/* Start — green */}
      {line.length > 0 && (
        <CircleMarker
          center={line[0]}
          radius={9}
          pathOptions={{ color: '#fff', weight: 2.5, fillColor: '#059669', fillOpacity: 1 }}
        >
          <Popup><b>Trip start</b><br />{new Date(points[0].recordedAt).toLocaleTimeString()}</Popup>
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
            {Math.round(points[points.length - 1].speedKmh)} km/h<br />
            {new Date(points[points.length - 1].recordedAt).toLocaleTimeString()}
          </Popup>
        </CircleMarker>
      )}
    </MapContainer>
  );
}
