import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { dt } from '../lib/format';

/**
 * Hotels near a driver.
 *
 * The manager never types a location — it comes from the driver's own last reported position,
 * the same feed the live map uses. What they choose is WHO, and the page answers WHERE.
 *
 * One driver is searched at a time on purpose: this provider bills per call, so a fan-out
 * across the fleet on every page load would be expensive and mostly unread.
 */

interface Money { value: number; label: string | null; currency: string | null }

interface Property {
  id: number | string | null;
  name: string;
  city: string | null;
  countryCode: string | null;
  stars: number | null;
  starsEstimated: boolean;
  score: number | null;
  scoreWord: string | null;
  reviews: number;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
  photo: string | null;
  perNight: Money | null;
  total: Money | null;
  totalWithTaxes: Money | null;
  wasPerNight: Money | null;
  localPrice: { value: number; currency: string } | null;
  nights: number;
  freeParking: boolean;
  freeCancellation: boolean;
  noPrepayment: boolean;
  breakfastIncluded: boolean;
  pool: boolean;
  checkinFrom: string | null;
  checkinUntil: string | null;
  checkoutUntil: string | null;
  roomLabel: string | null;
  urgency: string | null;
  badges: string[];
}

interface RosterDriver {
  _id: string;
  name: string;
  country: string | null;
  project: string | null;
  located: boolean;
  lat: number | null;
  lon: number | null;
  lastSeenAt: string | null;
  timezone: string | null;
}

interface HotelResponse {
  configured: boolean;
  drivers: RosterDriver[];
  unplaced: { _id: string; name: string }[];
  budget: { used: number; cap: number; remaining: number };
  selected: RosterDriver | null;
  search: {
    arrival: string; departure: string; nights: number;
    adults: number; rooms: number; radiusKm: number; currency: string; sort: string;
  } | null;
  properties: Property[];
  totalFound: number;
  shown?: number;
  fromCache?: boolean;
  cachedAgeSeconds?: number;
  message?: string;
}

const BedIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>
  </svg>
);
const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
);

const CURRENCIES = ['INR', 'AUD', 'GBP', 'EUR', 'USD', 'AED', 'SGD'];
const RADII = [10, 20, 30, 50, 100, 200];

/** Booking.com has no stable per-property URL in this payload, so this opens a scoped search. */
function bookingUrl(p: Property, arrival: string, departure: string, adults: number, rooms: number) {
  const q = new URLSearchParams({
    ss: p.name,
    checkin: arrival,
    checkout: departure,
    group_adults: String(adults),
    no_rooms: String(rooms),
  });
  if (p.lat != null && p.lon != null) {
    q.set('latitude', String(p.lat));
    q.set('longitude', String(p.lon));
  }
  return `https://www.booking.com/searchresults.html?${q}`;
}

function scoreTone(score: number | null) {
  if (score == null) return 'gray';
  if (score >= 8) return 'green';
  if (score >= 6.5) return 'amber';
  return 'gray';
}

/** A driver rolling in at midnight cannot use a property whose reception shuts at 20:00. */
function lateArrivalRisk(until: string | null) {
  if (!until) return false;
  const [h] = until.split(':').map(Number);
  return Number.isFinite(h) && h < 21 && h > 0;
}

