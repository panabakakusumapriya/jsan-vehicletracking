import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';

/**
 * Markers — define what drivers can flag from the field.
 *
 * Drivers drop a marker from the mobile map at their current position; the flags are REVIEWED
 * where they belong — on each trip's own map (SessionMap / TripDetail popups, straight Google
 * Maps links). This page is only the other half: the category list the driver's picker offers,
 * colour-coded by flag group (red = stops and incidents, yellow = restricted ground,
 * blue = impassable road).
 */

type Category = {
  id: string; name: string; color: string;
  /** The reasons this flag covers, comma-separated — what the driver sees under the name. */
  description: string | null;
  active: boolean; order: number;
};

/** The palette offered when defining a category — the three flag groups first (red = stops
 *  and incidents, yellow = restricted ground, blue = impassable road), then spares. */
const PALETTE = ['#ef4444', '#fbbc04', '#4285f4', '#34a853', '#7700c7', '#000000'];

export function Markers() {
  const [cats, setCats] = useState<Category[]>([]);
  const [markerCount, setMarkerCount] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [formName, setFormName] = useState('');
  const [formColor, setFormColor] = useState(PALETTE[0]);
  const [formDesc, setFormDesc] = useState('');

  const load = useCallback(() => {
    api.get<{ categories: Category[] }>('/api/markers/categories').then((r) => setCats(r.categories));
    // Count only — the markers themselves are reviewed on each trip's own map.
    api.get<{ markers: unknown[] }>('/api/markers?days=90').then((r) => setMarkerCount(r.markers.length));
  }, []);
  useEffect(load, [load]);

  const openAdd = () => { setFormName(''); setFormColor(PALETTE[0]); setFormDesc(''); setShowAdd(true); };
  const openEdit = (c: Category) => { setFormName(c.name); setFormColor(c.color); setFormDesc(c.description ?? ''); setEditing(c); };

  const saveNew = async () => {
    try {
      await api.post('/api/markers/categories', { name: formName, color: formColor, description: formDesc });
      setShowAdd(false);
      load();
    } catch (e) { alert(e instanceof Error ? e.message : 'Could not create the category'); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try {
      await api.patch(`/api/markers/categories/${editing.id}`, { name: formName, color: formColor, description: formDesc });
      setEditing(null);
      load();
    } catch (e) { alert(e instanceof Error ? e.message : 'Could not update the category'); }
  };
  const removeCat = async (c: Category) => {
    if (!confirm(`Delete category "${c.name}"? This only works if no markers use it.`)) return;
    try {
      await api.del(`/api/markers/categories/${c.id}`);
      load();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed to delete the category'); }
  };

  const activeCats = cats.filter((c) => c.active).length;
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', border: '1px solid var(--border, #d1d5db)',
    borderRadius: 8, fontSize: 14, boxSizing: 'border-box',
  };

  const form = (onSave: () => void, saveLabel: string) => (
    <div style={{ display: 'grid', gap: 12, padding: '4px 0' }}>
      <label style={{ fontSize: 13 }}>
        Name
        <input style={{ ...inputStyle, marginTop: 4 }} value={formName}
          onChange={(e) => setFormName(e.target.value)} placeholder="e.g. Closed road" autoFocus />
      </label>
      <label style={{ fontSize: 13 }}>
        Reasons covered (comma separated — drivers see these under the name)
        <textarea style={{ ...inputStyle, marginTop: 4, minHeight: 64, resize: 'vertical' }} value={formDesc}
          onChange={(e) => setFormDesc(e.target.value)}
          placeholder="e.g. Tunnel, Traffic Accident, Stopped by Police" />
      </label>
      <div style={{ fontSize: 13 }}>
        Colour
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {PALETTE.map((c) => (
            <button key={c} onClick={() => setFormColor(c)} aria-label={`Colour ${c}`}
              style={{
                width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                border: formColor === c ? '3px solid #0f172a' : '2px solid #ffffff',
                boxShadow: '0 0 0 1px #cbd5e1',
              }} />
          ))}
          {/* Any colour, not just the presets — whatever convention the ops team lands on. */}
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(formColor) ? formColor : '#ef4444'}
            onChange={(e) => setFormColor(e.target.value)}
            title="Custom colour"
            style={{ width: 34, height: 30, padding: 0, border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer', background: 'none' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onSave} disabled={!formName.trim()}>{saveLabel}</button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title">Marker Categories</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            What drivers can flag from the field. The colour is the flag group — red for stops
            and incidents, yellow for restricted ground, blue for impassable road. Dropped
            markers are reviewed on each trip's own map, with a direct Google Maps link.
          </p>
        </div>
        <button className="btn" onClick={openAdd}>+ Add category</button>
      </div>

      <div className="stat-row">
        <div className="stat"><div className="v">{cats.length}</div><div className="k">Categories</div></div>
        <div className="stat"><div className="v">{activeCats}</div><div className="k">Active</div></div>
        <div className="stat"><div className="v">{markerCount ?? '—'}</div><div className="k">Markers (last 90 d)</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Compact, self-scrolling list: 16 categories at the global 13px row padding is a
            wall — tighter rows and an internal scroller keep the whole set in one glance. */}
        <style>{`
          .cat-scroll { max-height: 420px; overflow-y: auto; }
          .cat-scroll thead th { position: sticky; top: 0; z-index: 1; background: var(--sb-bg); }
          .cat-scroll th { padding: 8px 14px; }
          .cat-scroll td { padding: 5px 14px; font-size: 13px; }
          .cat-scroll .btn { padding: 3px 10px; font-size: 12px; }
        `}</style>
        <div className="cat-scroll">
        <table>
          <thead>
            <tr>
              <th style={{ width: 140 }}>Colour</th>
              <th>Name</th>
              <th>Covers</th>
              <th style={{ width: 90 }}>Status</th>
              <th style={{ width: 220 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {cats.map((c) => (
              <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span style={{ width: 16, height: 16, borderRadius: '50%', background: c.color, display: 'inline-block', boxShadow: '0 0 0 1px #cbd5e1', verticalAlign: 'middle' }} />
                  <code style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>{c.color}</code>
                </td>
                <td>{c.name}</td>
                <td style={{ color: 'var(--muted)', fontSize: 12.5 }}>{c.description ?? '—'}</td>
                <td>{c.active ? 'Active' : 'Inactive'}</td>
                <td>
                  <button className="btn" style={{ marginRight: 6 }} onClick={() => openEdit(c)}>Edit</button>
                  <button className="btn" onClick={() => removeCat(c)}>Delete</button>
                </td>
              </tr>
            ))}
            {cats.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>
                No categories yet — add the first one.
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {showAdd && (
        <Modal title="Add marker category" onClose={() => setShowAdd(false)}>
          {form(saveNew, 'Add category')}
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit "${editing.name}"`} onClose={() => setEditing(null)}>
          {form(saveEdit, 'Save changes')}
        </Modal>
      )}
    </div>
  );
}
