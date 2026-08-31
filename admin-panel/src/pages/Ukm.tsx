import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Polyline, TileLayer, useMap } from 'react-leaflet';
import { api, downloadFile } from '../lib/api';
import { MapAutoResize } from '../lib/MapAutoResize';
import { decodeRouteShapes } from '../lib/polyline';
import type { User } from '../lib/types';

/* ── Types ── */

/* Every figure below is computed and persisted by the backend (services/globalUkm.js).
 * Nothing on this page derives a UKM number or a UKM colour of its own — see the note above
 * DriverMapView for what used to happen here and why it had to stop. */

type UkmStatus = 'pending' | 'computed' | 'review' | 'failed';

interface UkmDriver {
  driverId: string;
  name: string;
  country: string | null;
  project: string | null;
  coverageScopeId: string | null;
  trips: number;
  rawKm: number;
  cleanedKm: number;
  distinctKm: number;
  sameTripRepeatKm: number;
  historicalDuplicateKm: number;
  uniqueKm: number;
  unmatchedKm: number;
  pendingTrips: number;
  reviewTrips: number;
}

interface UkmResult {
  totalRawKm: number;
  uniqueKm: number;
  distinctKm: number;
  duplicateKm: number;
  overlapPct: number;
  pendingTrips: number;
  reviewTrips: number;
  drivers: UkmDriver[];
}

interface TripRoute {
  tripId: string;
  startedAt: string;
  endedAt?: string | null;
  distanceMeters: number;
  ukmStatus: UkmStatus;
  uniqueMeters: number | null;
  duplicateMeters: number | null;
  distinctMeters: number | null;
  shapes?: string[];
  // The server's verdict on this trip's geometry. null means it has no verdict yet, which is not
  // the same as an empty array (a verdict of "none of this was new road").
  uniqueShapes?: string[] | null;
  duplicateShapes?: string[] | null;
  points?: [number, number][];
  type: 'matched' | 'raw';
}

interface DriverDetail {
  driverId: string;
  trips: number;
  coverageScopeId: string | null;
  rawKm: number;
  cleanedKm: number;
  distinctKm: number;
  sameTripRepeatKm: number;
  historicalDuplicateKm: number;
  uniqueKm: number;
  unmatchedKm: number;
  pendingTrips: number;
  reviewTrips: number;
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

const ALL_TRIPS_COLOR = '#94a3b8'; // grey: the full route, as context under everything else
const UNIQUE_COLOR = '#059669';    // green: road this driver covered first in the whole programme
const DUPLICATE_COLOR = '#dc2626'; // red: road the programme had already covered before this trip

/* ── Driver Detail Full-Page View ──
 *
 * This view used to compute the green "unique" overlay itself: it re-ran an ~11 m grid-cell edge
 * dedup, in the browser, over whichever routes it had loaded for the selected driver. Three
 * things were wrong with that, and the third is the one that mattered.
 *
 *   1. It was a different algorithm to the backend's, so the line and the headline number were
 *      answers to two different questions and could not be reconciled.
 *   2. It ran on raw ~11 m cells, which are smaller than this fleet's GPS error — the same street
 *      driven twice lands in different cells and reads as two different roads.
 *   3. It only ever saw ONE driver's routes. Global uniqueness is a statement about every driver
 *      in the coverage scope, so a street another crew had already driven was painted green here
 *      with total confidence. The browser had no way to know better; it had never been sent the
 *      evidence.
 *
 * So the decision now happens once, on the server, and this component draws what it is told:
 * green for road this driver covered first, red for road already covered, grey underneath for
 * everything else the trip drove. */

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

  // The server's unique / duplicate geometry, decoded and nothing more. No dedup, no grid, no
  // uniqueness decision — those all belong to services/globalUkm.js and are already made.
  const toLatLng = (shapes: string[]) =>
    decodeRouteShapes(shapes).map(([lon, lat]) => [lat, lon] as [number, number]);

  const uniqueSegments = useMemo(() => {
    if (!detail?.routes) return [];
    return detail.routes
      .flatMap(r => (r.uniqueShapes ?? []).map(shape => toLatLng([shape])))
      .filter(c => c.length > 1);
  }, [detail]);

  const duplicateSegments = useMemo(() => {
    if (!detail?.routes) return [];
    return detail.routes
      .flatMap(r => (r.duplicateShapes ?? []).map(shape => toLatLng([shape])))
      .filter(c => c.length > 1);
  }, [detail]);

