import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { dt } from '../lib/format';
import type { User } from '../lib/types';

export function Managers() {
  const [managers, setManagers] = useState<User[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const load = () => api.get<{ users: User[] }>('/api/users?role=manager').then((r) => setManagers(r.users));
  useEffect(() => {
    load();
  }, []);

  const deactivate = async (m: User) => {
    if (!confirm(`Deactivate manager ${m.name}?`)) return;
    await api.del(`/api/users/${m._id}`);
    load();
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Managers</h1>
        <button className="btn" onClick={() => setShowAdd(true)}>
          + Add manager
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {managers.map((m) => (
              <tr key={m._id}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>{m.phone || '—'}</td>
                <td>{dt(m.createdAt)}</td>
                <td>
                  <span className={`badge ${m.active ? 'green' : 'red'}`}>{m.active ? 'active' : 'inactive'}</span>
                </td>
                <td style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setEditing(m)}>Edit</button>
                  {m.active && <button className="btn-danger" onClick={() => deactivate(m)}>Deactivate</button>}
                </td>
              </tr>
            ))}
            {managers.length === 0 && (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No managers yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddManager
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
      {editing && (
        <EditManager
          manager={editing}
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

function AddManager({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '' });
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
        role: 'manager',
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create manager');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add manager" onClose={onClose}>
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

      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Create manager'}
        </button>
      </div>
    </Modal>
  );
}

function EditManager({ manager, onClose, onSaved }: {
  manager: User; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: manager.name, phone: manager.phone || '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null); setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        phone: form.phone || null,
      };
      if (form.password) body.password = form.password;
      await api.patch(`/api/users/${manager._id}`, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update manager');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Edit · ${manager.name}`} onClose={onClose}>
      <div className="field">
        <label>Full name</label>
        <input className="input" value={form.name} onChange={e => set('name', e.target.value)} />
      </div>
      <div className="field">
        <label>Phone</label>
        <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} />
      </div>
      <div className="field">
        <label>New password (leave blank to keep current)</label>
        <input className="input" type="text" value={form.password} onChange={e => set('password', e.target.value)} placeholder="Leave blank to keep current" />
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button>
      </div>
    </Modal>
  );
}
