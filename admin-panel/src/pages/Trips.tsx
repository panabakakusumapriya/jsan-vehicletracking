import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DateField } from '../components/DateField';
import { ExportButtons } from '../components/ExportButtons';
import { api, downloadFile } from '../lib/api';
import { km, sessionDt, statusBadge } from '../lib/format';
import type { Project, Trip, User } from '../lib/types';

const driverName = (d: Trip['driverId']) => (typeof d === 'object' && d ? d.name : '—');
const plate      = (v: Trip['vehicleId']) => (typeof v === 'object' && v ? v.plateNumber : '—');

const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
);

// Trips per page — the most recent 50 trips make up page 1.
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
  const [trips, setTrips] = useState<Trip[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [drivers, setDrivers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [driverId, setDriverId] = useState('');
  const [project, setProject] = useState('');
  const [country, setCountry] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

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
    api.get<{ trips: Trip[]; total: number; page: number; limit: number }>(`/api/trips?${params}`)
      .then(r => {
        setTrips(r.trips);
        setTotal(r.total);
        setPage(r.page);
      })
      .finally(() => setLoading(false));
  }, [buildParams]);

  // Any filter change starts over at page 1 — never leaves the view showing a page number that
  // no longer matches what's selected. Deliberately keyed on the primitive filter values, not
  // on `load`/`scopedDriverIds` (a new array every render), so this only re-fires on an actual
  // filter change rather than every re-render.
  useEffect(() => {
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, driverId, project, country, from, to]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const goToPage = (p: number) => {
    if (p < 1 || p > totalPages || p === page) return;
    load(p);
  };

  const handleExport = (format: 'kml' | 'json') => {
    const params = new URLSearchParams({ format });
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (driverId) params.set('driverId', driverId);
    else if (scopedDriverIds) params.set('driverIds', scopedDriverIds.join(','));
    return downloadFile(`/api/trips/export?${params.toString()}`);
  };

  // Countries scoped to the selected project (still keyed by the driver's denormalized
  // `.project` name string, which the server keeps in sync with the real Project doc).
  const countries = Array.from(new Set(
    drivers.filter(d => !project || d.project === project).map(d => d.country).filter(Boolean)
  )).sort() as string[];

  // These reflect only the current page — `total` (below) is the one number here that's
  // always exact for the whole filtered set regardless of which page is showing.
  const active    = trips.filter(t => t.status === 'active').length;
  const completed = trips.filter(t => t.status === 'completed').length;
  const totalKm   = trips.reduce((acc, t) => acc + (t.distanceMeters ?? 0), 0);
  const topSpeed  = trips.reduce((acc, t) => Math.max(acc, t.maxSpeedKmh ?? 0), 0);

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
      `}</style>
      <div className="page-head">
        <div>
          <h1 className="page-title">Trips</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Full history of driver trips and routes
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
          onChange={e => { setProject(e.target.value); setCountry(''); setDriverId(''); }}
        >
          <option value="">All projects</option>
          {projects.map(p => <option key={p._id} value={p.name}>{p.name}</option>)}
        </select>
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
          style={{ width: 150, margin: 0 }}
          value={status}
          onChange={e => setStatus(e.target.value)}
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
            setDriverId(id);
            // Picking a driver directly (without going Project → Country first) should fill
            // those dropdowns back in to match, not leave them showing "All" while a specific
            // driver is selected underneath.
            if (id) {
              const d = drivers.find(dr => dr._id === id);
              if (d) {
                setProject(d.project || '');
                setCountry(d.country || '');
              }
            }
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
          onChange={setFrom}
        />
        <span style={{ color: 'var(--muted)', fontSize: 13 }}>to</span>
        <DateField
          style={{ width: 150 }}
          value={to}
          min={from || undefined}
          onChange={setTo}
        />
        {(status || driverId || project || country || from || to) && (
          <button
            className="btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12.5 }}
            onClick={() => { setStatus(''); setDriverId(''); setProject(''); setCountry(''); setFrom(''); setTo(''); }}
          >
            Clear
          </button>
        )}
        <ExportButtons onExport={handleExport} disabled={total === 0} />
      </div>

      {/* Stats */}
      <div className="stat-row trips-stats">
        <div className="stat">
          <div className="icon">🗺️</div>
          <div className="v">{total}</div>
          <div className="k">Total trips</div>
        </div>
        <div className="stat">
          <div className="icon">🟢</div>
          <div className="v">{active}</div>
          <div className="k">Active now</div>
        </div>
        <div className="stat">
          <div className="icon">✅</div>
          <div className="v">{completed}</div>
          <div className="k">Completed</div>
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
              <th>Driver</th>
              <th>Vehicle</th>
              <th>Status</th>
              <th>Started</th>
              <th>Ended</th>
              <th>Distance</th>
              <th>Max speed</th>
              <th>Points</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {trips.map(t => (
              <tr key={t._id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <div style={{
                      width: 30, height: 30, borderRadius: 9,
                      background: 'var(--brand-light)', border: '1px solid rgba(124,58,237,0.18)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--brand)', fontSize: 10, fontWeight: 800, flexShrink: 0,
                    }}>
                      {driverName(t.driverId).split(' ').slice(0, 2).map((n: string) => n[0]).join('').toUpperCase()}
                    </div>
                    {driverName(t.driverId)}
                  </div>
                </td>
                <td>
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
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {t.status === 'active' && (
                      <Link to={`/trips/${t._id}/map`} style={{
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
            {!loading && trips.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  No trips found for the selected filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Numbered pagination — page 1 is always the most recent PAGE_SIZE trips. Each page
          replaces the table rather than accumulating, so the page never has to hold more than
          one page's worth of trips in memory at once. */}
      {!loading && trips.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3, padding: '10px 0 2px', fontSize: 11 }}>
          <span style={{ color: 'var(--muted)', marginRight: 6, fontSize: 11 }}>
            {(page - 1) * PAGE_SIZE + 1}–{(page - 1) * PAGE_SIZE + trips.length} of {total}
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
