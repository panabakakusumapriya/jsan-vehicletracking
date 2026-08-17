import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet';
import { api, downloadFile } from '../lib/api';
import { MapAutoResize } from '../lib/MapAutoResize';
import { decodeRouteShapes } from '../lib/polyline';
import type { User } from '../lib/types';

/* ── Types ── */

interface UkmDriver {
  driverId: string;
  name: string;
  country: string | null;
  project: string | null;
  rawKm: number;
  uniqueKm: number;
  trips: number;
}

interface UkmResult {
  totalRawKm: number;
  uniqueKm: number;
  overlapPct: number;
  drivers: UkmDriver[];
}

interface TripRoute {
  tripId: string;
  startedAt: string;
  endedAt?: string | null;
  distanceMeters: number;
  shapes?: string[];
  points?: [number, number][];
  type: 'matched' | 'raw';
}

interface DriverDetail {
  driverId: string;
  trips: number;
  rawKm: number;
  uniqueKm: number;
  edgeCount: number;
  routes: TripRoute[];
}

/* ── Helpers ── */

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function thirtyDaysAgoISO() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function FitBounds({ positions }: { positions: [number, number][][] }) {
  const map = useMap();
  useEffect(() => {
    const all = positions.flat();
    if (all.length) {
      const bounds = all.reduce(
        (b, [lat, lon]) => [
          [Math.min(b[0][0], lat), Math.min(b[0][1], lon)],
          [Math.max(b[1][0], lat), Math.max(b[1][1], lon)],
        ] as [[number, number], [number, number]],
        [[90, 180], [-90, -180]] as [[number, number], [number, number]],
      );
      map.fitBounds(bounds, { padding: [30, 30] });
    }
  }, [positions, map]);
  return null;
}

const ALL_TRIPS_COLOR = '#94a3b8'; // muted gray for all driven routes
const UNIQUE_COLOR = '#059669';    // green for unique coverage

/* ── Driver Detail Full-Page View ── */

