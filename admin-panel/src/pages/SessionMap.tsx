import { useEffect, useRef, useState } from 'react';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
} from 'react-leaflet';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { km, dt } from '../lib/format';
import type { Trip } from '../lib/types';

interface Point {
  lat: number;
  lon: number;
  speedKmh: number;
  recordedAt: string;
}

/** Auto-fit the map to the polyline bounds whenever the points change */
function FitBounds({ line }: { line: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (line.length > 1) {
      map.fitBounds(line, { padding: [32, 32], maxZoom: 17 });
    } else if (line.length === 1) {
      map.setView(line[0], 15);
    }
  }, [line, map]);
  return null;
}

export function SessionMap() {
  const { id } = useParams<{ id: string }>();          // tripId
  const [trip, setTrip]     = useState<Trip | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = async (silent = false) => {
    if (!id) return;
    if (!silent) setLoading(true);
    try {
      const r = await api.get<{ trip: Trip; points?: Point[] }>(
        `/api/trips/${id}?points=true`
      );
      setTrip(r.trip);
      setPoints(r.points ?? []);
      setLastRefresh(new Date());
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 10 s while the trip is still active
    intervalRef.current = setInterval(() => fetchData(true), 10_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Stop auto-refresh once trip is no longer active
  useEffect(() => {
    if (trip && trip.status !== 'active' && intervalRef.current) {
      clearInterval(intervalRef.current);
    }
  }, [trip]);

  if (loading) return <div className="muted" style={{ padding: 32 }}>Loading session…</div>;
  if (!trip)   return <div className="muted" style={{ padding: 32 }}>Trip not found.</div>;

  const line: [number, number][] = points.map(p => [p.lat, p.lon]);
  const start  = line[0];
  const latest = line[line.length - 1];
  const center: [number, number] = start ?? [17.42, 78.45];

  const driverName = typeof trip.driverId === 'object' ? trip.driverId.name : 'Driver';
  const plate      = trip.vehicleId && typeof trip.vehicleId === 'object' ? trip.vehicleId.plateNumber : null;

  // Speed-colour gradient for each segment (green → amber → red)
  const segmentColors = points.slice(1).map((_, i) => {
    const spd = points[i].speedKmh;
    if (spd < 40)  return '#059669'; // green
    if (spd < 80)  return '#d97706'; // amber
    return '#dc2626';                // red
  });

  return (
    <div>
      {/* Header */}
      <div className="page-head">
        <div>
          <h1 className="page-title">
            Session Map
            <span
              className={`badge ${trip.status === 'active' ? 'green' : trip.status === 'completed' ? 'gray' : 'amber'}`}
              style={{ marginLeft: 10, verticalAlign: 'middle' }}
            >
              {trip.status === 'active' ? '● Live' : trip.status}
            </span>
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            {driverName}{plate ? ` · ${plate}` : ''} · Started {dt(trip.startedAt)}
            {lastRefresh && trip.status === 'active' && (
              <span style={{ marginLeft: 8, color: 'var(--muted)' }}>
                · updated {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {trip.status === 'active' && (
            <button className="btn" onClick={() => fetchData(true)}>↻ Refresh</button>
          )}
          <Link to="/trips" className="btn-ghost">← Trips</Link>
        </div>
      </div>

      {/* Stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="v">{km(trip.distanceMeters)}</div>
          <div className="k">Distance</div>
        </div>
        <div className="stat">
          <div className="v">{Math.round(trip.maxSpeedKmh)} <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>km/h</span></div>
          <div className="k">Top speed</div>
        </div>
        <div className="stat">
          <div className="v">{points.length}</div>
          <div className="k">GPS points</div>
        </div>
        <div className="stat">
          <div className="v" style={{ fontSize: 14 }}>{dt(trip.startedAt)}</div>
          <div className="k">Started</div>
        </div>
        {trip.endedAt && (
          <div className="stat">
            <div className="v" style={{ fontSize: 14 }}>{dt(trip.endedAt)}</div>
            <div className="k">Ended</div>
          </div>
        )}
      </div>

      {/* Speed legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, fontSize: 12, color: 'var(--muted)' }}>
        <span style={{ fontWeight: 600 }}>Speed:</span>
        {[['#059669','< 40 km/h'], ['#d97706','40–80 km/h'], ['#dc2626','> 80 km/h']].map(([color, label]) => (
          <span key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ display: 'inline-block', width: 28, height: 4, borderRadius: 2, background: color }} />
            {label}
          </span>
        ))}
      </div>

      {/* Map */}
      <div className="map-wrap" style={{ height: 'calc(100vh - 300px)', minHeight: 420 }}>
        <MapContainer
          center={center}
          zoom={14}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
          // prefer canvas renderer for GPU acceleration
          renderer={undefined}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <FitBounds line={line} />

          {/* Speed-coloured segments */}
          {line.length > 1 && line.slice(1).map((_, i) => (
            <Polyline
              key={i}
              positions={[line[i], line[i + 1]]}
              pathOptions={{ color: segmentColors[i], weight: 5, opacity: 0.9 }}
            />
          ))}

          {/* Start marker — green */}
          {start && (
            <CircleMarker
              center={start}
              radius={9}
              pathOptions={{ color: '#fff', weight: 2.5, fillColor: '#059669', fillOpacity: 1 }}
            >
              <Popup><b>Trip start</b><br />{dt(points[0]?.recordedAt)}</Popup>
            </CircleMarker>
          )}

          {/* Latest / current position — violet */}
          {latest && line.length > 0 && (
            <CircleMarker
              center={latest}
              radius={10}
              pathOptions={{ color: '#fff', weight: 2.5, fillColor: '#7c3aed', fillOpacity: 1 }}
            >
              <Popup>
                <b>{trip.status === 'active' ? 'Current position' : 'Trip end'}</b><br />
                {Math.round(points[points.length - 1]?.speedKmh ?? 0)} km/h<br />
                {dt(points[points.length - 1]?.recordedAt)}
              </Popup>
            </CircleMarker>
          )}
        </MapContainer>
      </div>

      {points.length === 0 && (
        <p style={{ color: 'var(--muted)', marginTop: 12, fontSize: 13 }}>
          No GPS points recorded yet for this session.
        </p>
      )}
    </div>
  );
}
