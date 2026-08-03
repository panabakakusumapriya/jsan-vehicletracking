import { useEffect, useMemo, useState } from 'react';
import { divIcon } from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { api } from '../lib/api';
import { MapAutoResize } from '../lib/MapAutoResize';
import type { DrivingRisk, DrivingWeather, ParkedDriver, WeatherGroup, WeatherSlot } from '../lib/types';

/* ── Risk styling ── */
const RISK_LABEL: Record<DrivingRisk, string> = {
  clear: 'Good to drive',
  caution: 'Drive with caution',
  unsafe: 'Do not drive',
};
const RISK_BADGE: Record<DrivingRisk, string> = { clear: 'green', caution: 'amber', unsafe: 'red' };
const RISK_DOT: Record<DrivingRisk, string> = { clear: '🟢', caution: '🟠', unsafe: '🔴' };
const RISK_COLOR: Record<DrivingRisk, string> = {
  clear: 'var(--green)', caution: 'var(--amber)', unsafe: 'var(--red)',
};

const ICONS: Record<string, string> = {
  'sun-d': '☀️', 'sun-n': '🌙', 'partly-d': '⛅', 'partly-n': '☁️',
  cloud: '☁️', fog: '🌫️', drizzle: '🌦️', rain: '🌧️',
  showers: '🌦️', snow: '🌨️', storm: '⛈️',
};
const glyphFor = (icon: string | null) => (icon && ICONS[icon]) || '·';

const DAYS = [
  { offset: 0, label: 'Today' },
  { offset: 1, label: 'Tomorrow' },
  { offset: 2, label: '+2 days' },
  { offset: 3, label: '+3 days' },
  { offset: 4, label: '+4 days' },
];

