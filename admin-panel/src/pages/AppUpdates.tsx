import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';

interface AppVersion {
  _id: string;
  version: string;
  platform: string;
  buildNumber?: string;
  downloadUrl: string;
  releaseNotes: string;
  isActive: boolean;
  releasedAt: string;
}

const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
const EditIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);
function InlineUrlEditor({ v, onSaved }: { v: AppVersion; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(v.downloadUrl);
  const [busy, setBusy] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const save = async () => {
    setUrlError(null);
    if (url) {
      try { new URL(url); } catch { setUrlError('Must be a valid URL'); return; }
    }
    setBusy(true);
    try {
      await api.patch(`/api/app/versions/${v._id}`, {
        isActive: v.isActive,
        downloadUrl: url,
        releaseNotes: v.releaseNotes,
        buildNumber: v.buildNumber,
      });
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div style={{ minWidth: 260 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            className="input"
            style={{ margin: 0, padding: '4px 8px', fontSize: 12, flex: 1, borderColor: urlError ? 'var(--red)' : undefined }}
            value={url}
            onChange={e => { setUrl(e.target.value); setUrlError(null); }}
            placeholder="https://…/app.apk"
            autoFocus
          />
          <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={save} disabled={busy}>
            {busy ? '…' : 'Save'}
          </button>
          <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => { setUrl(v.downloadUrl); setEditing(false); setUrlError(null); }}>
            ✕
          </button>
        </div>
        {urlError && <div style={{ fontSize: 11, color: 'var(--red, #dc2626)', marginTop: 3 }}>{urlError}</div>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {v.downloadUrl
        ? <>
            <a href={v.downloadUrl} target="_blank" rel="noreferrer"
               style={{ color: 'var(--brand)', fontSize: 12.5, fontWeight: 500, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
              {v.downloadUrl}
            </a>
            <button onClick={() => setEditing(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 2 }}>
              <EditIcon />
            </button>
          </>
        : <button
            onClick={() => setEditing(true)}
            style={{ color: 'var(--brand)', fontSize: 12, fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            + Add URL
          </button>
      }
    </div>
  );
}

export function AppUpdates() {
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.get<{ versions: AppVersion[] }>('/api/app/versions')
      .then(r => setVersions(r.versions))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const setActive = async (v: AppVersion) => {
    setActionBusy(v._id);
    try {
      await api.patch(`/api/app/versions/${v._id}`, {
        isActive: true,
        downloadUrl: v.downloadUrl,
        releaseNotes: v.releaseNotes,
        buildNumber: v.buildNumber,
      });
      load();
    } finally {
      setActionBusy(null);
    }
  };

  const remove = async (v: AppVersion) => {
    if (!confirm(`Delete version ${v.version}?`)) return;
    setActionBusy(v._id);
    try {
      await api.del(`/api/app/versions/${v._id}`);
      load();
    } finally {
      setActionBusy(null);
    }
  };

  const active = versions.find(v => v.isActive);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">App Updates</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Manage mobile app versions — versions appear here automatically when the app launches
          </p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>
          <PlusIcon /> Add version
        </button>
      </div>

      {/* Stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="icon">📦</div>
          <div className="v">{versions.length}</div>
          <div className="k">Total versions</div>
        </div>
        <div className="stat">
          <div className="icon">✅</div>
          <div className="v">{active?.version ?? '—'}</div>
          <div className="k">Required version</div>
        </div>
        <div className="stat">
          <div className="icon">🔗</div>
          <div className="v" style={{ fontSize: 13 }}>
            {active?.downloadUrl
              ? <a href={active.downloadUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--brand)' }}>View link</a>
              : <span style={{ color: 'var(--muted)' }}>Not set</span>
            }
          </div>
          <div className="k">Active download</div>
        </div>
        <div className="stat">
          <div className="icon">📱</div>
          <div className="v">{active?.platform ?? '—'}</div>
          <div className="k">Platform</div>
        </div>
      </div>

      {/* Active version highlight */}
      {active && (
        <div className="card" style={{
          marginBottom: 16,
          background: 'var(--brand-light)',
          border: '1.5px solid rgba(124,58,237,0.2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span className="badge green">Required version</span>
            <span style={{ fontWeight: 800, fontSize: 18, color: 'var(--brand)' }}>v{active.version}</span>
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              · build {active.buildNumber ?? '—'} · {active.platform}
            </span>
          </div>
          {active.downloadUrl
            ? <div style={{ fontSize: 13, marginBottom: active.releaseNotes ? 6 : 0 }}>
                <span style={{ color: 'var(--muted)' }}>Download: </span>
                <a href={active.downloadUrl} target="_blank" rel="noreferrer"
                   style={{ color: 'var(--brand)', fontWeight: 600, wordBreak: 'break-all' }}>
                  {active.downloadUrl}
                </a>
              </div>
            : <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: active.releaseNotes ? 6 : 0 }}>
                No download link set — click the edit icon in the table below to add one.
              </div>
          }
          {active.releaseNotes && (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>{active.releaseNotes}</p>
          )}
        </div>
      )}

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Build</th>
              <th>Platform</th>
              <th>Detected</th>
              <th>Download URL</th>
              <th>Release notes</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {versions.map(v => (
              <tr key={v._id}>
                <td>
                  <span style={{ fontWeight: 700, fontFamily: 'monospace', fontSize: 14 }}>v{v.version}</span>
                </td>
                <td style={{ color: 'var(--muted)' }}>{v.buildNumber ?? '—'}</td>
                <td>
                  <span style={{
                    background: 'var(--panel-2)', border: '1px solid var(--line-2)',
                    borderRadius: 5, padding: '1px 7px', fontSize: 11.5, fontWeight: 600,
                  }}>{v.platform}</span>
                </td>
                <td style={{ color: 'var(--muted)', fontSize: 13 }}>
                  {new Date(v.releasedAt).toLocaleDateString()}
                </td>
                <td>
                  <InlineUrlEditor v={v} onSaved={load} />
                </td>
                <td style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 200 }}>
                  {v.releaseNotes || <span style={{ color: 'var(--line-2)' }}>—</span>}
                </td>
                <td>
                  <span className={`badge ${v.isActive ? 'green' : 'gray'}`}>
                    {v.isActive ? 'Required' : 'Inactive'}
                  </span>
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {!v.isActive && (
                      <button
                        className="btn"
                        style={{ padding: '4px 10px', fontSize: 12 }}
                        disabled={actionBusy === v._id}
                        onClick={() => setActive(v)}
                      >
                        Set required
                      </button>
                    )}
                    <button
                      className="btn-danger"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      disabled={actionBusy === v._id || v.isActive}
                      onClick={() => remove(v)}
                      title={v.isActive ? 'Cannot delete the required version' : ''}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && versions.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  No versions yet — launch the mobile app once and it will appear here automatically.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--muted)' }}>
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddVersion
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
    </div>
  );
}

function AddVersion({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    version: '', platform: 'android', buildNumber: '', downloadUrl: '', releaseNotes: '', isActive: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null);

    // Client-side validation
    const semverPattern = /^\d+\.\d+\.\d+$/;
    if (!form.version.trim()) { setError('Version is required'); return; }
    if (!semverPattern.test(form.version.trim())) { setError('Version must be in semver format: 1.0.0'); return; }
    if (form.downloadUrl) {
      try { new URL(form.downloadUrl); } catch { setError('Download URL must be a valid URL (include https://)'); return; }
    }

    setBusy(true);
    try {
      await api.post('/api/app/versions', {
        version: form.version.trim(),
        platform: form.platform,
        buildNumber: form.buildNumber || undefined,
        downloadUrl: form.downloadUrl || '',
        releaseNotes: form.releaseNotes || '',
        isActive: form.isActive,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create version');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add app version" onClose={onClose}>
      <div className="field"><label>Version (semver)</label>
        <input className="input" value={form.version} onChange={e => set('version', e.target.value)} placeholder="1.0.0" />
      </div>
      <div className="field"><label>Platform</label>
        <select className="input" value={form.platform} onChange={e => set('platform', e.target.value)}>
          <option value="android">Android</option>
          <option value="ios">iOS</option>
          <option value="both">Both</option>
        </select>
      </div>
      <div className="field"><label>Build number</label>
        <input className="input" type="text" value={form.buildNumber} onChange={e => set('buildNumber', e.target.value)} placeholder="e.g. 1.0.0 or 100" />
      </div>
      <div className="field"><label>Download URL</label>
        <input className="input" value={form.downloadUrl} onChange={e => set('downloadUrl', e.target.value)} placeholder="https://…/app.apk" />
      </div>
      <div className="field"><label>Release notes</label>
        <textarea className="input" rows={3} value={form.releaseNotes} onChange={e => set('releaseNotes', e.target.value)} placeholder="What's new in this version…" style={{ resize: 'vertical' }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <input type="checkbox" id="isActive" checked={form.isActive} onChange={e => set('isActive', e.target.checked)} />
        <label htmlFor="isActive" style={{ margin: 0, cursor: 'pointer', fontSize: 13 }}>
          Set as required version (users on older versions must update)
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Creating…' : 'Create version'}</button>
      </div>
    </Modal>
  );
}
