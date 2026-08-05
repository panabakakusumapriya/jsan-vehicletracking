import { useEffect, useMemo, useRef, useState } from 'react';
import { ExportButtons } from '../components/ExportButtons';
import { api, downloadFile } from '../lib/api';
import { km } from '../lib/format';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';
import { buildReplayLayers, vehicleAtElapsed } from '../lib/map3d/TripPathLayer';
import { useTripPlayback } from '../lib/map3d/useTripPlayback';
import type { User } from '../lib/types';

interface PathPoint {
  lat: number;
  lon: number;
  speedKmh: number;
  heading?: number | null;
  recordedAt: string;
}

interface TripSegment {
  tripId: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  distanceMeters: number;
  maxSpeedKmh: number;
  points: PathPoint[];
}

interface MergedData {
  driverName: string;
  vehiclePlate: string | null;
  date: string;
  totalTrips: number;
  totalDistance: number;
  maxSpeed: number;
  totalPoints: number;
  trips: TripSegment[];
}

interface MergedSummary {
  driverId: string;
  driverName: string;
  date: string;
  totalTrips: number;
  totalDistance: number;
  maxSpeed: number;
  firstStart: string;
  lastEnd: string | null;
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

const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
);

const ReportIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
);

export function Reports() {
  const [drivers, setDrivers] = useState<User[]>([]);
  const [country, setCountry] = useState('');
  const [driverId, setDriverId] = useState('');
  const [date, setDate] = useState('');
  const [merged, setMerged] = useState<MergedData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<MergedSummary[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const mapRef = useRef<Map3DHandle>(null);
  const lastFlyRef = useRef(0);

  useEffect(() => {
    api.get<{ users: User[] }>('/api/users?role=user').then(r => setDrivers(r.users));
  }, []);

  // Load the overview summary when no filters are selected
  useEffect(() => {
    if (driverId && date) return;
    setSummaryLoading(true);
    setError(null);
    api.get<{ summaries: MergedSummary[] }>('/api/trips/merged-summary?limit=200')
      .then(r => setSummaries(r.summaries ?? []))
      .catch(e => {
        setSummaries([]);
        setError(e instanceof Error ? e.message : 'Failed to load reports');
      })
      .finally(() => setSummaryLoading(false));
  }, [driverId, date]);

  // Fetch merged data when driver + date are both set
  useEffect(() => {
    if (!driverId || !date) {
      setMerged(null);
      return;
    }
    setLoading(true);
    setError(null);
    api.get<MergedData>(`/api/trips/merged-points?driverId=${driverId}&date=${date}`)
      .then(r => {
        setMerged(r);
        if (r.totalTrips === 0) {
          setError('No trips found for this driver on this date.');
        }
      })
      .catch(e => {
        setMerged(null);
        setError(e instanceof Error ? e.message : 'Failed to load data');
      })
      .finally(() => setLoading(false));
  }, [driverId, date]);

  // Merge all trip points into a single array for playback
  const allPoints = useMemo(() => {
    if (!merged) return [];
    return merged.trips.flatMap(t => t.points);
  }, [merged]);

  // Fit map to merged route
  useEffect(() => {
    if (allPoints.length > 0) {
      mapRef.current?.fitToRoute(allPoints.map(p => [p.lon, p.lat]));
    }
  }, [allPoints]);

  const playback = useTripPlayback(allPoints);
  const layers = useMemo(
    () => buildReplayLayers(allPoints, playback.currentTimeMs, playback.playing),
    [allPoints, playback.currentTimeMs, playback.playing]
  );

  // Auto-zoom to where the car is during playback (throttled to ~1s)
  useEffect(() => {
    if (!playback.playing || allPoints.length === 0) return;
    const now = Date.now();
    if (now - lastFlyRef.current < 1000) return;
    lastFlyRef.current = now;
    const vehicle = vehicleAtElapsed(allPoints, playback.currentTimeMs);
    if (vehicle) {
      mapRef.current?.flyTo([vehicle.lon, vehicle.lat], 16);
    }
  }, [playback.currentTimeMs, playback.playing, allPoints]);

  const countries = Array.from(new Set(drivers.map(d => d.country).filter(Boolean))).sort() as string[];
  const filteredDrivers = country ? drivers.filter(d => d.country === country) : drivers;

  const handleExport = (format: 'kml' | 'json') => {
    if (driverId && date) {
      return downloadFile(`/api/trips/export-merged?driverId=${driverId}&date=${date}&format=${format}`);
    }
    // Bulk export: all trips matching current filters
    const params = new URLSearchParams({ format });
    if (driverId) params.set('driverId', driverId);
    if (country) {
      const ids = drivers.filter(d => d.country === country).map(d => d._id);
      if (ids.length) params.set('driverIds', ids.join(','));
    }
    return downloadFile(`/api/trips/export?${params.toString()}`);
  };

  const selectedDriver = drivers.find(d => d._id === driverId);
  const center: [number, number] = allPoints.length > 0
    ? [allPoints[0].lon, allPoints[0].lat]
    : [78.45, 17.42];

  const showDetail = driverId && date;

  // Filter summaries client-side by partial filters (driver only, date only, country)
  const filteredSummaries = useMemo(() => {
    let list = summaries;
    if (driverId) {
      list = list.filter(s => s.driverId === driverId);
    }
    if (date) {
      list = list.filter(s => s.date === date);
    }
    if (country) {
      const countryDriverIds = new Set(drivers.filter(d => d.country === country).map(d => d._id));
      list = list.filter(s => countryDriverIds.has(s.driverId));
    }
    return list;
  }, [summaries, driverId, date, country, drivers]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ReportIcon /> Reports
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            View merged daily routes per driver
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FilterIcon />
          <select
            className="input"
            style={{ width: 140, margin: 0 }}
            value={country}
            onChange={e => { setCountry(e.target.value); setDriverId(''); }}
          >
            <option value="">All countries</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            className="input"
            style={{ width: 170, margin: 0 }}
            value={driverId}
            onChange={e => setDriverId(e.target.value)}
          >
            <option value="">Select driver</option>
            {filteredDrivers.map(d => (
              <option key={d._id} value={d._id}>{d.name}</option>
            ))}
          </select>
          <input
            className="input"
            type="date"
            style={{ width: 160, margin: 0 }}
            value={date}
            onChange={e => setDate(e.target.value)}
          />
          {(country || driverId || date) && (
            <button
              className="btn-ghost"
              style={{ padding: '6px 10px', fontSize: 12.5 }}
              onClick={() => { setCountry(''); setDriverId(''); setDate(''); }}
            >
              Clear
            </button>
          )}
          <ExportButtons onExport={handleExport} />
        </div>
      </div>

      {!showDetail ? (
        /* Overview: all merged trip summaries */
        summaryLoading ? (
          <div className="muted" style={{ padding: 40, textAlign: 'center' }}>Loading reports...</div>
        ) : error && summaries.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--danger, #e53e3e)' }}>
            {error}
          </div>
        ) : filteredSummaries.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--muted)' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'var(--text-2)' }}>
              No trip reports yet
            </div>
            <div style={{ fontSize: 13 }}>
              Once drivers complete trips, merged daily reports will appear here. Use the filters above to drill into a specific driver and date.
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table>
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Date</th>
                  <th>Trips</th>
                  <th>Total distance</th>
                  <th>Max speed</th>
                  <th>First start</th>
                  <th>Last end</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredSummaries.map((s) => (
                  <tr
                    key={`${s.driverId}-${s.date}`}
                    style={{ cursor: 'pointer' }}
                    onClick={() => { setDriverId(s.driverId); setDate(s.date); }}
                  >
                    <td style={{ fontWeight: 600 }}>{s.driverName}</td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>{s.date}</td>
                    <td>{s.totalTrips}</td>
                    <td style={{ fontWeight: 600 }}>{km(s.totalDistance)}</td>
                    <td>{Math.round(s.maxSpeed)} <span style={{ color: 'var(--muted)', fontSize: 12 }}>km/h</span></td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                      {s.firstStart ? new Date(s.firstStart).toLocaleTimeString() : '—'}
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                      {s.lastEnd ? new Date(s.lastEnd).toLocaleTimeString() : '—'}
                    </td>
                    <td>
                      <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : loading ? (
        <div className="muted" style={{ padding: 40, textAlign: 'center' }}>Loading report...</div>
      ) : error && !merged ? (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
          {error}
        </div>
      ) : merged && merged.totalTrips > 0 ? (
        <>
          {/* Stats */}
          <div className="stat-row">
            <div className="stat">
              <div className="icon">👤</div>
              <div className="v">{merged.driverName}</div>
              <div className="k">Driver</div>
            </div>
            {merged.vehiclePlate && (
              <div className="stat">
                <div className="icon">🚗</div>
                <div className="v" style={{ fontFamily: 'monospace' }}>{merged.vehiclePlate}</div>
                <div className="k">Vehicle</div>
              </div>
            )}
            <div className="stat">
              <div className="icon">📅</div>
              <div className="v">{date}</div>
              <div className="k">Date</div>
            </div>
            <div className="stat">
              <div className="icon">🗺️</div>
              <div className="v">{merged.totalTrips}</div>
              <div className="k">Trips</div>
            </div>
            <div className="stat">
              <div className="icon">📏</div>
              <div className="v">{km(merged.totalDistance)}</div>
              <div className="k">Total distance</div>
            </div>
            <div className="stat">
              <div className="icon">⚡</div>
              <div className="v">{Math.round(merged.maxSpeed)} <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>km/h</span></div>
              <div className="k">Max speed</div>
            </div>
            <div className="stat">
              <div className="icon">📍</div>
              <div className="v">{merged.totalPoints}</div>
              <div className="k">GPS points</div>
            </div>
          </div>

          {/* Trip segments list */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Trip #</th>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Distance</th>
                  <th>Max speed</th>
                  <th>Points</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {merged.trips.map((t, i) => (
                  <tr key={t.tripId}>
                    <td style={{ fontWeight: 700 }}>{i + 1}</td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                      {new Date(t.startedAt).toLocaleTimeString()}
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                      {t.endedAt ? new Date(t.endedAt).toLocaleTimeString() : '—'}
                    </td>
                    <td style={{ fontWeight: 600 }}>{km(t.distanceMeters)}</td>
                    <td>{Math.round(t.maxSpeedKmh)} <span style={{ color: 'var(--muted)', fontSize: 12 }}>km/h</span></td>
                    <td style={{ color: 'var(--muted)' }}>{t.points.length}</td>
                    <td>
                      <span className={`badge ${t.status === 'active' ? 'green' : t.status === 'timed_out' ? 'amber' : 'gray'}`}>
                        {t.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td>
                      <a
                        href={`/trips/${t.tripId}/map`}
                        className="btn-ghost"
                        style={{ padding: '4px 10px', fontSize: 12 }}
                        onClick={e => e.stopPropagation()}
                      >
                        View
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Map */}
          <div className="map-wrap" style={{ height: 'calc(100vh - 480px - var(--topbar-h))', minHeight: 380 }}>
            <Map3D ref={mapRef} center={center} zoom={14} layers={layers} />
          </div>

          {/* Playback controls */}
          {allPoints.length > 1 && (
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
                    mapRef.current?.fitToRoute(allPoints.map(p => [p.lon, p.lat]));
                  } else {
                    playback.play();
                    lastFlyRef.current = 0;
                    // Immediately zoom to vehicle position on play start
                    const startMs = playback.currentTimeMs >= playback.durationMs ? 0 : playback.currentTimeMs;
                    const pos = vehicleAtElapsed(allPoints, startMs);
                    if (pos) {
                      mapRef.current?.flyTo([pos.lon, pos.lat], 16);
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
        </>
      ) : (
        <div className="card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
          No trips found for {selectedDriver?.name || 'this driver'} on {date}.
        </div>
      )}
    </div>
  );
}