  // Trips the engine has not reached yet. Called out rather than quietly drawn as "no unique
  // road", because a trip with no verdict and a trip that genuinely covered nothing new look
  // identical on a map and mean completely different things.
  const awaitingVerdict = useMemo(
    () => (detail?.routes ?? []).filter(r => r.uniqueShapes == null).length,
    [detail],
  );

  // All coords flattened for fitting bounds
  const allPositions = useMemo(() => allRouteCoords.flat(), [allRouteCoords]);

  // Against DISTINCT road, not raw distance. Raw holds GPS noise, idling and same-trip repeat, so
  // dividing by it produced an "overlap" that moved with the traffic. This one means one thing:
  // of the road this driver actually covered, how much had the programme already covered.
  const overlap = detail && detail.distinctKm > 0
    ? ((detail.historicalDuplicateKm / detail.distinctKm) * 100).toFixed(1)
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
              <div><span style={{ color: 'var(--muted)' }}>Driven: </span><b>{detail.rawKm.toLocaleString()} km</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Distinct road: </span><b>{detail.distinctKm.toLocaleString()} km</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Already covered: </span><b style={{ color: DUPLICATE_COLOR }}>{detail.historicalDuplicateKm.toLocaleString()} km</b></div>
              <div><span style={{ color: 'var(--muted)' }}>UKM: </span><b style={{ color: 'var(--brand)' }}>{detail.uniqueKm.toLocaleString()} km</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Overlap: </span><b style={{ color: '#d97706' }}>{overlap}%</b></div>
              <div><span style={{ color: 'var(--muted)' }}>Trips: </span><b>{detail.trips}</b></div>
              {awaitingVerdict > 0 && (
                <div title="These trips have no UKM figure yet — that is not the same as zero.">
                  <span style={{ color: 'var(--muted)' }}>Awaiting UKM: </span><b style={{ color: '#d97706' }}>{awaitingVerdict}</b>
                </div>
              )}
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

          {/* Layer 2: road the programme had already covered before this trip reached it */}
          {duplicateSegments.map((seg, i) => (
            <Polyline key={`dup-${i}`} positions={seg} pathOptions={{ color: DUPLICATE_COLOR, weight: 3, opacity: 0.75 }} />
          ))}

          {/* Layer 3: road this driver covered FIRST, anywhere in the coverage scope. Drawn last
              so it wins any overlap — this is the number the customer is billed on. */}
          {uniqueSegments.map((seg, i) => (
            <Polyline key={`ukm-${i}`} positions={seg} pathOptions={{ color: UNIQUE_COLOR, weight: 4, opacity: 0.9 }} />
          ))}

          {allPositions.length > 0 && (
            <FitBounds positions={[allPositions]} />
          )}
        </MapContainer>

        {/* Legend */}
        {(allRouteCoords.length > 0 || uniqueSegments.length > 0) && (
          <div style={{
            position: 'absolute', bottom: 16, left: 16, zIndex: 1000,
            background: 'rgba(255,255,255,0.95)', borderRadius: 10, padding: '12px 16px',
            fontSize: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}>
            <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 13 }}>Legend</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 24, height: 4, background: ALL_TRIPS_COLOR, borderRadius: 2, flexShrink: 0, opacity: 0.7 }} />
              <span>Everything driven ({detail?.trips ?? 0} trips — {detail?.rawKm.toLocaleString()} km)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 24, height: 4, background: UNIQUE_COLOR, borderRadius: 2, flexShrink: 0 }} />
              <span>New road — UKM ({detail?.uniqueKm.toLocaleString()} km)</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ width: 24, height: 4, background: DUPLICATE_COLOR, borderRadius: 2, flexShrink: 0 }} />
              <span>Already covered ({detail?.historicalDuplicateKm.toLocaleString()} km)</span>
            </div>
            <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 10.5, lineHeight: 1.5 }}>
              Green is road nobody in {detail?.coverageScopeId ?? 'the coverage scope'} had driven before —<br />
              any driver, any project, including this driver's own earlier trips.<br />
              Red is road the programme already had. Colours come from the server.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main Component ── */

/** One summary tile. `hint` is a tooltip, because these six figures are easy to confuse and the
 *  difference between "distinct road" and "unique road" is the whole point of the page. */
