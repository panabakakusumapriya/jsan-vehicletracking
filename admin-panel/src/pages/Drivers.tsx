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
    api.get<{ users: User[] }>('/api/users?role=user').then(r => setDrivers(r.users));
    api.get<{ vehicles: Vehicle[] }>('/api/vehicles').then(r => setVehicles(r.vehicles));
    if (isAdmin) api.get<{ users: User[] }>('/api/users?role=manager').then(r => setManagers(r.users));
  };
  useEffect(load, [isAdmin]);

  const deactivate = async (d: User) => {
    if (!confirm(`Deactivate ${d.name}? They will no longer be able to log in.`)) return;
    await api.del(`/api/users/${d._id}`);
    load();
  };

  const active   = drivers.filter(d => d.active).length;
  const inactive = drivers.length - active;
  const assigned = drivers.filter(d => d.vehicleId).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Drivers</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Manage driver accounts and vehicle assignments
          </p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>
          + Add driver
        </button>
      </div>

      {/* Stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="icon">👤</div>
          <div className="v">{drivers.length}</div>
          <div className="k">Total drivers</div>
        </div>
        <div className="stat">
          <div className="icon">✅</div>
          <div className="v">{active}</div>
          <div className="k">Active</div>
        </div>
        <div className="stat">
          <div className="icon">🚗</div>
          <div className="v">{assigned}</div>
          <div className="k">Assigned vehicle</div>
        </div>
        <div className="stat">
          <div className="icon">⛔</div>
          <div className="v">{inactive}</div>
          <div className="k">Inactive</div>
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Country</th>
              <th>Vehicle</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {drivers.map(d => (
              <tr key={d._id}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 10,
                      background: 'var(--brand-light)', border: '1px solid rgba(124,58,237,0.2)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: 'var(--brand)', fontSize: 11, fontWeight: 800, flexShrink: 0,
                    }}>
                      {d.name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()}
                    </div>
                    {d.name}
                  </div>
                </td>
                <td style={{ color: 'var(--muted)' }}>{d.email}</td>
                <td>{d.phone || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td>{d.country || <span style={{ color: 'var(--muted)' }}>—</span>}</td>
                <td>
                  {vehiclePlate(d.vehicleId) !== '—'
                    ? <span style={{ background: 'var(--panel-2)', border: '1px solid var(--line-2)', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}>{vehiclePlate(d.vehicleId)}</span>
                    : <span style={{ color: 'var(--muted)' }}>—</span>
                  }
                </td>
                <td><span className={`badge ${d.active ? 'green' : 'red'}`}>{d.active ? 'Active' : 'Inactive'}</span></td>
                <td>{d.active && <button className="btn-danger" onClick={() => deactivate(d)}>Deactivate</button>}</td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  No drivers yet — add one to get started.
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
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
    </div>
  );
}

function AddDriver({ vehicles, managers, isAdmin, onClose, onSaved }: {
  vehicles: Vehicle[]; managers: User[];
  isAdmin: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', country: '', vehicleId: '', managerId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.country.trim()) { setError('Country is required'); return; }
    setError(null); setBusy(true);
    try {
      await api.post('/api/users', {
        name: form.name, email: form.email, password: form.password,
        phone: form.phone || undefined, role: 'user',
        country: form.country.trim(),
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
    <Modal title="Add new driver" onClose={onClose}>
      <div className="field"><label>Full name</label>
        <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="John Smith" />
      </div>
      <div className="field"><label>Email</label>
        <input className="input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="driver@company.com" />
      </div>
      <div className="field"><label>Password</label>
        <input className="input" type="text" value={form.password} onChange={e => set('password', e.target.value)} placeholder="Temporary password" />
      </div>
      <div className="field"><label>Phone (optional)</label>
        <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+91 9876543210" />
      </div>
      <div className="field"><label>Country</label>
        <input className="input" value={form.country} onChange={e => set('country', e.target.value)} placeholder="India" />
      </div>
      {isAdmin && (
        <div className="field"><label>Manager</label>
          <select className="input" value={form.managerId} onChange={e => set('managerId', e.target.value)}>
            <option value="">— Unassigned —</option>
            {managers.map(m => <option key={m._id} value={m._id}>{m.name} ({m.email})</option>)}
          </select>
        </div>
      )}
      <div className="field"><label>Vehicle (optional)</label>
        <select className="input" value={form.vehicleId} onChange={e => set('vehicleId', e.target.value)}>
          <option value="">— None —</option>
          {vehicles.map(v => <option key={v._id} value={v._id}>{v.plateNumber}{v.model ? ` · ${v.model}` : ''}</option>)}
        </select>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Creating…' : 'Create driver'}</button>
      </div>
    </Modal>
  );
}
