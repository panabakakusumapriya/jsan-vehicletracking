import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MobileDevice, User, Vehicle } from '../lib/types';

/**
 * Drivers — and the ONE place assets are allocated.
 *
 * The Vehicles and Mobiles screens are inventory only. Picking a vehicle or a handset here
 * writes a row to the custody ledger (closing whoever held it before), so "who had what last
 * month" survives. See docs/asset-custody-design.md.
 */
export function Drivers() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isManager = user?.role === 'manager';
  const canAssignTeamLead = isAdmin || isManager;
  const [drivers, setDrivers] = useState<User[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [managers, setManagers] = useState<User[]>([]);
  const [teamLeads, setTeamLeads] = useState<User[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = () => {
    api.get<{ users: User[] }>('/api/users?role=user').then(r => setDrivers(r.users));
    api.get<{ vehicles: Vehicle[] }>('/api/vehicles').then(r => setVehicles(r.vehicles));
    api.get<{ devices: MobileDevice[] }>('/api/mobiles').then(r => setDevices(r.devices)).catch(() => {});
    if (isAdmin) api.get<{ users: User[] }>('/api/users?role=manager').then(r => setManagers(r.users));
    if (canAssignTeamLead) api.get<{ users: User[] }>('/api/users?role=team_lead').then(r => setTeamLeads(r.users));
  };
  useEffect(load, [isAdmin, canAssignTeamLead]);

  const deactivate = async (d: User) => {
    if (!confirm(`Exit ${d.name}? They will no longer be able to log in.`)) return;
    await api.del(`/api/users/${d._id}`);
    load();
  };

  const projects = Array.from(new Set(drivers.map(d => d.project).filter(Boolean))).sort() as string[];
  const countries = Array.from(new Set(drivers.map(d => d.country).filter(Boolean))).sort() as string[];

  const filtered = drivers.filter(d => {
    if (projectFilter && d.project !== projectFilter) return false;
    if (countryFilter && d.country !== countryFilter) return false;
    if (statusFilter === 'active' && !d.active) return false;
    if (statusFilter === 'inactive' && d.active) return false;
    return true;
  });

  const active   = filtered.filter(d => d.active).length;
  const inactive = filtered.length - active;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px - var(--topbar-h))' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Drivers</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Manage driver accounts and assignments
          </p>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="input" style={{ width: 90, fontSize: 12, padding: '4px 6px' }} value={projectFilter} onChange={e => setProjectFilter(e.target.value)}>
            <option value="">Project</option>
            {projects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="input" style={{ width: 90, fontSize: 12, padding: '4px 6px' }} value={countryFilter} onChange={e => setCountryFilter(e.target.value)}>
            <option value="">Country</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input" style={{ width: 90, fontSize: 12, padding: '4px 6px' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
          <button className="btn" onClick={() => setShowAdd(true)}>+ Add driver</button>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat"><div className="v">{filtered.length}</div><div className="k">Total</div></div>
        <div className="stat"><div className="v">{active}</div><div className="k">Active</div></div>
        <div className="stat"><div className="v">{inactive}</div><div className="k">Inactive</div></div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto', flex: 1, minHeight: 0 }}>
        <style>{`.card table thead { position: sticky; top: 0; z-index: 1; }`}</style>
        <table>
          <thead>
            <tr>
              <th style={{ minWidth: 180 }}>Project</th>
              <th>Driver ID</th>
              <th>Driver Name</th>
              <th>Vehicle</th>
              <th>Mobile</th>
              <th>Scope</th>
              <th>Region</th>
              <th>Country</th>
              <th>Driving Location</th>
              <th>Driver Mode</th>
              <th>Team Lead</th>
              <th>POC</th>
              <th>Contact</th>
              <th>Personal Mail</th>
              <th>Driver Address</th>
              <th>CTS Mail</th>
              <th>Driver Status</th>
              <th>Joining Date</th>
              <th>Exit Date</th>
              <th>Price/Hour</th>
              <th>Per Diem</th>
              <th>Currency</th>
              <th>Language</th>
              <th>Timezone</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(d => (
              <tr key={d._id}>
                <td style={{ minWidth: 180, wordBreak: 'break-word' }}>{d.project || <M />}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{d.driverId || <M />}</td>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{d.name}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{plateOf(d) ?? <M />}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{deviceOf(d) ?? <M />}</td>
                <td>{d.scope || <M />}</td>
                <td>{d.region || <M />}</td>
                <td>{d.country || <M />}</td>
                <td>{d.drivingLocation || <M />}</td>
                <td>{d.driverMode || <M />}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{d.teamLeadId && typeof d.teamLeadId === 'object' ? d.teamLeadId.name : <M />}</td>
                <td>{d.poc || <M />}</td>
                <td>{d.contact || <M />}</td>
                <td>{d.personalMail || d.email || <M />}</td>
                <td>{d.driverAddress || <M />}</td>
                <td>{d.ctsMail || <M />}</td>
                <td>{d.driverStatus || <M />}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{d.joiningDate ? new Date(d.joiningDate).toLocaleDateString() : <M />}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{d.exitDate ? new Date(d.exitDate).toLocaleDateString() : <M />}</td>
                <td>{d.pricePerHour ?? <M />}</td>
                <td>{d.perDiem ?? <M />}</td>
                <td>{d.currency || <M />}</td>
                <td>{d.language || <M />}</td>
                <td>{d.timezone || <M />}</td>
                <td><span className={`badge ${d.active ? 'green' : 'red'}`}>{d.active ? 'Active' : 'Exit'}</span></td>
                <td style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
                  <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setEditing(d)}>Edit</button>
                  {d.active && <button className="btn-danger" onClick={() => deactivate(d)}>Exit</button>}
                </td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <tr><td colSpan={25} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No drivers yet — add one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddDriver vehicles={vehicles} devices={devices} managers={managers} teamLeads={teamLeads} isAdmin={isAdmin} canAssignTeamLead={canAssignTeamLead} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {editing && <EditDriver driver={editing} vehicles={vehicles} devices={devices} managers={managers} teamLeads={teamLeads} isAdmin={isAdmin} canAssignTeamLead={canAssignTeamLead} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function M() { return <span style={{ color: 'var(--muted)' }}>—</span>; }

/** Populated refs come back as objects; fall back to nothing rather than a raw id. */
const idOf = (ref: unknown): string =>
  ref && typeof ref === 'object' ? String((ref as { _id: string })._id) : (ref ? String(ref) : '');

function plateOf(d: User): string | null {
  const v = d.vehicleId;
  return v && typeof v === 'object' ? v.plateNumber : null;
}

function deviceOf(d: User): string | null {
  const m = d.mobileDeviceId;
  if (!m || typeof m !== 'object') return null;
  return m.label || m.phoneModel || (m.imei ? `…${m.imei.slice(-5)}` : null);
}

/** Devices a driver may be given: free stock, plus whatever they already hold. */
function allocatableDevices(devices: MobileDevice[], currentId: string) {
  return devices.filter(
    dev => dev._id === currentId || (dev.status === 'in_stock' && !dev.currentDriverId)
  );
}

const deviceOptionLabel = (dev: MobileDevice) =>
  [dev.label || dev.phoneModel || 'Device', dev.imei ? `…${dev.imei.slice(-5)}` : null]
    .filter(Boolean)
    .join(' · ');

const EMPTY_FORM = {
  name: '', email: '', password: '', phone: '', country: '', vehicleId: '', mobileDeviceId: '', managerId: '', teamLeadId: '',
  driverId: '', project: '', scope: '', region: '', drivingLocation: '', driverMode: '',
  poc: '', contact: '', personalMail: '', driverAddress: '', ctsMail: '',
  driverStatus: '', joiningDate: '', exitDate: '',
  pricePerHour: '', perDiem: '', currency: '', language: '',
};

function AddDriver({ vehicles, devices, managers, teamLeads, isAdmin, canAssignTeamLead, onClose, onSaved }: {
  vehicles: Vehicle[]; devices: MobileDevice[]; managers: User[]; teamLeads: User[];
  isAdmin: boolean; canAssignTeamLead: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (!form.email.trim()) { setError('Email is required'); return; }
    if (!form.password.trim()) { setError('Password is required'); return; }
    setError(null); setBusy(true);
    try {
      await api.post('/api/users', {
        name: form.name, email: form.email, password: form.password,
        phone: form.phone || undefined, role: 'user',
        country: form.country.trim() || undefined,
        vehicleId: form.vehicleId || undefined,
        mobileDeviceId: form.mobileDeviceId || undefined,
        managerId: isAdmin ? form.managerId || undefined : undefined,
        teamLeadId: canAssignTeamLead ? form.teamLeadId || undefined : undefined,
        driverId: form.driverId || undefined,
        project: form.project || undefined,
        scope: form.scope || undefined,
        region: form.region || undefined,
        drivingLocation: form.drivingLocation || undefined,
        driverMode: form.driverMode || undefined,
        poc: form.poc || undefined,
        contact: form.contact || undefined,
        personalMail: form.personalMail || undefined,
        driverAddress: form.driverAddress || undefined,
        ctsMail: form.ctsMail || undefined,
        driverStatus: form.driverStatus || undefined,
        joiningDate: form.joiningDate || undefined,
        exitDate: form.exitDate || undefined,
        pricePerHour: form.pricePerHour ? Number(form.pricePerHour) : undefined,
        perDiem: form.perDiem ? Number(form.perDiem) : undefined,
        currency: form.currency || undefined,
        language: form.language || undefined,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create driver');
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Add new driver" onClose={onClose}>
      <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 }}>
        <SectionLabel text="Account" />
        <Row>
          <F label="Full name *"><input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="John Smith" /></F>
          <F label="Email *"><input className="input" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="driver@company.com" /></F>
        </Row>
        <Row>
          <F label="Password *"><input className="input" type="text" value={form.password} onChange={e => set('password', e.target.value)} placeholder="Temporary password" /></F>
          <F label="Phone"><input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+91 9876543210" /></F>
        </Row>

        <SectionLabel text="Project & Location" />
        <Row>
          <F label="Project"><input className="input" value={form.project} onChange={e => set('project', e.target.value)} /></F>
          <F label="Driver ID"><input className="input" value={form.driverId} onChange={e => set('driverId', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Scope"><input className="input" value={form.scope} onChange={e => set('scope', e.target.value)} /></F>
          <F label="Region"><input className="input" value={form.region} onChange={e => set('region', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Country"><input className="input" value={form.country} onChange={e => set('country', e.target.value)} placeholder="India" /></F>
          <F label="Driving Location"><input className="input" value={form.drivingLocation} onChange={e => set('drivingLocation', e.target.value)} /></F>
        </Row>
        <F label="Driver Mode"><input className="input" value={form.driverMode} onChange={e => set('driverMode', e.target.value)} /></F>

        <SectionLabel text="Contact & POC" />
        <Row>
          <F label="POC"><input className="input" value={form.poc} onChange={e => set('poc', e.target.value)} /></F>
          <F label="Contact"><input className="input" value={form.contact} onChange={e => set('contact', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Personal Mail"><input className="input" type="email" value={form.personalMail} onChange={e => set('personalMail', e.target.value)} /></F>
          <F label="CTS Mail"><input className="input" type="email" value={form.ctsMail} onChange={e => set('ctsMail', e.target.value)} /></F>
        </Row>
        <F label="Driver Address"><input className="input" value={form.driverAddress} onChange={e => set('driverAddress', e.target.value)} /></F>

        <SectionLabel text="Employment" />
        <Row>
          <F label="Driver Status"><input className="input" value={form.driverStatus} onChange={e => set('driverStatus', e.target.value)} placeholder="Active / On Leave / Resigned" /></F>
          <F label="Language"><input className="input" value={form.language} onChange={e => set('language', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Joining Date"><input className="input" type="date" value={form.joiningDate} onChange={e => set('joiningDate', e.target.value)} /></F>
          <F label="Exit Date"><input className="input" type="date" value={form.exitDate} onChange={e => set('exitDate', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Price/Hour"><input className="input" type="number" value={form.pricePerHour} onChange={e => set('pricePerHour', e.target.value)} /></F>
          <F label="Per Diem"><input className="input" type="number" value={form.perDiem} onChange={e => set('perDiem', e.target.value)} /></F>
        </Row>
        <F label="Currency"><input className="input" value={form.currency} onChange={e => set('currency', e.target.value)} placeholder="INR / EUR / USD" /></F>

        <SectionLabel text="Assignment" />
        {isAdmin && (
          <F label="Manager">
            <select className="input" value={form.managerId} onChange={e => set('managerId', e.target.value)}>
              <option value="">— Unassigned —</option>
              {managers.map(m => <option key={m._id} value={m._id}>{m.name} ({m.email})</option>)}
            </select>
          </F>
        )}
        {canAssignTeamLead && (
          <F label="Team Lead">
            <select className="input" value={form.teamLeadId} onChange={e => set('teamLeadId', e.target.value)}>
              <option value="">— None —</option>
              {teamLeads.map(t => <option key={t._id} value={t._id}>{t.name} ({t.email})</option>)}
            </select>
          </F>
        )}
        <F label="Vehicle">
          <select className="input" value={form.vehicleId} onChange={e => set('vehicleId', e.target.value)}>
            <option value="">— None —</option>
            {vehicles.map(v => <option key={v._id} value={v._id}>{v.plateNumber}{v.model ? ` · ${v.model}` : ''}</option>)}
          </select>
        </F>
        <F label="Mobile device">
          <select className="input" value={form.mobileDeviceId} onChange={e => set('mobileDeviceId', e.target.value)}>
            <option value="">— None —</option>
            {allocatableDevices(devices, '').map(dev => (
              <option key={dev._id} value={dev._id}>{deviceOptionLabel(dev)}</option>
            ))}
          </select>
        </F>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Creating...' : 'Create driver'}</button>
      </div>
    </Modal>
  );
}

function EditDriver({ driver, vehicles, devices, managers, teamLeads, isAdmin, canAssignTeamLead, onClose, onSaved }: {
  driver: User; vehicles: Vehicle[]; devices: MobileDevice[]; managers: User[]; teamLeads: User[];
  isAdmin: boolean; canAssignTeamLead: boolean; onClose: () => void; onSaved: () => void;
}) {
  const vehicleIdVal = idOf(driver.vehicleId);
  const deviceIdVal = idOf(driver.mobileDeviceId);
  const managerIdVal = driver.managerId && typeof driver.managerId === 'object' ? (driver.managerId as any)._id : (driver.managerId || '');
  const teamLeadIdVal = driver.teamLeadId && typeof driver.teamLeadId === 'object' ? (driver.teamLeadId as any)._id : (driver.teamLeadId || '');
  const [form, setForm] = useState({
    name: driver.name,
    phone: driver.phone || '',
    country: driver.country || '',
    vehicleId: vehicleIdVal,
    mobileDeviceId: deviceIdVal,
    managerId: managerIdVal as string,
    teamLeadId: teamLeadIdVal as string,
    password: '',
    driverId: driver.driverId || '',
    project: driver.project || '',
    scope: driver.scope || '',
    region: driver.region || '',
    drivingLocation: driver.drivingLocation || '',
    driverMode: driver.driverMode || '',
    poc: driver.poc || '',
    contact: driver.contact || '',
    personalMail: driver.personalMail || '',
    driverAddress: driver.driverAddress || '',
    ctsMail: driver.ctsMail || '',
    driverStatus: driver.driverStatus || '',
    joiningDate: driver.joiningDate ? driver.joiningDate.slice(0, 10) : '',
    exitDate: driver.exitDate ? driver.exitDate.slice(0, 10) : '',
    pricePerHour: driver.pricePerHour != null ? String(driver.pricePerHour) : '',
    perDiem: driver.perDiem != null ? String(driver.perDiem) : '',
    currency: driver.currency || '',
    language: driver.language || '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    setError(null); setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        phone: form.phone || null,
        country: form.country || null,
        vehicleId: form.vehicleId || null,
        mobileDeviceId: form.mobileDeviceId || null,
        driverId: form.driverId || null,
        project: form.project || null,
        scope: form.scope || null,
        region: form.region || null,
        drivingLocation: form.drivingLocation || null,
        driverMode: form.driverMode || null,
        poc: form.poc || null,
        contact: form.contact || null,
        personalMail: form.personalMail || null,
        driverAddress: form.driverAddress || null,
        ctsMail: form.ctsMail || null,
        driverStatus: form.driverStatus || null,
        joiningDate: form.joiningDate || null,
        exitDate: form.exitDate || null,
        pricePerHour: form.pricePerHour ? Number(form.pricePerHour) : null,
        perDiem: form.perDiem ? Number(form.perDiem) : null,
        currency: form.currency || null,
        language: form.language || null,
      };
      if (isAdmin) body.managerId = form.managerId || null;
      if (canAssignTeamLead) body.teamLeadId = form.teamLeadId || null;
      if (form.password) body.password = form.password;
      await api.patch(`/api/users/${driver._id}`, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update driver');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Edit · ${driver.name}`} onClose={onClose}>
      <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 }}>
        <SectionLabel text="Account" />
        <Row>
          <F label="Full name"><input className="input" value={form.name} onChange={e => set('name', e.target.value)} /></F>
          <F label="Phone"><input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} /></F>
        </Row>

        <SectionLabel text="Project & Location" />
        <Row>
          <F label="Project"><input className="input" value={form.project} onChange={e => set('project', e.target.value)} /></F>
          <F label="Driver ID"><input className="input" value={form.driverId} onChange={e => set('driverId', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Scope"><input className="input" value={form.scope} onChange={e => set('scope', e.target.value)} /></F>
          <F label="Region"><input className="input" value={form.region} onChange={e => set('region', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Country"><input className="input" value={form.country} onChange={e => set('country', e.target.value)} /></F>
          <F label="Driving Location"><input className="input" value={form.drivingLocation} onChange={e => set('drivingLocation', e.target.value)} /></F>
        </Row>
        <F label="Driver Mode"><input className="input" value={form.driverMode} onChange={e => set('driverMode', e.target.value)} /></F>

        <SectionLabel text="Contact & POC" />
        <Row>
          <F label="POC"><input className="input" value={form.poc} onChange={e => set('poc', e.target.value)} /></F>
          <F label="Contact"><input className="input" value={form.contact} onChange={e => set('contact', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Personal Mail"><input className="input" type="email" value={form.personalMail} onChange={e => set('personalMail', e.target.value)} /></F>
          <F label="CTS Mail"><input className="input" type="email" value={form.ctsMail} onChange={e => set('ctsMail', e.target.value)} /></F>
        </Row>
        <F label="Driver Address"><input className="input" value={form.driverAddress} onChange={e => set('driverAddress', e.target.value)} /></F>

        <SectionLabel text="Employment" />
        <Row>
          <F label="Driver Status"><input className="input" value={form.driverStatus} onChange={e => set('driverStatus', e.target.value)} /></F>
          <F label="Language"><input className="input" value={form.language} onChange={e => set('language', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Joining Date"><input className="input" type="date" value={form.joiningDate} onChange={e => set('joiningDate', e.target.value)} /></F>
          <F label="Exit Date"><input className="input" type="date" value={form.exitDate} onChange={e => set('exitDate', e.target.value)} /></F>
        </Row>
        <Row>
          <F label="Price/Hour"><input className="input" type="number" value={form.pricePerHour} onChange={e => set('pricePerHour', e.target.value)} /></F>
          <F label="Per Diem"><input className="input" type="number" value={form.perDiem} onChange={e => set('perDiem', e.target.value)} /></F>
        </Row>
        <F label="Currency"><input className="input" value={form.currency} onChange={e => set('currency', e.target.value)} /></F>

        <SectionLabel text="Assignment" />
        {isAdmin && (
          <F label="Manager">
            <select className="input" value={form.managerId} onChange={e => set('managerId', e.target.value)}>
              <option value="">— Unassigned —</option>
              {managers.map(m => <option key={m._id} value={m._id}>{m.name} ({m.email})</option>)}
            </select>
          </F>
        )}
        {canAssignTeamLead && (
          <F label="Team Lead">
            <select className="input" value={form.teamLeadId} onChange={e => set('teamLeadId', e.target.value)}>
              <option value="">— None —</option>
              {teamLeads.map(t => <option key={t._id} value={t._id}>{t.name} ({t.email})</option>)}
            </select>
          </F>
        )}
        <F label="Vehicle">
          <select className="input" value={form.vehicleId} onChange={e => set('vehicleId', e.target.value)}>
            <option value="">— None —</option>
            {vehicles.map(v => <option key={v._id} value={v._id}>{v.plateNumber}{v.model ? ` · ${v.model}` : ''}</option>)}
          </select>
        </F>
        <F label="Mobile device">
          <select className="input" value={form.mobileDeviceId} onChange={e => set('mobileDeviceId', e.target.value)}>
            <option value="">— None —</option>
            {allocatableDevices(devices, deviceIdVal).map(dev => (
              <option key={dev._id} value={dev._id}>{deviceOptionLabel(dev)}</option>
            ))}
          </select>
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '5px 0 0', lineHeight: 1.5 }}>
            Changing this returns the old handset to stock and records the handover.
          </p>
        </F>
        <F label="New password (leave blank to keep current)">
          <input className="input" type="text" value={form.password} onChange={e => set('password', e.target.value)} placeholder="Leave blank to keep current" />
        </F>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="modal-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button>
      </div>
    </Modal>
  );
}

function SectionLabel({ text }: { text: string }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--muted)', margin: '16px 0 8px', borderBottom: '1px solid var(--line-2)', paddingBottom: 4 }}>{text}</div>;
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>;
}
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}
