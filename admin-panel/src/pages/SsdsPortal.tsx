import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth';
import { api, API_URL } from '../lib/api';
import { ssdsApi } from '../lib/ssdsApi';
import { Modal } from '../components/Modal';
import type { Project, User } from '../lib/types';
import { extractFromImages } from '../lib/ocrAi';

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
  ssdImageUrls?: string[];
  rigId?: string;
  dataUnit?: string;
  shippingCompany?: string;
  trackingNumber?: string;
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
const SHIPPING_COMPANIES = ['UPS', 'FedEx', 'AU Post'];
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
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);

  // Form state
  const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
  const [editingDriver, setEditingDriver] = useState<SsdsDriver | null>(null);
  const [ssdNumber, setSsdNumber] = useState('');
  const [ssdStatus, setSsdStatus] = useState('');
  const [ssdComments, setSsdComments] = useState('');
  const [rigId, setRigId] = useState('');
  const [dataUnit, setDataUnit] = useState('');
  const [shippingCompany, setShippingCompany] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [saving, setSaving] = useState(false);

  // Add mode: pick a driver
  const [allDrivers, setAllDrivers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');

  // OCR + multiple images (add mode only)
  const [capturedFiles, setCapturedFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  // Lightbox for multiple images
  const [lightboxUrls, setLightboxUrls] = useState<string[]>([]);
  const [lightboxIdx, setLightboxIdx] = useState(0);

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
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
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
    setRigId('');
    setDataUnit('');
    setShippingCompany('');
    setTrackingNumber('');
    setCapturedFiles([]);
    setPreviewUrls([]);
  };

  const openEdit = (d: SsdsDriver) => {
    setFormMode('edit');
    setEditingDriver(d);
    setSelectedUserId(d._id);
    setSsdNumber(d.ssdNumber);
    setSsdStatus(d.ssdStatus);
    setSsdComments(d.ssdComments);
    setRigId(d.rigId || '');
    setDataUnit(d.dataUnit || '');
    setShippingCompany(d.shippingCompany || '');
    setTrackingNumber(d.trackingNumber || '');
    setCapturedFiles([]);
    setPreviewUrls([]);
  };

  const closeForm = () => {
    setFormMode('closed');
    setEditingDriver(null);
  };

  // AI OCR — uses Gemini Flash Lite for fast extraction (all images in parallel)
  const handleImageCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files.length) return;
    const newFiles = Array.from(files);
    const newUrls = newFiles.map(f => URL.createObjectURL(f));
    setCapturedFiles(prev => [...prev, ...newFiles]);
    setPreviewUrls(prev => [...prev, ...newUrls]);

    setOcrLoading(true);
    setOcrProgress(0);
    try {
      const result = await extractFromImages(newFiles, setOcrProgress);
      if (!ssdNumber && result.ssdNumber) setSsdNumber(result.ssdNumber);
      if (!dataUnit && result.dataUnit) setDataUnit(result.dataUnit);
      if (!trackingNumber && result.trackingNumber) setTrackingNumber(result.trackingNumber);
      if (!shippingCompany && result.shippingCompany) setShippingCompany(result.shippingCompany);
    } catch (err: any) {
      alert('AI OCR failed: ' + err.message);
    } finally {
      setOcrLoading(false);
    }
    if (cameraRef.current) cameraRef.current.value = '';
    if (galleryRef.current) galleryRef.current.value = '';
  };

  const removeImage = (idx: number) => {
    setCapturedFiles(prev => prev.filter((_, i) => i !== idx));
    setPreviewUrls(prev => {
      URL.revokeObjectURL(prev[idx]);
      return prev.filter((_, i) => i !== idx);
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const extraFields = { rigId, dataUnit, shippingCompany, trackingNumber };
      if (formMode === 'edit' && editingDriver) {
        if (editingDriver.ssdRecordId) {
          await ssdsApi.patch(`/ssds/${editingDriver.ssdRecordId}`, { ssdNumber, ssdStatus, comments: ssdComments, ...extraFields });
        } else {
          await ssdsApi.post('/ssds', { userId: editingDriver._id, ssdNumber, ssdStatus, comments: ssdComments, ...extraFields });
        }
      } else if (formMode === 'add') {
        if (!selectedUserId) return alert('Please select a driver');
        if (!ssdNumber.trim()) return alert('SSD Number is required');
        const fd = new FormData();
        fd.append('userId', selectedUserId);
        fd.append('ssdNumber', ssdNumber);
        fd.append('ssdStatus', ssdStatus);
        fd.append('comments', ssdComments);
        fd.append('rigId', rigId);
        fd.append('dataUnit', dataUnit);
        fd.append('shippingCompany', shippingCompany);
        fd.append('trackingNumber', trackingNumber);
        capturedFiles.forEach(f => fd.append('ssdImages', f));
        await ssdsApi.postForm('/ssds', fd);
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
    if (search) {
      const s = search.toLowerCase();
      if (!`${d.name} ${d.email} ${d.country} ${d.vehicle?.vid || ''} ${d.ssdNumber}`.toLowerCase().includes(s)) return false;
    }
    if (startDate || endDate) {
      const date = d.createdAt ? new Date(d.createdAt).toISOString().split('T')[0] : '';
      if (!date) return false;
      if (startDate && date < startDate) return false;
      if (endDate && date > endDate) return false;
    }
    return true;
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
        <input className="input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} title="From date" style={{ maxWidth: 150 }} />
        <input className="input" type="date" value={endDate} onChange={e => setEndDate(e.target.value)} title="To date" style={{ maxWidth: 150 }} />
        {(startDate || endDate) && (
          <button className="btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => { setStartDate(''); setEndDate(''); }}>Clear dates</button>
        )}
        <span className="muted" style={{ fontSize: 12 }}>{filtered.length} records</span>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflowX: 'auto', width: '100%' }}>
        <table style={{ minWidth: 1200 }}>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Email</th>
              <th>Country</th>
              <th>VID</th>
              <th>SSD</th>
              <th>Status</th>
              <th>Rig ID</th>
              <th>Data Unit</th>
              <th>Shipping Company</th>
              <th>Tracking Number</th>
              <th>Date</th>
              <th>Last Updated</th>
              <th>Comments</th>
              <th>Images</th>
              {canEdit && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((d, i) => {
              const imgs = d.ssdImageUrls?.length ? d.ssdImageUrls : d.ssdImageUrl ? [d.ssdImageUrl] : [];
              return (
              <tr key={d.ssdRecordId || `${d._id}-${i}`}>
                <td style={{ fontWeight: 600 }}>{d.name}</td>
                <td>{d.email}</td>
                <td>{d.country || <M />}</td>
                <td>{d.vehicle?.vid || <M />}</td>
                <td>{d.ssdNumber ? <span className="badge blue">{d.ssdNumber}</span> : <M />}</td>
                <td>
                  {d.ssdStatus ? (
                    <span className={`badge ${d.ssdStatus === 'In Camera' ? 'blue' : d.ssdStatus === 'Filled - with driver' ? 'green' : d.ssdStatus === 'Empty - with driver' ? 'yellow' : 'gray'}`}>
                      {d.ssdStatus}
                    </span>
                  ) : <M />}
                </td>
                <td>{d.rigId || <M />}</td>
                <td>{d.dataUnit || <M />}</td>
                <td>{d.shippingCompany || <M />}</td>
                <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.trackingNumber}>{d.trackingNumber || <M />}</td>
                <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {d.createdAt ? new Date(d.createdAt).toLocaleDateString() : <M />}
                </td>
                <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {d.lastUpdated || <M />}
                </td>
                <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.ssdComments}>{d.ssdComments || <M />}</td>
                <td>
                  {imgs.length > 0 ? (
                    <div style={{ display: 'flex', gap: 3 }}>
                      {imgs.map((url, idx) => (
                        <img key={idx} src={resolveImgUrl(url)} alt="SSD" style={{ width: 36, height: 28, objectFit: 'cover', borderRadius: 3, cursor: 'pointer' }}
                          onClick={() => { setLightboxUrls(imgs.map(resolveImgUrl)); setLightboxIdx(idx); }} />
                      ))}
                    </div>
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
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={canEdit ? 15 : 14} className="muted" style={{ textAlign: 'center', padding: 28 }}>No drivers found.</td></tr>
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

                {/* Image Capture — multiple images with OCR */}
                <div style={{ padding: '12px 14px', background: 'var(--surface)', borderRadius: 8 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Capture SSD Images (optional — OCR extracts Data Unit &amp; Tracking #)</div>
                  <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple onChange={handleImageCapture} style={{ display: 'none' }} />
                  <input ref={galleryRef} type="file" accept="image/*" multiple onChange={handleImageCapture} style={{ display: 'none' }} />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn" onClick={() => cameraRef.current?.click()} disabled={ocrLoading} style={{ fontSize: 12 }}>
                      {ocrLoading ? 'Extracting...' : '📷 Camera'}
                    </button>
                    <button className="btn" onClick={() => galleryRef.current?.click()} disabled={ocrLoading} style={{ fontSize: 12 }}>
                      🖼️ Gallery
                    </button>
                  </div>
                  {ocrLoading && (
                    <span style={{ marginLeft: 10 }}>
                      <span className="muted" style={{ fontSize: 12 }}>{ocrProgress}%</span>
                    </span>
                  )}
                  {previewUrls.length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                      {previewUrls.map((url, idx) => (
                        <div key={idx} style={{ position: 'relative' }}>
                          <img src={url} alt={`SSD ${idx + 1}`} style={{ width: 100, height: 70, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} />
                          <button type="button" onClick={() => removeImage(idx)} style={{
                            position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%',
                            background: 'var(--danger, #dc2626)', color: '#fff', border: 'none', cursor: 'pointer',
                            fontSize: 11, lineHeight: '18px', textAlign: 'center', padding: 0,
                          }}>×</button>
                        </div>
                      ))}
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
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Rig ID</span>
              <input className="input" value={rigId} onChange={e => setRigId(e.target.value)} placeholder="e.g. HT480" />
            </label>

            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Data Unit</span>
              <input className="input" value={dataUnit} onChange={e => setDataUnit(e.target.value)} placeholder="e.g. 47451" />
            </label>

            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Shipping Company</span>
              <select className="input" value={shippingCompany} onChange={e => setShippingCompany(e.target.value)}>
                <option value="">Select...</option>
                {SHIPPING_COMPANIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>

            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Tracking Number</span>
              <input className="input" value={trackingNumber} onChange={e => setTrackingNumber(e.target.value)} placeholder="e.g. 1221572804240006..." />
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

      {/* Image Lightbox — multi-image with nav */}
      {lightboxUrls.length > 0 && (
        <div onClick={() => setLightboxUrls([])} style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 9999, cursor: 'pointer',
        }}>
          <div onClick={e => e.stopPropagation()} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 16 }}>
            {lightboxUrls.length > 1 && (
              <button onClick={() => setLightboxIdx(i => (i - 1 + lightboxUrls.length) % lightboxUrls.length)} style={{
                background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', fontSize: 28, cursor: 'pointer',
                borderRadius: '50%', width: 40, height: 40, lineHeight: '40px',
              }}>‹</button>
            )}
            <img src={lightboxUrls[lightboxIdx]} alt="SSD Card" style={{ maxWidth: '80vw', maxHeight: '85vh', borderRadius: 8 }} />
            {lightboxUrls.length > 1 && (
              <button onClick={() => setLightboxIdx(i => (i + 1) % lightboxUrls.length)} style={{
                background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', fontSize: 28, cursor: 'pointer',
                borderRadius: '50%', width: 40, height: 40, lineHeight: '40px',
              }}>›</button>
            )}
          </div>
          {lightboxUrls.length > 1 && (
            <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', color: '#fff', fontSize: 13 }}>
              {lightboxIdx + 1} / {lightboxUrls.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
