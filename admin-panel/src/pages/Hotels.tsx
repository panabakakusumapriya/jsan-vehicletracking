import { useEffect, useMemo, useRef, useState } from 'react';
import { divIcon, type Marker as LeafletMarker, type LatLngBoundsExpression } from 'leaflet';
import { Circle, MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { api } from '../lib/api';
import { MapAutoResize } from '../lib/MapAutoResize';
import { dt } from '../lib/format';

/**
 * Hotels near a driver — as a MAP, not a list.
 *
 * The question a manager actually has is spatial: "where is my driver, and which beds are
 * closest to them right now?" A stack of price cards answers the wrong question. So the driver's
 * own last reported position (the end of their most recent trip — the same feed the live map
 * uses) is the anchor, the search radius is drawn around it, and every hotel is a pin placed at
 * its real coordinates. The list on the right is a synced index into the map, not the main view.
 *
 * One driver is searched at a time on purpose: this provider bills per call, so a fan-out across
 * the fleet on every page load would be expensive and mostly unread.
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
const CURRENCY_SYMBOL: Record<string, string> = {
  INR: '₹', AUD: '$', USD: '$', SGD: '$', GBP: '£', EUR: '€', AED: 'AED ',
};

/** A pin label has to be tiny, so "Rs. 41,318" becomes "₹41k". Full price lives in the popup. */
function shortPrice(m: Money | null): string {
  if (!m || typeof m.value !== 'number') return '—';
  const sym = CURRENCY_SYMBOL[m.currency ?? ''] ?? `${m.currency ?? ''} `;
  const v = m.value;
  if (v >= 1000) return `${sym}${Math.round(v / 1000)}k`;
  return `${sym}${Math.round(v)}`;
}

/** Booking.com has no stable per-property URL in this payload, so this opens a scoped search. */
function bookingUrl(p: Property, arrival: string, departure: string, adults: number, rooms: number) {
  const q = new URLSearchParams({
    ss: p.name, checkin: arrival, checkout: departure,
    group_adults: String(adults), no_rooms: String(rooms),
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

// ── Map markers ──────────────────────────────────────────────────────────────

/** The driver: a violet pulse, deliberately unlike a hotel so "where they are" reads instantly. */
function driverPin() {
  return divIcon({
    className: 'hotel-driver-pin',
    html: `<div style="position:relative;width:26px;height:26px;">
      <span style="position:absolute;inset:0;border-radius:50%;background:rgba(124,58,237,0.28);animation:hotelpulse 2s ease-out infinite;"></span>
      <span style="position:absolute;inset:6px;border-radius:50%;background:#7c3aed;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></span>
    </div>`,
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13],
  });
}

/**
 * A hotel: a price tag. Green when it has free parking (what a driver in a van actually needs),
 * violet otherwise; the focused one is filled and lifted so the map and list stay in step.
 */
function hotelPin(label: string, freeParking: boolean, active: boolean) {
  const base = freeParking ? '#059669' : '#7c3aed';
  const bg = active ? base : '#ffffff';
  const fg = active ? '#ffffff' : base;
  const scale = active ? 1.12 : 1;
  return divIcon({
    className: 'hotel-price-pin',
    html: `<div style="transform:scale(${scale});transform-origin:bottom center;">
      <div style="background:${bg};color:${fg};border:1.5px solid ${base};border-radius:999px;
        padding:2px 8px;font:700 11.5px/1.3 Inter,sans-serif;white-space:nowrap;
        box-shadow:0 2px 6px rgba(0,0,0,${active ? 0.35 : 0.2});">${label}</div>
    </div>`,
    iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -10],
  });
}

/** Fit the map to the driver + every hotel whenever the result set changes. */
function FitToData({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14, animate: true });
  }, [bounds, map]);
  return null;
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
  const [focusId, setFocusId] = useState<string | null>(null);
  const markerRefs = useRef<Record<string, LeafletMarker | null>>({});

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
        setFocusId(null);
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
  const mapped = useMemo(
    () => props.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number'),
    [props]
  );

  const anchor: [number, number] | null =
    selected && selected.lat != null && selected.lon != null ? [selected.lat, selected.lon] : null;

  // Frame the driver plus every placeable hotel. Null until we have one, so the map waits.
  const bounds = useMemo<LatLngBoundsExpression | null>(() => {
    const pts: [number, number][] = [];
    if (anchor) pts.push(anchor);
    for (const p of mapped) pts.push([p.lat as number, p.lon as number]);
    return pts.length ? pts : null;
  }, [anchor, mapped]);

  const focusHotel = (id: string) => {
    setFocusId(id);
    const m = markerRefs.current[id];
    if (m) m.openPopup();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <BedIcon /> Hotels
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Rooms around a driver&apos;s last reported position — shown where they actually are
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
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14, fontSize: 13 }}>
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
        {selected && data?.search && (
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            <strong>{selected.name}</strong> · {mapped.length} within {data.search.radiusKm} km of {data.totalFound} ·{' '}
            {data.search.nights} night{data.search.nights === 1 ? '' : 's'} ({data.search.arrival} → {data.search.departure})
          </span>
        )}
        {data?.budget && (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            {data.budget.remaining} of {data.budget.cap} searches left today
            {data.fromCache ? ' · from cache' : ''}
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

      {loading && !data && (
        <div className="muted" style={{ padding: 40, textAlign: 'center' }}>Searching for rooms…</div>
      )}

      {/* Map + synced list */}
      {anchor && !error && !data?.message && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 14, alignItems: 'stretch' }}>
          <div className="map-wrap" style={{ height: 'calc(100vh - 250px)', minHeight: 460 }}>
            <MapContainer center={anchor} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
              />
              <MapAutoResize />
              <FitToData bounds={bounds} />

              {/* Search radius around the driver — the night-stop zone. */}
              {data?.search && (
                <Circle
                  center={anchor}
                  radius={data.search.radiusKm * 1000}
                  pathOptions={{ color: '#7c3aed', weight: 1, fillColor: '#7c3aed', fillOpacity: 0.05 }}
                />
              )}

              {/* The driver. */}
              <Marker position={anchor} icon={driverPin()}>
                <Popup>
                  <b>{selected!.name}</b><br />
                  <span style={{ color: '#64748b' }}>Last reported position</span><br />
                  {dt(selected!.lastSeenAt)}
                </Popup>
              </Marker>

              {/* The hotels. */}
              {mapped.map((p, i) => {
                const id = `${p.id}-${i}`;
                return (
                  <Marker
                    key={id}
                    position={[p.lat as number, p.lon as number]}
                    icon={hotelPin(shortPrice(p.perNight), p.freeParking, focusId === id)}
                    ref={(m) => { markerRefs.current[id] = m; }}
                    eventHandlers={{ click: () => setFocusId(id) }}
                  >
                    <Popup>
                      <div style={{ width: 210 }}>
                        {p.photo && (
                          <img src={p.photo.replace('/square60/', '/max300/')} alt="" loading="lazy"
                            style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 6, marginBottom: 6 }} />
                        )}
                        <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{p.name}</div>
                        <div style={{ color: '#64748b', fontSize: 11.5, marginTop: 2 }}>
                          {p.city}{p.countryCode ? `, ${p.countryCode}` : ''}
                          {p.distanceKm != null ? ` · ${p.distanceKm} km away` : ''}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                          {p.score != null && <span className={`badge ${scoreTone(p.score)}`}>{p.score.toFixed(1)}</span>}
                          {p.freeParking && <span className="badge green">Free parking</span>}
                          {lateArrivalRisk(p.checkinUntil) && <span className="badge amber">Check in by {p.checkinUntil}</span>}
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                          <div>
                            <span style={{ fontWeight: 800, fontSize: 15 }}>{p.perNight?.label ?? '—'}</span>
                            <span style={{ color: '#64748b', fontSize: 11 }}> / night</span>
                            {p.localPrice && p.localPrice.currency !== p.perNight?.currency && (
                              <div style={{ color: '#64748b', fontSize: 11 }}>
                                charged as {p.localPrice.currency} {p.localPrice.value.toLocaleString()}
                              </div>
                            )}
                          </div>
                          {data?.search && (
                            <a className="btn" style={{ padding: '5px 11px', fontSize: 12 }}
                              href={bookingUrl(p, data.search.arrival, data.search.departure, data.search.adults, data.search.rooms)}
                              target="_blank" rel="noopener noreferrer">Book</a>
                          )}
                        </div>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          </div>

          {/* Synced list — a scannable index into the map, not the main view. */}
          <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 250px)', minHeight: 460 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>
              {mapped.length} hotel{mapped.length === 1 ? '' : 's'} on map
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {mapped.map((p, i) => {
                const id = `${p.id}-${i}`;
                const active = focusId === id;
                return (
                  <button
                    key={id}
                    onClick={() => focusHotel(id)}
                    style={{
                      display: 'flex', gap: 10, width: '100%', textAlign: 'left', cursor: 'pointer',
                      padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--line)',
                      background: active ? 'var(--brand-light)' : 'transparent', fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ width: 54, height: 54, flexShrink: 0, borderRadius: 8, overflow: 'hidden', background: 'var(--panel-2)' }}>
                      {p.photo && (
                        <img src={p.photo} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      )}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {p.name}
                      </div>
                      <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>
                        {p.distanceKm != null ? `${p.distanceKm} km` : ''}
                        {p.score != null ? ` · ★ ${p.score.toFixed(1)}` : ''}
                        {p.freeParking ? ' · P' : ''}
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 13, marginTop: 3 }}>
                        {p.perNight?.label ?? '—'}
                        <span style={{ color: 'var(--muted)', fontWeight: 500, fontSize: 10.5 }}> /night</span>
                      </div>
                    </div>
                  </button>
                );
              })}
              {mapped.length === 0 && (
                <div className="muted" style={{ padding: '30px 16px', textAlign: 'center', fontSize: 13 }}>
                  Nothing bookable within {data?.search?.radiusKm} km.
                  {parkingOnly ? ' Try turning off the free-parking filter.' : ' Try a wider radius.'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {(data?.unplaced?.length ?? 0) > 0 && (
        <div className="card" style={{ marginTop: 14, padding: '12px 16px' }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>No recent position ({data!.unplaced.length})</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 5 }}>
            {data!.unplaced.map(d => d.name).join(' · ')}
          </div>
        </div>
      )}
    </div>
  );
}
