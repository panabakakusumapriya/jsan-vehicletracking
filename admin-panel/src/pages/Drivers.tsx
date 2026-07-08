import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { User, Vehicle } from '../lib/types';

const vehiclePlate = (v: User['vehicleId']) => (v && typeof v === 'object' ? v.plateNumber : '—');

export function Drivers() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [drivers, setDrivers] = useState<User[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [managers, setManagers] = useState<User[]>([]);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    api.get<{ users: User[] }>('/api/users?role=user').then((r) => setDrivers(r.users));
    api.get<{ vehicles: Vehicle[] }>('/api/vehicles').then((r) => setVehicles(r.vehicles));
    if (isAdmin) api.get<{ users: User[] }>('/api/users?role=manager').then((r) => setManagers(r.users));
  };
  useEffect(load, [isAdmin]);

  const deactivate = async (d: User) => {
    if (!confirm(`Deactivate ${d.name}? They will no longer be able to log in.`)) return;
    await api.del(`/api/users/${d._id}`);
    load();
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Drivers</h1>
        <button className="btn" onClick={() => setShowAdd(true)}>
          + Add driver
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Vehicle</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d._id}>
                <td>{d.name}</td>
                <td>{d.email}</td>
                <td>{d.phone || '—'}</td>
                <td>{vehiclePlate(d.vehicleId)}</td>
                <td>
                  <span className={`badge ${d.active ? 'green' : 'red'}`}>{d.active ? 'active' : 'inactive'}</span>
                </td>
                <td>{d.active && <button className="btn-danger" onClick={() => deactivate(d)}>Deactivate</button>}</td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No drivers yet. Add one to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddDriver
          vehicles={vehicles}
          managers={managers}
          isAdmin={isAdmin}
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

function AddDriver({
  vehicles,
  managers,
  isAdmin,
  onClose,
  onSaved,
}: {
  vehicles: Vehicle[];
  managers: User[];
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', vehicleId: '', managerId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/users', {
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
        role: 'user',
        vehicleId: form.vehicleId || undefined,
        managerId: isAdmin ? form.managerId || undefined : undefined,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create driver');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add driver" onClose={onClose}>
      <div className="field">
        <label>Full name</label>
        <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div className="field">
        <label>Email</label>
        <input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
      </div>
      <div className="field">
        <label>Password</label>
        <input className="input" type="text" value={form.password} onChange={(e) => set('password', e.target.value)} />
      </div>
      <div className="field">
        <label>Phone (optional)</label>
        <input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
      </div>
      {isAdmin && (
        <div className="field">
          <label>Manager</label>
          <select className="input" value={form.managerId} onChange={(e) => set('managerId', e.target.value)}>
            <option value="">— Unassigned —</option>
            {managers.map((m) => (
              <option key={m._id} value={m._id}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label>Vehicle (optional)</label>
        <select className="input" value={form.vehicleId} onChange={(e) => set('vehicleId', e.target.value)}>
          <option value="">— None —</option>
          {vehicles.map((v) => (
            <option key={v._id} value={v._id}>
              {v.plateNumber} {v.model ? `· ${v.model}` : ''}
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
          {busy ? 'Saving…' : 'Create driver'}
        </button>
      </div>
    </Modal>
  );
}
