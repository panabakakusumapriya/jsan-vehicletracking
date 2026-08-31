import { useEffect, useMemo, useRef, useState } from 'react';
import { divIcon, type Marker as LeafletMarker, type LatLngBoundsExpression } from 'leaflet';
import { Circle, MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { api } from '../lib/api';
import { MapAutoResize } from '../lib/MapAutoResize';
import { dt } from '../lib/format';

/**
 * Courier drop-off points near a driver — modeled directly on the Hotels tab: a map first,
 * a synced list second, one driver searched at a time.
 *
 * Answered from our own imported dataset (68k drop-off points, 167 countries) rather than a
 * metered Places API — see the backend's services/courierLocations.js. Searching is now free and
 * offline, so the page no longer has to ration it: the budget readout, the "from cache" note and
 * the missing-API-key branch have all gone, because none of them describe anything real any more.
 * The one-driver-at-a-time shape is kept, since a fleet-wide fan-out still says nothing useful.
 */

interface CourierPlace {
  id: string | number | null;
  name: string;
  address: string | null;
  category: string | null;
  phone: string | null;
  website: string | null;
  // Always null / 0 from the dataset — it carries no review data. Deliberately NOT filled from
  // the dataset's `confidence`, which measures "are we sure this place exists", not "is it good".
  rating: number | null;
  ratingCount: number;
  lat: number | null;
  lon: number | null;
  distanceKm: number | null;
  // --- richer than the old provider gave us ---
  brand: string | null;
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
}

interface CourierResponse {
  // Now means "the dataset has been imported", not "an API key is set".
  configured: boolean;
  dataset: { total: number; source: string; metered: boolean };
  drivers: RosterDriver[];
  unplaced: { _id: string; name: string }[];
  selected: RosterDriver | null;
  search: { radiusKm: number; locationName?: string | null } | null;
  places: CourierPlace[];
  totalFound: number;
  shown?: number;
  message?: string;
}

const PackageIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/>
    <path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>
  </svg>
);
const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
  </svg>
);

const RADII = [5, 10, 15, 25, 50, 100];

/**
 * Known carriers get a recognizable short tag; anything else falls back to its category.
 *
 * The dataset carries a real `brand` on the chains (The UPS Store, FedEx Ship Center, DHL
 * Express...), so that is used first — it beats guessing from the name, which is how a
 * "DHL Express Service Point" filed under a business-services category used to end up tagged
 * with the category instead of the carrier everyone recognises.
 */
function shortLabel(p: CourierPlace): string {
  if (p.brand) {
    const b = p.brand.toLowerCase();
    if (b.includes('fedex')) return 'FedEx';
    if (b.includes('dhl')) return 'DHL';
    if (b.includes('ups')) return 'UPS';
    return p.brand;
  }
  const t = `${p.name} ${p.category ?? ''}`.toLowerCase();
  if (t.includes('fedex')) return 'FedEx';
  if (t.includes('dhl')) return 'DHL';
  if (t.includes('ups ')) return 'UPS';
  if (t.includes('post office') || t.includes('postal')) return 'Post';
  if (p.category) return p.category.replace(/ service$/i, '');
  return 'Courier';
}

function scoreTone(score: number | null) {
  if (score == null) return 'gray';
  if (score >= 4) return 'green';
  if (score >= 3) return 'amber';
  return 'gray';
}

// ── Map markers ──────────────────────────────────────────────────────────────

/** The driver: a violet pulse, same as Hotels/Weather, so "where they are" reads instantly. */
function driverPin() {
  return divIcon({
    className: 'courier-driver-pin',
    html: `<div style="position:relative;width:26px;height:26px;">
      <span style="position:absolute;inset:0;border-radius:50%;background:rgba(124,58,237,0.28);animation:hotelpulse 2s ease-out infinite;"></span>
      <span style="position:absolute;inset:6px;border-radius:50%;background:#7c3aed;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></span>
    </div>`,
    iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -13],
  });
}

function placePin(label: string, active: boolean) {
  const base = '#0891b2';
  const bg = active ? base : '#ffffff';
  const fg = active ? '#ffffff' : base;
  const scale = active ? 1.12 : 1;
  return divIcon({
    className: 'courier-place-pin',
    html: `<div style="transform:scale(${scale});transform-origin:bottom center;">
      <div style="background:${bg};color:${fg};border:1.5px solid ${base};border-radius:999px;
        padding:2px 8px;font:700 11.5px/1.3 Inter,sans-serif;white-space:nowrap;
        box-shadow:0 2px 6px rgba(0,0,0,${active ? 0.35 : 0.2});">📦 ${label}</div>
    </div>`,
    iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -10],
  });
}

/** Fit the map to the driver + every place whenever the result set changes. */
function FitToData({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14, animate: true });
  }, [bounds, map]);
  return null;
}

