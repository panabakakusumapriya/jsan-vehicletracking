import { useEffect, useMemo, useRef, useState } from 'react';
import { latLng, type Marker as LeafletMarker, type LatLngBoundsExpression } from 'leaflet';
import { Circle, CircleMarker, MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { api } from '../lib/api';
import { MapAutoResize } from '../lib/MapAutoResize';
import { dt } from '../lib/format';
import { NearbyIcon, nearbyPlacePin, nearbyDriverPin } from '../lib/NearbyUI';

// Imported hotel locations around the selected driver, with a synced map and list.

interface HotelPlace {
  id: string | number | null;
  name: string;
  address: string | null;
  city: string | null;
  category: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  // Always null / 0 from the dataset — it carries no review or price data. Deliberately NOT
  // filled from `confidence`, which measures "are we sure this place exists", not "is it good".
  rating: number | null;
  ratingCount: number;
  perNight: { value: number; label: string | null; currency: string | null } | null;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
  // The dataset's own 0..1 certainty about the record. Shown only when it is low, so a doubtful
  // hit does not sit on screen looking exactly as solid as a certain one.
  confidence: number | null;
  isoCountry: string | null;
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
  /** Older than the fleet's "active" window — usable, but the manager should know. */
  stale?: boolean;
}

interface HotelResponse {
  // Now means "the dataset has been imported", not "an API key is set".
  configured: boolean;
  dataset: { total: number; source: string; metered: boolean };
  projects: string[];
  drivers: RosterDriver[];
  unplaced: { _id: string; name: string }[];
  selected: (RosterDriver & { stale?: boolean }) | null;
  search: { radiusKm: number; locationName?: string | null; category?: string | null; project?: string | null } | null;
  properties: HotelPlace[];
  totalFound: number;
  shown?: number;
  message?: string;
}

const RADII = [5, 10, 15, 25, 50, 100];

const ACCENT = '#0050a9';

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** A short, recognisable tag for the pin. The category is all this dataset gives us. */
function shortLabel(p: HotelPlace): string {
  const c = (p.category ?? '').toLowerCase();
  if (!c) return 'Stay';
  if (c.includes('bed and breakfast')) return 'B&B';
  if (c.includes('guest')) return 'Guest house';
  if (c.includes('hostel')) return 'Hostel';
  if (c.includes('motel')) return 'Motel';
  if (c.includes('resort')) return 'Resort';
  if (c.includes('hotel')) return 'Hotel';
  const first = c.split(' ')[0];
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// ── Map markers ──────────────────────────────────────────────────────────────

/** The driver being searched around: a violet pulse, same as Couriers/Weather. */
const driverPin = nearbyDriverPin;
const placePin = (label: string, active: boolean) => nearbyPlacePin('hotel', label, active);

/** Fit the map to the driver + every property whenever the result set changes. */
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
  const [radiusKm, setRadiusKm] = useState(15);

  const [runId, setRunId] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const markerRefs = useRef<Record<string, LeafletMarker | null>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ radiusKm: String(radiusKm) });
    if (driverId) q.set('driverId', driverId);

    api.get<HotelResponse>(`/api/hotels/near-driver?${q}`)
      .then(r => {
        if (cancelled) return;
        setData(r);
        setFocusId(null);
        setDriverId(r.selected ? String(r.selected._id) : '');
      })
      .catch(e => { if (cancelled) return; setData(null); setError(e instanceof Error ? e.message : 'Hotel search failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const search = () => setRunId(n => n + 1);

  const located = useMemo(() => (data?.drivers ?? []).filter(d => d.located), [data]);
  const selected = data?.selected ?? null;
  const properties = data?.properties ?? [];
  const mapped = useMemo(
    () => properties.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number'),
    [properties]
  );
  // Everyone else's last known position, so the map answers "where is the fleet" as well as
  // "what is near this one" — a muted dot, never competing with the driver being searched around.
  const otherDrivers = useMemo(
    () => located.filter(d => !selected || String(d._id) !== String(selected._id)),
    [located, selected]
  );

  const anchor = useMemo<[number, number] | null>(() =>
    selected && selected.lat != null && selected.lon != null ? [selected.lat, selected.lon] : null, [selected]);

  const bounds = useMemo<LatLngBoundsExpression | null>(() => {
    if (anchor && mapped.length === 0 && data?.search) {
      return latLng(anchor).toBounds(data.search.radiusKm * 2000);
    }
    const pts: [number, number][] = [];
    if (anchor) pts.push(anchor);
    for (const p of mapped) pts.push([p.lat as number, p.lon as number]);
    return pts.length ? pts : null;
  }, [anchor, mapped, data?.search]);

  const focusPlace = (id: string) => {
    setFocusId(id);
    const m = markerRefs.current[id];
    if (m) m.openPopup();
  };

  return (
    <div className="nearby-page nearby-page--hotel">

      <div className="page-head">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="nearby-logo"><NearbyIcon kind="hotel" size={27} /></span> Hotels
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Hotels, motels, hostels and guest houses near a driver&apos;s last reported position
          </p>
        </div>
        <div className="nearby-controls">
          <label className="nearby-field"><span><NearbyIcon kind="driver" size={13} /> Driver</span>
          <select className="input" style={{ width: 180, margin: 0 }} value={driverId} onChange={e => setDriverId(e.target.value)}>
            {located.length === 0 && <option value="">No drivers in last 48 hours</option>}
            {located.map(d => (
              <option key={d._id} value={d._id}>
                {d.name}{d.country ? ` · ${d.country}` : ''} — {ago(d.lastSeenAt)}
              </option>
            ))}
          </select>
          </label>
          <label className="nearby-field nearby-field--radius"><span><NearbyIcon kind="radius" size={13} /> Radius</span>
          <select className="input" style={{ width: 100, margin: 0 }} value={radiusKm} onChange={e => setRadiusKm(Number(e.target.value))}>
            {RADII.map(r => <option key={r} value={r}>{r} km</option>)}
          </select>
          </label>
          <button className="btn" onClick={search} disabled={loading}>
            <NearbyIcon kind="search" size={17} /> {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {/* Secondary status line */}
      <div className="nearby-status">
        {selected && data?.search && (
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            <strong>{selected.name}</strong>
            {selected.project ? ` · ${selected.project}` : ''} · {mapped.length} within {data.search.radiusKm} km
            {data.search.locationName ? ` of ${data.search.locationName}` : ''}
          </span>
        )}
        {selected?.stale && (
          <span
            className="badge amber"
            title="This is the last position we ever received from this driver. The hotels shown are near where they were then, not necessarily where they are now."
          >
            position {ago(selected.lastSeenAt)}
          </span>
        )}
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>
          {located.length} driver{located.length === 1 ? '' : 's'} with a position in the last 48 hours
          {(data?.unplaced?.length ?? 0) > 0 ? ` · ${data!.unplaced.length} never placed` : ''}
        </span>
        {data?.dataset && (
          <span
            className="muted"
            style={{ marginLeft: 'auto', fontSize: 12 }}
            title="Answered from the imported hotel dataset. No external service is called, so searching is unmetered and works offline. The dataset has no prices or availability."
          >
            {data.dataset.total.toLocaleString()} properties on file · local lookup
          </span>
        )}
      </div>

      {error && (
        <div className="card" style={{ padding: '18px 20px', marginBottom: 18, borderLeft: '3px solid var(--red)' }}>
          <strong>Hotel search unavailable.</strong>
          <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{error}</div>
        </div>
      )}

      {data?.message && !error && !anchor && (
        <div className="card" style={{ textAlign: 'center', padding: '50px 24px', color: 'var(--muted)' }}>
          <span className="nearby-empty-icon"><NearbyIcon kind="hotel" size={26} /></span>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>
            {anchor ? 'No accommodation found' : 'Nowhere to search yet'}
          </div>
          <div style={{ fontSize: 13 }}>{data.message}</div>
        </div>
      )}

      {loading && !data && (
        <div className="muted" style={{ padding: 40, textAlign: 'center' }}>Searching for places to stay…</div>
      )}

      {/* Map + synced list */}
      {anchor && !error && (
        <div className="nearby-results">
          <div className="map-wrap" style={{ position: 'relative', isolation: 'isolate', height: 'calc(100vh - 230px)', minHeight: 460 }}>
            <MapContainer center={anchor} zoom={12} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
              <TileLayer
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                attribution="&copy; OpenStreetMap contributors"
              />
              <MapAutoResize />
              <FitToData bounds={bounds} />

              {data?.search && (
                <Circle
                  center={anchor}
                  radius={data.search.radiusKm * 1000}
                  pathOptions={{ color: ACCENT, weight: 1, fillColor: ACCENT, fillOpacity: 0.05 }}
                />
              )}

              {/* The rest of the fleet, muted — context, not the subject. */}
              {otherDrivers.map(d => (
                <CircleMarker
                  key={`drv-${d._id}`}
                  center={[d.lat as number, d.lon as number]}
                  radius={5}
                  pathOptions={{ color: '#0050a9', weight: 1.5, fillColor: '#7db8e8', fillOpacity: 0.75 }}
                >
                  <Popup>
                    <b>{d.name}</b><br />
                    {d.project ? <>{d.project}<br /></> : null}
                    <span style={{ color: '#64748b' }}>Last reported {ago(d.lastSeenAt)}</span><br />
                    {dt(d.lastSeenAt)}
                  </Popup>
                </CircleMarker>
              ))}

              <Marker position={anchor} icon={driverPin()}>
                <Popup>
                  <b>{selected!.name}</b><br />
                  <span style={{ color: '#64748b' }}>Last reported position</span><br />
                  {dt(selected!.lastSeenAt)}
                </Popup>
              </Marker>

              {mapped.map((p, i) => {
                const id = `${p.id}-${i}`;
                return (
                  <Marker
                    key={id}
                    position={[p.lat as number, p.lon as number]}
                    icon={placePin(shortLabel(p), focusId === id)}
                    ref={(m) => { markerRefs.current[id] = m; }}
                    eventHandlers={{ click: () => setFocusId(id) }}
                  >
                    <Popup>
                      <div style={{ width: 180 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{p.name}</div>
                        <div style={{ color: '#64748b', fontSize: 11.5, marginTop: 2 }}>
                          {p.address}
                          {p.distanceKm != null ? ` · ${p.distanceKm} km away` : ''}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                          {p.category && <span className="badge gray">{p.category}</span>}
                          {/* Only when the dataset itself is unsure. A confidence badge on every
                              row would be noise; on the doubtful ones it is a warning. */}
                          {p.confidence != null && p.confidence < 0.7 && (
                            <span
                              className="badge amber"
                              title={`The source dataset is only ${Math.round(p.confidence * 100)}% confident this property is what it claims to be. Worth ringing ahead.`}
                            >
                              unverified
                            </span>
                          )}
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {p.phone && <span style={{ fontSize: 12 }}>Phone: {p.phone}</span>}
                          {p.email && <span style={{ fontSize: 12 }}>Email: {p.email}</span>}
                          {p.website && (
                            <a href={p.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                              Website →
                            </a>
                          )}
                        </div>
                        <a
                          className="btn hotel-book-now"
                          href={`https://www.booking.com/searchresults.en-gb.html?${new URLSearchParams({
                            ss: p.name.trim(),
                            ssne: p.name.trim(),
                            ssne_untouched: p.name.trim(),
                            lang: 'en-gb',
                            sb: '1',
                            src: 'index',
                            src_elem: 'sb',
                            group_adults: '1',
                            no_rooms: '1',
                            group_children: '0',
                          })}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Book now: search for ${p.name} on Booking.com (opens in a new tab)`}
                        >
                          Book now <span aria-hidden="true">&#8599;</span>
                        </a>

                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
            {!loading && mapped.length === 0 && data?.search && (
              <div role="status" aria-live="polite" className="nearby-map-empty">
                <span className="nearby-empty-icon"><NearbyIcon kind="hotel" size={25} /></span>
                <strong>No hotels found within {data.search.radiusKm} km.</strong>
                <div style={{ marginTop: 4, fontSize: 13 }}>Please increase the distance and search again.</div>
              </div>
            )}
          </div>

          {/* Synced list — a scannable index into the map, not the main view. */}
          <div className="card nearby-list" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 230px)', minHeight: 460 }}>
            <div className="nearby-list-head"><NearbyIcon kind="hotel" /> Nearby hotels <small>{mapped.length} found</small></div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {mapped.map((p, i) => {
                const id = `${p.id}-${i}`;
                const active = focusId === id;
                return (
                  <button
                    key={id}
                    className="nearby-result"
                    aria-pressed={active}
                    onClick={() => focusPlace(id)}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 3, width: '100%', textAlign: 'left', cursor: 'pointer',
                      padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--line)',
                      background: active ? 'var(--brand-light)' : 'transparent', fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ background: '#e8f4fc', color: ACCENT, border: '1px solid #b6d8f4', borderRadius: 6, padding: '1px 6px', fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>
                        {shortLabel(p)}
                      </span>
                      <div style={{ fontWeight: 700, fontSize: 12.5, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {p.name}
                      </div>
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.address ?? '—'}
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 11 }}>
                      {p.distanceKm != null ? `${p.distanceKm} km` : ''}
                      {p.phone ? ` · ${p.phone}` : ''}
                    </div>
                  </button>
                );
              })}
              {mapped.length === 0 && (
                <div className="muted" style={{ padding: '30px 16px', textAlign: 'center', fontSize: 13 }}>
                  <span className="nearby-empty-icon"><NearbyIcon kind="hotel" size={26} /></span>
                  Nothing found within {data?.search?.radiusKm} km. Try a wider radius.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {(data?.unplaced?.length ?? 0) > 0 && (
        <details className="card" style={{ marginTop: 14, padding: '12px 16px' }}>
          <summary style={{ fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Never reported a position ({data!.unplaced.length})</summary>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 5 }}>
            {data!.unplaced.map(d => d.name).join(' · ')}
          </div>
        </details>
      )}
    </div>
  );
}
