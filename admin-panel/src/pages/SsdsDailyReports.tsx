import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { ssdsApi } from '../lib/ssdsApi';
import type { Project } from '../lib/types';

interface DailyReport {
  _id: string;
  driverName?: string;
  driverEmail?: string;
  vid?: string;
  reportType?: string;
  map?: string;
  kmsDone?: string | number;
  status?: string;
  notes?: string;
  submittedAt?: string;
  projectId?: string;
  projectName?: string | null;
  [key: string]: unknown;
}

interface MapAssignment {
  _id: string;
  email?: string;
  'Mail ID'?: string;
  maps?: string[];
  mapName?: string;
  [key: string]: unknown;
}

interface DailyReportsData {
  reports: DailyReport[];
  mapAssignments: MapAssignment[];
  total_reports: number;
}

const EMPTY_FORM = {
  driverName: '',
  driverEmail: '',
  vid: '',
  reportType: 'BOD',
  map: '',
  kmsDone: '',
  status: 'Pending',
  notes: '',
  projectId: '',
};

export function SsdsDailyReports() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canEdit = isAdmin || user?.role === 'manager';
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [mapAssignments, setMapAssignments] = useState<MapAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'reports' | 'maps'>('reports');
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
    if (projectFilter) params.set('projectId', projectFilter);
    const qs = params.toString();
    ssdsApi.get<DailyReportsData>(`/daily-reports${qs ? '?' + qs : ''}`)
      .then(r => { setReports(r.reports); setMapAssignments(r.mapAssignments); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [projectFilter]);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (projectFilter) params.set('projectId', projectFilter);
    ssdsApi.download(`/daily-reports/export${params.toString() ? '?' + params.toString() : ''}`).catch(e => alert(e.message));
  };

  const handleAssignProject = async (targetProjectId: string) => {
    if (!selected.size) return;
    setAssigning(true);
    try {
      await ssdsApi.patch('/assign-project', { collection: 'daily_reports', ids: [...selected], projectId: targetProjectId || null });
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

  const openEdit = (r: DailyReport) => {
    setEditId(r._id);
    setForm({
      driverName: r.driverName || '',
      driverEmail: r.driverEmail || '',
      vid: r.vid || '',
      reportType: r.reportType || 'BOD',
      map: r.map || '',
      kmsDone: String(r.kmsDone || ''),
      status: r.status || 'Pending',
      notes: r.notes || '',
      projectId: r.projectId || '',
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.driverName.trim()) return alert('Driver name is required');
    if (!isAdmin && !form.projectId) return alert('Project is required');
    setSaving(true);
    try {
      if (editId) await ssdsApi.patch(`/daily-reports/${editId}`, form);
      else await ssdsApi.post('/daily-reports', form);
      setShowModal(false);
      load();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this report?')) return;
    try { await ssdsApi.del(`/daily-reports/${id}`); load(); }
    catch (e: any) { alert(e.message); }
  };

  if (loading) return <div className="center-screen">Loading daily reports...</div>;
  if (error) return <div className="center-screen" style={{ color: 'var(--danger)' }}>Error: {error}</div>;

  const filteredReports = reports.filter(r => {
    if (!search) return true;
    const s = search.toLowerCase();
    return `${r.driverName} ${r.driverEmail} ${r.vid} ${r.reportType} ${r.map}`.toLowerCase().includes(s);
  });

  const reportTypes: Record<string, number> = {};
  reports.forEach(r => { const t = r.reportType || 'Unknown'; reportTypes[t] = (reportTypes[t] || 0) + 1; });

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">Daily Status Reports</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button className="btn" onClick={openAdd}>+ Add Report</button>}
          <button className="btn" onClick={handleExport}>Export</button>
          <button className="btn-ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Total Reports</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{reports.length}</div>
        </div>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Map Assignments</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{mapAssignments.length}</div>
        </div>
        {Object.entries(reportTypes).slice(0, 3).map(([t, c]) => (
          <div key={t} className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{t}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>{c}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input" value={projectFilter} onChange={e => setProjectFilter(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All Projects</option>
          {isAdmin && <option value="unassigned">Unassigned</option>}
          {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
        <button className={`btn${tab === 'reports' ? '' : '-ghost'}`} style={{ fontSize: 13 }} onClick={() => setTab('reports')}>
          Reports ({reports.length})
        </button>
        <button className={`btn${tab === 'maps' ? '' : '-ghost'}`} style={{ fontSize: 13 }} onClick={() => setTab('maps')}>
          Map Assignments ({mapAssignments.length})
        </button>
      </div>

      {tab === 'reports' && (
        <>
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <input className="input" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
            <span className="muted" style={{ alignSelf: 'center', fontSize: 12 }}>{filteredReports.length} records</span>
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

          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  {canEdit && <th style={{ width: 36 }}><input type="checkbox" checked={filteredReports.length > 0 && filteredReports.every(r => selected.has(r._id))} onChange={() => toggleAll(filteredReports.map(r => r._id))} /></th>}
                  <th>Driver Name</th>
                  <th>Email</th>
                  <th>VID</th>
                  <th>Project</th>
                  <th>Report Type</th>
                  <th>Map</th>
                  <th>KMs Done</th>
                  <th>Status</th>
                  <th>Submitted At</th>
                  {canEdit && <th style={{ width: 90 }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {filteredReports.map(r => (
                  <tr key={r._id}>
                    {canEdit && <td><input type="checkbox" checked={selected.has(r._id)} onChange={() => toggleSelect(r._id)} /></td>}
                    <td>{r.driverName || '—'}</td>
                    <td>{r.driverEmail || '—'}</td>
                    <td>{r.vid || '—'}</td>
                    <td><span className={`badge ${r.projectName ? 'blue' : 'gray'}`}>{r.projectName || 'Unassigned'}</span></td>
                    <td><span className={`badge ${r.reportType === 'BOD' ? 'blue' : r.reportType === 'EOD' ? 'green' : 'yellow'}`}>{r.reportType || '—'}</span></td>
                    <td>{r.map || '—'}</td>
                    <td>{r.kmsDone ?? '—'}</td>
                    <td>{r.status || '—'}</td>
                    <td>{r.submittedAt ? new Date(r.submittedAt).toLocaleString() : '—'}</td>
                    {canEdit && (
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => openEdit(r)}>Edit</button>
                          <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px', color: 'var(--danger)' }} onClick={() => handleDelete(r._id)}>Del</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {filteredReports.length === 0 && (
                  <tr><td colSpan={canEdit ? 11 : 9} className="muted" style={{ textAlign: 'center', padding: 28 }}>No reports found.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'maps' && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Maps</th>
              </tr>
            </thead>
            <tbody>
              {mapAssignments.map(m => (
                <tr key={m._id}>
                  <td>{m['Mail ID'] || m.email || '—'}</td>
                  <td>{(m.maps || [m.mapName]).filter(Boolean).join(', ') || '—'}</td>
                </tr>
              ))}
              {mapAssignments.length === 0 && (
                <tr><td colSpan={2} className="muted" style={{ textAlign: 'center', padding: 28 }}>No map assignments.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <h3 style={{ marginTop: 0 }}>{editId ? 'Edit Report' : 'Add Report'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label>Driver Name *
                <input className="input" value={form.driverName} onChange={e => setForm(f => ({ ...f, driverName: e.target.value }))} />
              </label>
              <label>Email
                <input className="input" value={form.driverEmail} onChange={e => setForm(f => ({ ...f, driverEmail: e.target.value }))} />
              </label>
              <label>VID
                <input className="input" value={form.vid} onChange={e => setForm(f => ({ ...f, vid: e.target.value }))} />
              </label>
              <label>Report Type
                <select className="input" value={form.reportType} onChange={e => setForm(f => ({ ...f, reportType: e.target.value }))}>
                  <option value="BOD">BOD</option>
                  <option value="EOD">EOD</option>
                  <option value="Midday">Midday</option>
                </select>
              </label>
              <label>Map
                <input className="input" value={form.map} onChange={e => setForm(f => ({ ...f, map: e.target.value }))} />
              </label>
              <label>KMs Done
                <input className="input" value={form.kmsDone} onChange={e => setForm(f => ({ ...f, kmsDone: e.target.value }))} />
              </label>
              <label>Status
                <select className="input" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="Pending">Pending</option>
                  <option value="Completed">Completed</option>
                  <option value="In Progress">In Progress</option>
                </select>
              </label>
              <label>Notes
                <textarea className="input" rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
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