export function Couriers() {
  const [data, setData] = useState<CourierResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [driverId, setDriverId] = useState('');
  const [radiusKm, setRadiusKm] = useState(15);

  // A search is a paid call, so it runs when the manager asks for one — not on every keystroke.
  const [runId, setRunId] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const markerRefs = useRef<Record<string, LeafletMarker | null>>({});

  useEffect(() => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ radiusKm: String(radiusKm) });
    if (driverId) q.set('driverId', driverId);

    api.get<CourierResponse>(`/api/couriers/near-driver?${q}`)
      .then(r => {
        setData(r);
        setFocusId(null);
        if (r.selected && !driverId) setDriverId(String(r.selected._id));
      })
      .catch(e => { setData(null); setError(e instanceof Error ? e.message : 'Courier search failed'); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const search = () => setRunId(n => n + 1);

  const located = useMemo(() => (data?.drivers ?? []).filter(d => d.located), [data]);
  const selected = data?.selected ?? null;
  const places = data?.places ?? [];
  const mapped = useMemo(
    () => places.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number'),
    [places]
  );

  const anchor: [number, number] | null =
    selected && selected.lat != null && selected.lon != null ? [selected.lat, selected.lon] : null;

  const bounds = useMemo<LatLngBoundsExpression | null>(() => {
    const pts: [number, number][] = [];
    if (anchor) pts.push(anchor);
    for (const p of mapped) pts.push([p.lat as number, p.lon as number]);
    return pts.length ? pts : null;
  }, [anchor, mapped]);

  const focusPlace = (id: string) => {
    setFocusId(id);
    const m = markerRefs.current[id];
    if (m) m.openPopup();
  };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <PackageIcon /> Couriers
          </h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            FedEx / DHL / UPS and other drop-off points near a driver&apos;s last reported position
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
          <select className="input" style={{ width: 100, margin: 0 }} value={radiusKm} onChange={e => setRadiusKm(Number(e.target.value))}>
            {RADII.map(r => <option key={r} value={r}>{r} km</option>)}
          </select>
          <button className="btn" onClick={search} disabled={loading}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {/* Secondary status line */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14, fontSize: 13 }}>
        {selected && data?.search && (
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            <strong>{selected.name}</strong> · {mapped.length} within {data.search.radiusKm} km
            {data.search.locationName ? ` of ${data.search.locationName}` : ''}
          </span>
        )}
        {data?.dataset && (
          <span
            className="muted"
            style={{ marginLeft: 'auto', fontSize: 12 }}
            title="Answered from the imported courier dataset. No external service is called, so searching is unmetered and works offline."
          >
            {data.dataset.total.toLocaleString()} drop-off points on file · local lookup
          </span>
        )}
      </div>

      {error && (
        <div className="card" style={{ padding: '18px 20px', marginBottom: 18, borderLeft: '3px solid var(--red)' }}>
          <strong>Courier search unavailable.</strong>
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
        <div className="muted" style={{ padding: 40, textAlign: 'center' }}>Searching for courier locations…</div>
      )}

      {/* Map + synced list */}
      {anchor && !error && !data?.message && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 14, alignItems: 'stretch' }}>
          <div className="map-wrap" style={{ height: 'calc(100vh - 230px)', minHeight: 460 }}>
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
                  pathOptions={{ color: '#0891b2', weight: 1, fillColor: '#0891b2', fillOpacity: 0.05 }}
                />
              )}

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
                      <div style={{ width: 210 }}>
                        <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.3 }}>{p.name}</div>
                        <div style={{ color: '#64748b', fontSize: 11.5, marginTop: 2 }}>
                          {p.address}
                          {p.distanceKm != null ? ` · ${p.distanceKm} km away` : ''}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                          {p.rating != null && <span className={`badge ${scoreTone(p.rating)}`}>★ {p.rating.toFixed(1)} ({p.ratingCount})</span>}
                          {p.category && <span className="badge gray">{p.category}</span>}
                          {/* Only when the dataset itself is unsure. A confidence badge on every
                              row would be noise; on the doubtful ones it is a warning. */}
                          {p.confidence != null && p.confidence < 0.7 && (
                            <span
                              className="badge amber"
                              title={`The source dataset is only ${Math.round(p.confidence * 100)}% confident this location is what it claims to be. Worth ringing ahead.`}
                            >
                              unverified
                            </span>
                          )}
                        </div>
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {p.phone && <span style={{ fontSize: 12 }}>📞 {p.phone}</span>}
                          {p.website && (
                            <a href={p.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12 }}>
                              Website →
                            </a>
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
          <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 'calc(100vh - 230px)', minHeight: 460 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', fontSize: 12.5, fontWeight: 700, color: 'var(--text-2)' }}>
              {mapped.length} location{mapped.length === 1 ? '' : 's'} on map
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {mapped.map((p, i) => {
                const id = `${p.id}-${i}`;
                const active = focusId === id;
                return (
                  <button
                    key={id}
                    onClick={() => focusPlace(id)}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 3, width: '100%', textAlign: 'left', cursor: 'pointer',
                      padding: '10px 12px', border: 'none', borderBottom: '1px solid var(--line)',
                      background: active ? 'var(--brand-light)' : 'transparent', fontFamily: 'inherit',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ background: '#ecfeff', color: '#0891b2', border: '1px solid #a5f3fc', borderRadius: 6, padding: '1px 6px', fontSize: 10.5, fontWeight: 700, flexShrink: 0 }}>
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
                      {p.rating != null ? ` · ★ ${p.rating.toFixed(1)}` : ''}
                    </div>
                  </button>
                );
              })}
              {mapped.length === 0 && (
                <div className="muted" style={{ padding: '30px 16px', textAlign: 'center', fontSize: 13 }}>
                  Nothing found within {data?.search?.radiusKm} km. Try a wider radius.
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
