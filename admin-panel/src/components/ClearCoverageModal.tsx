import { useState } from 'react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import type { AreaCoverageDetail } from '../lib/types';

/** What POST …/areas/:id/clear-coverage answers. */
export interface ClearCoverageResult {
  clearedLinks: number;
  clearedMeters: number;
  tripsAffected: number;
  tripsPending: number;
}

/**
 * "Are you sure?" for wiping an area's driven data.
 *
 * Coverage is fleet-wide and first-cover-wins: hand an area to a driver a second time — a trial
 * run, a re-drive — and their phone opens it already blue wherever anyone drove before. This puts
 * the area back to zero.
 *
 * It destroys recorded progress, and it is not reversible: the server also refuses to count any
 * driving from before the clear again, so re-running attribution will not bring it back. Hence a
 * dialog that says exactly what goes and what stays, and a box that has to be ticked before the
 * button works — a single mis-click on the area card must not be enough.
 */
export function ClearCoverageModal({
  scopeId,
  detail,
  onClose,
  onDone,
}: {
  scopeId: string;
  detail: AreaCoverageDetail;
  onClose: () => void;
  onDone: (result: ClearCoverageResult) => void;
}) {
  const [sure, setSure] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { area } = detail;
  const km = (m: number) => (m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const drivers = detail.byDriver.filter((d) => d.links > 0);

  const clear = async () => {
    if (!sure) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<ClearCoverageResult>(
        `/api/network/versions/${scopeId}/areas/${area._id}/clear-coverage`,
        { confirm: true, note: note.trim() || undefined }
      );
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The driven data could not be cleared');
      setBusy(false);
    }
  };

  return (
    <Modal title="Clear driven data?" onClose={busy ? () => {} : onClose}>
      <p className="cov-sub" style={{ marginTop: 0 }}>
        <b style={{ color: 'var(--text)' }}>{area.name}</b> has{' '}
        <b style={{ color: 'var(--text)' }}>{km(detail.coveredMeters)} km driven</b> across{' '}
        {detail.coveredLinks.toLocaleString()} roads ({detail.pct.toFixed(1)}% of the area).
      </p>

      {drivers.length > 0 && (
        <div className="clear-drivers">
          {drivers.slice(0, 5).map((d) => (
            <div key={d.driverId || 'none'}>
              <span className="name">{d.name}</span>
              <span className="what">{km(d.meters)} km · {d.links.toLocaleString()} roads</span>
            </div>
          ))}
          {drivers.length > 5 && <div><span className="what">and {drivers.length - 5} more</span></div>}
        </div>
      )}

      <div className="cov-issue warn" style={{ marginTop: 14 }}>
        Clearing puts the whole area back to <b>0% — every road “to drive”</b>:
        <ul className="clear-list">
          <li>on this map and on the driver’s phone (within a few minutes);</li>
          <li>the credit those drivers had for these roads is removed from their trips;</li>
          <li>anything driven before now will <b>not</b> count again — the area has to be driven afresh.</li>
        </ul>
        Trips, routes and GPS history are kept. Other areas are not affected.
      </div>

      <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
        <label htmlFor="clear-note">Reason (optional)</label>
        <input
          id="clear-note"
          className="input"
          placeholder="e.g. test run, handing over to a new driver"
          value={note}
          maxLength={200}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <label className="cov-toggle clear-sure">
        <input type="checkbox" checked={sure} disabled={busy} onChange={(e) => setSure(e.target.checked)} />
        <span>
          Yes, clear the driven data for <b>{area.name}</b>. I understand this cannot be undone.
        </span>
      </label>

      {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn-ghost" disabled={busy} onClick={onClose}>Keep it</button>
        <button className="btn danger" disabled={!sure || busy} onClick={clear}>
          {busy ? 'Clearing…' : 'Clear driven data'}
        </button>
      </div>
    </Modal>
  );
}
