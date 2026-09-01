import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dt } from '../lib/format';
import type { Project, User, TabKey, TabPermission } from '../lib/types';
import { TAB_LABELS, ADMIN_PANEL_TABS, SSDS_TABS, ADMIN_ONLY_TABS } from '../lib/types';

const idOf = (ref: unknown): string =>
  ref && typeof ref === 'object' ? String((ref as { _id: string })._id) : (ref ? String(ref) : '');
const idsOf = (refs: User['projectIds']): string[] => (refs || []).map(idOf).filter(Boolean);
const namesOf = (refs: User['projectIds']): string[] =>
  (refs || []).map((r) => (r && typeof r === 'object' ? r.name : null)).filter((x): x is string => Boolean(x));

/**
 * Checkbox list rather than a native multi-select — a manager can run more than one project at
 * once (129 drivers split across 3 projects under a single manager, observed directly in this
 * fleet's data), so a single dropdown isn't enough for that tier.
 */
function ProjectPicker({ projects, selectedIds, onToggle }: {
  projects: Project[]; selectedIds: string[]; onToggle: (id: string) => void;
}) {
  return (
    <div style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--radius)', maxHeight: 160, overflowY: 'auto', background: 'var(--panel)' }}>
      {projects.length === 0 && (
        <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No projects yet — add one on the Projects tab.</div>
      )}
      {projects.map((p) => {
        const checked = selectedIds.includes(p._id);
        return (
          <label key={p._id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 10px', fontSize: 12.5, cursor: 'pointer',
            borderBottom: '1px solid var(--line)',
          }}>
            <input type="checkbox" checked={checked} onChange={() => onToggle(p._id)} />
            <span style={{ flex: 1 }}>{p.name}</span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * Lets an admin assign edit / view / hidden per tab for a user. Grouped into
 * "Admin Panel" tabs and "SSDS Tool" tabs so the layout stays clean.
 */
function TabPermissionsPicker({ value, onChange }: {
  value: Partial<Record<TabKey, TabPermission>>;
  onChange: (v: Partial<Record<TabKey, TabPermission>>) => void;
}) {
  const set = (key: TabKey, perm: TabPermission) => {
    onChange({ ...value, [key]: perm });
  };

  const renderGroup = (label: string, keys: readonly TabKey[]) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
      <div style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--radius)', background: 'var(--panel)', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px', padding: '6px 10px', fontSize: 11, fontWeight: 600, color: 'var(--muted)', borderBottom: '1px solid var(--line-2)' }}>
          <span>Module</span>
          <span style={{ textAlign: 'center' }}>Edit</span>
          <span style={{ textAlign: 'center' }}>View</span>
          <span style={{ textAlign: 'center' }}>Hidden</span>
        </div>
        {keys.map((key) => {
          const current = value[key] || (ADMIN_ONLY_TABS.includes(key) ? 'hidden' : 'edit');
          return (
            <div key={key} style={{
              display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px',
              padding: '7px 10px', fontSize: 12.5,
              borderBottom: '1px solid var(--line)',
              alignItems: 'center',
            }}>
              <span>{TAB_LABELS[key]}</span>
              {(['edit', 'view', 'hidden'] as TabPermission[]).map((perm) => (
                <label key={perm} style={{ display: 'flex', justifyContent: 'center', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name={`perm-${key}`}
                    checked={current === perm}
                    onChange={() => set(key, perm)}
                  />
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div>
      {renderGroup('Admin Panel Tabs', ADMIN_PANEL_TABS)}
      {renderGroup('SSDS Tool Tabs', SSDS_TABS)}
    </div>
  );
}

export function Managers() {
  const [users, setUsers] = useState<User[]>([]);
  const [managers, setManagers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
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
    api.get<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects));
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
              <th>Project(s)</th>
              <th>Manager</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((m) => {
              const projectNames = namesOf(m.projectIds);
              return (
                <tr key={m._id}>
                  <td>{m.name}</td>
                  <td>{m.email}</td>
                  <td>{m.phone || '—'}</td>
                  <td><span className="badge gray" style={{ textTransform: 'capitalize' }}>{m.role === 'team_lead' ? 'Team Lead' : m.role}</span></td>
                  <td title={projectNames.join(', ')}>{projectNames.length ? projectNames.join(', ') : '—'}</td>
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
              );
            })}
            {users.length === 0 && (
              <tr>
                <td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 28 }}>
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
          projects={projects}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
      {editing && (
        <EditUser
          user={editing}
          managers={managers}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function AddUser({ managers, projects, onClose, onSaved }: {
  managers: User[]; projects: Project[]; onClose: () => void; onSaved: () => void;
}) {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', role: 'manager', managerId: '' });
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [tabPermissions, setTabPermissions] = useState<Partial<Record<TabKey, TabPermission>>>({});
  const [showPermissions, setShowPermissions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const toggleProject = (id: string) => setProjectIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

  const save = async () => {
    if (form.role === 'team_lead' && !form.managerId) {
      setError('Please select a manager for this team lead');
      return;
    }
    if (!projectIds.length) {
      setError('Please select at least one project');
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
        projectIds,
        tabPermissions: Object.keys(tabPermissions).length ? tabPermissions : undefined,
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
      <div className="field">
        <label>Project(s) * {projectIds.length ? `· ${projectIds.length} selected` : ''}</label>
        <ProjectPicker projects={projects} selectedIds={projectIds} onToggle={toggleProject} />
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

      {isAdmin && (
        <div className="field">
          <button
            type="button"
            className="btn-ghost"
            style={{ fontSize: 12.5, padding: '6px 0' }}
            onClick={() => setShowPermissions((v) => !v)}
          >
            {showPermissions ? '▼' : '▶'} Module Permissions
          </button>
          {showPermissions && (
            <div style={{ marginTop: 8 }}>
              <TabPermissionsPicker value={tabPermissions} onChange={setTabPermissions} />
            </div>
          )}
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

function EditUser({ user, managers, projects, onClose, onSaved }: {
  user: User; managers: User[]; projects: Project[]; onClose: () => void; onSaved: () => void;
}) {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const currentManagerId = user.managerId && typeof user.managerId === 'object' ? user.managerId._id : (user.managerId || '');
  const [form, setForm] = useState({
    name: user.name, email: user.email, phone: user.phone || '', password: '', role: user.role,
    managerId: currentManagerId as string,
  });
  const [projectIds, setProjectIds] = useState<string[]>(idsOf(user.projectIds));
  const [tabPermissions, setTabPermissions] = useState<Partial<Record<TabKey, TabPermission>>>(
    (user.tabPermissions as Partial<Record<TabKey, TabPermission>>) || {}
  );
  const [showPermissions, setShowPermissions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const toggleProject = (id: string) => setProjectIds((ids) => ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);

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
      if (projectIds.length) body.projectIds = projectIds;
      if (form.password) body.password = form.password;
      if (isAdmin) body.tabPermissions = tabPermissions;
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
      <div className="field">
        <label>Project(s) {projectIds.length ? `· ${projectIds.length} selected` : '· none assigned yet'}</label>
        <ProjectPicker projects={projects} selectedIds={projectIds} onToggle={toggleProject} />
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

      {isAdmin && (
        <div className="field">
          <button
            type="button"
            className="btn-ghost"
            style={{ fontSize: 12.5, padding: '6px 0' }}
            onClick={() => setShowPermissions((v) => !v)}
          >
            {showPermissions ? '▼' : '▶'} Module Permissions
          </button>
          {showPermissions && (
            <div style={{ marginTop: 8 }}>
              <TabPermissionsPicker value={tabPermissions} onChange={setTabPermissions} />
            </div>
          )}
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button>
      </div>
    </Modal>
  );
}
