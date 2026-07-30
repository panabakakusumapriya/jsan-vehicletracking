import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { Vehicle } from '../lib/types';

/**
 * Vehicle inventory — add, edit and retire vehicles.
 *
 * Allocation to a driver is NOT done here; it lives on the Drivers screen, so there is one
 * place to do it and no chance of two screens disagreeing about who holds what. The
 * "Assigned driver" column below is read-only, reflecting the current custody row.
 */
const assigned = (v: Vehicle['assignedDriverId']) => (v && typeof v === 'object' ? v.name : '—');

export function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);

  const load = () => {
    api.get<{ vehicles: Vehicle[] }>('/api/vehicles').then((r) => setVehicles(r.vehicles));
  };
  useEffect(load, []);

  const remove = async (v: Vehicle) => {
    if (!confirm(`Delete vehicle ${v.plateNumber}?`)) return;
    await api.del(`/api/vehicles/${v._id}`);
    load();
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Vehicles</h1>
        <button className="btn" onClick={() => setShowAdd(true)}>
          + Add vehicle
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>VID</th>
              <th>Plate</th>
              <th>Model</th>
              <th>Assigned driver</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) => (
              <tr key={v._id}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{v.vid || '—'}</td>
                <td>{v.plateNumber}</td>
                <td>{v.model || '—'}</td>
                <td>{assigned(v.assignedDriverId)}</td>
                <td>
                  <span className={`badge ${v.active ? 'green' : 'gray'}`}>{v.active ? 'active' : 'inactive'}</span>
                </td>
                <td style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setEditing(v)}>Edit</button>
                  <button className="btn-danger" onClick={() => remove(v)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {vehicles.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No vehicles yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddVehicle
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
      {editing && (
        <EditVehicle
          vehicle={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function AddVehicle({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ plateNumber: '', vid: '', model: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/vehicles', {
        plateNumber: form.plateNumber,
        vid: form.vid || undefined,
        model: form.model || undefined,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create vehicle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add vehicle" onClose={onClose}>
      <div className="field">
        <label>Plate number</label>
        <input className="input" value={form.plateNumber} onChange={(e) => set('plateNumber', e.target.value)} />
      </div>
      <div className="field">
        <label>VID</label>
        <input className="input" value={form.vid} onChange={(e) => set('vid', e.target.value)} />
      </div>
      <div className="field">
        <label>Model (optional)</label>
        <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} />
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '0 0 4px', lineHeight: 1.5 }}>
        Allocate this vehicle to a driver from the <b>Drivers</b> screen.
      </p>

      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Create vehicle'}
        </button>
      </div>
    </Modal>
  );
}

function EditVehicle({ vehicle, onClose, onSaved }: {
  vehicle: Vehicle; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    plateNumber: vehicle.plateNumber,
    vid: vehicle.vid || '',
    model: vehicle.model || '',
    active: vehicle.active,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.patch(`/api/vehicles/${vehicle._id}`, {
        plateNumber: form.plateNumber,
        vid: form.vid || null,
        model: form.model || null,
        active: form.active,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update vehicle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit · ${vehicle.plateNumber}`} onClose={onClose}>
      <div className="field">
        <label>Plate number</label>
        <input className="input" value={form.plateNumber} onChange={(e) => set('plateNumber', e.target.value)} />
      </div>
      <div className="field">
        <label>VID</label>
        <input className="input" value={form.vid} onChange={(e) => set('vid', e.target.value)} />
      </div>
      <div className="field">
        <label>Model</label>
        <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} />
      </div>
      <div className="field">
        <label>Currently held by</label>
        <input className="input" value={assigned(vehicle.assignedDriverId)} disabled readOnly />
        <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
          Change this from the <b>Drivers</b> screen — every handover is recorded there.
        </p>
      </div>
      <div className="field">
        <label>Status</label>
        <select className="input" value={form.active ? 'active' : 'inactive'} onChange={(e) => setForm(f => ({ ...f, active: e.target.value === 'active' }))}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </Modal>
  );
}
