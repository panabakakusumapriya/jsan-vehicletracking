import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { dt, km, statusBadge } from '../lib/format';
import type { Trip } from '../lib/types';

const driverName = (d: Trip['driverId']) => (typeof d === 'object' && d ? d.name : '—');
const plate      = (v: Trip['vehicleId']) => (typeof v === 'object' && v ? v.plateNumber : '—');

const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
);

export function Trips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get<{ trips: Trip[] }>(`/api/trips${status ? `?status=${status}` : ''}`)
      .then(r => setTrips(r.trips))
      .finally(() => setLoading(false));
  }, [status]);

  const active    = trips.filter(t => t.status === 'active').length;
  const completed = trips.filter(t => t.status === 'completed').length;
  const totalKm   = trips.reduce((acc, t) => acc + (t.distanceMeters ?? 0), 0);
  const topSpeed  = trips.reduce((acc, t) => Math.max(acc, t.maxSpeedKmh ?? 0), 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Trips</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Full history of driver trips and routes
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FilterIcon />
          <select
            className="input"
            style={{ width: 170, margin: 0 }}
            value={status}
            onChange={e => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="timed_out">Timed out</option>
          </select>
        </div>
      </div>

      {/* Stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="icon">🗺️</div>
          <div className="v">{trips.length}</div>
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
          <div className="v">{Math.round(topSpeed)}<span style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}> km/h</span></div>
          <div className="k">Top speed</div>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Vehicle</th>
              <th>Status</th>
              <th>Started</th>
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
                <td style={{ color: 'var(--muted)', fontSize: 13 }}>{dt(t.startedAt)}</td>
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
                    <Link to={`/trips/${t._id}/map`} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 12.5, fontWeight: 600, color: 'var(--brand)',
                      background: 'var(--brand-light)', border: '1px solid rgba(124,58,237,0.2)',
                      borderRadius: 7, padding: '4px 10px',
                    }}>
                      Map →
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && trips.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  No trips found for the selected filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
