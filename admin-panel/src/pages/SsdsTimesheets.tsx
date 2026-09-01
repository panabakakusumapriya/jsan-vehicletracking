import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { ssdsApi } from '../lib/ssdsApi';
import type { Project } from '../lib/types';

interface Timesheet {
  _id: string;
  'Driver Name'?: string;
  'Date'?: string;
  'Mail ID'?: string;
  'Country'?: string;
  'Actual Hours'?: string;
  'Status'?: string;
  'Comments'?: string;
  'Last Updated'?: string;
  'CommentsHistory'?: { by: string; text: string; at: string }[];
  projectId?: string;
  projectName?: string | null;
  [key: string]: unknown;
}

interface TimesheetData {
  timesheets: Timesheet[];
}

const EMPTY_FORM = {
  'Driver Name': '',
  'Date': '',
  'Mail ID': '',
  'Country': '',
  'Actual Hours': '',
  'Status': 'Pending',
  'Comments': '',
  projectId: '',
};

export function SsdsTimesheets() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canEdit = isAdmin || user?.role === 'manager';
  const [data, setData] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);

  // Modal
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ projects: Project[] }>('/api/projects').then(r => setProjects(r.projects)).catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    setSelected(new Set());
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (projectFilter) params.set('projectId', projectFilter);
    const qs = params.toString();
    ssdsApi.get<TimesheetData>(`/timesheets${qs ? '?' + qs : ''}`)
      .then(r => setData(r.timesheets))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [projectFilter]);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (projectFilter) params.set('projectId', projectFilter);
    const qs = params.toString();
    ssdsApi.download(`/timesheets/export${qs ? '?' + qs : ''}`).catch(e => alert(e.message));
  };

  const handleAssignProject = async (targetProjectId: string) => {
    if (!selected.size) return;
    setAssigning(true);
    try {
      await ssdsApi.patch('/assign-project', { collection: 'timesheets', ids: [...selected], projectId: targetProjectId || null });
      load();
    } catch (e: any) { alert(e.message); }
    finally { setAssigning(false); }
  };

  const toggleSelect = (id: string) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = (ids: string[]) => setSelected(prev => { const all = ids.every(id => prev.has(id)); const n = new Set(prev); if (all) ids.forEach(id => n.delete(id)); else ids.forEach(id => n.add(id)); return n; });

  const openAdd = () => {
    const userProjectIds = (user?.projectIds || []) as (string | { _id: string })[];
    const defaultProject = userProjectIds.length ? (typeof userProjectIds[0] === 'string' ? userProjectIds[0] : userProjectIds[0]._id) : '';
    setEditId(null);
    setForm({ ...EMPTY_FORM, projectId: defaultProject });
    setShowModal(true);
  };

  const openEdit = (t: Timesheet) => {
    setEditId(t._id);
    setForm({
      'Driver Name': t['Driver Name'] || '',
      'Date': t['Date'] || '',
      'Mail ID': t['Mail ID'] || '',
      'Country': t['Country'] || '',
      'Actual Hours': t['Actual Hours'] || '',
      'Status': t['Status'] || 'Pending',
      'Comments': t['Comments'] || '',
      projectId: t.projectId || '',
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form['Driver Name'].trim()) return alert('Driver Name is required');
    if (!isAdmin && !form.projectId) return alert('Project is required');
    setSaving(true);
    try {
      if (editId) await ssdsApi.patch(`/timesheets/${editId}`, form);
      else await ssdsApi.post('/timesheets', form);
      setShowModal(false);
      load();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this timesheet?')) return;
    try { await ssdsApi.del(`/timesheets/${id}`); load(); }
    catch (e: any) { alert(e.message); }
  };

  if (loading) return <div className="center-screen">Loading timesheets...</div>;
  if (error) return <div className="center-screen" style={{ color: 'var(--danger)' }}>Error: {error}</div>;

  const filtered = data.filter(t => {
    if (!search) return true;
    const s = search.toLowerCase();
    return `${t['Driver Name']} ${t['Mail ID']} ${t['Date']} ${t['Country']} ${t['Status']}`.toLowerCase().includes(s);
  });

  const statusCounts: Record<string, number> = {};
  data.forEach(t => { const s = t['Status'] || 'Unknown'; statusCounts[s] = (statusCounts[s] || 0) + 1; });

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Timesheets</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button className="btn" onClick={openAdd}>+ Add Timesheet</button>}
          <button className="btn" onClick={handleExport}>Export</button>
          <button className="btn-ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Total</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{data.length}</div>
        </div>
        {Object.entries(statusCounts).slice(0, 4).map(([s, c]) => (
          <div key={s} className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{s}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{c}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
        <select className="input" value={projectFilter} onChange={e => setProjectFilter(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All Projects</option>
          {isAdmin && <option value="unassigned">Unassigned</option>}
          {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
        <input className="input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={{ maxWidth: 155 }} />
        <input className="input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={{ maxWidth: 155 }} />
        <button className="btn-ghost" onClick={load} style={{ fontSize: 12 }}>Apply</button>
        <span className="muted" style={{ fontSize: 12 }}>{filtered.length} records</span>
      </div>

      {/* Bulk assign bar */}
      {canEdit && selected.size > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center', padding: '8px 12px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{selected.size} selected</span>
          <select className="input" style={{ maxWidth: 180 }} defaultValue="" onChange={e => { if (e.target.value !== '') handleAssignProject(e.target.value); }} disabled={assigning}>
            <option value="" disabled>Assign to project...</option>
            {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          {assigning && <span className="muted" style={{ fontSize: 12 }}>Assigning...</span>}
          <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              {canEdit && <th style={{ width: 36 }}><input type="checkbox" checked={filtered.length > 0 && filtered.every(t => selected.has(t._id))} onChange={() => toggleAll(filtered.map(t => t._id))} /></th>}
              <th>Driver Name</th>
              <th>Date</th>
              <th>Mail ID</th>
              <th>Country</th>
              <th>Project</th>
              <th>Actual Hours</th>
              <th>Status</th>
              <th>Comments</th>
              <th>Last Updated</th>
              {canEdit && <th style={{ width: 90 }}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map(t => (
              <tr key={t._id}>
                {canEdit && <td><input type="checkbox" checked={selected.has(t._id)} onChange={() => toggleSelect(t._id)} /></td>}
                <td>{t['Driver Name'] || '—'}</td>
                <td>{t['Date'] || '—'}</td>
                <td>{t['Mail ID'] || '—'}</td>
                <td>{t['Country'] || '—'}</td>
                <td><span className={`badge ${t.projectName ? 'blue' : 'gray'}`}>{t.projectName || 'Unassigned'}</span></td>
                <td>{t['Actual Hours'] || '—'}</td>
                <td>
                  <span className={`badge ${t['Status'] === 'Correct' ? 'green' : t['Status'] === 'Mismatched' ? 'red' : 'yellow'}`}>
                    {t['Status'] || '—'}
                  </span>
                </td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t['Comments'] || ''}>{t['Comments'] || '—'}</td>
                <td>{t['Last Updated'] || '—'}</td>
                {canEdit && (
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => openEdit(t)}>Edit</button>
                      <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px', color: 'var(--danger)' }} onClick={() => handleDelete(t._id)}>Del</button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={canEdit ? 11 : 9} className="muted" style={{ textAlign: 'center', padding: 28 }}>No timesheet data.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <h3 style={{ marginTop: 0 }}>{editId ? 'Edit Timesheet' : 'Add Timesheet'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label>Driver Name *
                <input className="input" value={form['Driver Name']} onChange={e => setForm(f => ({ ...f, 'Driver Name': e.target.value }))} />
              </label>
              <label>Date
                <input className="input" type="date" value={form['Date']} onChange={e => setForm(f => ({ ...f, 'Date': e.target.value }))} />
              </label>
              <label>Mail ID
                <input className="input" value={form['Mail ID']} onChange={e => setForm(f => ({ ...f, 'Mail ID': e.target.value }))} />
              </label>
              <label>Country
                <input className="input" value={form['Country']} onChange={e => setForm(f => ({ ...f, 'Country': e.target.value }))} />
              </label>
              <label>Actual Hours
                <input className="input" value={form['Actual Hours']} onChange={e => setForm(f => ({ ...f, 'Actual Hours': e.target.value }))} />
              </label>
              <label>Status
                <select className="input" value={form['Status']} onChange={e => setForm(f => ({ ...f, 'Status': e.target.value }))}>
                  <option value="Pending">Pending</option>
                  <option value="Correct">Correct</option>
                  <option value="Mismatched">Mismatched</option>
                  <option value="Approved">Approved</option>
                </select>
              </label>
              <label>Comments
                <textarea className="input" rows={3} value={form['Comments']} onChange={e => setForm(f => ({ ...f, 'Comments': e.target.value }))} />
              </label>
              <label>Project *
                <select className="input" value={form.projectId} onChange={e => setForm(f => ({ ...f, projectId: e.target.value }))}>
                  <option value="">Select project...</option>
                  {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
              <button className="btn" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : editId ? 'Update' : 'Add'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
