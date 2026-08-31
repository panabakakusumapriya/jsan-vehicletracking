import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { Project } from '../lib/types';

/**
 * Projects — the tenancy boundary managers, team leads and drivers operate inside.
 *
 * A manager/team lead can only ever create drivers inside their OWN project (enforced on the
 * backend, not just here), so this list is what actually shapes who can see and manage whom —
 * see docs/asset-custody-design.md's sibling note in user.controller.js for the enforcement.
 */
export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);

  const load = () => {
    api.get<{ projects: Project[] }>('/api/projects?all=true').then((r) => setProjects(r.projects));
  };
  useEffect(load, []);

  const remove = async (p: Project) => {
    if (!confirm(`Delete project "${p.name}"? This only works if nobody is assigned to it.`)) return;
    try {
      await api.del(`/api/projects/${p._id}`);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete project');
    }
  };

  const active = projects.filter((p) => p.active).length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Every manager, team lead and driver belongs to one of these. A project's coverage scope
            decides which history its UKM is measured against.
          </p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>+ Add project</button>
      </div>

      <div className="stat-row">
        <div className="stat"><div className="v">{projects.length}</div><div className="k">Total</div></div>
        <div className="stat"><div className="v">{active}</div><div className="k">Active</div></div>
        <div className="stat"><div className="v">{projects.length - active}</div><div className="k">Inactive</div></div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Country</th>
              <th title="Projects sharing a coverage scope deduplicate UKM against each other">Coverage scope</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => (
              <tr key={p._id}>
                <td style={{ fontWeight: 600 }}>{p.name}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.code || '—'}</td>
                <td>{p.country || '—'}</td>
                <td style={{ fontSize: 12 }}>
                  {p.coverageScopeId
                    ? <span style={{ fontFamily: 'monospace' }}>{p.coverageScopeId}</span>
                    : <span style={{ color: 'var(--muted)' }} title="Shares the fleet-wide default scope: deduplicates against every other project">shared default</span>}
                  {p.coverageCycleId && (
                    <span style={{ color: 'var(--muted)', fontFamily: 'monospace' }}> · {p.coverageCycleId}</span>
                  )}
                </td>
                <td><span className={`badge ${p.active ? 'green' : 'gray'}`}>{p.active ? 'Active' : 'Inactive'}</span></td>
                <td style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setEditing(p)}>Edit</button>
                  <button className="btn-danger" onClick={() => remove(p)}>Delete</button>
                </td>
              </tr>
            ))}
            {projects.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No projects yet — add one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <ProjectForm onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {editing && <ProjectForm project={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function ProjectForm({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: project?.name || '',
    code: project?.code || '',
    country: project?.country || '',
    coverageScopeId: project?.coverageScopeId || '',
    coverageCycleId: project?.coverageCycleId || '',
    active: project?.active ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) { setError('Project name is required'); return; }
    setError(null); setBusy(true);
    try {
      const body = {
        name: form.name.trim(),
        code: form.code || null,
        country: form.country || null,
        // Empty means "use the shared default scope" — the backend stores null and resolves it at
        // read time, rather than freezing today's default name into every project row.
        coverageScopeId: form.coverageScopeId.trim() || null,
        coverageCycleId: form.coverageCycleId.trim() || null,
        active: form.active,
      };
      if (project) await api.patch(`/api/projects/${project._id}`, body);
      else await api.post('/api/projects', body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save project');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={project ? `Edit · ${project.name}` : 'Add project'} onClose={onClose}>
      <div className="field">
        <label>Project name *</label>
        <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. PRJ-007-CT-SV-AU-Google" />
      </div>
      <div className="field">
        <label>Code (optional)</label>
        <input className="input" value={form.code} onChange={(e) => set('code', e.target.value)} />
      </div>
      <div className="field">
        <label>Country (optional)</label>
        <input className="input" value={form.country} onChange={(e) => set('country', e.target.value)} />
      </div>
      <div className="field">
        <label>Coverage scope (optional)</label>
        <input className="input" value={form.coverageScopeId}
          onChange={(e) => set('coverageScopeId', e.target.value)}
          placeholder="leave empty to share the fleet-wide default" />
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
          Projects that share a scope share one coverage history: a road first driven under another
          project in the same scope earns <b>no</b> UKM here. Leave this empty unless this project's
          coverage must be counted <b>separately</b> — a different customer, or a deliberately
          repeated capture. Giving a project its own scope creates duplicate billable road by
          definition, and only affects trips recorded from now on.
        </div>
      </div>
      <div className="field">
        <label>Coverage cycle (optional)</label>
        <input className="input" value={form.coverageCycleId}
          onChange={(e) => set('coverageCycleId', e.target.value)}
          placeholder="e.g. 2027-refresh" />
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>
          Starts uniqueness again from scratch inside the scope, without touching the previous
          cycle's numbers. Use for a re-capture campaign where the same streets must be paid for
          again.
        </div>
      </div>
      {project && (
        <div className="field">
          <label>Status</label>
          <select className="input" value={form.active ? 'active' : 'inactive'} onChange={(e) => setForm((f) => ({ ...f, active: e.target.value === 'active' }))}>
            <option value="active">Active — selectable when creating users</option>
            <option value="inactive">Inactive — hidden from new assignments</option>
          </select>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : project ? 'Save changes' : 'Create project'}</button>
      </div>
    </Modal>
  );
}
