import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile } from '../lib/api';
import type { Project } from '../lib/types';
import { HotelBookingModal } from './HotelBookingModal';
import { ProjectSelect, useDefaultProject, useProjectScope } from './ProjectSelect';
import {
  PAYMENT_LABEL, STAY_LABEL, dayLabel, money, todayIso, type HotelBooking,
} from '../lib/hotelBookings';

/**
 * Every stay the office has booked, filterable by where it sits on the calendar.
 *
 * "Staying now" is the default because it is the question this list mostly answers — where is
 * everybody sleeping tonight. The calendar states are the VIEWER's today, sent with the request.
 */

type When = 'current' | 'upcoming' | 'past' | 'cancelled' | 'all';

const WHEN: { key: When; label: string }[] = [
  { key: 'current', label: 'Staying now' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'past', label: 'Past' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

export function HotelBookingsTab({ reloadKey }: { reloadKey: number }) {
  const [when, setWhen] = useState<When>('current');
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('');
  const projectScope = useProjectScope();
  useDefaultProject(projectScope, projectId, setProjectId, 'id');
  const [projects, setProjects] = useState<Project[]>([]);
  const [rows, setRows] = useState<HotelBooking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<HotelBooking | null>(null);
  const [creating, setCreating] = useState(false);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    api.get<{ projects: Project[] }>('/api/projects').then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, []);

  const query = useCallback(() => {
    const p = new URLSearchParams({ today: todayIso(0) });
    if (when !== 'all') p.set('when', when);
    if (q.trim()) p.set('q', q.trim());
    if (projectId) p.set('projectId', projectId);
    return p;
  }, [when, q, projectId]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.get<{ bookings: HotelBooking[] }>(`/api/hotels/bookings?${query()}`)
        .then((r) => { if (live) { setRows(r.bookings); setError(null); } })
        .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load bookings'); })
        .finally(() => { if (live) setLoading(false); });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [query, q, reloadKey, bump]);

  const exportCsv = () =>
    downloadFile(`/api/hotels/bookings/export.csv?${query()}`, `hotel-bookings-${todayIso(0)}.csv`)
      .catch((e) => setError(e instanceof Error ? e.message : 'Export failed'));

  const totalNights = rows.reduce((n, b) => n + (b.status === 'booked' ? b.nights : 0), 0);

  return (
    <div>
      <div className="hb-toolbar">
        <div className="cov-seg" role="tablist" aria-label="Which bookings">
          {WHEN.map((w) => (
            <button key={w.key} role="tab" aria-selected={when === w.key} className={when === w.key ? 'active' : ''} onClick={() => setWhen(w.key)}>
              {w.label}
            </button>
          ))}
        </div>
        <input className="input" type="search" placeholder="Driver, hotel, city or reference…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260, margin: 0 }} />
        <ProjectSelect scope={projectScope} keyBy="id" value={projectId} onChange={setProjectId} style={{ width: 'auto', margin: 0 }}
          options={projects.map((p) => ({ value: p._id, label: p.name }))} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn-ghost" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
          <button className="btn" onClick={() => setCreating(true)}>+ Record booking</button>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
        {loading ? 'Loading…' : `${rows.length} booking${rows.length === 1 ? '' : 's'}${totalNights ? ` · ${totalNights} night${totalNights === 1 ? '' : 's'}` : ''}`}
      </div>

      {error && <div className="card" style={{ borderLeft: '3px solid var(--red)', marginBottom: 12 }}>{error}</div>}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Driver</th>
              <th>Hotel</th>
              <th>Stay</th>
              <th>Cost</th>
              <th>Reference</th>
              <th>Payment</th>
              <th>Status</th>
              <th>Booked by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const tag = STAY_LABEL[b.stayState] ?? STAY_LABEL.booked;
              return (
                <tr key={b._id} className="cov-row-clickable" onClick={() => setEditing(b)} title="Open this booking">
                  <td>
                    <div style={{ fontWeight: 600 }}>{b.driver.name}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {[b.driver.driverCode, b.driver.project].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{b.hotel.name}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{b.hotel.city || b.hotel.address || '—'}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div>{dayLabel(b.checkIn)} → {dayLabel(b.checkOut)}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {b.nights} night{b.nights === 1 ? '' : 's'} · {b.rooms} room{b.rooms === 1 ? '' : 's'}
                      {b.breakfastIncluded ? ' · breakfast' : ''}
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div>{money(b.totalCost, b.currency)}</div>
                    {b.costPerNight != null && <div className="muted" style={{ fontSize: 11.5 }}>{money(b.costPerNight, b.currency)} / night</div>}
                  </td>
                  <td>
                    <div style={{ fontFamily: 'monospace', fontSize: 12 }}>{b.bookingReference || '—'}</div>
                    {b.attachments.length > 0 && (
                      <div className="muted" style={{ fontSize: 11.5 }}>📎 {b.attachments.length} file{b.attachments.length === 1 ? '' : 's'}</div>
                    )}
                  </td>
                  <td style={{ fontSize: 12.5 }}>{PAYMENT_LABEL[b.payment] ?? b.payment}</td>
                  <td><span className={`badge ${tag.tone}`}>{tag.text}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {b.bookedByName || '—'}
                    <div style={{ fontSize: 11 }}>{new Date(b.createdAt).toLocaleDateString()}</div>
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
                  {when === 'current' ? 'Nobody is booked into a hotel tonight.' : 'No bookings match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <HotelBookingModal
          booking={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); setBump((n) => n + 1); }}
        />
      )}
    </div>
  );
}
