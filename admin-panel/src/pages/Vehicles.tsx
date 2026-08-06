import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { Project, User, Vehicle } from '../lib/types';

const driverObj = (v: Vehicle['assignedDriverId']) => (v && typeof v === 'object' ? v : null);
const assigned = (v: Vehicle['assignedDriverId']) => (v && typeof v === 'object' ? v.name : '—');
const assignedId = (v: Vehicle['assignedDriverId']) => (v && typeof v === 'object' ? v._id : (v as string | null | undefined) ?? '');

export function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<User[]>([]);
  const [projectOptions, setProjectOptions] = useState<Project[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Vehicle | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');

  const load = () => {
    Promise.all([
      api.get<{ vehicles: Vehicle[] }>('/api/vehicles'),
      api.get<{ users: User[] }>('/api/users?role=user'),
      api.get<{ projects: Project[] }>('/api/projects'),
    ]).then(([vr, ur, pr]) => {
      setVehicles(vr.vehicles);
      setDrivers(ur.users ?? []);
      setProjectOptions(pr.projects ?? []);
    });
  };
  useEffect(load, []);

  const remove = async (v: Vehicle) => {
    if (!confirm(`Delete vehicle ${v.plateNumber}?`)) return;
    await api.del(`/api/vehicles/${v._id}`);
    load();
  };

  // Derive project from assigned driver
  const vehicleProject = (v: Vehicle): string | null => {
    const d = driverObj(v.assignedDriverId);
    return d?.project || null;
  };

  const filteredByProject = projectFilter
    ? vehicles.filter(v => vehicleProject(v) === projectFilter)
    : vehicles;

  const countries = Array.from(new Set(
    filteredByProject.map(v => v.country).filter(Boolean)
  )).sort() as string[];

  const filtered = filteredByProject.filter(v => {
    if (countryFilter && v.country !== countryFilter) return false;
    return true;
  });

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Vehicles</h1>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="input" style={{ width: 120, fontSize: 12, padding: '4px 6px' }} value={projectFilter} onChange={e => { setProjectFilter(e.target.value); setCountryFilter(''); }}>
            <option value="">Project</option>
            {projectOptions.map(p => <option key={p._id} value={p.name}>{p.name}</option>)}
          </select>
          <select className="input" style={{ width: 100, fontSize: 12, padding: '4px 6px' }} value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
            <option value="">Country</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button className="btn" onClick={() => setShowAdd(true)}>
            + Add vehicle
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>VID</th>
              <th>Licence Plate</th>
              <th>Model</th>
              <th>Country</th>
              <th>Assigned Driver</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => (
              <tr key={v._id}>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{v.vid || '—'}</td>
                <td>{v.plateNumber}</td>
                <td>{v.model || '—'}</td>
                <td>{v.country || '—'}</td>
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
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No vehicles found.
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
      {editing && (
        <EditVehicle
          vehicle={editing}
          drivers={drivers}
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

function AddVehicle({ drivers, onClose, onSaved }: { drivers: User[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ plateNumber: '', vid: '', model: '', country: '', assignedDriverId: '' });
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
        country: form.country || undefined,
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
        <label>VID</label>
        <input className="input" value={form.vid} onChange={(e) => set('vid', e.target.value)} />
      </div>
      <div className="field">
        <label>Model (optional)</label>
        <input className="input" value={form.model} onChange={(e) => set('model', e.target.value)} />
      </div>
      <div className="field">
        <label>Country (optional)</label>
        <input className="input" value={form.country} onChange={(e) => set('country', e.target.value)} />
      </div>
      <div className="field">
        <label>Assign to driver (optional)</label>
        <select className="input" value={form.assignedDriverId} onChange={(e) => set('assignedDriverId', e.target.value)}>
          <option value="">— Unassigned —</option>
          {drivers.map(d => (
            <option key={d._id} value={d._id}>{d.name}{d.country ? ` (${d.country})` : ''}</option>
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

function EditVehicle({ vehicle, drivers, onClose, onSaved }: {
  vehicle: Vehicle; drivers: User[]; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({
    plateNumber: vehicle.plateNumber,
    vid: vehicle.vid || '',
    model: vehicle.model || '',
    country: vehicle.country || '',
    active: vehicle.active,
    assignedDriverId: assignedId(vehicle.assignedDriverId),
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
        country: form.country || null,
        active: form.active,
        assignedDriverId: form.assignedDriverId || null,
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
        <label>Country</label>
        <input className="input" value={form.country} onChange={(e) => set('country', e.target.value)} />
      </div>
      <div className="field">
        <label>Assigned driver</label>
        <select className="input" value={form.assignedDriverId} onChange={(e) => set('assignedDriverId', e.target.value)}>
          <option value="">— Unassigned —</option>
          {drivers.map(d => (
            <option key={d._id} value={d._id}>{d.name}{d.country ? ` (${d.country})` : ''}</option>
          ))}
        </select>
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
