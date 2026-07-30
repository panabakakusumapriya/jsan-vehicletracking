import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { Assignment, DeviceStatus, MobileDevice } from '../lib/types';

/**
 * Device inventory.
 *
 * Phones used to be six fields on the driver record, which meant a handset could not exist
 * unless somebody was holding it. They are assets now: they sit in stock, move between
 * drivers, and keep their custody history when a driver leaves. Handing one over writes a
 * row to the assignment ledger rather than overwriting the last value.
 *
 * This screen is INVENTORY ONLY — add, edit and inspect handsets. Allocating one to a driver
 * happens on the Drivers screen, so there is exactly one place to do it and no chance of two
 * screens disagreeing about who holds what.
 *
 * `secondaryImei` came from the branch that kept these as driver fields; it lives on the
 * device now, so nothing from that work is lost.
 */

const STATUS_LABEL: Record<DeviceStatus, string> = {
  in_stock: 'In stock',
  assigned: 'Assigned',
  repair: 'In repair',
  lost: 'Lost',
  retired: 'Retired',
};
const STATUS_BADGE: Record<DeviceStatus, string> = {
  in_stock: 'gray',
  assigned: 'green',
  repair: 'amber',
  lost: 'red',
  retired: 'gray',
};

const driverOf = (d: MobileDevice) =>
  d.currentDriverId && typeof d.currentDriverId === 'object' ? d.currentDriverId : null;

