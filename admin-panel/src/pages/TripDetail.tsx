import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ExportButtons } from '../components/ExportButtons';
import { api, downloadFile } from '../lib/api';
import { dt, km, statusBadge } from '../lib/format';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';
import { buildReplayLayers, vehicleAtElapsed } from '../lib/map3d/TripPathLayer';
import { useTripPlayback } from '../lib/map3d/useTripPlayback';
import type { Trip } from '../lib/types';

interface PathPoint {
  lat: number;
  lon: number;
  speedKmh: number;
  heading?: number | null;
  recordedAt: string;
}

const SPEEDS = [1, 4, 16];

function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [points, setPoints] = useState<PathPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const mapRef = useRef<Map3DHandle>(null);
  const lastFlyRef = useRef(0);

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

  // Show the whole recorded route, not just a fixed zoom on its first point.
  useEffect(() => {
    if (points.length > 0) {
      mapRef.current?.fitToRoute(points.map((p) => [p.lon, p.lat]));
    }
  }, [points]);

  const playback = useTripPlayback(points);

  // Camera follows the vehicle during playback — rotates to face the driving
  // direction so it feels like you're travelling along the route. Throttled to
  // ~500ms for smooth continuous movement without overwhelming the map.
  useEffect(() => {
    if (!playback.playing || points.length === 0) return;
    const now = Date.now();
    if (now - lastFlyRef.current < 500) return;
    lastFlyRef.current = now;
    const vehicle = vehicleAtElapsed(points, playback.currentTimeMs);
    if (vehicle) {
      mapRef.current?.driveTo([vehicle.lon, vehicle.lat], vehicle.heading);
    }
  }, [playback.currentTimeMs, playback.playing, points]);

  const layers = useMemo(
    () => buildReplayLayers(points, playback.currentTimeMs, playback.playing),
    [points, playback.currentTimeMs, playback.playing]
  );

  if (loading) return <div className="muted">Loading trip…</div>;
  if (!trip) return <div className="muted">Trip not found.</div>;

  const start: [number, number] = points[0] ? [points[0].lon, points[0].lat] : [78.45, 17.42];
  const driver = typeof trip.driverId === 'object' ? trip.driverId.name : 'Driver';

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">
          Trip · {driver} <span className={`badge ${statusBadge(trip.status)}`}>{trip.status}</span>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <ExportButtons onExport={(format) => downloadFile(`/api/trips/${id}/export?format=${format}`)} />
          <Link to="/trips" className="btn-ghost">
            ← Back to trips
          </Link>
        </div>
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
        {trip.timezone && (
          <div className="stat">
            <div className="v" style={{ fontSize: 14 }}>{trip.timezone}</div>
            <div className="k">Timezone</div>
          </div>
        )}
      </div>

      <div className="map-wrap" style={{ height: 'calc(100vh - 340px - var(--topbar-h))', minHeight: 380 }}>
        <Map3D ref={mapRef} center={start} zoom={14} layers={layers} />
      </div>

      {points.length > 1 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 12,
            padding: '10px 14px', background: 'var(--panel)', border: '1px solid var(--line-2)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <button
            className="btn"
            style={{ minWidth: 72 }}
            onClick={() => {
              if (playback.playing) {
                playback.pause();
                // Zoom back to full route on pause
                if (points.length > 0) {
                  mapRef.current?.fitToRoute(points.map(p => [p.lon, p.lat]));
                }
              } else {
                playback.play();
                lastFlyRef.current = 0;
                // Immediately enter driving view on play start
                const startMs = playback.currentTimeMs >= playback.durationMs ? 0 : playback.currentTimeMs;
                const pos = vehicleAtElapsed(points, startMs);
                if (pos) {
                  mapRef.current?.driveTo([pos.lon, pos.lat], pos.heading);
                }
              }
            }}
          >
            {playback.playing ? '⏸ Pause' : '▶ Play'}
          </button>

          <span style={{ fontSize: 12.5, color: 'var(--muted)', fontFamily: 'monospace', minWidth: 90 }}>
            {formatClock(playback.currentTimeMs)} / {formatClock(playback.durationMs)}
          </span>

          <input
            type="range"
            min={0}
            max={playback.durationMs}
            value={playback.currentTimeMs}
            onChange={(e) => playback.seek(Number(e.target.value))}
            style={{ flex: 1 }}
          />

          <div style={{ display: 'flex', gap: 4 }}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className="btn-ghost"
                style={{
                  padding: '4px 9px', fontSize: 12, fontWeight: 700,
                  background: playback.speed === s ? 'var(--brand-light)' : undefined,
                  color: playback.speed === s ? 'var(--brand)' : undefined,
                }}
                onClick={() => playback.setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}

      {points.length === 0 && <p className="muted" style={{ marginTop: 12 }}>No location points recorded for this trip yet.</p>}
    </div>
  );
}