function DriverMapView({
  driver,
  from,
  to,
  onBack,
}: {
  driver: UkmDriver;
  from: string;
  to: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<DriverDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` });
        const res = await api.get<DriverDetail>(`/api/tracking/ukm-driver/${driver.driverId}?${params}`);
        setDetail(res);
      } catch {
        setDetail(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [driver.driverId, from, to]);

  // All trip routes (one muted color).
  // decodeRouteShapes returns [lon, lat] (deck.gl convention) — swap to [lat, lon] for Leaflet.
  const allRouteCoords = useMemo(() => {
    if (!detail?.routes) return [];
    return detail.routes.map(r => {
      if (r.shapes && r.shapes.length) {
        return decodeRouteShapes(r.shapes).map(([lon, lat]) => [lat, lon] as [number, number]);
      }
      if (r.points && r.points.length) return r.points; // already [lat, lon]
      return [];
    }).filter(c => c.length > 1);
  }, [detail]);

  // Build unique segments client-side from the route data we already have.
  // Same grid-cell edge dedup as the backend (4 decimal places ≈ 11m).
  const uniquePolyline = useMemo(() => {
    const PRECISION = 10000;
    const round = (v: number) => Math.round(v * PRECISION);
    const seen = new Set<string>();
    const segments: [number, number][][] = [];
    let currentLine: [number, number][] = [];

    for (const coords of allRouteCoords) {
      let prevCell: string | null = null;
      for (let i = 0; i < coords.length; i++) {
        const [lat, lon] = coords[i];
        const cell = `${round(lat)},${round(lon)}`;
        if (prevCell && cell !== prevCell) {
          const edgeKey = prevCell < cell ? `${prevCell}|${cell}` : `${cell}|${prevCell}`;
          if (!seen.has(edgeKey)) {
            seen.add(edgeKey);
            // Extend current line or start new one
            if (currentLine.length === 0) {
              currentLine.push(coords[i - 1], coords[i]);
            } else {
              currentLine.push(coords[i]);
            }
          } else {
            // Break: this edge was already seen, flush current line
            if (currentLine.length > 1) segments.push(currentLine);
            currentLine = [];
          }
        }
        prevCell = cell;
      }
      // Flush at end of each trip's coords
      if (currentLine.length > 1) segments.push(currentLine);
      currentLine = [];
    }
    return segments;
  }, [allRouteCoords]);

  // All coords flattened for fitting bounds
  const allPositions = useMemo(() => allRouteCoords.flat(), [allRouteCoords]);

  const overlap = detail && detail.rawKm > 0
    ? ((1 - detail.uniqueKm / detail.rawKm) * 100).toFixed(1)
    : '0';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Header bar */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0,
        background: 'var(--panel)',
      }}>
        <button onClick={onBack} className="btn-ghost"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, padding: '6px 10px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>

        <div style={{ borderLeft: '1px solid var(--line)', height: 24, margin: '0 4px' }} />

        <div>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{driver.name}</span>
          <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>
            {[driver.project, driver.country].filter(Boolean).join(' · ') || ''}
          </span>
        </div>

        {detail && (
          <>
            <div style={{ borderLeft: '1px solid var(--line)', height: 24, margin: '0 4px' }} />
            <div style={{ display: 'flex', gap: 18, fontSize: 13, flexWrap: 'wrap' }}>
              <div><span style={{ color: 'var(--muted)' }}>Total: </span><b>{detail.rawKm.toLocaleString()} km</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Unique: </span><b style={{ color: 'var(--brand)' }}>{detail.uniqueKm.toLocaleString()} km</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Overlap: </span><b style={{ color: '#d97706' }}>{overlap}%</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Trips: </span><b>{detail.trips}</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Unique segments: </span><b>{detail.edgeCount.toLocaleString()}</b></div>
            </div>
          </>
        )}
      </div>

      {/* Map — fills all remaining space */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {loading && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.7)', fontSize: 13, color: 'var(--muted)',
          }}>
            Loading routes…
          </div>
        )}
        <MapContainer center={[48, 10]} zoom={5} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <MapAutoResize />

          {/* Layer 1: All driven routes in muted gray */}
          {allRouteCoords.map((coords, i) => (
            <Polyline key={`all-${i}`} positions={coords} pathOptions={{ color: ALL_TRIPS_COLOR, weight: 4, opacity: 0.5 }} />
          ))}

          {/* Layer 2: Unique segments in green on top */}
          {uniquePolyline.map((seg, i) => (
            <Polyline key={`ukm-${i}`} positions={seg} pathOptions={{ color: UNIQUE_COLOR, weight: 3, opacity: 0.85 }} />
          ))}

          {allPositions.length > 0 && (
            <FitBounds positions={[allPositions]} />
          )}
        </MapContainer>

        {/* Legend */}
        {(allRouteCoords.length > 0 || uniquePolyline.length > 0) && (
          <div style={{
            position: 'absolute', bottom: 16, left: 16, zIndex: 1000,
            background: 'rgba(255,255,255,0.95)', borderRadius: 10, padding: '12px 16px',
            fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Legend</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 24, height: 4, background: ALL_TRIPS_COLOR, borderRadius: 2, flexShrink: 0, opacity: 0.7 }} />
              <span>All driven routes ({detail?.trips ?? 0} trips — {detail?.rawKm.toLocaleString()} km)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 24, height: 4, background: UNIQUE_COLOR, borderRadius: 2, flexShrink: 0 }} />
              <span>Unique roads ({detail?.uniqueKm.toLocaleString()} km — {detail?.edgeCount.toLocaleString()} segments)</span>
            </div>
            <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.5 }}>
              Gray = total distance driven (includes repeats).<br />
              Green = roads counted only once for UKM.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main Component ── */

export function Ukm() {
  const [from, setFrom] = useState(thirtyDaysAgoISO);
  const [to, setTo] = useState(todayISO);
  const [projectFilter, setProjectFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [driverFilter, setDriverFilter] = useState('');
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [data, setData] = useState<UkmResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDriver, setSelectedDriver] = useState<UkmDriver | null>(null);
  const mountedRef = useRef(false);

  // Stable fetch function that reads current filter state via refs.
  const fromRef = useRef(from);
  const toRef = useRef(to);
  const projectRef = useRef(projectFilter);
  const countryRef = useRef(countryFilter);
  const driverRef = useRef(driverFilter);
  fromRef.current = from;
  toRef.current = to;
  projectRef.current = projectFilter;
  countryRef.current = countryFilter;
  driverRef.current = driverFilter;

  const buildParams = useCallback(() => {
    const params = new URLSearchParams({ from: `${fromRef.current}T00:00:00Z`, to: `${toRef.current}T23:59:59Z` });
    if (projectRef.current) params.set('project', projectRef.current);
    if (countryRef.current) params.set('country', countryRef.current);
    if (driverRef.current) params.set('driverId', driverRef.current);
    return params;
  }, []);

  const fetchUkm = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get<UkmResult>(`/api/tracking/ukm?${buildParams()}`);
      setData(res);
    } catch (e: any) {
      setError(e.message || 'Failed to load UKM data');
    } finally {
      setLoading(false);
    }
  }, [buildParams]);

  // Load users on mount.
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ users: User[] }>('/api/users?role=user');
        setAllUsers(res.users ?? []);
      } catch {}
    })();
  }, []);

  // Auto-fetch on mount and whenever filters change.
  useEffect(() => {
    // Skip the very first render — the mount effect below handles it.
    if (!mountedRef.current) {
      mountedRef.current = true;
      fetchUkm();
      return;
    }
    fetchUkm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, projectFilter, countryFilter, driverFilter]);

  // Cascading filters
  const projects = useMemo(() =>
    Array.from(new Set(allUsers.map(u => u.project).filter(Boolean))).sort() as string[],
    [allUsers]);

  const countries = useMemo(() => {
    const f = projectFilter ? allUsers.filter(u => u.project === projectFilter) : allUsers;
    return Array.from(new Set(f.map(u => u.country).filter(Boolean))).sort() as string[];
  }, [allUsers, projectFilter]);

  const driverOptions = useMemo(() => {
    let f = allUsers;
    if (projectFilter) f = f.filter(u => u.project === projectFilter);
    if (countryFilter) f = f.filter(u => u.country === countryFilter);
    return f.sort((a, b) => a.name.localeCompare(b.name));
  }, [allUsers, projectFilter, countryFilter]);

  const handleProjectChange = (val: string) => {
    setProjectFilter(val);
    if (countryFilter) {
      const valid = val ? allUsers.filter(u => u.project === val).map(u => u.country) : allUsers.map(u => u.country);
      if (!valid.includes(countryFilter)) setCountryFilter('');
    }
    setDriverFilter('');
  };

  const handleCountryChange = (val: string) => {
    setCountryFilter(val);
    if (driverFilter) {
      let f = allUsers;
      if (projectFilter) f = f.filter(u => u.project === projectFilter);
      if (val) f = f.filter(u => u.country === val);
      if (!f.some(u => u._id === driverFilter)) setDriverFilter('');
    }
  };

  const handleExport = async () => {
    await downloadFile(`/api/tracking/ukm-export?${buildParams()}`, 'ukm-report.csv');
  };

  // ── If a driver is selected, show full-page map view ──
  if (selectedDriver) {
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: 'var(--bg)', display: 'flex', flexDirection: 'column' }}>
        <DriverMapView
          driver={selectedDriver}
          from={from}
          to={to}
          onBack={() => setSelectedDriver(null)}
        />
      </div>
    );
  }

  // ── Normal list view ──
  return (
    <div style={{ padding: '0 4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h1 className="page-title">Unique Kilometers (UKM)</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13, lineHeight: 1.5 }}>
            Road distance counted only once — if the same road is driven 3 times, it counts once.
          </p>
        </div>
        {data && (
          <button className="btn-ghost" onClick={handleExport}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Export CSV
          </button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'end', marginBottom: 16 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)', flex: '0 0 auto' }}>
          From
          <input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)}
            style={{ display: 'block', marginTop: 2, fontSize: 13 }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--muted)', flex: '0 0 auto' }}>
          To
          <input type="date" className="input" value={to} onChange={e => setTo(e.target.value)}
            style={{ display: 'block', marginTop: 2, fontSize: 13 }} />
        </label>
        <select className="input" style={{ fontSize: 13, flex: '1 1 0', minWidth: 0 }} value={projectFilter}
          onChange={e => handleProjectChange(e.target.value)}>
          <option value="">All projects</option>
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className="input" style={{ fontSize: 13, flex: '1 1 0', minWidth: 0 }} value={countryFilter}
          onChange={e => handleCountryChange(e.target.value)}>
          <option value="">All countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input" style={{ fontSize: 13, flex: '1 1 0', minWidth: 0 }} value={driverFilter}
          onChange={e => setDriverFilter(e.target.value)}>
          <option value="">All drivers</option>
          {driverOptions.map(d => <option key={d._id} value={d._id}>{d.name}</option>)}
        </select>
      </div>

      {error && <div style={{ color: 'var(--red)', marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {loading && !data && (
        <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
      )}

      {data && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 20 }}>
            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Total Driven</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{data.totalRawKm.toLocaleString()} km</div>
            </div>
            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Unique KM</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--brand)' }}>{data.uniqueKm.toLocaleString()} km</div>
            </div>
            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Overlap</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: data.overlapPct > 50 ? 'var(--red)' : '#d97706' }}>{data.overlapPct}%</div>
            </div>
            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Drivers</div>
              <div style={{ fontSize: 24, fontWeight: 700 }}>{data.drivers.length}</div>
            </div>
          </div>

          {loading && (
            <div style={{ textAlign: 'center', padding: '8px', color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
              Updating…
            </div>
          )}

          {/* Per-driver table */}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Driver</th>
                  <th>Project</th>
                  <th>Country</th>
                  <th style={{ textAlign: 'right' }}>Trips</th>
                  <th style={{ textAlign: 'right' }}>Total KM</th>
                  <th style={{ textAlign: 'right' }}>Unique KM</th>
                  <th style={{ textAlign: 'right' }}>Overlap</th>
                </tr>
              </thead>
              <tbody>
                {data.drivers.map(d => {
                  const overlap = d.rawKm > 0 ? +((1 - d.uniqueKm / d.rawKm) * 100).toFixed(1) : 0;
                  return (
                    <tr key={d.driverId} onClick={() => setSelectedDriver(d)}
                      style={{ cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}>
                      <td style={{ fontWeight: 600 }}>{d.name}</td>
                      <td>{d.project || '—'}</td>
                      <td>{d.country || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{d.trips}</td>
                      <td style={{ textAlign: 'right' }}>{d.rawKm.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--brand)' }}>{d.uniqueKm.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', color: overlap > 50 ? 'var(--red)' : '#d97706' }}>{overlap}%</td>
                    </tr>
                  );
                })}
                {data.drivers.length === 0 && (
                  <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No data for this period</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
