import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Modal } from './Modal';
import { api, downloadFile, uploadRaw, type ApiError } from '../lib/api';
import {
  BOOKED_VIA_LABEL, PAYMENT_LABEL, ROOM_TYPE_LABEL, dayLabel, money, nightsBetween, todayIso,
  type BookedVia, type BookingAttachment, type BookingDriver, type BookingHotel, type DriverProfile,
  type HotelBooking, type Payment, type RoomType,
} from '../lib/hotelBookings';

/**
 * Record (or edit) a hotel stay booked for a driver.
 *
 * Opened from a hotel's "Book now" — the booking itself happens on Booking.com in the other tab,
 * and this is where what was booked comes back into the system. The driver's details come from
 * their record and the hotel's from the search, so the manager only types what nobody else knows:
 * the dates, the reference and the price. Everything prefilled stays editable, because the booking
 * may have gone in under a different number, or at a different hotel than the one clicked.
 */

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FILE_ACCEPT = '.pdf,image/png,image/jpeg,image/webp,image/heic';

interface DriverOption { _id: string; name: string; driverCode: string | null; project: string | null }
interface Conflict { _id: string; hotel: { name: string }; checkIn: string; checkOut: string; nights: number }

const EMPTY_DRIVER: BookingDriver = {
  name: '', driverCode: null, phone: null, email: null, project: null, region: null, country: null, vehiclePlate: null,
};
const EMPTY_HOTEL: BookingHotel = {
  hotelLocationId: null, name: '', address: null, city: null, phone: null, category: null, lat: null, lon: null,
};

