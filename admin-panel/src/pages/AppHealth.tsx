import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Project } from '../lib/types';

interface ActivityRow {
  _id: string;
  driverId: { _id: string; name: string; email: string; country?: string; project?: string } | string;
  action: 'sign_in' | 'sign_out';
  timestamp: string;
  driverName: string;
  driverEmail: string;
  country?: string;
  project?: string;
}

type DriverStatus = 'online' | 'logged_out' | 'app_closed' | 'gps_off' | 'network_off' | 'battery_restricted' | 'offline';

interface DriverSummary {
  driver: { _id: string; name: string; email: string; country?: string; project?: string };
  lastSignIn: string | null;
  lastSignOut: string | null;
  lastHeartbeat: string | null;
  online: boolean;
  status: DriverStatus;
  batteryLevel: number | null;
}

const STATUS_CONFIG: Record<DriverStatus, { label: string; badge: string }> = {
  online:             { label: 'Online',             badge: 'green' },
  logged_out:         { label: 'Logged Out',         badge: 'gray' },
  app_closed:         { label: 'App Closed',         badge: 'gray' },
  gps_off:            { label: 'GPS Off',            badge: 'amber' },
  network_off:        { label: 'Network Off',        badge: 'amber' },
  battery_restricted: { label: 'Battery Restricted', badge: 'amber' },
  offline:            { label: 'Offline',            badge: 'gray' },
};

type Tab = 'summary' | 'history';

export function AppHealth() {
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [summary, setSummary] = useState<DriverSummary[]>([]);
  const [projectOptions, setProjectOptions] = useState<Project[]>([]);
  const [projectFilter, setProjectFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [tab, setTab] = useState<Tab>('summary');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([
      api.get<{ activities: ActivityRow[]; summary: DriverSummary[] }>('/api/app-activity'),
      api.get<{ projects: Project[] }>('/api/projects'),
    ]).then(([r, pr]) => {
      setActivities(r.activities);
      setSummary(r.summary);
      setProjectOptions(pr.projects ?? []);
    }).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Auto-refresh every 30s
  useEffect(() => {
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  // Filtering
  const filteredSummary = summary.filter(s => {
    if (projectFilter && s.driver.project !== projectFilter) return false;
    if (countryFilter && s.driver.country !== countryFilter) return false;
    return true;
  });

  const filteredActivities = activities.filter(a => {
    const proj = typeof a.driverId === 'object' ? a.driverId.project : a.project;
    const ctry = typeof a.driverId === 'object' ? a.driverId.country : a.country;
    if (projectFilter && proj !== projectFilter) return false;
    if (countryFilter && ctry !== countryFilter) return false;
    return true;
  });

  // Countries filtered by selected project
  const source = tab === 'summary'
    ? summary.map(s => ({ project: s.driver.project, country: s.driver.country }))
    : activities.map(a => ({
        project: typeof a.driverId === 'object' ? a.driverId.project : a.project,
        country: typeof a.driverId === 'object' ? a.driverId.country : a.country,
      }));
  const afterProject = projectFilter ? source.filter(s => s.project === projectFilter) : source;
  const countries = Array.from(new Set(afterProject.map(s => s.country).filter(Boolean))).sort() as string[];

  // Stats
  const online = filteredSummary.filter(s => s.status === 'online').length;
  const warnings = filteredSummary.filter(s => ['gps_off', 'network_off', 'battery_restricted'].includes(s.status)).length;
  const offline = filteredSummary.length - online - warnings;

  const fmt = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const ago = (iso: string | null) => {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px - var(--topbar-h))' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">App Health</h1>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="input" style={{ width: 120, fontSize: 12, padding: '4px 6px' }} value={projectFilter} onChange={e => { setProjectFilter(e.target.value); setCountryFilter(''); }}>
            <option value="">Project</option>
            {projectOptions.map(p => <option key={p._id} value={p.name}>{p.name}</option>)}
          </select>
          <select className="input" style={{ width: 100, fontSize: 12, padding: '4px 6px' }} value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
            <option value="">Country</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn-ghost" onClick={load} style={{ fontSize: 12, padding: '4px 10px' }}>Refresh</button>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat"><div className="v">{filteredSummary.length}</div><div className="k">Drivers</div></div>
        <div className="stat"><div className="v" style={{ color: 'var(--green)' }}>{online}</div><div className="k">Online</div></div>
        <div className="stat"><div className="v" style={{ color: 'var(--amber)' }}>{warnings}</div><div className="k">Warnings</div></div>
        <div className="stat"><div className="v" style={{ color: 'var(--muted)' }}>{offline}</div><div className="k">Offline</div></div>
      </div>

      <div style={{ display: 'flex', gap: 6, margin: '0 0 10px' }}>
        <button className={`btn${tab === 'summary' ? '' : '-ghost'}`} style={{ fontSize: 12, padding: '5px 14px' }} onClick={() => setTab('summary')}>Driver Status</button>
        <button className={`btn${tab === 'history' ? '' : '-ghost'}`} style={{ fontSize: 12, padding: '5px 14px' }} onClick={() => setTab('history')}>Activity History</button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto', flex: 1, minHeight: 0 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>Loading...</div>
        ) : tab === 'summary' ? (
          <table>
            <thead>
              <tr>
                <th>Driver Name</th>
                <th>Email</th>
                <th>Country</th>
                <th>Project</th>
                <th>Last Sign In</th>
                <th>Last Sign Out</th>
                <th>Last Heartbeat</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredSummary.map(s => (
                <tr key={s.driver._id}>
                  <td>{s.driver.name}</td>
                  <td>{s.driver.email}</td>
                  <td>{s.driver.country || '—'}</td>
                  <td>{s.driver.project || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(s.lastSignIn)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(s.lastSignOut)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {s.lastHeartbeat ? (
                      <span title={fmt(s.lastHeartbeat)}>{ago(s.lastHeartbeat)}</span>
                    ) : '—'}
                  </td>
                  <td>
                    <span className={`badge ${STATUS_CONFIG[s.status]?.badge || (s.online ? 'green' : 'gray')}`}>
                      {STATUS_CONFIG[s.status]?.label || (s.online ? 'Online' : 'Offline')}
                    </span>
                  </td>
                </tr>
              ))}
              {filteredSummary.length === 0 && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No drivers found.</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Driver Name</th>
                <th>Email</th>
                <th>Action</th>
                <th>Date</th>
                <th>Time</th>
                <th>Country</th>
                <th>Project</th>
              </tr>
            </thead>
            <tbody>
              {filteredActivities.map(a => {
                const ts = new Date(a.timestamp);
                return (
                  <tr key={a._id}>
                    <td>{a.driverName}</td>
                    <td>{a.driverEmail}</td>
                    <td>
                      <span className={`badge ${a.action === 'sign_in' ? 'green' : 'gray'}`}>
                        {a.action === 'sign_in' ? 'Sign In' : 'Sign Out'}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{ts.toLocaleDateString()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                    <td>{(typeof a.driverId === 'object' ? a.driverId.country : a.country) || '—'}</td>
                    <td>{(typeof a.driverId === 'object' ? a.driverId.project : a.project) || '—'}</td>
                  </tr>
                );
              })}
              {filteredActivities.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No activity recorded yet. History starts when drivers sign in or out of the mobile app.</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
