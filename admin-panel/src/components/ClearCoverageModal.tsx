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
 * "Are you sure?" for wiping an area's driven data — optionally just one driver's.
 *
 * Coverage is fleet-wide and first-cover-wins: hand an area to a driver a second time — a trial
 * run, a re-drive — and their phone opens it already blue wherever anyone drove before. This puts
 * the area back to zero, or removes just one driver's claims while keeping the rest.
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
  const [selectedDriver, setSelectedDriver] = useState<string | null>(null);

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
        { confirm: true, note: note.trim() || undefined, driverId: selectedDriver || undefined }
      );
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The driven data could not be cleared');
      setBusy(false);
    }
  };

  const targetName = selectedDriver
    ? drivers.find((d) => d.driverId === selectedDriver)?.name || 'selected driver'
    : null;

  return (
    <Modal title="Clear driven data?" onClose={busy ? () => {} : onClose}>
      <p className="cov-sub" style={{ marginTop: 0 }}>
        <b style={{ color: 'var(--text)' }}>{area.name}</b> has{' '}
        <b style={{ color: 'var(--text)' }}>{km(detail.coveredMeters)} km driven</b> across{' '}
        {detail.coveredLinks.toLocaleString()} roads ({detail.pct.toFixed(1)}% of the area).
      </p>

      {drivers.length > 0 && (
        <div className="clear-drivers">
          <label className={`clear-driver-row${selectedDriver === null ? ' active' : ''}`}>
            <input
              type="radio"
              name="clear-target"
              checked={selectedDriver === null}
              disabled={busy}
              onChange={() => { setSelectedDriver(null); setSure(false); }}
            />
            <span className="name">All drivers</span>
            <span className="what">{km(detail.coveredMeters)} km · {detail.coveredLinks.toLocaleString()} roads</span>
          </label>
          {drivers.map((d) => (
            <label key={d.driverId || 'none'} className={`clear-driver-row${selectedDriver === d.driverId ? ' active' : ''}`}>
              <input
                type="radio"
                name="clear-target"
                checked={selectedDriver === d.driverId}
                disabled={busy}
                onChange={() => { setSelectedDriver(d.driverId); setSure(false); }}
              />
              <span className="name">{d.name}</span>
              <span className="what">{km(d.meters)} km · {d.links.toLocaleString()} roads</span>
            </label>
          ))}
        </div>
      )}

      <div className="cov-issue warn" style={{ marginTop: 14 }}>
        {selectedDriver ? (
          <>
            Clearing removes <b>{targetName}</b>'s driven data only — their roads go back to "to drive":
            <ul className="clear-list">
              <li>their credit for these roads is removed from their trips;</li>
              <li>other drivers' coverage in this area is <b>not</b> affected;</li>
              <li>their driving before now will <b>not</b> count again for these roads.</li>
            </ul>
          </>
        ) : (
          <>
            Clearing puts the whole area back to <b>0% — every road "to drive"</b>:
            <ul className="clear-list">
              <li>on this map and on the driver's phone (within a few minutes);</li>
              <li>the credit those drivers had for these roads is removed from their trips;</li>
              <li>anything driven before now will <b>not</b> count again — the area has to be driven afresh.</li>
            </ul>
          </>
        )}
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
          {selectedDriver
            ? <>Yes, clear <b>{targetName}</b>'s driven data in <b>{area.name}</b>. I understand this cannot be undone.</>
            : <>Yes, clear the driven data for <b>{area.name}</b>. I understand this cannot be undone.</>}
        </span>
      </label>

      {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn-ghost" disabled={busy} onClick={onClose}>Keep it</button>
        <button className="btn danger" disabled={!sure || busy} onClick={clear}>
          {busy ? 'Clearing…' : selectedDriver ? `Clear ${targetName}'s data` : 'Clear driven data'}
        </button>
      </div>
    </Modal>
  );
}
