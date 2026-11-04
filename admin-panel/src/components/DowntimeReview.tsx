import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import { hm } from '../lib/format';

/**
 * Downtime drivers reported from the app — time stopped for a reason (a weather stop, a vehicle
 * change-over) — for a manager to approve or not. Only approved downtime counts toward working
 * hours (backend services/downtime.js); the server already checked each entry against the day's
 * trips, so what is left to judge is the reason.
 */

export type DowntimeRow = {
  id: string;
  driverId: string;
  driverName: string | null;
  timezone: string;
  date: string;
  startAt: string;
  endAt: string;
  durationMs: number;
  reason: string;
  note: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewNote: string | null;
  reviewedByName: string | null;
};

export const DOWNTIME_REASON: Record<string, string> = {
  weather: 'Weather',
  vehicle_changeover: 'Vehicle change-over',
  vehicle_issue: 'Vehicle issue',
  road_closed: 'Road closed',
  waiting_instructions: 'Waiting for instructions',
  fuel: 'Fuel',
  other: 'Other',
};

const clockIn = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

const TABS: { key: 'pending' | 'approved' | 'rejected'; label: string }[] = [
  { key: 'pending', label: 'Waiting for approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Not approved' },
];

export function DowntimeReview({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rows, setRows] = useState<DowntimeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The row whose "Not approved" note is being typed. */
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const r = await api.get<{ downtime: DowntimeRow[] }>(`/api/downtime?status=${tab}`);
      setRows(r.downtime);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load downtime');
      setRows([]);
    }
  }, [tab]);
  useEffect(() => { load(); }, [load]);

  const decide = async (id: string, status: 'approved' | 'rejected', reviewNote?: string) => {
    setBusy(id);
    try {
      await api.patch(`/api/downtime/${id}`, { status, reviewNote });
      setRows((cur) => (cur || []).filter((r) => r.id !== id));
      setRejecting(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Driver downtime" onClose={onClose} wide>
      <style>{`
        .dtr-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
        .dtr-tabs button { border: 1px solid var(--line-2); background: var(--panel); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 13px; font-weight: 600; color: var(--text-2); cursor: pointer; }
        .dtr-tabs button.on { background: var(--brand); border-color: var(--brand); color: #fff; }
        .dtr-hint { font-size: 12.5px; color: var(--muted); margin: 0 0 10px; }
        .dtr-list { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow-y: auto; }
        .dtr-row { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; align-items: center; }
        .dtr-main b { font-size: 14px; }
        .dtr-when { font-variant-numeric: tabular-nums; color: var(--text-2); font-size: 13px; }
        .dtr-reason { font-size: 13px; margin-top: 2px; }
        .dtr-note { font-size: 12.5px; color: var(--text-2); font-style: italic; }
        .dtr-acts { display: flex; gap: 6px; }
        .dtr-acts .btn { padding: 6px 12px; font-size: 13px; }
        .dtr-reject { grid-column: 1 / -1; display: flex; gap: 6px; }
        .dtr-reject input { flex: 1; }
        .dtr-decided { font-size: 12px; color: var(--muted); }
      `}</style>
      <div className="dtr-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      <p className="dtr-hint">
        Time drivers were stopped for a reason. Approved downtime is added to their working hours; until then it is not counted.
        Times are in each driver's own time zone.
      </p>
      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      {!rows ? (
        <div className="dtr-hint">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="dtr-hint">{tab === 'pending' ? 'Nothing waiting for approval.' : 'None.'}</div>
      ) : (
        <div className="dtr-list">
          {rows.map((r) => (
            <div key={r.id} className="dtr-row">
              <div className="dtr-main">
                <b>{r.driverName || 'Driver'}</b>{' '}
                <span className="dtr-when">· {r.date} · {clockIn(r.startAt, r.timezone)}–{clockIn(r.endAt, r.timezone)} · {hm(r.durationMs)}</span>
                <div className="dtr-reason">⏸ {DOWNTIME_REASON[r.reason] || r.reason}</div>
                {r.note && <div className="dtr-note">“{r.note}”</div>}
                {r.status !== 'pending' && (
                  <div className="dtr-decided">
                    {r.status === 'approved' ? 'Approved' : 'Not approved'}{r.reviewedByName ? ` by ${r.reviewedByName}` : ''}
                    {r.reviewNote ? ` — ${r.reviewNote}` : ''}
                  </div>
                )}
              </div>
              <div className="dtr-acts">
                {r.status !== 'approved' && (
                  <button type="button" className="btn" disabled={busy === r.id} onClick={() => decide(r.id, 'approved')}>Approve</button>
                )}
                {r.status !== 'rejected' && (
                  <button type="button" className="btn btn-secondary" disabled={busy === r.id} onClick={() => setRejecting({ id: r.id, note: '' })}>Not approve</button>
                )}
              </div>
              {rejecting?.id === r.id && (
                <div className="dtr-reject">
                  <input
                    className="input"
                    autoFocus
                    placeholder="Reason the driver will see (optional)"
                    value={rejecting.note}
                    maxLength={300}
                    onChange={(e) => setRejecting({ id: r.id, note: e.target.value })}
                  />
                  <button type="button" className="btn danger" disabled={busy === r.id} onClick={() => decide(r.id, 'rejected', rejecting.note)}>Not approve</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setRejecting(null)}>Cancel</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
