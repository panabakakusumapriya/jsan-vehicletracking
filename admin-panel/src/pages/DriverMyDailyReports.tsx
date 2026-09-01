import { useEffect, useState } from 'react';
import { ssdsApi } from '../lib/ssdsApi';

interface DailyReport {
  _id: string;
  driverName?: string;
  driverEmail?: string;
  vid?: string;
  reportType?: string;
  map?: string;
  kmsDone?: string | number;
  status?: string;
  notes?: string;
  submittedAt?: string;
  [key: string]: unknown;
}

export function DriverMyDailyReports() {
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ssdsApi.get<{ reports: DailyReport[] }>('/my/daily-reports')
      .then(r => setReports(r.reports))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center-screen">Loading your daily reports...</div>;
  if (error) return <div className="center-screen" style={{ color: 'var(--danger)' }}>Error: {error}</div>;

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">My Daily Reports</h1>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card" style={{ flex: '1 1 160px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Total Reports</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{reports.length}</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ minWidth: 600 }}>
          <thead>
            <tr>
              <th>Report Type</th>
              <th>VID</th>
              <th>Map</th>
              <th>KMs Done</th>
              <th>Status</th>
              <th>Notes</th>
              <th>Submitted At</th>
            </tr>
          </thead>
          <tbody>
            {reports.map(r => (
              <tr key={r._id}>
                <td><span className={`badge ${r.reportType === 'BOD' ? 'blue' : r.reportType === 'EOD' ? 'green' : 'yellow'}`}>{r.reportType || '—'}</span></td>
                <td>{r.vid || '—'}</td>
                <td>{r.map || '—'}</td>
                <td>{r.kmsDone ?? '—'}</td>
                <td>{r.status || '—'}</td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.notes || ''}>{r.notes || '—'}</td>
                <td>{r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '—'}</td>
              </tr>
            ))}
            {reports.length === 0 && (
              <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>No reports found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