function Card({ label, value, color, hint }: {
  label: string; value: string; color?: string; hint?: string;
}) {
  return (
    <div className="card" style={{ padding: '16px 20px' }} title={hint}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

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
            Road counted once for the whole coverage programme. A street earns UKM for the driver
            who reached it first — any later pass, by any driver on any project in the same
            coverage scope, earns nothing.
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
            <Card label="Total Driven" value={`${data.totalRawKm.toLocaleString()} km`}
              hint="Raw GPS distance, including repeats and noise" />
            <Card label="Distinct Road" value={`${data.distinctKm.toLocaleString()} km`}
              hint="Road covered after removing repeats inside each trip" />
            <Card label="Already Covered" value={`${data.duplicateKm.toLocaleString()} km`} color={DUPLICATE_COLOR}
              hint="Of that road, the part the programme had already driven" />
            <Card label="Global UKM" value={`${data.uniqueKm.toLocaleString()} km`} color="var(--brand)"
              hint="New road, first covered in this period. This is the billable figure." />
            <Card label="Overlap" value={`${data.overlapPct}%`}
              color={data.overlapPct > 50 ? 'var(--red)' : '#d97706'}
              hint="Already-covered road as a share of distinct road covered" />
            <Card label="Drivers" value={String(data.drivers.length)}
              hint={data.pendingTrips > 0
                ? `${data.pendingTrips} trip(s) still have no UKM figure — not counted as zero`
                : 'All trips in range have a UKM figure'} />
          </div>

          {loading && (
            <div style={{ textAlign: 'center', padding: '8px', color: 'var(--muted)', fontSize: 12, marginBottom: 8 }}>
              Updating…
            </div>
          )}

          {/* Trips without a settled figure. Surfaced rather than folded into the totals as zeros:
              "covered no new road" and "not worked out yet" are different claims, and a report
              that cannot tell them apart is not auditable. */}
          {(data.pendingTrips > 0 || data.reviewTrips > 0) && (
            <div style={{
              marginBottom: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12.5,
              background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.25)', color: '#b45309',
            }}>
              {data.pendingTrips > 0 && (
                <div>
                  <b>{data.pendingTrips}</b> trip(s) in this range have no UKM figure yet (still map-matching,
                  or the match failed). They are excluded from the totals above rather than counted as zero.
                </div>
              )}
              {data.reviewTrips > 0 && (
                <div style={{ marginTop: data.pendingTrips > 0 ? 4 : 0 }}>
                  <b>{data.reviewTrips}</b> trip(s) are flagged <b>review</b>: part of the trace could not be
                  snapped to a road, so their road identity is not fully established.
                </div>
              )}
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
                  <th style={{ textAlign: 'right' }} title="Raw GPS distance, including repeats and noise">Driven KM</th>
                  <th style={{ textAlign: 'right' }} title="Road covered after removing repeats inside each trip">Distinct KM</th>
                  <th style={{ textAlign: 'right' }} title="Real distance re-driven within a single trip">Self-repeat KM</th>
                  <th style={{ textAlign: 'right' }} title="Distinct road the programme had already covered">Already Covered</th>
                  <th style={{ textAlign: 'right' }} title="New road first covered by this driver — the billable figure">UKM</th>
                  <th style={{ textAlign: 'right' }} title="Already covered, as a share of distinct road">Overlap</th>
                  <th style={{ textAlign: 'right' }} title="Trips with no figure yet, or flagged for review">Unsettled</th>
                </tr>
              </thead>
              <tbody>
                {data.drivers.map(d => {
                  // Against distinct road, not raw distance — see the note in exports.ukm.
                  const overlap = d.distinctKm > 0
                    ? +((d.historicalDuplicateKm / d.distinctKm) * 100).toFixed(1)
                    : 0;
                  const unsettled = d.pendingTrips + d.reviewTrips;
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
                      <td style={{ textAlign: 'right' }}>{d.distinctKm.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', color: 'var(--muted)' }}>{d.sameTripRepeatKm.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', color: DUPLICATE_COLOR }}>{d.historicalDuplicateKm.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--brand)' }}>{d.uniqueKm.toLocaleString()}</td>
                      <td style={{ textAlign: 'right', color: overlap > 50 ? 'var(--red)' : '#d97706' }}>{overlap}%</td>
                      <td style={{ textAlign: 'right', color: unsettled ? '#d97706' : 'var(--muted)' }}>
                        {unsettled || '—'}
                      </td>
                    </tr>
                  );
                })}
                {data.drivers.length === 0 && (
                  <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>No data for this period</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
