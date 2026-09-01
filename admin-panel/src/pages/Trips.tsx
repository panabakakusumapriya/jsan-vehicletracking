import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { DateField } from '../components/DateField';
import { ExportButtons } from '../components/ExportButtons';
import { api, viewerTimeZone } from '../lib/api';
import { runExportJob, describeJob } from '../lib/exportJobs';
import { km, sessionDt, statusBadge } from '../lib/format';
import type { Project, Trip, User } from '../lib/types';

const plate = (v: Trip['vehicleId']) => (typeof v === 'object' && v ? v.plateNumber : '—');

/** One row per driver+calendar-day — /api/trips/merged-summary. */
interface DaySummary {
  driverId: string;
  driverName: string;
  date: string; // YYYY-MM-DD
  /**
   * The timezone this row was grouped in (the driver's, from their country). Expanding the row
   * must query the same zone, or the day boundaries disagree and the group comes back empty.
   */
  timezone?: string;
  totalTrips: number;
  totalDistance: number;
  maxSpeed: number;
  firstStart: string;
  lastEnd: string | null;
  anyActive: boolean;
}

const dayKey = (s: DaySummary) => `${s.driverId}|${s.date}`;

const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
);
const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    style={{ transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>
    <polyline points="9 18 15 12 9 6"/>
  </svg>
);

// Driver-day rows per page.
const PAGE_SIZE = 50;

// Builds the list of page buttons to render, with '...' gaps for ranges that are skipped —
// e.g. for page 7 of 20: [1, '...', 6, 7, 8, '...', 20].
function pageList(current: number, total: number): (number | '...')[] {
  if (total <= 1) return [1];
  const delta = 1;
  const left = Math.max(2, current - delta);
  const right = Math.min(total - 1, current + delta);
  const list: (number | '...')[] = [1];
  if (left > 2) list.push('...');
  for (let i = left; i <= right; i++) list.push(i);
  if (right < total - 1) list.push('...');
  list.push(total);
  return list;
}

export function Trips() {
  const [summaries, setSummaries] = useState<DaySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [drivers, setDrivers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters, page, and which day-rows are expanded all live in the URL rather than useState,
  // so opening a trip and coming back (browser back or "← Back to trips") restores this exact
  // view — same filters, same page, same rows open — instead of a fresh page 1.
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const driverId = searchParams.get('driver') ?? '';
  const project = searchParams.get('project') ?? '';
  const country = searchParams.get('country') ?? '';
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const expanded = useMemo(
    () => new Set((searchParams.get('exp') ?? '').split(',').filter(Boolean)),
    [searchParams]
  );

  // Every update replaces the current history entry rather than pushing — the /trips entry
  // always carries the latest view state, and one "back" from a trip returns straight to it
  // instead of stepping through every filter tweak.
  const updateParams = (changes: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    setSearchParams(next, { replace: true });
  };
  // Any filter change starts over at page 1 with everything collapsed — never leaves the view
  // showing a page number or open rows that no longer match what's selected.
  const setFilters = (changes: Record<string, string>) =>
    updateParams({ ...changes, page: '', exp: '' });

  // A day-row's individual trips are fetched lazily on first expand and then cached by key,
  // so collapsing and re-expanding the same row doesn't refetch.
  const [dayTrips, setDayTrips] = useState<Record<string, Trip[]>>({});
  const [dayTripsLoading, setDayTripsLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.get<{ users: User[] }>('/api/users?role=user').then(r => setDrivers(r.users));
    // The real Projects table, not just whatever names happen to already be on a driver — a
    // project with nobody assigned to it yet still needs to show up here (it'll correctly
    // filter down to "no drivers, no trips" rather than being unselectable).
    api.get<{ projects: Project[] }>('/api/projects').then(r => setProjects(r.projects)).catch(() => {});
  }, []);

  // Drivers matching the Project + Country filters — populates the Driver dropdown AND scopes
  // the trip query itself, server-side. This must not be a client-side post-filter on top of
  // a paginated fetch: filtering only what's already loaded silently hides trips that exist on
  // a chunk that hasn't loaded yet, which is exactly the "driver went missing" bug this fixes.
  const driversForSelect = drivers.filter(d => {
    if (project && d.project !== project) return false;
    if (country && d.country !== country) return false;
    return true;
  });
  // null = no project/country filter active (don't scope by driver at all). An array — even
  // an empty one — is sent as-is: a combo matching zero drivers must return zero trips, not
  // silently fall back to "no filter, show everyone".
  const scopedDriverIds = (project || country) ? driversForSelect.map(d => d._id) : null;

  const buildParams = useCallback((pageToLoad: number) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    // Filter on the same clock the rows are displayed in — see viewerTimeZone().
    if (from || to) params.set('tz', viewerTimeZone());
    if (driverId) params.set('driverId', driverId);
    else if (scopedDriverIds) params.set('driverIds', scopedDriverIds.join(','));
    params.set('page', String(pageToLoad));
    params.set('limit', String(PAGE_SIZE));
    return params;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, from, to, driverId, scopedDriverIds?.join(',')]);

  const load = useCallback((pageToLoad: number) => {
    setLoading(true);
    const params = buildParams(pageToLoad);
    api.get<{ summaries: DaySummary[]; total: number; page: number; limit: number }>(`/api/trips/merged-summary?${params}`)
      .then(r => {
        setSummaries(r.summaries);
        setTotal(r.total);
      })
      .finally(() => setLoading(false));
  }, [buildParams]);

  // Loads whatever page the URL says (a filter change already reset it to 1 via setFilters).
  // Deliberately keyed on primitive values, not on `load`/`scopedDriverIds` (a new array every
  // render), so this only re-fires on an actual change. The joined-ids string is a real dep:
  // arriving with a project/country filter in the URL before the drivers list has loaded
  // queries zero drivers, and this refires with the actual ids once they arrive.
  const scopedJoin = scopedDriverIds?.join(',') ?? '';
  useEffect(() => {
    load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, driverId, project, country, from, to, page, scopedJoin]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const goToPage = (p: number) => {
    if (p < 1 || p > totalPages || p === page) return;
    updateParams({ page: p === 1 ? '' : String(p) });
  };

  const fetchDayTrips = useCallback((s: DaySummary) => {
    const key = dayKey(s);
    if (dayTrips[key] || dayTripsLoading[key]) return; // already loaded or in flight
    setDayTripsLoading(prev => ({ ...prev, [key]: true }));
    // tz is what keeps this consistent with the row above it: merged-summary buckets by the
    // driver's local day, so asking for that date in any other zone can miss the trips it counted.
    const params = new URLSearchParams({ driverId: s.driverId, from: s.date, to: s.date, limit: '200' });
    if (s.timezone) params.set('tz', s.timezone);
    api.get<{ trips: Trip[] }>(`/api/trips?${params}`)
      .then(r => setDayTrips(prev => ({ ...prev, [key]: r.trips })))
      .finally(() => setDayTripsLoading(prev => ({ ...prev, [key]: false })));
  }, [dayTrips, dayTripsLoading]);

  const toggleExpand = (s: DaySummary) => {
    const key = dayKey(s);
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      fetchDayTrips(s);
    }
    updateParams({ exp: Array.from(next).join(',') });
  };

  // Rows expanded via the URL (arriving back from a trip) never went through toggleExpand,
  // so their day-trips still need fetching once the summaries are in.
  useEffect(() => {
    summaries.forEach(s => { if (expanded.has(dayKey(s))) fetchDayTrips(s); });
  }, [summaries, expanded, fetchDayTrips]);

  // After coming back from a trip, land on the row that was opened — scroll it into view and
  // flash it once its day-row has re-expanded and loaded.
  useEffect(() => {
    let id: string | null = null;
    try { id = sessionStorage.getItem('trips:lastViewed'); } catch { /* private mode */ }
    if (!id) return;
    const el = document.querySelector(`[data-trip-id="${CSS.escape(id)}"]`);
    if (!el) return; // day-trips still loading — retried on the next dayTrips update
    try { sessionStorage.removeItem('trips:lastViewed'); } catch { /* ignore */ }
    el.scrollIntoView({ block: 'center' });
    el.classList.add('row-flash');
  }, [dayTrips]);

  const rememberTrip = (id: string) => {
    try { sessionStorage.setItem('trips:lastViewed', id); } catch { /* private mode */ }
  };

  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Bulk exports run as a background job — see lib/exportJobs.ts. Zipping a whole date range
  // inside the request timed out on large ranges and produced truncated files that still
  // downloaded as though they had succeeded.
  const handleExport = async (format: 'kml' | 'json', layer: 'raw' | 'snapped') => {
    const params: Record<string, string> = { format, layer };
    if (status) params.status = status;
    if (from) params.from = from;
    if (to) params.to = to;
    if (from || to) params.tz = viewerTimeZone();
    if (driverId) params.driverId = driverId;
    else if (scopedDriverIds) params.driverIds = scopedDriverIds.join(',');
    try {
      await runExportJob(params as never, (job) => setExportStatus(describeJob(job)));
    } finally {
      setExportStatus(null);
    }
  };

  // Countries scoped to the selected project (still keyed by the driver's denormalized
  // `.project` name string, which the server keeps in sync with the real Project doc).
  const countries = Array.from(new Set(
    drivers.filter(d => !project || d.project === project).map(d => d.country).filter(Boolean)
  )).sort() as string[];

  // These reflect only the current page of driver-days — `total` (below) is the one number
  // here that's always exact for the whole filtered set regardless of which page is showing.
  const tripsOnPage  = summaries.reduce((acc, s) => acc + s.totalTrips, 0);
  const activeDays   = summaries.filter(s => s.anyActive).length;
  const totalKm      = summaries.reduce((acc, s) => acc + (s.totalDistance ?? 0), 0);
  const topSpeed     = summaries.reduce((acc, s) => Math.max(acc, s.maxSpeed ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 56px - var(--topbar-h))' }}>
      {/* Compact stat cards, scoped to this page only — frees up vertical room for the table
          below rather than shrinking `.stat` everywhere else in the app. */}
      <style>{`
        .trips-stats { margin-bottom: 8px; gap: 8px; }
        .trips-stats .stat { padding: 5px 10px; min-width: 90px; border-radius: 8px; }
        .trips-stats .stat .icon { font-size: 10px; margin-bottom: 0; }
        .trips-stats .stat .v { font-size: 14px; letter-spacing: -0.4px; }
        .trips-stats .stat .k { font-size: 9px; margin-top: 0; }
        .card table thead { position: sticky; top: 0; z-index: 3; }
        .day-row { cursor: pointer; }
        .day-row:hover td { background: var(--panel-2); }
        .day-detail-row td { padding: 0; background: var(--bg); }
        .day-detail-row table td { background: transparent; }
        .row-flash td { animation: tripsRowFlash 1.8s ease-out; }
        @keyframes tripsRowFlash { 0%, 40% { background: var(--brand-light); } 100% { background: transparent; } }
      `}</style>
      <div className="page-head">
        <div>
          <h1 className="page-title">Trips</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            One row per driver per day — click a row to see that day&apos;s individual trips
          </p>
        </div>
      </div>

      {/* Filters bar — below title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
        <FilterIcon />
        <select
          className="input"
          style={{ width: 140, margin: 0 }}
          value={project}
          onChange={e => setFilters({ project: e.target.value, country: '', driver: '' })}
        >
          <option value="">All projects</option>
          {projects.map(p => <option key={p._id} value={p.name}>{p.name}</option>)}
        </select>
        <select
          className="input"
          style={{ width: 140, margin: 0 }}
          value={country}
          onChange={e => setFilters({ country: e.target.value, driver: '' })}
        >
          <option value="">All countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          className="input"
          style={{ width: 150, margin: 0 }}
          value={status}
          onChange={e => setFilters({ status: e.target.value })}
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="timed_out">Timed out</option>
        </select>
        <select
          className="input"
          style={{ width: 170, margin: 0 }}
          value={driverId}
          onChange={e => {
            const id = e.target.value;
            // Picking a driver directly (without going Project → Country first) should fill
            // those dropdowns back in to match, not leave them showing "All" while a specific
            // driver is selected underneath.
            const d = id ? drivers.find(dr => dr._id === id) : undefined;
            setFilters(d
              ? { driver: id, project: d.project || '', country: d.country || '' }
              : { driver: id });
          }}
        >
          <option value="">All drivers</option>
          {driversForSelect.map(d => (
            <option key={d._id} value={d._id}>{d.name}</option>
          ))}
        </select>
        <DateField
          style={{ width: 150 }}
          value={from}
          max={to || undefined}
          onChange={v => setFilters({ from: v })}
        />
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>to</span>
        <DateField
          style={{ width: 150 }}
          value={to}
          min={from || undefined}
          onChange={v => setFilters({ to: v })}
        />
        {(status || driverId || project || country || from || to) && (
          <button
            className="btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12.5 }}
            onClick={() => setSearchParams({}, { replace: true })}
          >
            Clear
          </button>
        )}
        <ExportButtons onExport={handleExport} disabled={total === 0} snappedAvailable status={exportStatus} />
      </div>

      {/* Stats */}
      <div className="stat-row trips-stats">
        <div className="stat">
          <div className="icon">📅</div>
          <div className="v">{total}</div>
          <div className="k">Driver-days</div>
        </div>
        <div className="stat">
          <div className="icon">🗺️</div>
          <div className="v">{tripsOnPage}</div>
          <div className="k">Trips (loaded)</div>
        </div>
        <div className="stat">
          <div className="icon">🟢</div>
          <div className="v">{activeDays}</div>
          <div className="k">Days with active trip</div>
        </div>
        <div className="stat">
          <div className="icon">📏</div>
          <div className="v">{km(totalKm)}</div>
          <div className="k">Total distance</div>
        </div>
        <div className="stat">
          <div className="icon">⚡</div>
          <div className="v">{Math.round(topSpeed)}<span style={{ fontSize: 10, fontWeight: 600, color: 'var(--muted)' }}> km/h</span></div>
          <div className="k">Top speed</div>
        </div>
      </div>

      {/* Table — scrolls on its own; the filter bar and stats above stay put. */}
      <div className="card" style={{ padding: 0, overflow: 'auto', flex: 1, minHeight: 0 }}>
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Driver</th>
              <th>Date</th>
              <th>Trips</th>
              <th>Total distance</th>
              <th>Max speed</th>
              <th>First start</th>
              <th>Last end</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map(s => {
              const key = dayKey(s);
              const isOpen = expanded.has(key);
              const rows = dayTrips[key];
              const rowsLoading = dayTripsLoading[key];
              return (
                <Fragment key={key}>
                  <tr className="day-row" onClick={() => toggleExpand(s)}>
                    <td style={{ width: 28, paddingRight: 0 }}><ChevronIcon open={isOpen} /></td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <div style={{
                          width: 30, height: 30, borderRadius: 9,
                          background: 'var(--brand-light)', border: '1px solid rgba(124,58,237,0.18)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'var(--brand)', fontSize: 10, fontWeight: 800, flexShrink: 0,
                        }}>
                          {s.driverName.split(' ').slice(0, 2).map((n: string) => n[0]).join('').toUpperCase()}
                        </div>
                        {s.driverName}
                        {s.anyActive && <span className="badge green" style={{ fontSize: 10 }}>active</span>}
                      </div>
                    </td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>{s.date}</td>
                    <td style={{ fontWeight: 700 }}>{s.totalTrips}</td>
                    <td style={{ fontWeight: 600 }}>{km(s.totalDistance)}</td>
                    <td>{Math.round(s.maxSpeed)} <span style={{ color: 'var(--muted)', fontSize: 12 }}>km/h</span></td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>{sessionDt(s.firstStart)}</td>
                    <td style={{ color: 'var(--muted)', fontSize: 13 }}>{s.lastEnd ? sessionDt(s.lastEnd) : '—'}</td>
                  </tr>
                  {isOpen && (
                    <tr key={`${key}-detail`} className="day-detail-row">
                      <td colSpan={8}>
                        {rowsLoading && !rows ? (
                          <div className="muted" style={{ padding: '14px 20px', fontSize: 12.5 }}>Loading trips…</div>
                        ) : (
                          <table style={{ width: '100%' }}>
                            <thead>
                              <tr>
                                <th style={{ paddingLeft: 48 }}>Vehicle</th>
                                <th>Status</th>
                                <th>Started</th>
                                <th>Ended</th>
                                <th>Distance</th>
                                <th>Max speed</th>
                                <th>Points</th>
                                <th title="Unique kilometers: assigned roads first covered by the trip when the driver held a polygon, otherwise road new to the whole programme">UKM</th>
                                <th title="Snapped distance driven outside the polygons the driver was assigned during the trip">Outside area</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {(rows ?? []).map(t => (
                                <tr key={t._id} data-trip-id={t._id}>
                                  <td style={{ paddingLeft: 48 }}>
                                    {plate(t.vehicleId) !== '—'
                                      ? <span style={{ background: 'var(--panel-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>{plate(t.vehicleId)}</span>
                                      : <span style={{ color: 'var(--muted)' }}>—</span>
                                    }
                                  </td>
                                  <td><span className={`badge ${statusBadge(t.status)}`}>{t.status.replace('_', ' ')}</span></td>
                                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{sessionDt(t.startedAt)}</td>
                                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{t.endedAt ? sessionDt(t.endedAt) : '—'}</td>
                                  <td style={{ fontWeight: 600 }}>{km(t.distanceMeters)}</td>
                                  <td>{Math.round(t.maxSpeedKmh)} <span style={{ color: 'var(--muted)', fontSize: 12 }}>km/h</span></td>
                                  <td style={{ color: 'var(--muted)' }}>{t.pointCount}</td>
                                  <td
                                    style={{ fontWeight: 600 }}
                                    title={t.effectiveUkmMeters == null
                                      ? (t.status === 'active' ? 'Computed once the trip ends and is map-matched' : 'Not established yet — this is not zero')
                                      : t.ukmBasis === 'assigned' ? 'Measured against the assigned road network' : 'Measured against all driving in the programme'}
                                  >
                                    {t.effectiveUkmMeters != null
                                      ? <>{km(t.effectiveUkmMeters)}{t.ukmBasis && <span style={{ marginLeft: 5, fontSize: 10, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>{t.ukmBasis}</span>}</>
                                      : <span style={{ color: 'var(--muted)' }}>—</span>}
                                  </td>
                                  <td style={{ color: (t.outAreaMeters ?? 0) > 0 ? '#d97706' : 'var(--muted)', fontWeight: (t.outAreaMeters ?? 0) > 0 ? 600 : 400 }}>
                                    {t.outAreaMeters != null ? km(t.outAreaMeters) : '—'}
                                  </td>
                                  <td onClick={e => e.stopPropagation()}>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                      {t.status === 'active' && (
                                        <Link to={`/trips/${t._id}/map`} state={{ tripsSearch: searchParams.toString() }} onClick={() => rememberTrip(t._id)} style={{
                                          display: 'inline-flex', alignItems: 'center', gap: 4,
                                          fontSize: 12.5, fontWeight: 600, color: '#059669',
                                          background: '#f0fdf4', border: '1px solid #a7f3d0',
                                          borderRadius: 7, padding: '4px 10px',
                                        }}>
                                          ● Live
                                        </Link>
                                      )}
                                      <Link
                                        to={t.status === 'active' ? `/trips/${t._id}/map` : `/trips/${t._id}`}
                                        state={{ tripsSearch: searchParams.toString() }}
                                        onClick={() => rememberTrip(t._id)}
                                        style={{
                                          display: 'inline-flex', alignItems: 'center', gap: 4,
                                          fontSize: 12.5, fontWeight: 600, color: 'var(--brand)',
                                          background: 'var(--brand-light)', border: '1px solid rgba(124,58,237,0.2)',
                                          borderRadius: 7, padding: '4px 10px',
                                        }}
                                      >
                                        {t.status === 'active' ? 'Map →' : 'Details →'}
                                      </Link>
                                    </div>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!loading && summaries.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  No trips found for the selected filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Numbered pagination over driver-day rows. Each page replaces the table rather than
          accumulating, so the page never has to hold more than one page's worth in memory. */}
      {!loading && summaries.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3, padding: '10px 0 2px', fontSize: 11 }}>
          <span style={{ color: 'var(--muted)', marginRight: 6, fontSize: 11 }}>
            {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + summaries.length} of {total}
          </span>
          <button className="btn-ghost" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => goToPage(page - 1)} disabled={page <= 1}>
            ← Prev
          </button>
          {pageList(page, totalPages).map((p, i) =>
            p === '...'
              ? <span key={`e${i}`} style={{ padding: '0 2px', color: 'var(--muted)', fontSize: 11 }}>…</span>
              : (
                <button
                  key={p}
                  className="btn-ghost"
                  onClick={() => goToPage(p)}
                  style={{
                    padding: '2px 6px', minWidth: 22, fontSize: 11,
                    ...(p === page ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : {}),
                  }}
                >
                  {p}
                </button>
              )
          )}
          <button className="btn-ghost" style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => goToPage(page + 1)} disabled={page >= totalPages}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
