import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api, API_URL } from '../lib/api';
import { ssdsApi } from '../lib/ssdsApi';
import { Modal } from '../components/Modal';
import type { Project, User } from '../lib/types';
import Tesseract from 'tesseract.js';

interface SsdsDriver {
  _id: string;
  ssdRecordId?: string | null;
  name: string;
  email: string;
  country?: string | null;
  vehicle?: { plateNumber: string; vid?: string } | null;
  ssdNumber: string;
  ssdStatus: string;
  ssdComments: string;
  ssdImageUrl?: string;
  lastUpdated?: string;
  createdAt?: string;
  active?: boolean;
}

interface SsdsData {
  data: SsdsDriver[];
  total_drivers: number;
  total_ssds: number;
}

const SSD_STATUSES = ['In Camera', 'Empty - with driver', 'Filled - with driver', 'Shipped'];
const M = () => <span className="muted">—</span>;
const todayStr = () => new Date().toISOString().split('T')[0];

const resolveImgUrl = (url?: string) => {
  if (!url) return '';
  return url.startsWith('http') ? url : `${API_URL}${url}`;
};

export function SsdsPortal() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canEdit = isAdmin || user?.role === 'manager';
  const [data, setData] = useState<SsdsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  // Form state
  const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
  const [editingDriver, setEditingDriver] = useState<SsdsDriver | null>(null);
  const [ssdNumber, setSsdNumber] = useState('');
  const [ssdStatus, setSsdStatus] = useState('');
  const [ssdComments, setSsdComments] = useState('');
  const [saving, setSaving] = useState(false);

  // Add mode: pick a driver
  const [allDrivers, setAllDrivers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');

  // OCR + image (add mode only)
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.get<{ projects: Project[] }>('/api/projects').then(r => setProjects(r.projects)).catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (projectFilter) params.set('projectId', projectFilter);
    const qs = params.toString();
    ssdsApi.get<SsdsData>(`/ssds${qs ? '?' + qs : ''}`)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [projectFilter]);

  const handleExport = () => {
    const params = new URLSearchParams();
    if (projectFilter) params.set('projectId', projectFilter);
    const qs = params.toString();
    ssdsApi.download(`/ssds/export${qs ? '?' + qs : ''}`).catch(e => alert(e.message));
  };

  const openAdd = () => {
    api.get<{ users: User[] }>('/api/users?role=user').then(r => setAllDrivers(r.users)).catch(() => {});
    setFormMode('add');
    setEditingDriver(null);
    setSelectedUserId('');
    setSsdNumber('');
    setSsdStatus('');
    setSsdComments('');
    setCapturedFile(null);
    setPreviewUrl(null);
  };

  const openEdit = (d: SsdsDriver) => {
    setFormMode('edit');
    setEditingDriver(d);
    setSelectedUserId(d._id);
    setSsdNumber(d.ssdNumber);
    setSsdStatus(d.ssdStatus);
    setSsdComments(d.ssdComments);
    setCapturedFile(null);
    setPreviewUrl(null);
  };

  const closeForm = () => {
    setFormMode('closed');
    setEditingDriver(null);
  };

  // OCR capture for add mode
  const handleImageCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setCapturedFile(file);
    setOcrLoading(true);
    setOcrProgress(0);
    try {
      const result = await Tesseract.recognize(file, 'eng', {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') setOcrProgress(Math.round(m.progress * 100));
        },
      });
      const text = result.data.text.trim();
      const snMatch =
        text.match(/\bSN[-:\s]*([A-Z0-9-]+)/i) ||
        text.match(/\bS\/N[-:\s]*([A-Z0-9-]+)/i) ||
        text.match(/\bSerial\s*(?:No\.?|Number)[-:\s]*([A-Z0-9-]+)/i) ||
        text.match(/SSD[-\s]?\d+/i) ||
        text.match(/\b\d{3,}\b/);
      if (snMatch) {
        setSsdNumber((snMatch[1] || snMatch[0]).trim());
      }
    } catch (err: any) {
      alert('OCR failed: ' + err.message);
    } finally {
      setOcrLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (formMode === 'edit' && editingDriver) {
        if (editingDriver.ssdRecordId) {
          await ssdsApi.patch(`/ssds/${editingDriver.ssdRecordId}`, { ssdNumber, ssdStatus, comments: ssdComments });
        } else {
          await ssdsApi.post('/ssds', { userId: editingDriver._id, ssdNumber, ssdStatus, comments: ssdComments });
        }
      } else if (formMode === 'add') {
        if (!selectedUserId) return alert('Please select a driver');
        if (!ssdNumber.trim()) return alert('SSD Number is required');
        // Use FormData if image is captured
        if (capturedFile) {
          const fd = new FormData();
          fd.append('userId', selectedUserId);
          fd.append('ssdNumber', ssdNumber);
          fd.append('ssdStatus', ssdStatus);
          fd.append('comments', ssdComments);
          fd.append('ssdImage', capturedFile);
          await ssdsApi.postForm('/ssds', fd);
        } else {
          await ssdsApi.post('/ssds', { userId: selectedUserId, ssdNumber, ssdStatus, comments: ssdComments });
        }
      }
      closeForm();
      load();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  const handleDelete = async (d: SsdsDriver) => {
    if (!d.ssdRecordId) return alert('No SSD record to delete for this driver.');
    if (!confirm(`Remove SSD record "${d.ssdNumber}" for ${d.name}?`)) return;
    try { await ssdsApi.del(`/ssds/${d.ssdRecordId}`); load(); }
    catch (e: any) { alert(e.message); }
  };

  if (loading) return <div className="center-screen">Loading SSDS data...</div>;
  if (error) return <div className="center-screen" style={{ color: 'var(--danger)' }}>Error: {error}</div>;
  if (!data) return null;

  const filtered = data.data.filter(d => {
    if (!search) return true;
    const s = search.toLowerCase();
    return `${d.name} ${d.email} ${d.country} ${d.vehicle?.vid || ''} ${d.ssdNumber}`.toLowerCase().includes(s);
  });

  const availableDrivers = allDrivers;

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">SSDS Portal</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && <button className="btn" onClick={openAdd}>+ Add SSD</button>}
          <button className="btn" onClick={handleExport}>Export</button>
          <button className="btn-ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Total Drivers</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{data.total_drivers}</div>
        </div>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>With SSD</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{data.total_ssds}</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="input" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        <select className="input" value={projectFilter} onChange={e => setProjectFilter(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">All Projects</option>
          {isAdmin && <option value="unassigned">Unassigned</option>}
          {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>{filtered.length} records</span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflowX: 'auto', width: '100%' }}>
        <table style={{ minWidth: 900 }}>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Email</th>
              <th>Country</th>
              <th>VID</th>
              <th>SSD</th>
              <th>Status</th>
              <th>Date</th>
              <th>Last Updated</th>
              <th>Comments</th>
              <th>Image</th>
              {canEdit && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((d, i) => (
              <tr key={d.ssdRecordId || `${d._id}-${i}`}>
                <td style={{ fontWeight: 600 }}>{d.name}</td>
                <td>{d.email}</td>
                <td>{d.country || <M />}</td>
                <td>{d.vehicle?.vid || <M />}</td>
                <td>{d.ssdNumber ? <span className="badge blue">{d.ssdNumber}</span> : <M />}</td>
                <td>
                  {d.ssdStatus ? (
                    <span className={`badge ${d.ssdStatus === 'In Camera' ? 'blue' : d.ssdStatus === 'Filled - with driver' ? 'green' : d.ssdStatus === 'Empty - with driver' ? 'yellow' : d.ssdStatus === 'Shipped' ? 'gray' : 'gray'}`}>
                      {d.ssdStatus}
                    </span>
                  ) : <M />}
                </td>
                <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {d.createdAt ? new Date(d.createdAt).toLocaleDateString() : <M />}
                </td>
                <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {d.lastUpdated || <M />}
                </td>
                <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.ssdComments}>{d.ssdComments || <M />}</td>
                <td>
                  {d.ssdImageUrl ? (
                    <img src={resolveImgUrl(d.ssdImageUrl)} alt="SSD" style={{ width: 50, height: 34, objectFit: 'cover', borderRadius: 4, cursor: 'pointer' }}
                      onClick={() => setLightboxUrl(resolveImgUrl(d.ssdImageUrl))} />
                  ) : <M />}
                </td>
                {canEdit && (
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }} onClick={() => openEdit(d)}>Edit</button>
                      {d.ssdRecordId && (
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 6px', color: 'var(--danger)' }} onClick={() => handleDelete(d)}>Del</button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={canEdit ? 11 : 10} className="muted" style={{ textAlign: 'center', padding: 28 }}>No drivers found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {formMode !== 'closed' && (
        <Modal title={formMode === 'add' ? 'Add SSD Record' : `Edit SSD — ${editingDriver?.name || ''}`} onClose={closeForm}>
          {formMode === 'edit' && editingDriver && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px', padding: '10px 14px', background: 'var(--surface)', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              <div><strong>Driver:</strong> {editingDriver.name}</div>
              <div><strong>Email:</strong> {editingDriver.email}</div>
              <div><strong>Country:</strong> {editingDriver.country || '—'}</div>
              <div><strong>VID:</strong> {editingDriver.vehicle?.vid || '—'}</div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {formMode === 'add' && (
              <>
                <label>
                  <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Select Driver</span>
                  <select className="input" value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)}>
                    <option value="">Choose a driver...</option>
                    {availableDrivers.map(d => (
                      <option key={d._id} value={d._id}>{d.name}</option>
                    ))}
                  </select>
                </label>
                {selectedUserId && (() => {
                  const sel = availableDrivers.find(d => d._id === selectedUserId);
                  if (!sel) return null;
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px', padding: '10px 14px', background: 'var(--surface)', borderRadius: 8, fontSize: 13 }}>
                      <div><strong>Country:</strong> {sel.country || '—'}</div>
                      <div><strong>VID:</strong> {(sel.vehicleId && typeof sel.vehicleId === 'object' ? sel.vehicleId.vid : null) || '—'}</div>
                    </div>
                  );
                })()}

                {/* OCR Capture (add mode only) */}
                <div style={{ padding: '12px 14px', background: 'var(--surface)', borderRadius: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Scan SSD Card (optional)</div>
                  <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={handleImageCapture} style={{ display: 'none' }} />
                  <button className="btn" onClick={() => fileRef.current?.click()} disabled={ocrLoading} style={{ fontSize: 12 }}>
                    {ocrLoading ? 'Extracting...' : previewUrl ? 'Recapture' : 'Capture SSD Image'}
                  </button>
                  {ocrLoading && (
                    <span style={{ marginLeft: 10 }}>
                      <span className="muted" style={{ fontSize: 12 }}>{ocrProgress}%</span>
                    </span>
                  )}
                  {previewUrl && (
                    <div style={{ marginTop: 10 }}>
                      <img src={previewUrl} alt="SSD" style={{ maxWidth: 240, maxHeight: 160, borderRadius: 6, border: '1px solid var(--border)' }} />
                    </div>
                  )}
                </div>
              </>
            )}

            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>SSD Number</span>
              <input className="input" value={ssdNumber} onChange={e => setSsdNumber(e.target.value)} placeholder="e.g. SSD-001" />
            </label>

            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>SSD Status</span>
              <select className="input" value={ssdStatus} onChange={e => setSsdStatus(e.target.value)}>
                <option value="">Select...</option>
                {SSD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>

            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Date</span>
              <input className="input" type="date" value={todayStr()} disabled style={{ color: 'var(--muted)' }} />
            </label>

            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Comments</span>
              <textarea className="input" rows={3} value={ssdComments} onChange={e => setSsdComments(e.target.value)} placeholder="Any notes..." />
            </label>
          </div>

          <div className="modal-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn-ghost" onClick={closeForm}>Cancel</button>
            <button className="btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : formMode === 'add' ? 'Add' : 'Update'}
            </button>
          </div>
        </Modal>
      )}

      {/* Image Lightbox */}
      {lightboxUrl && (
        <div onClick={() => setLightboxUrl(null)} style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999, cursor: 'pointer',
        }}>
          <img src={lightboxUrl} alt="SSD Card" style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: 8 }} />
        </div>
      )}
    </div>
  );
}
