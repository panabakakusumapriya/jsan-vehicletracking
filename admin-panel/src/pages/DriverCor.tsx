import { useEffect, useState } from 'react';
import { ssdsApi } from '../lib/ssdsApi';

interface CorDeclaration {
  _id: string;
  type: string;
  date: string;
  status: string;
  vehiclePlate?: string;
  workStartTime?: string;
  workEndTime?: string;
  restHours?: string;
  totalDrivingHours?: string;
  checklist?: Record<string, boolean>;
  notes?: string;
  createdAt?: string;
}

const COR_TYPES = [
  { value: 'fitness', label: 'Fitness for Duty' },
  { value: 'pre_trip', label: 'Pre-Trip Inspection' },
  { value: 'fatigue', label: 'Fatigue Management' },
  { value: 'load', label: 'Load Compliance' },
  { value: 'speed', label: 'Speed Compliance' },
  { value: 'general', label: 'General Declaration' },
];

const PRE_TRIP_CHECKLIST = [
  'Tyres (pressure & condition)',
  'Brakes (foot & park)',
  'Lights (headlights, indicators, brake)',
  'Mirrors (clean & adjusted)',
  'Windscreen (clean, no cracks)',
  'Wipers (working)',
  'Seatbelt (working)',
  'Horn (working)',
  'Fluid levels (oil, coolant, washer)',
  'Dashboard warnings (none)',
  'Fire extinguisher (present)',
  'First aid kit (present)',
  'Fuel level (adequate)',
];

const EMPTY_FORM = {
  type: 'fitness',
  date: new Date().toISOString().split('T')[0],
  vehiclePlate: '',
  workStartTime: '',
  workEndTime: '',
  restHours: '',
  totalDrivingHours: '',
  notes: '',
  checklist: {} as Record<string, boolean>,
};

export function DriverCor() {
  const [declarations, setDeclarations] = useState<CorDeclaration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    ssdsApi.get<{ declarations: CorDeclaration[] }>('/my/cor')
      .then(r => setDeclarations(r.declarations))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const openNew = () => {
    const checklist: Record<string, boolean> = {};
    PRE_TRIP_CHECKLIST.forEach(item => { checklist[item] = false; });
    setForm({ ...EMPTY_FORM, date: new Date().toISOString().split('T')[0], checklist });
    setShowForm(true);
  };

  const toggleChecklist = (item: string) => {
    setForm(f => ({ ...f, checklist: { ...f.checklist, [item]: !f.checklist[item] } }));
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const allChecked = form.type === 'pre_trip'
        ? PRE_TRIP_CHECKLIST.every(item => form.checklist[item])
        : true;

      await ssdsApi.post('/my/cor', {
        ...form,
        status: allChecked ? 'compliant' : 'non_compliant',
      });
      setShowForm(false);
      load();
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="center-screen">Loading COR declarations...</div>;
  if (error) return <div className="center-screen" style={{ color: 'var(--danger)' }}>Error: {error}</div>;

  const todayCount = declarations.filter(d => d.date === new Date().toISOString().split('T')[0]).length;
  const compliantCount = declarations.filter(d => d.status === 'compliant').length;

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">COR Compliance</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={openNew}>+ New Declaration</button>
          <button className="btn-ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Total</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{declarations.length}</div>
        </div>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Today</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{todayCount}</div>
        </div>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Compliant</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--success)' }}>{compliantCount}</div>
        </div>
        <div className="card" style={{ flex: '1 1 140px', padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Non-Compliant</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--danger)' }}>{declarations.length - compliantCount}</div>
        </div>
      </div>

      {/* Declarations table */}
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ minWidth: 700 }}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Vehicle</th>
              <th>Work Start</th>
              <th>Work End</th>
              <th>Rest Hrs</th>
              <th>Driving Hrs</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {declarations.map(d => (
              <tr key={d._id}>
                <td>{d.date}</td>
                <td><span className="badge blue">{COR_TYPES.find(t => t.value === d.type)?.label || d.type}</span></td>
                <td>{d.vehiclePlate || '—'}</td>
                <td>{d.workStartTime || '—'}</td>
                <td>{d.workEndTime || '—'}</td>
                <td>{d.restHours || '—'}</td>
                <td>{d.totalDrivingHours || '—'}</td>
                <td>
                  <span className={`badge ${d.status === 'compliant' ? 'green' : 'red'}`}>
                    {d.status === 'compliant' ? 'Compliant' : 'Non-Compliant'}
                  </span>
                </td>
                <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.notes || ''}>
                  {d.notes || '—'}
                </td>
              </tr>
            ))}
            {declarations.length === 0 && (
              <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 28 }}>No declarations yet. Click "+ New Declaration" to start.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New declaration modal */}
      {showForm && (
        <div className="modal-backdrop" onClick={() => setShowForm(false)}>
          <div className="modal wide" onClick={e => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>New COR Declaration</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ flex: '1 1 200px' }}>Type
                  <select className="input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                    {COR_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>
                <label style={{ flex: '1 1 150px' }}>Date
                  <input className="input" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
                </label>
              </div>

              <label>Vehicle Plate
                <input className="input" value={form.vehiclePlate} onChange={e => setForm(f => ({ ...f, vehiclePlate: e.target.value }))} />
              </label>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <label style={{ flex: '1 1 120px' }}>Work Start
                  <input className="input" type="time" value={form.workStartTime} onChange={e => setForm(f => ({ ...f, workStartTime: e.target.value }))} />
                </label>
                <label style={{ flex: '1 1 120px' }}>Work End
                  <input className="input" type="time" value={form.workEndTime} onChange={e => setForm(f => ({ ...f, workEndTime: e.target.value }))} />
                </label>
                <label style={{ flex: '1 1 120px' }}>Rest Hours
                  <input className="input" type="number" step="0.5" value={form.restHours} onChange={e => setForm(f => ({ ...f, restHours: e.target.value }))} />
                </label>
                <label style={{ flex: '1 1 120px' }}>Total Driving Hrs
                  <input className="input" type="number" step="0.5" value={form.totalDrivingHours} onChange={e => setForm(f => ({ ...f, totalDrivingHours: e.target.value }))} />
                </label>
              </div>

              {/* Pre-trip checklist */}
              {form.type === 'pre_trip' && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Pre-Trip Inspection Checklist</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
                    {PRE_TRIP_CHECKLIST.map(item => (
                      <label key={item} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                        <input type="checkbox" checked={!!form.checklist[item]} onChange={() => toggleChecklist(item)} />
                        {item}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <label>Notes
                <textarea className="input" rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Any additional observations..." />
              </label>

              {form.type === 'fitness' && (
                <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8, fontSize: 13 }}>
                  By submitting this declaration, I confirm that I am fit for duty, free from the influence
                  of alcohol or drugs, have had adequate rest, and am medically fit to operate a vehicle.
                </div>
              )}
              {form.type === 'fatigue' && (
                <div style={{ padding: 12, background: 'var(--surface)', borderRadius: 8, fontSize: 13 }}>
                  I declare that my work and rest hours comply with fatigue management regulations,
                  and I have not exceeded maximum driving hours without adequate rest breaks.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn" onClick={handleSubmit} disabled={saving}>
                {saving ? 'Submitting...' : 'Submit Declaration'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
