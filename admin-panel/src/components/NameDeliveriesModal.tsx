import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../lib/api';
import type { NetworkVersion } from '../lib/types';

/**
 * Name the project's deliveries and say where each one is.
 *
 * The coverage page filters by region ("Australia", "New Zealand"), which the server detects from
 * the ground under each delivery. What it cannot detect is a useful NAME: the customer called three
 * of PRJ-025's deliveries the same thing, so inside Australia the delivery picker reads
 * "PRJ-025-HE-DRIVE-AUSGNZ network" three times until somebody calls them Victoria, Queensland
 * and Queensland top-up. Region is editable too — to split a country into states, say. Leaving a
 * region empty hands it back to detection.
 */
export function NameDeliveriesModal({
  deliveries,
  onClose,
  onSaved,
}: {
  /** The live deliveries, newest first. */
  deliveries: NetworkVersion[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(deliveries.map((v) => [v._id, { label: v.label, region: v.region || '' }]))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regions = useMemo(
    () => [...new Set(deliveries.map((v) => v.region).filter((r): r is string => Boolean(r)))].sort(),
    [deliveries]
  );
  const changed = deliveries.filter(
    (v) => draft[v._id].label.trim() !== v.label || draft[v._id].region.trim() !== (v.region || '')
  );
  const missingName = deliveries.some((v) => !draft[v._id].label.trim());

  const set = (id: string, field: 'label' | 'region', value: string) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id], [field]: value } }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const v of changed) {
        const body: { label?: string; region?: string } = {};
        if (draft[v._id].label.trim() !== v.label) body.label = draft[v._id].label;
        if (draft[v._id].region.trim() !== (v.region || '')) body.region = draft[v._id].region;
        // One at a time: a refusal names the delivery it is about, and nothing after it is sent.
        // eslint-disable-next-line no-await-in-loop
        await api.patch(`/api/network/versions/${v._id}`, body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The deliveries could not be saved');
      setBusy(false);
    }
  };

  return (
    <Modal title="Name deliveries" onClose={busy ? () => {} : onClose}>
      <p className="cov-sub" style={{ marginTop: 0 }}>
        The region is what the Coverage filter groups by. It was read from where each delivery’s
        areas are; change it to group differently (for example by state). Leave it empty to detect
        it again.
      </p>

      <div className="deliv-list">
        {deliveries.map((v) => (
          <div key={v._id} className="deliv-row">
            <div className="deliv-meta">
              {v.counts.areas.toLocaleString()} areas · {(v.targetMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} km
              {' · imported '}
              {new Date(v.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
              {v.status === 'active' && <span className="badge green" style={{ marginLeft: 6 }}>active</span>}
            </div>
            <div className="deliv-fields">
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`deliv-name-${v._id}`}>Name</label>
                <input
                  id={`deliv-name-${v._id}`}
                  className="input"
                  value={draft[v._id].label}
                  maxLength={120}
                  disabled={busy}
                  onChange={(e) => set(v._id, 'label', e.target.value)}
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor={`deliv-region-${v._id}`}>Region</label>
                <input
                  id={`deliv-region-${v._id}`}
                  className="input"
                  list="deliv-regions"
                  placeholder="detect automatically"
                  value={draft[v._id].region}
                  maxLength={60}
                  disabled={busy}
                  onChange={(e) => set(v._id, 'region', e.target.value)}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <datalist id="deliv-regions">
        {regions.map((r) => <option key={r} value={r} />)}
      </datalist>

      {error && <div className="cov-issue error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn" disabled={busy || !changed.length || missingName} onClick={save}>
          {busy ? 'Saving…' : changed.length > 1 ? `Save ${changed.length} changes` : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