export function Mobiles() {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [editing, setEditing] = useState<MobileDevice | null>(null);
  const [history, setHistory] = useState<MobileDevice | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    api.get<{ devices: MobileDevice[] }>('/api/mobiles').then(r => setDevices(r.devices)).catch(() => {});
  };
  useEffect(load, []);

  const inStock = devices.filter(d => d.status === 'in_stock').length;
  const assigned = devices.filter(d => d.status === 'assigned').length;
  const outOfService = devices.filter(d => ['repair', 'lost', 'retired'].includes(d.status)).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Mobiles</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Device inventory — every handover is recorded, so you can see who had which phone in any month
          </p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>+ Add device</button>
      </div>

      <div className="stat-row">
        <div className="stat"><div className="v">{devices.length}</div><div className="k">Devices</div></div>
        <div className="stat"><div className="v" style={{ color: 'var(--green)' }}>{assigned}</div><div className="k">Assigned</div></div>
        <div className="stat"><div className="v">{inStock}</div><div className="k">In stock</div></div>
        <div className="stat"><div className="v" style={{ color: 'var(--amber)' }}>{outOfService}</div><div className="k">Out of service</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Device</th>
              <th>IMEI</th>
              <th>Secondary IMEI</th>
              <th>Work phone</th>
              <th>Android</th>
              <th>Status</th>
              <th>Held by</th>
              <th>Case / guard</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {devices.map(d => {
              const holder = driverOf(d);
              return (
                <tr key={d._id}>
                  <td style={{ fontWeight: 600 }}>{d.displayLabel || d.label || d.phoneModel || '—'}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.imei || <M />}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.secondaryImei || <M />}</td>
                  <td>{d.workPhone || <M />}</td>
                  <td>{d.androidVersion || <M />}</td>
                  <td><span className={`badge ${STATUS_BADGE[d.status]}`}>{STATUS_LABEL[d.status]}</span></td>
                  <td>{holder ? holder.name : <M />}</td>
                  <td style={{ fontSize: 12 }}>
                    {[d.phoneCase, d.phoneScreenguard].filter(Boolean).join(' / ') || <M />}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {/* Deliberately no Assign/Return here — allocation happens on the
                        Drivers screen, so there is exactly one place to do it. */}
                    <button className="btn-ghost" style={btn} onClick={() => setHistory(d)}>History</button>
                    <button className="btn-ghost" style={btn} onClick={() => setEditing(d)}>Edit</button>
                  </td>
                </tr>
              );
            })}
            {devices.length === 0 && (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  No devices yet. Add one, or run <code>npm run backfill:custody</code> in the backend to
                  import the phones already recorded against your drivers.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <DeviceForm onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {editing && <DeviceForm device={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {history && <DeviceHistory device={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

const btn = { fontSize: 12, padding: '4px 10px', marginRight: 6 } as const;
function M() { return <span style={{ color: 'var(--muted)' }}>—</span>; }

const FIELDS: { key: keyof MobileDevice; label: string; placeholder?: string }[] = [
  { key: 'label', label: 'Label (e.g. Ops phone 07)' },
  { key: 'imei', label: 'IMEI number', placeholder: '15-digit IMEI' },
  { key: 'secondaryImei', label: 'Secondary IMEI', placeholder: '15-digit IMEI' },
  { key: 'workPhone', label: 'Work phone number' },
  { key: 'phoneModel', label: 'Phone model' },
  { key: 'androidVersion', label: 'Android version' },
  { key: 'serial', label: 'Serial' },
  { key: 'phoneCase', label: 'Phone case' },
  { key: 'phoneScreenguard', label: 'Phone screenguard' },
  { key: 'country', label: 'Country' },
];

function DeviceForm({ device, onClose, onSaved }: {
  device?: MobileDevice; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    FIELDS.forEach(f => { init[f.key as string] = (device?.[f.key] as string) || ''; });
    return init;
  });
  const [status, setStatus] = useState<DeviceStatus>(device?.status || 'in_stock');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null); setBusy(true);
    try {
      const body: Record<string, unknown> = { status };
      FIELDS.forEach(f => { body[f.key as string] = form[f.key as string] || null; });
      if (device) await api.patch(`/api/mobiles/${device._id}`, body);
      else await api.post('/api/mobiles', body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally { setBusy(false); }
  };

  return (
    <Modal
      wide
      title={device ? `Edit · ${device.displayLabel || 'device'}` : 'Add mobile device'}
      onClose={onClose}
    >
      {error && <div className="error-text">{error}</div>}
      <div className="form-grid">
        {FIELDS.map(f => (
          <div className="field" key={f.key as string}>
            <label>{f.label}</label>
            <input
              className="input"
              placeholder={f.placeholder}
              value={form[f.key as string]}
              onChange={e => setForm(s => ({ ...s, [f.key as string]: e.target.value }))}
            />
          </div>
        ))}
        <div className="field">
          <label>Status</label>
          <select className="input" value={status} onChange={e => setStatus(e.target.value as DeviceStatus)}>
            {(Object.keys(STATUS_LABEL) as DeviceStatus[]).map(s => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
        {['repair', 'lost', 'retired'].includes(status) && device?.currentDriverId && (
          <p className="span-2" style={{ fontSize: 11.5, color: 'var(--amber)', margin: '0 0 8px' }}>
            This will also return the device from its current holder.
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

/** The device's life story — every driver who has held it. */
function DeviceHistory({ device, onClose }: { device: MobileDevice; onClose: () => void }) {
  const [history, setHistory] = useState<Assignment[] | null>(null);

  useEffect(() => {
    api.get<{ history: Assignment[] }>(`/api/mobiles/${device._id}`)
      .then(r => setHistory(r.history))
      .catch(() => setHistory([]));
  }, [device._id]);

  return (
    <Modal title={`History · ${device.displayLabel || 'device'}`} onClose={onClose}>
      {history === null && <p className="muted" style={{ fontSize: 13 }}>Loading…</p>}
      {history?.length === 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          No custody recorded yet. History starts the first time this device is assigned.
        </p>
      )}
      {history && history.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {history.map(h => (
            <div key={h._id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', borderRadius: 10,
              background: h.open ? 'var(--green-bg)' : 'var(--panel-2)',
              border: `1px solid ${h.open ? 'rgba(5,150,105,0.2)' : 'var(--line)'}`,
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {typeof h.driverId === 'object' ? h.driverId.name : h.driverName}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                  {h.backfilled && 'since at least '}
                  {h.startedAt.slice(0, 10)} → {h.endedAt ? h.endedAt.slice(0, 10) : 'now'}
                  {h.note ? ` · ${h.note}` : ''}
                </div>
              </div>
              {h.open && <span className="badge green">Holding</span>}
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
