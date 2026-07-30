import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { km, dt } from '../lib/format';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';
import { buildLivePathLayers } from '../lib/map3d/TripPathLayer';
import { useInterpolatedPosition } from '../lib/map3d/useInterpolatedPosition';
import type { Trip } from '../lib/types';

interface Point {
  lat: number;
  lon: number;
  speedKmh: number;
  heading?: number | null;
  recordedAt: string;
}

export function SessionMap() {
  const { id } = useParams<{ id: string }>();          // tripId
  const [trip, setTrip]     = useState<Trip | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mapRef = useRef<Map3DHandle>(null);

  const fetchData = async (silent = false) => {
    if (!id) return;
    if (!silent) setLoading(true);
    try {
      const r = await api.get<{ trip: Trip; points?: Point[] }>(
        `/api/trips/${id}?points=true`
      );
      setTrip(r.trip);
      // Backend may insert null gap markers — filter them for clean rendering
      setPoints((r.points ?? []).filter((p): p is Point => p != null));
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

  const latest = points[points.length - 1] ?? null;
  const animatedVehicle = useInterpolatedPosition(
    latest ? { lat: latest.lat, lon: latest.lon, heading: latest.heading, recordedAt: latest.recordedAt } : null,
    trip ? trip.status !== 'active' : false
  );

  // Keep the whole recorded route in view as it grows -- matches the old
  // Leaflet FitBounds behavior. A fixed center/zoom on just the latest point
  // left most of the path off-screen for anything longer than a short hop.
  useEffect(() => {
    if (points.length > 0) {
      mapRef.current?.fitToRoute(points.map((p) => [p.lon, p.lat]));
    }
  }, [points]);

  const layers = useMemo(
    () => buildLivePathLayers(points, animatedVehicle, trip ? trip.status !== 'active' : false),
    [points, animatedVehicle, trip]
  );

  if (loading) return <div className="muted" style={{ padding: 32 }}>Loading session…</div>;
  if (!trip)   return <div className="muted" style={{ padding: 32 }}>Trip not found.</div>;

  const start: [number, number] = points[0] ? [points[0].lon, points[0].lat] : [78.45, 17.42];
  const driverName = typeof trip.driverId === 'object' ? trip.driverId.name : 'Driver';
  const plate      = trip.vehicleId && typeof trip.vehicleId === 'object' ? trip.vehicleId.plateNumber : null;

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
      <div className="map-wrap" style={{ height: 'calc(100vh - 300px - var(--topbar-h))', minHeight: 420 }}>
        <Map3D ref={mapRef} center={start} zoom={14} layers={layers} />
      </div>

      {points.length === 0 && (
        <p style={{ color: 'var(--muted)', marginTop: 12, fontSize: 13 }}>
          No GPS points recorded yet for this session.
        </p>
      )}
    </div>
  );
}
