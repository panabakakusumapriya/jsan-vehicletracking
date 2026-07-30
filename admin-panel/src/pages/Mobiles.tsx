import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { User } from '../lib/types';

export function Mobiles() {
  const [drivers, setDrivers] = useState<User[]>([]);
  const [editing, setEditing] = useState<User | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = () => {
    api.get<{ users: User[] }>('/api/users?role=user').then(r => setDrivers(r.users));
  };
  useEffect(load, []);

  const assigned = drivers.filter(d => d.workPhone || d.imei).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Mobiles</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Manage driver mobile devices and hardware info
          </p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>+ Add mobile</button>
      </div>

      <div className="stat-row">
        <div className="stat"><div className="v">{drivers.length}</div><div className="k">Total drivers</div></div>
        <div className="stat"><div className="v">{assigned}</div><div className="k">Devices assigned</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Driver Name</th>
              <th>Work Phone Number</th>
              <th>IMEI Number</th>
              <th>Secondary IMEI</th>
              <th>Phone Model</th>
              <th>Android Version</th>
              <th>Phone Case</th>
              <th>Phone Screenguard</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {drivers.map(d => (
              <tr key={d._id}>
                <td style={{ fontWeight: 600 }}>{d.name}</td>
                <td>{d.workPhone || <M />}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.imei || <M />}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.secondaryImei || <M />}</td>
                <td>{d.phoneModel || <M />}</td>
                <td>{d.androidVersion || <M />}</td>
                <td>{d.phoneCase || <M />}</td>
                <td>{d.phoneScreenguard || <M />}</td>
                <td>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setEditing(d)}>Edit</button>
                </td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No drivers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddMobile drivers={drivers} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {editing && <EditMobile driver={editing} drivers={drivers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function M() { return <span style={{ color: 'var(--muted)' }}>—</span>; }

function AddMobile({ drivers, onClose, onSaved }: {
  drivers: User[]; onClose: () => void; onSaved: () => void;
}) {
  const unassigned = drivers.filter(d => !d.workPhone && !d.imei);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState({
    workPhone: '', imei: '', secondaryImei: '', phoneModel: '', androidVersion: '', phoneCase: '', phoneScreenguard: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!selectedId) { setError('Select a driver'); return; }
    setError(null); setBusy(true);
    try {
      await api.patch(`/api/users/${selectedId}`, {
        workPhone: form.workPhone || null,
        imei: form.imei || null,
        secondaryImei: form.secondaryImei || null,
        phoneModel: form.phoneModel || null,
        androidVersion: form.androidVersion || null,
        phoneCase: form.phoneCase || null,
        phoneScreenguard: form.phoneScreenguard || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add mobile');
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Add mobile device" onClose={onClose}>
      <div className="field"><label>Driver</label>
        <select className="input" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
          <option value="">— Select driver —</option>
          {(unassigned.length > 0 ? unassigned : drivers).map(d => (
            <option key={d._id} value={d._id}>{d.name}</option>
          ))}
        </select>
      </div>
      <div className="field"><label>Work Phone Number</label>
        <input className="input" value={form.workPhone} onChange={e => set('workPhone', e.target.value)} placeholder="+91 9876543210" />
      </div>
      <div className="field"><label>IMEI Number</label>
        <input className="input" value={form.imei} onChange={e => set('imei', e.target.value)} placeholder="15-digit IMEI" />
      </div>
      <div className="field"><label>Secondary IMEI Number (optional)</label>
        <input className="input" value={form.secondaryImei} onChange={e => set('secondaryImei', e.target.value)} placeholder="15-digit IMEI" />
      </div>
      <div className="field"><label>Phone Model</label>
        <input className="input" value={form.phoneModel} onChange={e => set('phoneModel', e.target.value)} placeholder="Samsung Galaxy A14" />
      </div>
      <div className="field"><label>Android Version</label>
        <input className="input" value={form.androidVersion} onChange={e => set('androidVersion', e.target.value)} placeholder="14" />
      </div>
      <div className="field"><label>Phone Case</label>
        <select className="input" value={form.phoneCase} onChange={e => set('phoneCase', e.target.value)}>
          <option value="">— Select —</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </div>
      <div className="field"><label>Phone Screenguard</label>
        <select className="input" value={form.phoneScreenguard} onChange={e => set('phoneScreenguard', e.target.value)}>
          <option value="">— Select —</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Add mobile'}</button>
      </div>
    </Modal>
  );
}

function EditMobile({ driver, drivers, onClose, onSaved }: {
  driver: User; drivers: User[]; onClose: () => void; onSaved: () => void;
}) {
  const [selectedDriverId, setSelectedDriverId] = useState(driver._id);
  const [form, setForm] = useState({
    workPhone: driver.workPhone || '',
    secondaryImei: driver.secondaryImei || '',
    phoneModel: driver.phoneModel || '',
    androidVersion: driver.androidVersion || '',
    phoneCase: driver.phoneCase || '',
    phoneScreenguard: driver.phoneScreenguard || '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null); setBusy(true);
    try {
      // If driver changed, clear mobile data from old driver and set on new one
      if (selectedDriverId !== driver._id) {
        await api.patch(`/api/users/${driver._id}`, {
          workPhone: null, imei: null, secondaryImei: null, phoneModel: null, androidVersion: null, phoneCase: null, phoneScreenguard: null,
        });
      }
      await api.patch(`/api/users/${selectedDriverId}`, {
        workPhone: form.workPhone || null,
        secondaryImei: form.secondaryImei || null,
        phoneModel: form.phoneModel || null,
        androidVersion: form.androidVersion || null,
        phoneCase: form.phoneCase || null,
        phoneScreenguard: form.phoneScreenguard || null,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Mobile · ${driver.imei || 'No IMEI'}`} onClose={onClose}>
      <div className="field"><label>Driver</label>
        <select className="input" value={selectedDriverId} onChange={e => setSelectedDriverId(e.target.value)}>
          {drivers.map(d => (
            <option key={d._id} value={d._id}>{d.name}</option>
          ))}
        </select>
      </div>
      <div className="field"><label>Work Phone Number</label>
        <input className="input" value={form.workPhone} onChange={e => set('workPhone', e.target.value)} placeholder="+91 9876543210" />
      </div>
      <div className="field"><label>Secondary IMEI Number (optional)</label>
        <input className="input" value={form.secondaryImei} onChange={e => set('secondaryImei', e.target.value)} placeholder="15-digit IMEI" />
      </div>
      <div className="field"><label>Phone Model</label>
        <input className="input" value={form.phoneModel} onChange={e => set('phoneModel', e.target.value)} placeholder="Samsung Galaxy A14" />
      </div>
      <div className="field"><label>Android Version</label>
        <input className="input" value={form.androidVersion} onChange={e => set('androidVersion', e.target.value)} placeholder="14" />
      </div>
      <div className="field"><label>Phone Case</label>
        <select className="input" value={form.phoneCase} onChange={e => set('phoneCase', e.target.value)}>
          <option value="">— Select —</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </div>
      <div className="field"><label>Phone Screenguard</label>
        <select className="input" value={form.phoneScreenguard} onChange={e => set('phoneScreenguard', e.target.value)}>
          <option value="">— Select —</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save'}</button>
      </div>
    </Modal>
  );
}