function Field({ label, children, span, hint }: { label: string; children: ReactNode; span?: boolean; hint?: ReactNode }) {
  return (
    <div className={`field${span ? ' span-2' : ''}`}>
      <label>{label}</label>
      {children}
      {hint && <div className="hb-hint">{hint}</div>}
    </div>
  );
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function HotelBookingModal({
  booking,
  driverId: initialDriverId,
  hotel: initialHotel,
  onClose,
  onSaved,
}: {
  /** Editing this booking. Absent = recording a new one. */
  booking?: HotelBooking | null;
  /** New booking: the driver picked on the search screen. */
  driverId?: string | null;
  /** New booking: the hotel clicked on the search screen. */
  hotel?: Partial<BookingHotel> | null;
  onClose: () => void;
  onSaved: (b: HotelBooking) => void;
}) {
  const editing = Boolean(booking);

  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [driverId, setDriverId] = useState(booking?.driverId ?? initialDriverId ?? '');
  const [driver, setDriver] = useState<BookingDriver>(booking?.driver ?? EMPTY_DRIVER);
  const [profile, setProfile] = useState<DriverProfile | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);

  const [hotel, setHotel] = useState<BookingHotel>(booking?.hotel ?? { ...EMPTY_HOTEL, ...(initialHotel || {}) });

  const [checkIn, setCheckIn] = useState(booking?.checkIn ?? todayIso(0));
  const [checkOut, setCheckOut] = useState(booking?.checkOut ?? todayIso(1));
  const [rooms, setRooms] = useState(booking?.rooms ?? 1);
  const [roomType, setRoomType] = useState<RoomType>(booking?.roomType ?? 'single');
  const [breakfast, setBreakfast] = useState(booking?.breakfastIncluded ?? false);
  const [bookedVia, setBookedVia] = useState<BookedVia>(booking?.bookedVia ?? 'booking_com');
  const [reference, setReference] = useState(booking?.bookingReference ?? '');
  const [totalCost, setTotalCost] = useState(booking?.totalCost != null ? String(booking.totalCost) : '');
  const [currency, setCurrency] = useState(booking?.currency ?? '');
  const [payment, setPayment] = useState<Payment>(booking?.payment ?? 'company_card');
  const [notes, setNotes] = useState(booking?.notes ?? '');

  const [attachments, setAttachments] = useState<BookingAttachment[]>(booking?.attachments ?? []);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);

  // The picker, for a booking not started from a search (or to change who it is for).
  useEffect(() => {
    if (editing) return;
    api.get<{ drivers: DriverOption[] }>('/api/hotels/drivers')
      .then((r) => setDrivers(r.drivers))
      .catch(() => setDrivers([]));
  }, [editing]);

  // Prefill from the driver's own record whenever the driver changes. Editing keeps the snapshot
  // the booking was made with — re-reading the record would silently rewrite history.
  useEffect(() => {
    if (!driverId) { setProfile(null); return; }
    let live = true;
    setProfileBusy(true);
    api.get<{ driver: DriverProfile }>(`/api/hotels/drivers/${driverId}/profile`)
      .then((r) => {
        if (!live) return;
        setProfile(r.driver);
        if (!editing) {
          const p = r.driver;
          setDriver({
            name: p.name, driverCode: p.driverCode, phone: p.phone, email: p.email,
            project: p.project, region: p.region, country: p.country, vehiclePlate: p.vehiclePlate,
          });
          setCurrency((c) => c || p.currency || '');
        }
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load the driver'); })
      .finally(() => { if (live) setProfileBusy(false); });
    return () => { live = false; };
  }, [driverId, editing]);

  const nights = nightsBetween(checkIn, checkOut);
  const cost = totalCost.trim() === '' ? null : Number(totalCost);
  const perNight = nights && cost != null && Number.isFinite(cost) ? cost / nights : null;
  const overPerDiem = perNight != null && profile?.perDiem != null && perNight > profile.perDiem;

  const setD = (k: keyof BookingDriver) => (e: ChangeEvent<HTMLInputElement>) =>
    setDriver((d) => ({ ...d, [k]: e.target.value || null }));
  const setH = (k: keyof BookingHotel) => (e: ChangeEvent<HTMLInputElement>) =>
    setHotel((h) => ({ ...h, [k]: e.target.value || null }));

  const pickFiles = (list: FileList | null) => {
    if (!list) return;
    const ok: File[] = [];
    for (const f of Array.from(list)) {
      if (f.size > MAX_FILE_BYTES) { setError(`${f.name} is larger than 10 MB`); continue; }
      ok.push(f);
    }
    setPendingFiles((cur) => [...cur, ...ok]);
    if (fileRef.current) fileRef.current.value = '';
  };

  const removeSaved = async (att: BookingAttachment) => {
    if (!booking) return;
    try {
      const r = await api.del<{ booking: HotelBooking }>(`/api/hotels/bookings/${booking._id}/attachments/${att._id}`);
      setAttachments(r.booking.attachments);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove the file');
    }
  };

  const valid = useMemo(() => {
    if (!driverId) return 'Pick the driver';
    if (!driver.name?.trim()) return "The driver's name is required";
    if (!hotel.name?.trim()) return "Enter the hotel's name";
    if (!nights) return 'Check-out must be after check-in';
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) return 'Total cost must be a number';
    return null;
  }, [driverId, driver.name, hotel.name, nights, cost]);

  const save = async (force = false) => {
    if (valid) { setError(valid); return; }
    setSaving(true);
    setError(null);
    const body = {
      driverId,
      driver,
      hotel,
      checkIn, checkOut, rooms, roomType,
      breakfastIncluded: breakfast,
      bookedVia,
      bookingReference: reference,
      totalCost: cost,
      currency: currency.trim().toUpperCase() || null,
      payment,
      notes,
      today: todayIso(0),
      force,
    };
    try {
      const r = booking
        ? await api.patch<{ booking: HotelBooking }>(`/api/hotels/bookings/${booking._id}`, body)
        : await api.post<{ booking: HotelBooking }>('/api/hotels/bookings', body);
      let saved = r.booking;
      // Files go up once the booking exists to hang them on. A failed upload does not undo the
      // booking — it is saved, and the file can be added again from the Bookings list.
      for (const f of pendingFiles) {
        try {
          const up = await uploadRaw<{ booking: HotelBooking }>(
            `/api/hotels/bookings/${saved._id}/attachments?today=${todayIso(0)}`,
            f,
            undefined,
            f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream')
          );
          saved = up.booking;
        } catch (e) {
          setError(`Booking saved, but ${f.name} did not upload: ${e instanceof Error ? e.message : 'failed'}`);
          onSaved(saved);
          setSaving(false);
          return;
        }
      }
      onSaved(saved);
    } catch (e) {
      const err = e as ApiError;
      const body = err.body as { code?: string; conflicts?: Conflict[] } | undefined;
      if (err.status === 409 && body?.code === 'OVERLAP') {
        setConflicts(body.conflicts || []);
      } else {
        setError(err.message || 'Could not save the booking');
      }
      setSaving(false);
    }
  };

  const cancelBooking = async (status: 'cancelled' | 'booked') => {
    if (!booking) return;
    if (status === 'cancelled' && !confirm(`Cancel ${driver.name}'s stay at ${hotel.name}?`)) return;
    setSaving(true);
    try {
      const r = await api.patch<{ booking: HotelBooking }>(`/api/hotels/bookings/${booking._id}`, { status, today: todayIso(0) });
      onSaved(r.booking);
    } catch (e) {
      const err = e as ApiError;
      setError(err.status === 409 ? 'Cannot reinstate — the driver has another stay on those nights now.' : err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit hotel booking' : 'Record hotel booking'} onClose={onClose} wide>
      {/* ---- Driver ---- */}
      <div className="hb-section">
        <div className="hb-section-head">
          <span>Driver</span>
          {profileBusy ? <small>Loading details…</small> : profile && !editing ? <small>Filled in from the driver record — edit if the booking used other details</small> : null}
        </div>
        <div className="form-grid">
          {!editing && (
            <Field label="Driver" span>
              <select className="input" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                <option value="">Select a driver…</option>
                {drivers.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}{d.driverCode ? ` · ${d.driverCode}` : ''}{d.project ? ` · ${d.project}` : ''}
                  </option>
                ))}
                {/* The search screen's driver, before the full list has arrived. */}
                {driverId && !drivers.some((d) => d._id === driverId) && (
                  <option value={driverId}>{driver.name || 'Selected driver'}</option>
                )}
              </select>
            </Field>
          )}
          <Field label="Name"><input className="input" value={driver.name ?? ''} onChange={setD('name')} /></Field>
          <Field label="Driver ID"><input className="input" value={driver.driverCode ?? ''} onChange={setD('driverCode')} /></Field>
          <Field label="Phone"><input className="input" value={driver.phone ?? ''} onChange={setD('phone')} /></Field>
          <Field label="Email"><input className="input" type="email" value={driver.email ?? ''} onChange={setD('email')} /></Field>
          <Field label="Project"><input className="input" value={driver.project ?? ''} onChange={setD('project')} /></Field>
          <Field label="Vehicle"><input className="input" value={driver.vehiclePlate ?? ''} onChange={setD('vehiclePlate')} /></Field>
        </div>
      </div>

      {/* ---- Hotel ---- */}
      <div className="hb-section">
        <div className="hb-section-head">
          <span>Hotel</span>
          {initialHotel?.name && !editing ? <small>From your search — change it if you booked somewhere else</small> : null}
        </div>
        <div className="form-grid">
          <Field label="Hotel name" span><input className="input" value={hotel.name ?? ''} onChange={setH('name')} placeholder="e.g. Hampton Park Motel" /></Field>
          <Field label="Address" span><input className="input" value={hotel.address ?? ''} onChange={setH('address')} /></Field>
          <Field label="City"><input className="input" value={hotel.city ?? ''} onChange={setH('city')} /></Field>
          <Field label="Hotel phone"><input className="input" value={hotel.phone ?? ''} onChange={setH('phone')} /></Field>
        </div>
      </div>

      {/* ---- The booking ---- */}
      <div className="hb-section">
        <div className="hb-section-head"><span>Booking</span></div>
        <div className="form-grid">
          <Field label="Check-in">
            <input className="input" type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </Field>
          <Field label="Check-out">
            <input className="input" type="date" value={checkOut} min={checkIn} onChange={(e) => setCheckOut(e.target.value)} />
          </Field>
          <div className="hb-nights span-2">
            {nights ? (
              <>
                <strong>{nights} night{nights === 1 ? '' : 's'}</strong>
                <span>{dayLabel(checkIn)} → {dayLabel(checkOut)}</span>
              </>
            ) : (
              <span className="error-text" style={{ margin: 0 }}>Check-out must be after check-in</span>
            )}
          </div>
          <Field label="Rooms">
            <input className="input" type="number" min={1} max={50} value={rooms} onChange={(e) => setRooms(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <Field label="Room type">
            <select className="input" value={roomType} onChange={(e) => setRoomType(e.target.value as RoomType)}>
              {Object.entries(ROOM_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Booked via">
            <select className="input" value={bookedVia} onChange={(e) => setBookedVia(e.target.value as BookedVia)}>
              {Object.entries(BOOKED_VIA_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Booking reference">
            <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Confirmation number" />
          </Field>
          <Field
            label="Total cost"
            hint={perNight != null ? (
              <span style={overPerDiem ? { color: 'var(--amber)' } : undefined}>
                {money(Math.round(perNight * 100) / 100, currency || null)} per night
                {profile?.perDiem != null && ` · per diem ${money(profile.perDiem, currency || null)}`}
                {overPerDiem && ' — over'}
              </span>
            ) : null}
          >
            <input className="input" type="number" min={0} step="0.01" value={totalCost} onChange={(e) => setTotalCost(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Currency">
            <input className="input" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="AUD" />
          </Field>
          <Field label="Payment">
            <select className="input" value={payment} onChange={(e) => setPayment(e.target.value as Payment)}>
              {Object.entries(PAYMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Breakfast">
            <label className="hb-check">
              <input type="checkbox" checked={breakfast} onChange={(e) => setBreakfast(e.target.checked)} />
              Included
            </label>
          </Field>
          <Field label="Notes" span>
            <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Late check-in, parking for the van…" />
          </Field>
        </div>
      </div>

      {/* ---- Confirmation files ---- */}
      <div className="hb-section">
        <div className="hb-section-head">
          <span>Confirmation</span>
          <small>PDF or screenshot, up to 10 MB each</small>
        </div>
        <div className="hb-files">
          {attachments.map((a) => (
            <div key={a._id} className="hb-file">
              <button
                type="button"
                className="cov-link"
                onClick={() => booking && downloadFile(`/api/hotels/bookings/${booking._id}/attachments/${a._id}`, a.filename).catch((e) => setError(e.message))}
              >
                {a.filename}
              </button>
              <span className="muted">{kb(a.bytes)}</span>
              <button type="button" className="hb-file-x" aria-label={`Remove ${a.filename}`} onClick={() => removeSaved(a)}>✕</button>
            </div>
          ))}
          {pendingFiles.map((f, i) => (
            <div key={`${f.name}-${i}`} className="hb-file pending">
              <span>{f.name}</span>
              <span className="muted">{kb(f.size)} · uploads on save</span>
              <button type="button" className="hb-file-x" aria-label={`Remove ${f.name}`} onClick={() => setPendingFiles((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn-ghost" onClick={() => fileRef.current?.click()}>+ Attach file</button>
          <input ref={fileRef} type="file" accept={FILE_ACCEPT} multiple hidden onChange={(e) => pickFiles(e.target.files)} />
        </div>
      </div>

      {conflicts && (
        <div className="cov-issue warn" style={{ marginTop: 14 }}>
          <strong>{driver.name || 'This driver'} already has a stay on some of these nights:</strong>
          <ul style={{ margin: '6px 0 8px', paddingLeft: 18 }}>
            {conflicts.map((c) => (
              <li key={c._id}>{c.hotel?.name} · {dayLabel(c.checkIn)} → {dayLabel(c.checkOut)} ({c.nights} night{c.nights === 1 ? '' : 's'})</li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={saving} onClick={() => { setConflicts(null); void save(true); }}>Save anyway</button>
            <button className="btn-ghost" onClick={() => setConflicts(null)}>Change dates</button>
          </div>
        </div>
      )}

      {error && <div className="error-text" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        {editing && booking?.status === 'booked' && (
          <button className="btn-ghost" style={{ marginRight: 'auto', color: 'var(--red)' }} disabled={saving} onClick={() => cancelBooking('cancelled')}>
            Cancel booking
          </button>
        )}
        {editing && booking?.status === 'cancelled' && (
          <button className="btn-ghost" style={{ marginRight: 'auto' }} disabled={saving} onClick={() => cancelBooking('booked')}>
            Reinstate
          </button>
        )}
        <button className="btn-ghost" onClick={onClose}>Close</button>
        <button className="btn" disabled={saving || Boolean(valid)} title={valid ?? undefined} onClick={() => save(false)}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Save booking'}
        </button>
      </div>
    </Modal>
  );
}
