import { useEffect, useState } from 'react';
import { ssdsApi } from '../lib/ssdsApi';

interface Timesheet {
  _id: string;
  'Driver Name'?: string;
  'Date'?: string;
  'Mail ID'?: string;
  'Country'?: string;
  'Actual Hours'?: string;
  'Status'?: string;
  'Comments'?: string;
  'Last Updated'?: string;
  [key: string]: unknown;
}

export function DriverMyTimesheets() {
  const [data, setData] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    const qs = params.toString();
    ssdsApi.get<{ timesheets: Timesheet[] }>(`/my/timesheets${qs ? '?' + qs : ''}`)
      .then(r => setData(r.timesheets))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (loading) return <div className="center-screen">Loading your timesheets...</div>;
  if (error) return <div className="center-screen" style={{ color: 'var(--danger)' }}>Error: {error}</div>;

  const statusCounts: Record<string, number> = {};
  data.forEach(t => { const s = t['Status'] || 'Unknown'; statusCounts[s] = (statusCounts[s] || 0) + 1; });

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">My Timesheets</h1>
        <button className="btn-ghost" onClick={load}>Refresh</button>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Total</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{data.length}</div>
        </div>
        {Object.entries(statusCounts).slice(0, 3).map(([s, c]) => (
          <div key={s} className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{s}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{c}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ maxWidth: 155 }} />
        <input className="input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ maxWidth: 155 }} />
        <button className="btn-ghost" onClick={load} style={{ fontSize: 12 }}>Apply</button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Country</th>
              <th>Actual Hours</th>
              <th>Status</th>
              <th>Comments</th>
              <th>Last Updated</th>
            </tr>
          </thead>
          <tbody>
            {data.map(t => (
              <tr key={t._id}>
                <td>{t['Date'] || '—'}</td>
                <td>{t['Country'] || '—'}</td>
                <td>{t['Actual Hours'] || '—'}</td>
                <td>
                  <span className={`badge ${t['Status'] === 'Correct' ? 'green' : t['Status'] === 'Mismatched' ? 'red' : 'yellow'}`}>
                    {t['Status'] || '—'}
                  </span>
                </td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t['Comments'] || ''}>
                  {t['Comments'] || '—'}
                </td>
                <td>{t['Last Updated'] || '—'}</td>
              </tr>
            ))}
            {data.length === 0 && (
              <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 28 }}>No timesheets found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