export function Hotels() {
  const [data, setData] = useState<HotelResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [driverId, setDriverId] = useState('');
  const [arrival, setArrival] = useState('');
  const [departure, setDeparture] = useState('');
  const [adults, setAdults] = useState(1);
  const [rooms, setRooms] = useState(1);
  const [radiusKm, setRadiusKm] = useState(30);
  const [currency, setCurrency] = useState('INR');
  const [sort, setSort] = useState('distance');
  const [parkingOnly, setParkingOnly] = useState(false);

  // A search is a paid call, so it runs when the manager asks for one — not on every keystroke.
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({
      adults: String(adults), rooms: String(rooms), radiusKm: String(radiusKm),
      currency, sort, freeParkingOnly: String(parkingOnly),
    });
    if (driverId) q.set('driverId', driverId);
    if (arrival) q.set('arrival', arrival);
    if (departure) q.set('departure', departure);

    api.get<HotelResponse>(`/api/hotels/near-driver?${q}`)
      .then(r => {
        setData(r);
        // Adopt whatever the server settled on, so the controls show the real search.
        if (r.search) { setArrival(r.search.arrival); setDeparture(r.search.departure); }
        if (r.selected && !driverId) setDriverId(String(r.selected._id));
      })
      .catch(e => { setData(null); setError(e instanceof Error ? e.message : 'Hotel search failed'); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const search = () => setRunId(n => n + 1);

  const located = useMemo(() => (data?.drivers ?? []).filter(d => d.located), [data]);
  const selected = data?.selected ?? null;
  const props = data?.properties ?? [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BedIcon /> Hotels
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Rooms near a driver&apos;s last reported position — no address needed
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <FilterIcon />
          <select className="input" style={{ width: 180, margin: 0 }} value={driverId} onChange={e => setDriverId(e.target.value)}>
            {located.length === 0 && <option value="">No located drivers</option>}
            {located.map(d => (
              <option key={d._id} value={d._id}>{d.name}{d.country ? ` · ${d.country}` : ''}</option>
            ))}
          </select>
          <input className="input" type="date" style={{ width: 150, margin: 0 }} value={arrival}
            onChange={e => setArrival(e.target.value)} title="Check-in" />
          <input className="input" type="date" style={{ width: 150, margin: 0 }} value={departure}
            onChange={e => setDeparture(e.target.value)} title="Check-out" />
          <select className="input" style={{ width: 100, margin: 0 }} value={radiusKm} onChange={e => setRadiusKm(Number(e.target.value))}>
            {RADII.map(r => <option key={r} value={r}>{r} km</option>)}
          </select>
          <select className="input" style={{ width: 92, margin: 0 }} value={currency} onChange={e => setCurrency(e.target.value)}>
            {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input" style={{ width: 130, margin: 0 }} value={sort} onChange={e => setSort(e.target.value)}>
            <option value="distance">Nearest first</option>
            <option value="price">Cheapest first</option>
            <option value="rating">Best rated</option>
          </select>
          <button className="btn" onClick={search} disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {/* Secondary controls */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18, fontSize: 13 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Guests
          <input className="input" type="number" min={1} max={30} style={{ width: 64, margin: 0 }}
            value={adults} onChange={e => setAdults(Number(e.target.value) || 1)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Rooms
          <input className="input" type="number" min={1} max={30} style={{ width: 64, margin: 0 }}
            value={rooms} onChange={e => setRooms(Number(e.target.value) || 1)} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input type="checkbox" checked={parkingOnly} onChange={e => setParkingOnly(e.target.checked)} />
          Free parking only
        </label>
        {data?.budget && (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            {data.budget.remaining} of {data.budget.cap} searches left today
            {data.fromCache ? ' · served from cache' : ''}
          </span>
        )}
      </div>

      {error && (
        <div className="card" style={{ padding: '18px 20px', marginBottom: 18, borderLeft: '3px solid var(--red)' }}>
          <strong>Hotel search unavailable.</strong>
          <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{error}</div>
        </div>
      )}

      {data?.message && !error && (
        <div className="card" style={{ textAlign: 'center', padding: '50px 24px', color: 'var(--muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📍</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
            Nowhere to search yet
          </div>
          <div style={{ fontSize: 13 }}>{data.message}</div>
        </div>
      )}

      {selected && data?.search && (
        <div className="stat-row">
          <div className="stat">
            <div className="icon">👤</div>
            <div className="v" style={{ fontSize: 18 }}>{selected.name}</div>
            <div className="k">Searching around this driver</div>
          </div>
          <div className="stat">
            <div className="icon">📍</div>
            <div className="v" style={{ fontSize: 15, fontFamily: 'monospace' }}>
              {selected.lat?.toFixed(3)}, {selected.lon?.toFixed(3)}
            </div>
            <div className="k">Last position · {dt(selected.lastSeenAt)}</div>
          </div>
          <div className="stat">
            <div className="icon">🌙</div>
            <div className="v">{data.search.nights}</div>
            <div className="k">{data.search.arrival} → {data.search.departure}</div>
          </div>
          <div className="stat">
            <div className="icon">🏨</div>
            <div className="v">{props.length}</div>
            <div className="k">Within {data.search.radiusKm} km of {data.totalFound} found</div>
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="muted" style={{ padding: 40, textAlign: 'center' }}>Searching for rooms…</div>
      )}

      {!loading && selected && props.length === 0 && !error && !data?.message && (
        <div className="card" style={{ textAlign: 'center', padding: '46px 24px', color: 'var(--muted)' }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>🛏️</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
            Nothing bookable within {data?.search?.radiusKm} km
          </div>
          <div style={{ fontSize: 13 }}>
            Try a wider radius{parkingOnly ? ', or turn off the free-parking filter' : ''}.
          </div>
        </div>
      )}

      {/* Results */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 16 }}>
        {props.map((p, i) => (
          <div className="card" key={`${p.id}-${i}`} style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ position: 'relative', height: 150, background: 'var(--panel-2)' }}>
              {p.photo && (
                <img
                  src={p.photo.replace('/square60/', '/max500/')}
                  alt=""
                  loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  // Booking serves several sizes; if the larger one 404s, fall back to the original.
                  onError={e => { (e.currentTarget as HTMLImageElement).src = p.photo as string; }}
                />
              )}
              {p.distanceKm != null && (
                <span style={{
                  position: 'absolute', left: 10, top: 10, background: 'rgba(13,13,20,0.82)', color: '#fff',
                  fontSize: 12, fontWeight: 700, padding: '3px 9px', borderRadius: 999,
                }}>
                  {p.distanceKm} km away
                </span>
              )}
              {p.score != null && (
                <span className={`badge ${scoreTone(p.score)}`} style={{ position: 'absolute', right: 10, top: 10 }}>
                  {p.score.toFixed(1)} {p.scoreWord ?? ''}
                </span>
              )}
            </div>

            <div style={{ padding: '13px 15px 15px', display: 'flex', flexDirection: 'column', flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5, lineHeight: 1.3 }}>{p.name}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                {p.city}{p.countryCode ? `, ${p.countryCode}` : ''}
                {p.stars ? ` · ${'★'.repeat(p.stars)}${p.starsEstimated ? '≈' : ''}` : ''}
                {p.reviews ? ` · ${p.reviews} reviews` : ''}
              </div>

              {p.roomLabel && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{p.roomLabel}</div>
              )}

              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '10px 0 0' }}>
                {p.freeParking && <span className="badge green">Free parking</span>}
                {p.freeCancellation && <span className="badge green">Free cancellation</span>}
                {p.breakfastIncluded && <span className="badge gray">Breakfast</span>}
                {p.noPrepayment && <span className="badge gray">No prepayment</span>}
                {lateArrivalRisk(p.checkinUntil) && (
                  <span className="badge amber">Check in by {p.checkinUntil}</span>
                )}
              </div>

              <div style={{ marginTop: 'auto', paddingTop: 12, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  {p.wasPerNight?.label && (
                    <span className="muted" style={{ fontSize: 12, textDecoration: 'line-through', marginRight: 6 }}>
                      {p.wasPerNight.label}
                    </span>
                  )}
                  <span style={{ fontWeight: 800, fontSize: 17 }}>{p.perNight?.label ?? '—'}</span>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    per night
                    {p.totalWithTaxes?.label && p.nights >= 1 && (
                      <> · {p.totalWithTaxes.label} total inc. tax</>
                    )}
                  </div>
                  {p.localPrice && p.localPrice.currency !== p.perNight?.currency && (
                    <div className="muted" style={{ fontSize: 11.5, marginTop: 1 }}>
                      charged as {p.localPrice.currency} {p.localPrice.value.toLocaleString()}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {p.lat != null && p.lon != null && (
                    <a className="btn-ghost" style={{ padding: '6px 9px', fontSize: 12 }}
                      href={`https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}`}
                      target="_blank" rel="noopener noreferrer">Map</a>
                  )}
                  {data?.search && (
                    <a className="btn" style={{ padding: '6px 11px', fontSize: 12 }}
                      href={bookingUrl(p, data.search.arrival, data.search.departure, data.search.adults, data.search.rooms)}
                      target="_blank" rel="noopener noreferrer">Book</a>
                  )}
                </div>
              </div>

              {p.urgency && (
                <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--amber)', fontWeight: 600 }}>{p.urgency}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {(data?.unplaced?.length ?? 0) > 0 && (
        <div className="card" style={{ marginTop: 20, padding: '14px 18px' }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            No recent position ({data!.unplaced.length})
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 5 }}>
            {data!.unplaced.map(d => d.name).join(' · ')}
          </div>
        </div>
      )}
    </div>
  );
}
