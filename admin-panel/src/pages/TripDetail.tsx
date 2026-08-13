import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DistanceModeToggle, type DistanceMode } from '../components/DistanceModeToggle';
import { ExportButtons } from '../components/ExportButtons';
import { api, downloadFile } from '../lib/api';
import { km, sessionDt, statusBadge } from '../lib/format';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';
import { buildReplayLayers, vehicleAtElapsed } from '../lib/map3d/TripPathLayer';
import { useTripPlayback } from '../lib/map3d/useTripPlayback';
import { decodeRouteShapes } from '../lib/polyline';
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

/**
 * Why this distinguishes two cases instead of printing one line: `trip.pointCount` is a counter
 * stored on the trip document as points are ingested, NOT a live count of what the
 * locationpoints collection currently holds. The two diverge the moment points are removed
 * behind the app's back, and the trip then displays a full set of summary stats (distance, max
 * speed, a point count in the thousands) beside an empty map. Saying "not recorded yet" there is
 * actively misleading — the points were recorded, and nothing is coming to fill the gap.
 */
function NoPointsNotice({ pointCount }: { pointCount: number }) {
  const wereRecorded = pointCount > 0;
  return (
    <p className="muted" style={{ marginTop: 12 }}>
      {wereRecorded ? (
        <>
          This trip’s {pointCount.toLocaleString()} recorded location points are no longer available, so its
          route can’t be drawn. The distance, speed and timing figures above were accumulated as the trip
          ran and are unaffected.
        </>
      ) : (
        'No location points recorded for this trip yet.'
      )}
    </p>
  );
}

/**
 * How much of the snapped route is genuinely road-matched.
 *
 * Only rendered in "cleaned" mode, and only when the answer is not "essentially all of it".
 * Where a trace can't be matched — a vehicle circling a car park, or a device that logged 63
 * fixes across 20 km — the backend keeps that stretch's raw GPS geometry rather than dropping it,
 * which keeps the line unbroken but means the route on screen is partly raw. Without this the two
 * cases are indistinguishable: both are just a line on a map, and the more broken the underlying
 * data, the more confident the result looks.
 */
function SnapCoverage({ ratio }: { ratio: number }) {
  const percent = Math.round(ratio * 100);
  const low = percent < 60;
  return (
    <span
      title={`${percent}% of this trip was matched to roads. The rest kept its raw GPS trace because it could not be snapped — usually sparse or missing fixes, or manoeuvring off the road network.`}
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color: low ? 'var(--danger, #dc2626)' : 'var(--muted)',
        background: low ? 'rgba(220,38,38,0.10)' : 'var(--bg)',
      }}
    >
      {percent}% snapped
    </span>
  );
}

export function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [points, setPoints] = useState<PathPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<DistanceMode>('raw');
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

  const cleanedAvailable = trip?.mapMatchStatus === 'matched' && !!trip.cleanedRouteShapes?.length;
  const snappedPath = useMemo(
    () => (mode === 'cleaned' ? decodeRouteShapes(trip?.cleanedRouteShapes) : null),
    [mode, trip]
  );

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
    () => buildReplayLayers(points, playback.currentTimeMs, playback.playing, snappedPath),
    [points, playback.currentTimeMs, playback.playing, snappedPath]
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
          <DistanceModeToggle mode={mode} onChange={setMode} cleanedAvailable={cleanedAvailable} />
          <ExportButtons onExport={(format) => downloadFile(`/api/trips/${id}/export?format=${format}`)} />
          <Link to="/trips" className="btn-ghost">
            ← Back to trips
          </Link>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="v">{km(mode === 'cleaned' && trip.cleanedDistanceMeters != null ? trip.cleanedDistanceMeters : trip.distanceMeters)}</div>
          <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span>Distance{mode === 'cleaned' ? ' (snapped)' : ''}</span>
            {mode === 'cleaned' && trip.cleanedMatchedRatio != null && trip.cleanedMatchedRatio < 0.98 && (
              <SnapCoverage ratio={trip.cleanedMatchedRatio} />
            )}
          </div>
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
          <div className="v" style={{ fontSize: 15 }}>{sessionDt(trip.startedAt)}</div>
          <div className="k">Started</div>
        </div>
        <div className="stat">
          <div className="v" style={{ fontSize: 15 }}>{sessionDt(trip.endedAt)}</div>
          <div className="k">Ended</div>
        </div>
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

      {points.length === 0 && <NoPointsNotice pointCount={trip.pointCount} />}
    </div>
  );
}
