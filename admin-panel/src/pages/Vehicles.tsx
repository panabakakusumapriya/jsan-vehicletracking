import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { User, Vehicle } from '../lib/types';

const assigned = (v: Vehicle['assignedDriverId']) => (v && typeof v === 'object' ? v.name : '—');

export function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<User[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    api.get<{ vehicles: Vehicle[] }>('/api/vehicles').then((r) => setVehicles(r.vehicles));
    api.get<{ users: User[] }>('/api/users?role=user').then((r) => setDrivers(r.users));
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
                <td>{v.plateNumber}</td>
                <td>{v.model || '—'}</td>
                <td>{assigned(v.assignedDriverId)}</td>
                <td>
                  <span className={`badge ${v.active ? 'green' : 'gray'}`}>{v.active ? 'active' : 'inactive'}</span>
                </td>
                <td>
                  <button className="btn-danger" onClick={() => remove(v)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {vehicles.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No vehicles yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddVehicle
          drivers={drivers}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function AddVehicle({ drivers, onClose, onSaved }: { drivers: User[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ plateNumber: '', model: '', assignedDriverId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/vehicles', {
        plateNumber: form.plateNumber,
        model: form.model || undefined,
        assignedDriverId: form.assignedDriverId || undefined,
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
        <label>Model (optional)</label>
        <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} />
      </div>
      <div className="field">
        <label>Assign driver (optional)</label>
        <select className="input" value={form.assignedDriverId} onChange={(e) => set('assignedDriverId', e.target.value)}>
          <option value="">— None —</option>
          {drivers.map((d) => (
            <option key={d._id} value={d._id}>
              {d.name} ({d.email})
            </option>
          ))}
        </select>
      </div>

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
