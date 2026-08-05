import { useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Assignment, MobileDevice, User, Vehicle } from '../lib/types';

/**
 * Drivers — and the ONE place assets are allocated.
 *
 * The Vehicles and Mobiles screens are inventory only. Picking vehicles or handsets here
 * writes rows to the custody ledger (closing whoever held each one before), so "who had what
 * last month" survives. A driver can hold several of each at once — see
 * docs/asset-custody-design.md. The most recently assigned of each kind is the driver's
 * "Active" one: that's the pointer trip tracking on the phone actually reads.
 */
export function Drivers() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isManager = user?.role === 'manager';
  const canAssignTeamLead = isAdmin || isManager;
  const [drivers, setDrivers] = useState<User[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [openAssignments, setOpenAssignments] = useState<Assignment[]>([]);
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
    api.get<{ assignments: Assignment[] }>('/api/assignments?open=true').then(r => setOpenAssignments(r.assignments)).catch(() => {});
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

  // Everything this driver currently holds of one kind, newest first — the ledger is the
  // source of truth, not the single vehicleId/mobileDeviceId cache field (which only tracks
  // the most recent / "active" one).
  const vehiclesOf = (d: User) => itemsFor(openAssetIds(openAssignments, d._id, 'vehicle'), vehicles);
  const devicesOf = (d: User) => itemsFor(openAssetIds(openAssignments, d._id, 'mobile'), devices);

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
        <style>{`
          .card table thead { position: sticky; top: 0; z-index: 3; }
          .card table td { white-space: nowrap; }
          .card table th.sticky-col, .card table td.sticky-col { position: sticky; overflow: hidden; text-overflow: ellipsis; }
          .card table td.sticky-col { background: var(--panel); z-index: 1; }
          .card table th.sticky-col { background: var(--sb-bg); z-index: 4; }
          .card table tbody tr:hover td.sticky-col { background: var(--brand-light); }
          .card table .sl-1 { left: 0; width: 190px; min-width: 190px; max-width: 190px; }
          .card table .sl-2 { left: 190px; width: 110px; min-width: 110px; max-width: 110px; }
          .card table .sl-3 { left: 300px; width: 170px; min-width: 170px; max-width: 170px; box-shadow: 2px 0 4px -2px rgba(0,0,0,0.15); }
          .card table .sr-2 { right: 0; width: 100px; min-width: 100px; max-width: 100px; box-shadow: -2px 0 4px -2px rgba(0,0,0,0.15); }
        `}</style>
        <table>
          <thead>
            <tr>
              <th className="sticky-col sl-1">Project</th>
              <th className="sticky-col sl-2">Driver ID</th>
              <th className="sticky-col sl-3">Driver Name</th>
              <th>Vehicles</th>
              <th>VIDs</th>
              <th>Mobiles</th>
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
              <th className="sticky-col sr-2">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(d => {
              const dVehicles = vehiclesOf(d);
              const dDevices = devicesOf(d);
              return (
                <tr key={d._id}>
                  <td className="sticky-col sl-1" title={d.project || ''}>{d.project || <M />}</td>
                  <td className="sticky-col sl-2" title={d.driverId || ''}>{d.driverId || <M />}</td>
                  <td className="sticky-col sl-3" style={{ fontWeight: 600 }} title={d.name}>{d.name}</td>
                  <td style={{ whiteSpace: 'nowrap', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }} title={dVehicles.map(v => v.plateNumber).join(', ')}>
                    {dVehicles.length ? dVehicles.map(v => v.plateNumber).join(', ') : <M />}
                  </td>
                  <td title={dVehicles.map(v => v.vid).filter(Boolean).join(', ')}>
                    {dVehicles.map(v => v.vid).filter(Boolean).join(', ') || <M />}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', maxWidth: 170, overflow: 'hidden', textOverflow: 'ellipsis' }} title={dDevices.map(deviceCellLabel).join(', ')}>
                    {dDevices.length ? dDevices.map(deviceCellLabel).join(', ') : <M />}
                  </td>
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
                  <td className="sticky-col sr-2"><span className={`badge ${d.active ? 'green' : 'red'}`}>{d.active ? 'Active' : 'Exit'}</span></td>
                  <td style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button className="btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setEditing(d)}>Edit</button>
                    {d.active && <button className="btn-danger" onClick={() => deactivate(d)}>Exit</button>}
                  </td>
                </tr>
              );
            })}
            {drivers.length === 0 && (
              <tr><td colSpan={26} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No drivers yet — add one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && <AddDriver vehicles={vehicles} devices={devices} managers={managers} teamLeads={teamLeads} isAdmin={isAdmin} canAssignTeamLead={canAssignTeamLead} existingDriverIds={new Set(drivers.map(d => d.driverId).filter(Boolean) as string[])} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />}
      {editing && (
        <EditDriver
          driver={editing}
          vehicles={vehicles}
          devices={devices}
          managers={managers}
          teamLeads={teamLeads}
          isAdmin={isAdmin}
          canAssignTeamLead={canAssignTeamLead}
          existingDriverIds={new Set(drivers.filter(d => d._id !== editing._id).map(d => d.driverId).filter(Boolean) as string[])}
          driverVehicleIds={openAssetIds(openAssignments, editing._id, 'vehicle')}
          driverMobileIds={openAssetIds(openAssignments, editing._id, 'mobile')}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function M() { return <span style={{ color: 'var(--muted)' }}>—</span>; }

/** Populated refs come back as objects; fall back to nothing rather than a raw id. */
const idOf = (ref: unknown): string =>
  ref && typeof ref === 'object' ? String((ref as { _id: string })._id) : (ref ? String(ref) : '');

/** A driver's open asset ids for one kind, most recently assigned first. */
function openAssetIds(assignments: Assignment[], driverId: string, kind: Assignment['assetKind']): string[] {
  return assignments
    .filter(a => a.assetKind === kind && idOf(a.driverId) === driverId)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .map(a => a.assetId);
}

function itemsFor<T extends { _id: string }>(ids: string[], pool: T[]): T[] {
  return ids.map(id => pool.find(x => x._id === id)).filter((x): x is T => Boolean(x));
}

/** Compact label for the driver table — truncated IMEI, not the full number. */
const deviceCellLabel = (dev: MobileDevice) =>
  dev.label || dev.phoneModel || (dev.imei ? `…${dev.imei.slice(-5)}` : 'Device');

/** Picker-list labels lead with the identifier the fleet actually looks up a device by. */
const vehicleOptionLabel = (v: Vehicle) =>
  [v.vid ? `VID ${v.vid}` : 'No VID', v.plateNumber, v.model].filter(Boolean).join(' · ');
const deviceOptionLabel = (dev: MobileDevice) =>
  [dev.imei ? `IMEI ${dev.imei}` : 'No IMEI', dev.label || dev.phoneModel].filter(Boolean).join(' · ');

/** Name of whoever else currently holds this vehicle, or null (including "nobody" / "this driver"). */
function vehicleHeldBy(v: Vehicle, excludeDriverId?: string): string | null {
  const holder = v.assignedDriverId && typeof v.assignedDriverId === 'object' ? v.assignedDriverId : null;
  if (!holder || holder._id === excludeDriverId) return null;
  return holder.name;
}
function deviceHeldBy(dev: MobileDevice, excludeDriverId?: string): string | null {
  const holder = dev.currentDriverId && typeof dev.currentDriverId === 'object' ? dev.currentDriverId : null;
  if (!holder || holder._id === excludeDriverId) return null;
  return holder.name;
}

/**
 * Multi-select as a checkbox list rather than a native <select multiple> — the latter needs a
 * modifier-key to multi-pick, which nobody discovers without being told. Flags an item already
 * held by someone else, and confirms before stealing it: reassigning here closes their stint.
 */
function AssetPicker<T extends { _id: string }>({
  items, selectedIds, onToggle, label, heldBy, activeId,
}: {
  items: T[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  label: (item: T) => string;
  heldBy: (item: T) => string | null;
  activeId?: string | null;
}) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const filtered = q ? items.filter(it => label(it).toLowerCase().includes(q)) : items;

  const handleToggle = (it: T) => {
    const checked = selectedIds.includes(it._id);
    if (!checked) {
      const holder = heldBy(it);
      if (holder && !confirm(`${label(it)} is currently held by ${holder}. Reassign it to this driver?`)) return;
    }
    onToggle(it._id);
  };

  return (
    <div>
      {items.length > 6 && (
        <input
          className="input"
          style={{ marginBottom: 6, fontSize: 12.5, padding: '6px 10px' }}
          placeholder="Filter by VID, IMEI, plate…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      )}
      <div style={{
        border: '1px solid var(--line-2)', borderRadius: 'var(--radius)',
        maxHeight: 172, overflowY: 'auto', background: 'var(--panel)',
      }}>
        {filtered.length === 0 && (
          <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--muted)' }}>No matches</div>
        )}
        {filtered.map(it => {
          const checked = selectedIds.includes(it._id);
          const holder = heldBy(it);
          return (
            <label
              key={it._id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 10px', fontSize: 12.5, cursor: 'pointer',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <input type="checkbox" checked={checked} onChange={() => handleToggle(it)} />
              <span style={{ flex: 1, fontFamily: 'monospace' }}>{label(it)}</span>
              {checked && it._id === activeId && <span className="badge green" style={{ fontSize: 9.5 }}>Active</span>}
              {holder && !checked && <span className="badge amber" style={{ fontSize: 9.5 }}>held by {holder}</span>}
            </label>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
        {selectedIds.length} selected
      </div>
    </div>
  );
}

const EMPTY_FORM = {
  name: '', email: '', password: '', phone: '', country: '', managerId: '', teamLeadId: '',
  driverId: '', project: '', scope: '', region: '', drivingLocation: '', driverMode: '',
  poc: '', contact: '', personalMail: '', driverAddress: '', ctsMail: '',
  driverStatus: '', joiningDate: '', exitDate: '',
  pricePerHour: '', perDiem: '', currency: '', language: '',
};

function AddDriver({ vehicles, devices, managers, teamLeads, isAdmin, canAssignTeamLead, existingDriverIds, onClose, onSaved }: {
  vehicles: Vehicle[]; devices: MobileDevice[]; managers: User[]; teamLeads: User[];
  isAdmin: boolean; canAssignTeamLead: boolean; existingDriverIds: Set<string>; onClose: () => void; onSaved: () => void;
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [vehicleIds, setVehicleIds] = useState<string[]>([]);
  const [mobileIds, setMobileIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const toggleVehicle = (id: string) => setVehicleIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const toggleMobile = (id: string) => setMobileIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

  const save = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (!form.email.trim()) { setError('Email is required'); return; }
    if (!form.password.trim()) { setError('Password is required'); return; }
    if (form.driverId && existingDriverIds.has(form.driverId.trim())) { setError('Driver ID already exists. Please use a unique Driver ID.'); return; }
    setError(null); setBusy(true);
    try {
      await api.post('/api/users', {
        name: form.name, email: form.email, password: form.password,
        phone: form.phone || undefined, role: 'user',
        country: form.country.trim() || undefined,
        vehicleIds, mobileDeviceIds: mobileIds,
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
    <Modal wide title="Add new driver" onClose={onClose}>
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
          <F label="Driver ID (unique)"><input className="input" value={form.driverId} onChange={e => set('driverId', e.target.value)} /></F>
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
        <F label={`Vehicles${vehicleIds.length ? ` · ${vehicleIds.length} selected` : ''}`}>
          <AssetPicker
            items={vehicles}
            selectedIds={vehicleIds}
            onToggle={toggleVehicle}
            label={vehicleOptionLabel}
            heldBy={v => vehicleHeldBy(v)}
          />
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
            A driver can hold more than one vehicle. Picking one already held by someone else reassigns it here and records the handover.
          </p>
        </F>
        <F label={`Mobile devices${mobileIds.length ? ` · ${mobileIds.length} selected` : ''}`}>
          <AssetPicker
            items={devices}
            selectedIds={mobileIds}
            onToggle={toggleMobile}
            label={deviceOptionLabel}
            heldBy={d => deviceHeldBy(d)}
          />
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

function EditDriver({ driver, vehicles, devices, managers, teamLeads, isAdmin, canAssignTeamLead, existingDriverIds, driverVehicleIds, driverMobileIds, onClose, onSaved }: {
  driver: User; vehicles: Vehicle[]; devices: MobileDevice[]; managers: User[]; teamLeads: User[];
  isAdmin: boolean; canAssignTeamLead: boolean; existingDriverIds: Set<string>;
  driverVehicleIds: string[]; driverMobileIds: string[];
  onClose: () => void; onSaved: () => void;
}) {
  const activeVehicleId = idOf(driver.vehicleId);
  const activeMobileId = idOf(driver.mobileDeviceId);
  const managerIdVal = driver.managerId && typeof driver.managerId === 'object' ? (driver.managerId as any)._id : (driver.managerId || '');
  const teamLeadIdVal = driver.teamLeadId && typeof driver.teamLeadId === 'object' ? (driver.teamLeadId as any)._id : (driver.teamLeadId || '');
  const [form, setForm] = useState({
    name: driver.name,
    phone: driver.phone || '',
    country: driver.country || '',
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
  const [vehicleIds, setVehicleIds] = useState<string[]>(driverVehicleIds);
  const [mobileIds, setMobileIds] = useState<string[]>(driverMobileIds);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));
  const toggleVehicle = (id: string) => setVehicleIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const toggleMobile = (id: string) => setMobileIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

  const save = async () => {
    if (form.driverId && form.driverId.trim() !== (driver.driverId || '') && existingDriverIds.has(form.driverId.trim())) {
      setError('Driver ID already exists. Please use a unique Driver ID.'); return;
    }
    setError(null); setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        phone: form.phone || null,
        country: form.country || null,
        vehicleIds,
        mobileDeviceIds: mobileIds,
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
    <Modal wide title={`Edit · ${driver.name}`} onClose={onClose}>
      <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: 8 }}>
        <SectionLabel text="Account" />
        <Row>
          <F label="Full name"><input className="input" value={form.name} onChange={e => set('name', e.target.value)} /></F>
          <F label="Phone"><input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} /></F>
        </Row>

        <SectionLabel text="Project & Location" />
        <Row>
          <F label="Project"><input className="input" value={form.project} onChange={e => set('project', e.target.value)} /></F>
          <F label="Driver ID (unique)"><input className="input" value={form.driverId} onChange={e => set('driverId', e.target.value)} /></F>
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
        <F label={`Vehicles${vehicleIds.length ? ` · ${vehicleIds.length} selected` : ''}`}>
          <AssetPicker
            items={vehicles}
            selectedIds={vehicleIds}
            onToggle={toggleVehicle}
            label={vehicleOptionLabel}
            heldBy={v => vehicleHeldBy(v, driver._id)}
            activeId={activeVehicleId}
          />
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
            A driver can hold more than one. The most recently assigned is marked <b>Active</b> — that's the one live trip tracking uses.
          </p>
        </F>
        <F label={`Mobile devices${mobileIds.length ? ` · ${mobileIds.length} selected` : ''}`}>
          <AssetPicker
            items={devices}
            selectedIds={mobileIds}
            onToggle={toggleMobile}
            label={deviceOptionLabel}
            heldBy={d => deviceHeldBy(d, driver._id)}
            activeId={activeMobileId}
          />
          <p style={{ fontSize: 11, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.5 }}>
            Unchecking a device returns it to stock and records the handover.
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
