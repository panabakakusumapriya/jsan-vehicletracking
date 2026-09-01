import { useEffect, useRef, useState } from 'react';
import { ssdsApi } from '../lib/ssdsApi';
import { API_URL } from '../lib/api';
import Tesseract from 'tesseract.js';

interface SsdRecord {
  _id: string;
  ssdNumber: string;
  ssdStatus: string;
  ssdComments: string;
  ssdImageUrl: string;
  lastUpdated?: string;
  createdAt?: string;
}

interface DriverInfo {
  name: string;
  email: string;
  driverId?: string | null;
  country?: string | null;
  project?: string | null;
}

const SSD_STATUSES = ['In Camera', 'Empty - with driver', 'Filled - with driver', 'Shipped'];

export function DriverMySsds() {
  const [driver, setDriver] = useState<DriverInfo | null>(null);
  const [records, setRecords] = useState<SsdRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [editComments, setEditComments] = useState('');
  const [saving, setSaving] = useState(false);

  // Add new SSD
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSsdNumber, setNewSsdNumber] = useState('');
  const [newSsdStatus, setNewSsdStatus] = useState('');
  const [newSsdComments, setNewSsdComments] = useState('');
  const [capturedFile, setCapturedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Image lightbox
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // OCR
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    ssdsApi.get<{ driver: DriverInfo; records: SsdRecord[] }>('/my/ssds')
      .then(r => {
        setDriver(r.driver);
        setRecords(r.records || []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // ── Edit existing ──
  const startEdit = (rec: SsdRecord) => {
    setEditingId(rec._id);
    setEditStatus(rec.ssdStatus);
    setEditComments(rec.ssdComments);
  };
  const cancelEdit = () => setEditingId(null);
  const handleSaveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      await ssdsApi.patch(`/my/ssds/${editingId}`, { ssdStatus: editStatus, comments: editComments });
      setEditingId(null);
      load();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  // ── Add new SSD ──
  const openAddForm = () => {
    setShowAddForm(true);
    setNewSsdNumber('');
    setNewSsdStatus('');
    setNewSsdComments('');
    setCapturedFile(null);
    setPreviewUrl(null);
  };
  const closeAddForm = () => setShowAddForm(false);

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

      // Extract SN (Serial Number) / SSD number from text
      const snMatch =
        text.match(/\bSN[-:\s]*([A-Z0-9-]+)/i) ||
        text.match(/\bS\/N[-:\s]*([A-Z0-9-]+)/i) ||
        text.match(/\bSerial\s*(?:No\.?|Number)[-:\s]*([A-Z0-9-]+)/i) ||
        text.match(/SSD[-\s]?\d+/i) ||
        text.match(/\b\d{3,}\b/);

      if (snMatch) {
        const extracted = snMatch[1] || snMatch[0];
        setNewSsdNumber(extracted.trim());
      }
    } catch (err: any) {
      alert('OCR failed: ' + err.message);
    } finally {
      setOcrLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleCreateSsd = async () => {
    if (!newSsdNumber.trim()) return alert('SSD Number is required');
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append('ssdNumber', newSsdNumber.trim());
      formData.append('ssdStatus', newSsdStatus);
      formData.append('comments', newSsdComments);
      if (capturedFile) formData.append('ssdImage', capturedFile);

      await ssdsApi.postForm('/my/ssds', formData);
      setShowAddForm(false);
      load();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  // S3 URLs are absolute (https://...), local paths need API_URL prefix
  const imgUrl = (url: string) => {
    if (!url) return '';
    return url.startsWith('http') ? url : `${API_URL}${url}`;
  };

  if (loading) return <div className="center-screen">Loading your SSDS data...</div>;
  if (error) return <div className="center-screen" style={{ color: 'var(--danger)' }}>Error: {error}</div>;
  if (!driver) return <div className="center-screen muted">No data found for your account.</div>;

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">My SSDS</h1>
        <button className="btn" onClick={openAddForm} disabled={showAddForm}>+ Add SSD</button>
      </div>

      {/* Driver Info */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <div className="card" style={{ flex: '1 1 180px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Driver</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{driver.name}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{driver.email}</div>
        </div>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Country</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{driver.country || '—'}</div>
        </div>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Project</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{driver.project || '—'}</div>
        </div>
      </div>

      {/* ── Add New SSD Form ── */}
      {showAddForm && (
        <div className="card" style={{ padding: '20px 24px', marginBottom: 20, border: '2px solid var(--brand)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Add New SSD</h3>
            <button className="btn-ghost" onClick={closeAddForm} style={{ fontSize: 12 }}>Cancel</button>
          </div>

          {/* Capture Image */}
          <div style={{ marginBottom: 18 }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleImageCapture}
              style={{ display: 'none' }}
            />
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={ocrLoading} style={{ fontSize: 13 }}>
              {ocrLoading ? 'Extracting SSD Number...' : previewUrl ? 'Recapture Image' : 'Capture SSD Image'}
            </button>
            {ocrLoading && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 12 }}>
                <div style={{ width: 100, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${ocrProgress}%`, height: '100%', background: 'var(--brand)', borderRadius: 3, transition: 'width 0.3s' }} />
                </div>
                <span className="muted" style={{ fontSize: 12 }}>{ocrProgress}%</span>
              </div>
            )}
          </div>

          {/* Image Preview */}
          {previewUrl && (
            <div style={{ marginBottom: 18 }}>
              <img src={previewUrl} alt="SSD Card" style={{ maxWidth: 320, maxHeight: 220, borderRadius: 8, border: '1px solid var(--border)' }} />
            </div>
          )}

          {/* Form fields */}
          <div className="driver-ssds-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>SSD Number *</span>
              <input className="input" value={newSsdNumber} onChange={e => setNewSsdNumber(e.target.value)} placeholder="e.g. SSD-001" />
            </label>
            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>SSD Status</span>
              <select className="input" value={newSsdStatus} onChange={e => setNewSsdStatus(e.target.value)}>
                <option value="">Select...</option>
                {SSD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Date</span>
              <input className="input" type="date" value={new Date().toISOString().split('T')[0]} disabled style={{ color: 'var(--muted)' }} />
            </label>
            <div />
            <label style={{ gridColumn: '1 / -1' }}>
              <span style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Comments</span>
              <textarea className="input" rows={2} value={newSsdComments} onChange={e => setNewSsdComments(e.target.value)} placeholder="Optional notes..." />
            </label>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="btn" onClick={handleCreateSsd} disabled={saving || !newSsdNumber.trim()}>
              {saving ? 'Submitting...' : 'Submit New SSD'}
            </button>
          </div>
        </div>
      )}

      {/* ── SSD Records Table ── */}
      {records.length === 0 && !showAddForm ? (
        <div className="card" style={{ padding: '28px', textAlign: 'center', border: '2px dashed var(--border)' }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>No SSD Records</div>
          <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>Click "+ Add SSD" to scan and add your first SSD card.</p>
        </div>
      ) : records.length > 0 && (
        <div className="card" style={{ padding: 0, overflowX: 'auto', width: '100%' }}>
          <table style={{ minWidth: 700 }}>
            <thead>
              <tr>
                <th>SSD Number</th>
                <th>Status</th>
                <th>Date</th>
                <th>Last Updated</th>
                <th>Comments</th>
                <th>Image</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {records.map(rec => (
                <tr key={rec._id}>
                  {editingId === rec._id ? (
                    <>
                      <td><span className="badge blue">{rec.ssdNumber}</span></td>
                      <td>
                        <select className="input" value={editStatus} onChange={e => setEditStatus(e.target.value)} style={{ minWidth: 140 }}>
                          <option value="">Select...</option>
                          {SSD_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{rec.createdAt ? new Date(rec.createdAt).toLocaleDateString() : '—'}</td>
                      <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{rec.lastUpdated || '—'}</td>
                      <td>
                        <textarea className="input" rows={2} value={editComments} onChange={e => setEditComments(e.target.value)} style={{ minWidth: 160 }} />
                      </td>
                      <td>
                        {rec.ssdImageUrl && (
                          <img src={imgUrl(rec.ssdImageUrl)} alt="SSD" style={{ width: 60, height: 40, objectFit: 'cover', borderRadius: 4 }} />
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn" onClick={handleSaveEdit} disabled={saving} style={{ fontSize: 11, padding: '4px 10px' }}>
                            {saving ? '...' : 'Save'}
                          </button>
                          <button className="btn-ghost" onClick={cancelEdit} style={{ fontSize: 11, padding: '4px 8px' }}>Cancel</button>
                        </div>
                      </td>
</>
                  ) : (
                    <>
                      <td style={{ fontWeight: 600 }}>{rec.ssdNumber}</td>
                      <td>
                        <span className={`badge ${rec.ssdStatus === 'In Camera' ? 'blue' : rec.ssdStatus === 'Filled - with driver' ? 'green' : rec.ssdStatus === 'Empty - with driver' ? 'yellow' : 'gray'}`}>
                          {rec.ssdStatus || '—'}
                        </span>
                      </td>
                      <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{rec.createdAt ? new Date(rec.createdAt).toLocaleDateString() : '—'}</td>
                      <td className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{rec.lastUpdated || '—'}</td>
                      <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={rec.ssdComments}>
                        {rec.ssdComments || '—'}
                      </td>
                      <td>
                        {rec.ssdImageUrl ? (
                          <img src={imgUrl(rec.ssdImageUrl)} alt="SSD" style={{ width: 60, height: 40, objectFit: 'cover', borderRadius: 4, cursor: 'pointer' }}
                            onClick={() => setLightboxUrl(imgUrl(rec.ssdImageUrl))} />
                        ) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <button className="btn-ghost" onClick={() => startEdit(rec)} style={{ fontSize: 11, padding: '4px 8px' }}>Edit</button>
                      </td>
</>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