/* ── Map marker icon ── */
function parkedCarIcon(risk: DrivingRisk | null, selected: boolean) {
  const fill = risk === 'unsafe' ? '#dc2626' : risk === 'caution' ? '#f97316' : '#059669';
  const stroke = selected ? '#7c3aed' : '#ffffff';
  const strokeW = selected ? 2.4 : 1.6;
  const size = selected ? 36 : 30;
  const svg = `
    <svg viewBox="0 0 32 32" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="3" width="14" height="26" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"/>
      <path d="M11.5 9 Q16 6.3 20.5 9 L19.6 12.6 Q16 11 12.4 12.6 Z" fill="rgba(255,255,255,0.7)"/>
      <path d="M12.4 23.6 Q16 22.2 19.6 23.6 L20.5 20.4 Q16 21.9 11.5 20.4 Z" fill="rgba(255,255,255,0.4)"/>
      <text x="16" y="19" text-anchor="middle" font-size="9" font-weight="bold" fill="white" font-family="sans-serif">P</text>
    </svg>`;
  return divIcon({
    className: 'car-marker',
    html: `<div style="width:${size}px; height:${size}px; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.3));">${svg}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2],
  });
}

/* ── Map helpers ── */
function FitBounds({ coords }: { coords: [number, number][] }) {
  const map = useMap();
  useEffect(() => {
    if (coords.length === 0) return;
    if (coords.length === 1) map.setView(coords[0], 12);
    else map.fitBounds(coords, { padding: [40, 40], maxZoom: 14 });
  }, [coords, map]);
  return null;
}

function FlyToDriver({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, 15, { duration: 1 });
  }, [target, map]);
  return null;
}

/* ── Slot (compact for popup) ── */
function SlotMini({ slot }: { slot: WeatherSlot }) {
  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
      minWidth: 44, padding: '3px 2px', borderRadius: 6, fontSize: 10,
      background: slot.risk === 'clear' ? '#f0fdf4' : slot.risk === 'caution' ? '#fff7ed' : '#fef2f2',
    }}>
      <div style={{ fontWeight: 600, color: '#888' }}>{slot.at}</div>
      <div style={{ fontSize: 14 }}>{glyphFor(slot.icon)}</div>
      <div style={{ fontWeight: 800 }}>{slot.tempC != null ? `${slot.tempC}°` : '—'}</div>
      {slot.windKmh != null && <div style={{ color: '#999' }}>{slot.windKmh}km/h</div>}
    </div>
  );
}

/* ── Slot (card version) ── */
function Slot({ slot }: { slot: WeatherSlot }) {
  return (
    <div
      title={`${slot.at} · ${slot.description}${slot.reasons.length ? ` — ${slot.reasons.join(', ')}` : ''}`}
      style={{
        flex: '1 1 0', minWidth: 58, textAlign: 'center',
        padding: '6px 3px 5px', borderRadius: 8,
        background: slot.risk === 'clear' ? 'var(--panel-2)' : slot.risk === 'caution' ? 'var(--amber-bg)' : 'var(--red-bg)',
        border: `1px solid ${slot.risk === 'clear' ? 'var(--line)' : RISK_COLOR[slot.risk]}33`,
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>{slot.at}</div>
      <div style={{ fontSize: 18, lineHeight: 1.3 }}>{glyphFor(slot.icon)}</div>
      <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)' }}>
        {slot.tempC != null ? `${slot.tempC}°` : '—'}
      </div>
      <div style={{ fontSize: 9, color: 'var(--muted)', lineHeight: 1.3 }}>
        {slot.windKmh != null && <div>{slot.gustKmh && slot.gustKmh > slot.windKmh ? `${slot.gustKmh}g` : slot.windKmh} km/h</div>}
        {slot.popPct > 0 && <div>{slot.popPct}%</div>}
      </div>
    </div>
  );
}

/* ── Location weather card ── */
function LocationCard({ group, selected, onSelect }: { group: WeatherGroup; selected: boolean; onSelect: () => void }) {
  const verdict = group.verdict ?? 'clear';
  return (
    <div
      className="card"
      onClick={onSelect}
      style={{
        padding: 0, overflow: 'hidden',
        borderLeft: `4px solid ${RISK_COLOR[verdict]}`,
        cursor: 'pointer',
        outline: selected ? `2px solid var(--brand)` : undefined,
        outlineOffset: -1,
      }}
    >
      <div style={{ padding: '12px 16px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)' }}>
                {RISK_DOT[verdict]} {group.place || `${group.lat.toFixed(2)}, ${group.lon.toFixed(2)}`}
                {group.country ? `, ${group.country}` : ''}
              </span>
              <span className={`badge ${RISK_BADGE[verdict]}`} style={{ fontSize: 10 }}>{RISK_LABEL[verdict]}</span>
              {group.stale && <span className="badge gray" style={{ fontSize: 10 }}>stale</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>{group.headline}</div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
            <div>local {group.localTimeNow}</div>
            <div>{group.drivers.length} driver{group.drivers.length === 1 ? '' : 's'}</div>
          </div>
        </div>

        {group.slots.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 10, overflowX: 'auto' }}>
            {group.slots.map(s => <Slot key={s.dt} slot={s} />)}
          </div>
        )}
      </div>

      <div style={{
        padding: '7px 16px', background: 'var(--panel-2)', borderTop: '1px solid var(--line)',
        display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center',
      }}>
        {group.drivers.map(d => (
          <span key={d._id} style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
            background: 'var(--panel)', border: '1px solid var(--line-2)',
            borderRadius: 999, padding: '1px 8px',
          }}>
            {d.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Unified driver info ── */
interface DriverInfo {
  driverId: string;
  name: string;
  project: string | null;
  country: string | null;
  lat: number;
  lon: number;
  risk: DrivingRisk | null;
  groupKey: string | null;
  endedAt: string | null;
  slots: WeatherSlot[];
  headline: string;
  place: string;
}

/* ── Main component ── */
export function Weather() {
  const [day, setDay] = useState(0);
  const [data, setData] = useState<DrivingWeather | null>(null);
  const [parked, setParked] = useState<ParkedDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedDriver, setSelectedDriver] = useState('');
  const [flyTarget, setFlyTarget] = useState<[number, number] | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.get<DrivingWeather>(`/api/weather/driving?day=${day}`),
      api.get<{ parked: ParkedDriver[] }>('/api/tracking/parked'),
    ])
      .then(([weather, parkedRes]) => {
        if (!alive) return;
        setData(weather);
        setParked(parkedRes.parked ?? []);
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Could not load forecast'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [day, reloadKey]);

  // Build unified driver list from weather groups + parked + unplaced
  const allDrivers: DriverInfo[] = useMemo(() => {
    const rows: DriverInfo[] = [];
    const seen = new Set<string>();
    if (data?.groups) {
      for (const g of data.groups) {
        for (const d of g.drivers) {
          if (seen.has(d._id)) continue;
          seen.add(d._id);
          rows.push({
            driverId: d._id, name: d.name,
            project: d.project ?? null, country: d.country ?? null,
            lat: g.lat, lon: g.lon,
            risk: g.verdict, groupKey: g.key,
            endedAt: null, slots: g.slots, headline: g.headline,
            place: g.place || `${g.lat.toFixed(2)}, ${g.lon.toFixed(2)}`,
          });
        }
      }
    }
    for (const p of parked) {
      if (!p.location || seen.has(p.driver._id)) continue;
      seen.add(p.driver._id);
      rows.push({
        driverId: p.driver._id, name: p.driver.name,
        project: p.driver.project ?? null, country: p.driver.country ?? null,
        lat: p.location.lat, lon: p.location.lon,
        risk: null, groupKey: null,
        endedAt: p.endedAt ?? null, slots: [], headline: 'No weather data',
        place: 'Last parked',
      });
    }
    if (data?.unplaced) {
      for (const u of data.unplaced) {
        if (seen.has(u._id)) continue;
        seen.add(u._id);
        rows.push({
          driverId: u._id, name: u.name,
          project: u.project ?? null, country: u.country ?? null,
          lat: 0, lon: 0,
          risk: null, groupKey: null, endedAt: null,
          slots: [], headline: 'No recent location', place: '—',
        });
      }
    }
    return rows;
  }, [data, parked]);

  // All unique projects
  const projects = useMemo(() =>
    Array.from(new Set(allDrivers.map(r => r.project).filter(Boolean))).sort() as string[],
    [allDrivers]);

  // Countries: only from the selected project (cascading), or all if no project selected
  const countries = useMemo(() => {
    const source = projectFilter
      ? allDrivers.filter(r => r.project === projectFilter)
      : allDrivers;
    return Array.from(new Set(source.map(r => r.country).filter(Boolean))).sort() as string[];
  }, [allDrivers, projectFilter]);

  // Reset country if it's no longer valid for the selected project
  useEffect(() => {
    if (countryFilter && !countries.includes(countryFilter)) {
      setCountryFilter('');
    }
  }, [countries, countryFilter]);

  // Filter drivers by project + country
  const filteredDrivers = useMemo(() => {
    return allDrivers.filter(r => {
      if (projectFilter && r.project !== projectFilter) return false;
      if (countryFilter && r.country !== countryFilter) return false;
      return true;
    });
  }, [allDrivers, projectFilter, countryFilter]);

  const filteredDriverIds = useMemo(() => new Set(filteredDrivers.map(r => r.driverId)), [filteredDrivers]);

  // Map markers (filtered drivers with location)
  const mapMarkers = useMemo(() =>
    filteredDrivers.filter(r => r.lat !== 0 || r.lon !== 0),
    [filteredDrivers]);

  // Driver dropdown options (only filtered drivers)
  const driverOptions = useMemo(() => {
    const list = filteredDrivers.map(r => ({ id: r.driverId, name: r.name }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [filteredDrivers]);

  // Handle driver selection
  const handleDriverSelect = (dId: string) => {
    setSelectedDriver(dId);
    if (!dId) { setFlyTarget(null); return; }
    const d = filteredDrivers.find(r => r.driverId === dId);
    if (d && (d.lat !== 0 || d.lon !== 0)) {
      setFlyTarget([d.lat, d.lon]);
    }
  };

  // Clear driver selection if filtered out
  useEffect(() => {
    if (selectedDriver && !filteredDriverIds.has(selectedDriver)) {
      setSelectedDriver('');
      setFlyTarget(null);
    }
  }, [filteredDriverIds, selectedDriver]);

  const selectedInfo = filteredDrivers.find(r => r.driverId === selectedDriver);
  const selectedGroupKey = selectedInfo?.groupKey ?? null;

  // Weather groups filtered to match visible drivers
  const filteredGroups = useMemo(() => {
    if (!data?.groups) return [];
    return data.groups
      .map(g => ({ ...g, drivers: g.drivers.filter(d => filteredDriverIds.has(d._id)) }))
      .filter(g => g.drivers.length > 0);
  }, [data?.groups, filteredDriverIds]);

  const mapCoords: [number, number][] = mapMarkers.map(m => [m.lat, m.lon]);
  const defaultCenter: [number, number] = mapCoords.length > 0 ? mapCoords[0] : [17.42, 78.45];

  const t = data?.thresholds;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px - var(--topbar-h))' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Predictive Weather</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            Weather forecast at drivers' last parked locations
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="input" style={{ width: 130, fontSize: 12, padding: '4px 6px' }}
            value={projectFilter}
            onChange={e => { setProjectFilter(e.target.value); setCountryFilter(''); setSelectedDriver(''); setFlyTarget(null); }}
          >
            <option value="">All projects</option>
            {projects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="input" style={{ width: 130, fontSize: 12, padding: '4px 6px' }}
            value={countryFilter}
            onChange={e => { setCountryFilter(e.target.value); setSelectedDriver(''); setFlyTarget(null); }}
          >
            <option value="">All countries</option>
            {countries.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input" style={{ width: 170 }}
            value={selectedDriver}
            onChange={e => handleDriverSelect(e.target.value)}
          >
            <option value="">All drivers</option>
            {driverOptions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="input" style={{ width: 130 }} value={day} onChange={e => setDay(Number(e.target.value))}>
            {DAYS.map(d => <option key={d.offset} value={d.offset}>{d.label}</option>)}
          </select>
          <button className="btn-ghost" onClick={() => setReloadKey(k => k + 1)} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          {(projectFilter || countryFilter || selectedDriver) && (
            <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => { setProjectFilter(''); setCountryFilter(''); setSelectedDriver(''); setFlyTarget(null); }}>
              Clear
            </button>
          )}
        </div>
      </div>

      {error && <div className="error-text">{error}</div>}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto' }}>
        {/* Map */}
        <div className="map-wrap" style={{ height: 380, minHeight: 300, borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--line-2)', flexShrink: 0 }}>
          <MapContainer center={defaultCenter} zoom={5} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapAutoResize />
            {mapCoords.length > 0 && !flyTarget && <FitBounds coords={mapCoords} />}
            <FlyToDriver target={flyTarget} />
            {mapMarkers.map((m) => (
              <Marker
                key={m.driverId}
                position={[m.lat, m.lon]}
                icon={parkedCarIcon(m.risk, m.driverId === selectedDriver)}
                eventHandlers={{ click: () => { setSelectedDriver(m.driverId); setFlyTarget([m.lat, m.lon]); } }}
              >
                <Popup maxWidth={320} minWidth={240}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{m.name}</div>
                    <div style={{ fontSize: 11, color: '#888' }}>
                      {m.project && <span>{m.project} · </span>}
                      {m.country && <span>{m.country}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{m.place}</div>
                    {m.risk && (
                      <div style={{ margin: '5px 0', fontSize: 12, fontWeight: 700, color: m.risk === 'unsafe' ? '#dc2626' : m.risk === 'caution' ? '#f97316' : '#059669' }}>
                        {RISK_DOT[m.risk]} {RISK_LABEL[m.risk]}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: '#666', marginBottom: 5 }}>{m.headline}</div>
                    {m.endedAt && (
                      <div style={{ fontSize: 11, color: '#999', marginBottom: 5 }}>
                        Parked: {new Date(m.endedAt).toLocaleString()}
                      </div>
                    )}
                    {m.slots.length > 0 && (
                      <div style={{ display: 'flex', gap: 3, overflowX: 'auto', paddingBottom: 2 }}>
                        {m.slots.slice(0, 8).map(s => <SlotMini key={s.dt} slot={s} />)}
                      </div>
                    )}
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        {/* Stats */}
        {data?.configured && (
          <div className="stat-row" style={{ flexShrink: 0 }}>
            <div className="stat"><div className="v" style={{ color: 'var(--green)' }}>{filteredDrivers.filter(r => r.risk === 'clear').length}</div><div className="k">Good to drive</div></div>
            <div className="stat"><div className="v" style={{ color: 'var(--amber)' }}>{filteredDrivers.filter(r => r.risk === 'caution').length}</div><div className="k">Caution</div></div>
            <div className="stat"><div className="v" style={{ color: filteredDrivers.some(r => r.risk === 'unsafe') ? 'var(--red)' : undefined }}>{filteredDrivers.filter(r => r.risk === 'unsafe').length}</div><div className="k">Do not drive</div></div>
            <div className="stat"><div className="v">{filteredDrivers.filter(r => r.lat === 0 && r.lon === 0).length}</div><div className="k">No location</div></div>
            <div className="stat"><div className="v">{filteredDrivers.length}</div><div className="k">Drivers</div></div>
          </div>
        )}

        {/* Weather cards */}
        {data?.configured && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 16 }}>
            {(selectedGroupKey
              ? filteredGroups.filter(g => g.key === selectedGroupKey)
              : filteredGroups
            ).map(g => (
              <LocationCard
                key={g.key}
                group={g}
                selected={g.key === selectedGroupKey}
                onSelect={() => {
                  setFlyTarget([g.lat, g.lon]);
                  if (!selectedDriver || !g.drivers.some(d => d._id === selectedDriver)) {
                    setSelectedDriver(g.drivers[0]?._id ?? '');
                  }
                }}
              />
            ))}

            {filteredGroups.length === 0 && !loading && filteredDrivers.length > 0 && (
              <div className="empty-state">
                <p>No weather data available for the filtered drivers.</p>
              </div>
            )}

            {filteredGroups.length === 0 && filteredDrivers.length === 0 && !loading && (
              <div className="empty-state">
                <p>No drivers match the selected filters.</p>
              </div>
            )}

            {selectedDriver && data.unplaced?.some(u => u._id === selectedDriver) && (
              <div className="card" style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
                No recent location for this driver — cannot show weather prediction.
              </div>
            )}

            {!selectedDriver && (data.unplaced?.filter(u => filteredDriverIds.has(u._id)) ?? []).length > 0 && (
              <div className="card" style={{ marginTop: 4 }}>
                <h3 style={{ margin: '0 0 6px', fontSize: 13 }}>No recent location ({data.unplaced!.filter(u => filteredDriverIds.has(u._id)).length})</h3>
                <p style={{ margin: '0 0 8px', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  No trip in the last {t?.activeDays ?? 7} days.
                </p>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {data.unplaced!.filter(u => filteredDriverIds.has(u._id)).map(d => (
                    <span key={d._id} style={{
                      fontSize: 11, color: 'var(--muted)',
                      background: 'var(--panel-2)', border: '1px solid var(--line)',
                      borderRadius: 999, padding: '2px 9px',
                    }}>
                      {d.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {t && !selectedDriver && (
              <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.6 }}>
                Guidance only. <b>Do not drive</b>: thunderstorms, heavy rain/snow, freezing rain, visibility {'<'} 1 km, gusts {'>'} {t.gustUnsafeKmh} km/h. <b>Caution</b>: moderate rain, fog, visibility {'<'} 4 km, wind {'>'} {t.windCautionKmh} km/h. Cached {t.cacheMinutes} min.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
