import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { dt } from '../lib/format';
import type { User } from '../lib/types';

export function Managers() {
  const [users, setUsers] = useState<User[]>([]);
  const [managers, setManagers] = useState<User[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);

  const load = () => {
    Promise.all([
      api.get<{ users: User[] }>('/api/users?role=manager'),
      api.get<{ users: User[] }>('/api/users?role=team_lead'),
    ]).then(([mgrs, leads]) => {
      setManagers(mgrs.users);
      setUsers([...mgrs.users, ...leads.users]);
    });
  };
  useEffect(() => { load(); }, []);

  const deactivate = async (m: User) => {
    if (!confirm(`Deactivate ${m.name}?`)) return;
    await api.del(`/api/users/${m._id}`);
    load();
  };

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Users</h1>
        <button className="btn" onClick={() => setShowAdd(true)}>
          + Add user
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Role</th>
              <th>Manager</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((m) => (
              <tr key={m._id}>
                <td>{m.name}</td>
                <td>{m.email}</td>
                <td>{m.phone || '—'}</td>
                <td><span className="badge gray" style={{ textTransform: 'capitalize' }}>{m.role === 'team_lead' ? 'Team Lead' : m.role}</span></td>
                <td>{m.role === 'team_lead' && m.managerId && typeof m.managerId === 'object' ? m.managerId.name : '—'}</td>
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
            {users.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddUser
          managers={managers}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
      {editing && (
        <EditUser
          user={editing}
          managers={managers}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function AddUser({ managers, onClose, onSaved }: { managers: User[]; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', role: 'manager', managerId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (form.role === 'team_lead' && !form.managerId) {
      setError('Please select a manager for this team lead');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/users', {
        name: form.name,
        email: form.email,
        password: form.password,
        phone: form.phone || undefined,
        role: form.role,
        managerId: form.role === 'team_lead' ? form.managerId : undefined,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create user');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add user" onClose={onClose}>
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
      <div className="field">
        <label>Role</label>
        <select className="input" value={form.role} onChange={(e) => set('role', e.target.value)}>
          <option value="manager">Manager</option>
          <option value="team_lead">Team Lead</option>
        </select>
      </div>
      {form.role === 'team_lead' && (
        <div className="field">
          <label>Assign to Manager *</label>
          <select className="input" value={form.managerId} onChange={(e) => set('managerId', e.target.value)}>
            <option value="">— Select manager —</option>
            {managers.map(m => <option key={m._id} value={m._id}>{m.name} ({m.email})</option>)}
          </select>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Create user'}
        </button>
      </div>
    </Modal>
  );
}

function EditUser({ user, managers, onClose, onSaved }: {
  user: User; managers: User[]; onClose: () => void; onSaved: () => void;
}) {
  const currentManagerId = user.managerId && typeof user.managerId === 'object' ? user.managerId._id : (user.managerId || '');
  const [form, setForm] = useState({ name: user.name, email: user.email, phone: user.phone || '', password: '', role: user.role, managerId: currentManagerId as string });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (form.role === 'team_lead' && !form.managerId) {
      setError('Please select a manager for this team lead');
      return;
    }
    setError(null); setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        email: form.email,
        phone: form.phone || null,
        role: form.role,
        managerId: form.role === 'team_lead' ? form.managerId : null,
      };
      if (form.password) body.password = form.password;
      await api.patch(`/api/users/${user._id}`, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update user');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Edit · ${user.name}`} onClose={onClose}>
      <div className="field">
        <label>Full name</label>
        <input className="input" value={form.name} onChange={e => set('name', e.target.value)} />
      </div>
      <div className="field">
        <label>Email</label>
        <input className="input" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
      </div>
      <div className="field">
        <label>Phone</label>
        <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} />
      </div>
      <div className="field">
        <label>Role</label>
        <select className="input" value={form.role} onChange={e => set('role', e.target.value)}>
          <option value="manager">Manager</option>
          <option value="team_lead">Team Lead</option>
        </select>
      </div>
      {form.role === 'team_lead' && (
        <div className="field">
          <label>Assign to Manager *</label>
          <select className="input" value={form.managerId} onChange={e => set('managerId', e.target.value)}>
            <option value="">— Select manager —</option>
            {managers.map(m => <option key={m._id} value={m._id}>{m.name} ({m.email})</option>)}
          </select>
        </div>
      )}
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
