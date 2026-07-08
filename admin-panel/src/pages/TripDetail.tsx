import { useEffect, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer } from 'react-leaflet';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { dt, km, statusBadge } from '../lib/format';
import type { Trip } from '../lib/types';

interface PathPoint {
  lat: number;
  lon: number;
  speedKmh: number;
  recordedAt: string;
}

export function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [points, setPoints] = useState<PathPoint[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api
      .get<{ trip: Trip; points?: PathPoint[] }>(`/api/trips/${id}?points=true`)
      .then((r) => {
        setTrip(r.trip);
        setPoints(r.points ?? []);
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="muted">Loading trip…</div>;
  if (!trip) return <div className="muted">Trip not found.</div>;

  const line: [number, number][] = points.map((p) => [p.lat, p.lon]);
  const start = line[0];
  const end = line[line.length - 1];
  const center: [number, number] = start ?? [17.42, 78.45];
  const driver = typeof trip.driverId === 'object' ? trip.driverId.name : 'Driver';

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">
          Trip · {driver} <span className={`badge ${statusBadge(trip.status)}`}>{trip.status}</span>
        </h1>
        <Link to="/trips" className="btn-ghost">
          ← Back to trips
        </Link>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="v">{km(trip.distanceMeters)}</div>
          <div className="k">Distance</div>
        </div>
        <div className="stat">
          <div className="v">{Math.round(trip.maxSpeedKmh)} km/h</div>
          <div className="k">Max speed</div>
        </div>
        <div className="stat">
          <div className="v">{trip.pointCount}</div>
          <div className="k">Points</div>
        </div>
        <div className="stat">
          <div className="v" style={{ fontSize: 15 }}>{dt(trip.startedAt)}</div>
          <div className="k">Started</div>
        </div>
        <div className="stat">
          <div className="v" style={{ fontSize: 15 }}>{dt(trip.endedAt)}</div>
          <div className="k">Ended</div>
        </div>
      </div>

      <div className="map-wrap" style={{ height: 'calc(100vh - 260px)' }}>
        <MapContainer center={center} zoom={14} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          {line.length > 1 && <Polyline positions={line} pathOptions={{ color: '#2f7bff', weight: 4 }} />}
          {start && (
            <CircleMarker center={start} radius={8} pathOptions={{ color: '#fff', weight: 2, fillColor: '#31d07a', fillOpacity: 1 }}>
              <Popup>Start</Popup>
            </CircleMarker>
          )}
          {end && line.length > 1 && (
            <CircleMarker center={end} radius={8} pathOptions={{ color: '#fff', weight: 2, fillColor: '#ff6b6b', fillOpacity: 1 }}>
              <Popup>End</Popup>
            </CircleMarker>
          )}
        </MapContainer>
      </div>
      {line.length === 0 && <p className="muted" style={{ marginTop: 12 }}>No location points recorded for this trip yet.</p>}
    </div>
  );
}
