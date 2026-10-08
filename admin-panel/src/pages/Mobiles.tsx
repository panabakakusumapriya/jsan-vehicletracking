import { PageIcon } from '../components/AppIcon';
import { ProjectSelect, useDefaultProject, useProjectScope } from '../components/ProjectSelect';
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import type { Assignment, DeviceStatus, MobileDevice, Project } from '../lib/types';

const STATUS_LABEL: Record<DeviceStatus, string> = {
  in_stock: 'In stock',
  assigned: 'Assigned',
  repair: 'In repair',
  lost: 'Lost',
  retired: 'Retired',
};
const STATUS_BADGE: Record<DeviceStatus, string> = {
  in_stock: 'gray',
  assigned: 'green',
  repair: 'amber',
  lost: 'red',
  retired: 'gray',
};

const driverOf = (d: MobileDevice) =>
  d.currentDriverId && typeof d.currentDriverId === 'object' ? d.currentDriverId : null;

export function Mobiles() {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [projectOptions, setProjectOptions] = useState<Project[]>([]);
  const [editing, setEditing] = useState<MobileDevice | null>(null);
  const [history, setHistory] = useState<MobileDevice | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [projectFilter, setProjectFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const projectScope = useProjectScope();
  useDefaultProject(projectScope, projectFilter, setProjectFilter);
  /** A chip clicked as a filter: a device status, or every out-of-service one. */
  const [statusFilter, setStatusFilter] = useState<'' | DeviceStatus | 'out'>('');
  /** Free text over IMEIs, work phone and mail, model, label and who holds it. */
  const [query, setQuery] = useState('');
  // A new filter starts the list from the top — the table scrolls inside its own card.
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tableRef.current) tableRef.current.scrollTop = 0;
  }, [projectFilter, countryFilter, statusFilter, query]);

  const load = () => {
    api.get<{ devices: MobileDevice[] }>('/api/mobiles').then(r => setDevices(r.devices)).catch(() => {});
    api.get<{ projects: Project[] }>('/api/projects').then(r => setProjectOptions(r.projects)).catch(() => {});
  };
  useEffect(load, []);

  // Derive project for each device from its assigned driver
  const deviceProject = (d: MobileDevice): string | null => {
    const holder = driverOf(d);
    return holder?.project || null;
  };

  // Build country options filtered by selected project
  const filteredByProject = projectFilter
    ? devices.filter(d => deviceProject(d) === projectFilter)
    : devices;

  const countries = Array.from(new Set(
    filteredByProject.map(d => d.country).filter(Boolean)
  )).sort() as string[];

  // Project / country / search narrow what the chips count; the chips pick a status, so each
  // chip's number is what clicking it would show. Same pattern as the Drivers page.
  const q = query.trim().toLowerCase();
  const inScope = filteredByProject.filter(d => {
    if (countryFilter && d.country !== countryFilter) return false;
    if (q) {
      const hay = [
        d.imei, d.secondaryImei, d.workPhone, d.workMail, d.phoneModel, d.label, d.serial,
        d.driverName, driverOf(d)?.name,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const OUT: DeviceStatus[] = ['repair', 'lost', 'retired'];
  const filtered = inScope.filter(d => {
    if (!statusFilter) return true;
    if (statusFilter === 'out') return OUT.includes(d.status);
    return d.status === statusFilter;
  });
  const count = (s: DeviceStatus) => inScope.filter(d => d.status === s).length;
  const assigned = count('assigned');
  const inStock = count('in_stock');
  const outOfService = inScope.filter(d => OUT.includes(d.status)).length;
  const pick = (s: DeviceStatus | 'out') => setStatusFilter(cur => (cur === s ? '' : s));
  const anyFilter = Boolean(projectFilter || countryFilter || statusFilter || q);
  const clearAll = () => {
    setProjectFilter(''); setCountryFilter(''); setStatusFilter(''); setQuery('');
  };

  return (
    <div className="list-page">
      {/* One slim row: the title, the numbers (each one a filter), search, filters, Add. */}
      <div className="dr-bar">
        <h1 className="dr-title" title="Device inventory — every handover is recorded, so you can see who had which phone in any month">
          <PageIcon name="phone" />Mobiles
        </h1>

        <div className="dr-stats" role="group" aria-label="Device counts — click one to filter">
          <button type="button" className={`dr-stat${!statusFilter ? ' on' : ''}`}
            onClick={() => setStatusFilter('')} title="Every device matching the filters">
            <b>{inScope.length}</b> Total
          </button>
          <button type="button" className={`dr-stat green${statusFilter === 'assigned' ? ' on' : ''}`}
            onClick={() => pick('assigned')} title="With a driver now">
            <b>{assigned}</b> Assigned
          </button>
          <button type="button" className={`dr-stat${statusFilter === 'in_stock' ? ' on' : ''}`}
            onClick={() => pick('in_stock')} title="Ready to hand out">
            <b>{inStock}</b> In stock
          </button>
          {(outOfService > 0 || statusFilter === 'out') && (
            <>
              <span className="dr-sep" aria-hidden="true" />
              <button type="button" className={`dr-stat amber${statusFilter === 'out' ? ' on' : ''}`}
                onClick={() => pick('out')} title={`In repair ${count('repair')} · lost ${count('lost')} · retired ${count('retired')}`}>
                <b>{outOfService}</b> Out of service
              </button>
            </>
          )}
        </div>

        <div className="dr-tools">
          <input
            className="input dr-search"
            type="search"
            placeholder="Search devices…"
            title="IMEI, work phone or mail, model, label or driver"
            aria-label="Search devices"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <ProjectSelect scope={projectScope} className="input dr-filter" value={projectFilter}
            onChange={v => { setProjectFilter(v); setCountryFilter(''); }} options={projectOptions.map(p => ({ value: p.name, label: p.name }))} />
          <select className="input dr-filter" aria-label="Country" value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
            <option value="">All countries</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {anyFilter && <button type="button" className="cov-link" onClick={clearAll}>Clear</button>}
          <button className="btn dr-add" onClick={() => setShowAdd(true)}>+ Add device</button>
        </div>
      </div>

      <div ref={tableRef} className="card list-card">
        <table className="mobiles-table">
          <thead>
            <tr>
              <th>Country</th>
              <th>Driver Name</th>
              <th>Work Mail</th>
              <th>Work Phone</th>
              <th>IMEI</th>
              <th>Secondary IMEI</th>
              <th>Phone Model</th>
              <th>Android</th>
              <th>Status</th>
              <th>Held by</th>
              <th>Phone Case</th>
              <th>Phone Screenguard</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(d => {
              const holder = driverOf(d);
              return (
                <tr key={d._id}>
                  <td>{d.country || <M />}</td>
                  <td>{d.driverName || <M />}</td>
                  <td>{d.workMail || <M />}</td>
                  <td>{d.workPhone || <M />}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.imei || <M />}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.secondaryImei || <M />}</td>
                  <td>{d.phoneModel || <M />}</td>
                  <td>{d.androidVersion || <M />}</td>
                  <td><span className={`badge ${STATUS_BADGE[d.status]}`}>{STATUS_LABEL[d.status]}</span></td>
                  <td>{holder ? holder.name : <M />}</td>
                  <td><Accessory label="Case" value={d.phoneCase} /></td>
                  <td><Accessory label="Guard" value={d.phoneScreenguard} /></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-ghost" style={btn} onClick={() => setHistory(d)}>History</button>
                    <button className="btn-ghost" style={btn} onClick={() => setEditing(d)}>Edit</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={13} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  {devices.length ? 'No device matches these filters.' : 'No devices yet — add one to get started.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <DeviceForm onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {editing && <DeviceForm device={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {history && <DeviceHistory device={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

const btn = { fontSize: 12, padding: '4px 10px', marginRight: 6 } as const;
function M() { return <span style={{ color: 'var(--muted)' }}>—</span>; }

function Accessory({ label, value }: { label: string; value?: string | null }) {
  if (!value) return <span className="badge gray" style={{ fontSize: 10 }}>{label} —</span>;
  const yes = value.toLowerCase() === 'yes';
  const no = value.toLowerCase() === 'no';
  return (
    <span className={`badge ${yes ? 'green' : no ? 'gray' : 'amber'}`} style={{ fontSize: 10 }}>
      {label} {value}
    </span>
  );
}

const YES_NO = ['Yes', 'No'];

const canonicalYesNo = (raw: string) =>
  YES_NO.find(v => v.toLowerCase() === raw.trim().toLowerCase()) ?? raw;

const FIELDS: {
  key: keyof MobileDevice;
  label: string;
  placeholder?: string;
  type?: 'text' | 'yesno';
}[] = [
  { key: 'workMail', label: 'Work Mail', placeholder: 'driver@example.com' },
  { key: 'label', label: 'Label (e.g. Ops phone 07)' },
  { key: 'imei', label: 'IMEI number', placeholder: '15-digit IMEI' },
  { key: 'secondaryImei', label: 'Secondary IMEI', placeholder: '15-digit IMEI' },
  { key: 'workPhone', label: 'Work phone number' },
  { key: 'phoneModel', label: 'Phone model' },
  { key: 'androidVersion', label: 'Android version' },
  { key: 'serial', label: 'Serial' },
  { key: 'phoneCase', label: 'Phone case', type: 'yesno' },
  { key: 'phoneScreenguard', label: 'Phone screenguard', type: 'yesno' },
  { key: 'country', label: 'Country' },
];

function DeviceForm({ device, onClose, onSaved }: {
  device?: MobileDevice; onClose: () => void; onSaved: () => void;
}) {
  const [drivers, setDrivers] = useState<{ _id: string; name: string; email: string }[]>([]);
  const [driverName, setDriverName] = useState(device?.driverName || '');
  const [form, setForm] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    FIELDS.forEach(f => {
      const raw = (device?.[f.key] as string) || '';
      init[f.key as string] = f.type === 'yesno' && raw ? canonicalYesNo(raw) : raw;
    });
    return init;
  });
  const [status, setStatus] = useState<DeviceStatus>(device?.status || 'in_stock');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ users: { _id: string; name: string; email: string }[] }>('/api/users?role=user')
      .then(r => setDrivers(r.users))
      .catch(() => {});
  }, []);

  const handleDriverChange = (name: string) => {
    setDriverName(name);
    const match = drivers.find(d => d.name === name);
    if (match) setForm(s => ({ ...s, workMail: match.email }));
  };

  const save = async () => {
    setError(null); setBusy(true);
    try {
      const body: Record<string, unknown> = { status, driverName: driverName || null };
      FIELDS.forEach(f => { body[f.key as string] = form[f.key as string] || null; });
      if (device) await api.patch(`/api/mobiles/${device._id}`, body);
      else await api.post('/api/mobiles', body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally { setBusy(false); }
  };

  return (
    <Modal
      wide
      title={device ? `Edit · ${device.displayLabel || 'device'}` : 'Add mobile device'}
      onClose={onClose}
    >
      {error && <div className="error-text">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label>Driver Name</label>
          <select className="input" value={driverName} onChange={e => handleDriverChange(e.target.value)}>
            <option value="">— Select driver —</option>
            {drivers.map(d => <option key={d._id} value={d.name}>{d.name}</option>)}
            {driverName && !drivers.some(d => d.name === driverName) && (
              <option value={driverName}>{driverName} (not found)</option>
            )}
          </select>
        </div>
        {FIELDS.map(f => {
          const name = f.key as string;
          const value = form[name];
          return (
            <div className="field" key={name}>
              <label>{f.label}</label>
              {f.type === 'yesno' ? (
                <select
                  className="input"
                  value={value}
                  onChange={e => setForm(s => ({ ...s, [name]: e.target.value }))}
                >
                  <option value="">— Not set —</option>
                  {YES_NO.map(v => <option key={v} value={v}>{v}</option>)}
                  {value && !YES_NO.includes(value) && (
                    <option value={value}>{value} (existing value)</option>
                  )}
                </select>
              ) : (
                <input
                  className="input"
                  placeholder={f.placeholder}
                  value={value}
                  onChange={e => setForm(s => ({ ...s, [name]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
        <div className="field">
          <label>Status</label>
          <select className="input" value={status} onChange={e => setStatus(e.target.value as DeviceStatus)}>
            {(Object.keys(STATUS_LABEL) as DeviceStatus[]).map(s => (
              <option key={s} value={s}>{STATUS_LABEL[s]}</option>
            ))}
          </select>
        </div>
        {['repair', 'lost', 'retired'].includes(status) && device?.currentDriverId && (
          <p className="span-2" style={{ fontSize: 11.5, color: 'var(--amber)', margin: '0 0 8px' }}>
            This will also return the device from its current holder.
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function DeviceHistory({ device, onClose }: { device: MobileDevice; onClose: () => void }) {
  const [history, setHistory] = useState<Assignment[] | null>(null);

  useEffect(() => {
    api.get<{ history: Assignment[] }>(`/api/mobiles/${device._id}`)
      .then(r => setHistory(r.history))
      .catch(() => setHistory([]));
  }, [device._id]);

  return (
    <Modal title={`History · ${device.displayLabel || 'device'}`} onClose={onClose}>
      {history === null && <p className="muted" style={{ fontSize: 13 }}>Loading…</p>}
      {history?.length === 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          No custody recorded yet. History starts the first time this device is assigned.
        </p>
      )}
      {history && history.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {history.map(h => (
            <div key={h._id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 12px', borderRadius: 10,
              background: h.open ? 'var(--green-bg)' : 'var(--panel-2)',
              border: `1px solid ${h.open ? 'rgba(5,150,105,0.2)' : 'var(--line)'}`,
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13 }}>
                  {typeof h.driverId === 'object' ? h.driverId.name : h.driverName}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                  {h.backfilled && 'since at least '}
                  {h.startedAt.slice(0, 10)} → {h.endedAt ? h.endedAt.slice(0, 10) : 'now'}
                  {h.note ? ` · ${h.note}` : ''}
                </div>
              </div>
              {h.open && <span className="badge green">Holding</span>}
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
