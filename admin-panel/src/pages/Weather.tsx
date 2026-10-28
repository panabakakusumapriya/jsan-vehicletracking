import { PageIcon } from '../components/AppIcon';
import { ProjectSelect, useDefaultProject, useProjectScope } from '../components/ProjectSelect';
import React, { useEffect, useMemo, useState } from 'react';
import { divIcon } from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { api } from '../lib/api';
import { km } from '../lib/format';
import { MapAutoResize } from '../lib/MapAutoResize';
import type { DrivingRisk, DrivingWeather, ParkedDriver, TripRouteWeather, WeatherGroup, WeatherSlot } from '../lib/types';
import { RISK_BADGE, RISK_COLOR, RISK_HEX, RISK_LABEL, dateLabel } from '../components/weather/weatherUi';
import { WeatherIcon } from '../components/weather/WeatherIcon';
import { HourlyChart } from '../components/weather/HourlyChart';
import { ConfidenceBar } from '../components/weather/ConfidenceBar';
import { WeatherLayers } from '../components/weather/WeatherLayers';
import { TripWeatherStrip } from '../components/weather/TripWeather';

/** "Today" / "Tomorrow" / "Thursday" for a day offset, as the viewer reads it. */
function dayName(offset: number) {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString(undefined, { weekday: 'long' });
}

const RANK: Record<DrivingRisk, number> = { clear: 0, caution: 1, unsafe: 2 };

/** One date card for the whole (filtered) fleet: every location's card for that day, combined. */
interface FleetDay {
  dayOffset: number;
  date: string | null;
  verdict: DrivingRisk | null;
  drivers: Record<DrivingRisk, number>;
  tempMinC: number | null;
  tempMaxC: number | null;
  precipMm: number;
  popMaxPct: number;
  gustMaxKmh: number | null;
  visibilityMinKm: number | null;
  icon: string | null;
  description: string;
  /** Driver-weighted average of the locations' scores; reasons from the least certain place. */
  confidence: number | null;
  confidenceReasons: string[];
}

function fleetOutlook(groups: WeatherGroup[], days: number): FleetDay[] {
  const out: FleetDay[] = [];
  for (let o = 0; o < days; o++) {
    const day: FleetDay = {
      dayOffset: o, date: null, verdict: null, drivers: { clear: 0, caution: 0, unsafe: 0 },
      tempMinC: null, tempMaxC: null, precipMm: 0, popMaxPct: 0, gustMaxKmh: null, visibilityMinKm: null,
      icon: null, description: '', confidence: null, confidenceReasons: [],
    };
    let face = -1;
    let confSum = 0;
    let confWeight = 0;
    let leastSure = 101;
    for (const g of groups) {
      const c = g.outlook?.find((x) => x.dayOffset === o);
      if (!c?.date || !c.verdict) continue;
      day.date ??= c.date;
      day.drivers[c.verdict] += g.drivers.length;
      if (day.verdict == null || RANK[c.verdict] > RANK[day.verdict]) day.verdict = c.verdict;
      if (c.tempMinC != null) day.tempMinC = day.tempMinC == null ? c.tempMinC : Math.min(day.tempMinC, c.tempMinC);
      if (c.tempMaxC != null) day.tempMaxC = day.tempMaxC == null ? c.tempMaxC : Math.max(day.tempMaxC, c.tempMaxC);
      day.precipMm = Math.max(day.precipMm, c.precipMm ?? 0);
      day.popMaxPct = Math.max(day.popMaxPct, c.popMaxPct ?? 0);
      if (c.gustMaxKmh != null) day.gustMaxKmh = Math.max(day.gustMaxKmh ?? 0, c.gustMaxKmh);
      if (c.visibilityMinKm != null) day.visibilityMinKm = Math.min(day.visibilityMinKm ?? 99, c.visibilityMinKm);
      // The card's face is the worst location's day (ties: the one with most drivers).
      const rank = RANK[c.verdict] * 1000 + g.drivers.length;
      if (rank > face) { face = rank; day.icon = c.icon ?? null; day.description = c.description ?? ''; }
      if (c.confidence) {
        const w = Math.max(g.drivers.length, 1);
        confSum += c.confidence.score * w;
        confWeight += w;
        if (c.confidence.score < leastSure) {
          leastSure = c.confidence.score;
          day.confidenceReasons = groups.length > 1
            ? c.confidence.reasons.map((r) => `${g.place || 'one location'}: ${r}`)
            : c.confidence.reasons;
        }
      }
    }
    if (confWeight) day.confidence = Math.round(confSum / confWeight);
    if (day.date) out.push(day);
  }
  return out;
}

/** One labelled line on a date card. Words, not emoji: system emoji differ per OS and shrink badly. */
function CardFact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/* ── Date cards ── */
function DateCards({ days, selected, onSelect }: { days: FleetDay[]; selected: number; onSelect: (o: number) => void }) {
  if (!days.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(122px, 1fr))`, gap: 8, overflowX: 'auto', flexShrink: 0, paddingBottom: 2 }}>
      {days.map((d) => {
        const on = d.dayOffset === selected;
        const v = d.verdict ?? 'clear';
        return (
          <button
            key={d.dayOffset}
            type="button"
            onClick={() => onSelect(d.dayOffset)}
            aria-pressed={on}
            className="card"
            style={{
              textAlign: 'left', cursor: 'pointer', padding: '9px 11px 8px', margin: 0, font: 'inherit', color: 'var(--text)',
              borderTop: `4px solid ${RISK_HEX[v]}`,
              outline: on ? '2px solid var(--brand)' : undefined, outlineOffset: -1,
              background: on ? 'var(--brand-light, var(--panel))' : undefined,
            }}
            title={d.description}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4 }}>
              <b style={{ fontSize: 13 }}>{dayName(d.dayOffset)}</b>
              <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{d.date ? dateLabel(d.date, { day: 'numeric', month: 'short' }) : ''}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 3px' }}>
              <WeatherIcon icon={d.icon} size={34} title={d.description} />
              <span style={{ fontSize: 14, fontWeight: 800 }}>
                {d.tempMaxC ?? '—'}°<span style={{ color: 'var(--muted)', fontWeight: 600, fontSize: 12 }}> / {d.tempMinC ?? '—'}°</span>
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
              <CardFact label="Rain" value={`${d.precipMm > 0 ? `${d.precipMm} mm` : 'dry'}${d.popMaxPct > 0 ? ` · ${d.popMaxPct}%` : ''}`} />
              <CardFact label="Gusts" value={`${d.gustMaxKmh ?? '—'} km/h`} />
              <CardFact label="Visibility" value={d.visibilityMinKm == null ? '—' : `${d.visibilityMinKm >= 20 ? '20+' : d.visibilityMinKm} km`} />
            </div>
            <div style={{ display: 'flex', gap: 4, marginTop: 5, flexWrap: 'wrap' }}>
              {(['unsafe', 'caution', 'clear'] as DrivingRisk[]).filter((r) => d.drivers[r] > 0).map((r) => (
                <span key={r} className={`badge ${RISK_BADGE[r]}`} style={{ fontSize: 9.5, padding: '0 6px' }}
                  title={`${d.drivers[r]} driver${d.drivers[r] === 1 ? '' : 's'}: ${RISK_LABEL[r]}`}>
                  {d.drivers[r]} {r === 'clear' ? 'good' : r === 'caution' ? 'caution' : 'no-go'}
                </span>
              ))}
            </div>
            <div style={{ marginTop: 7 }}>
              <ConfidenceBar score={d.confidence} reasons={d.confidenceReasons} compact />
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ── Map marker icon ── */
function parkedCarIcon(risk: DrivingRisk | null, selected: boolean) {
  const fill = risk === 'unsafe' ? '#dc2626' : risk === 'caution' ? '#f97316' : '#059669';
  const stroke = selected ? '#0050a9' : '#ffffff';
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
      <WeatherIcon icon={slot.icon} size={18} />
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
      <div style={{ margin: '2px 0' }}><WeatherIcon icon={slot.icon} size={22} /></div>
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
function LocationCard({ group, day, selected, onSelect }: { group: WeatherGroup; day: number; selected: boolean; onSelect: () => void }) {
  const verdict = group.verdict ?? 'clear';
  const confidence = group.outlook?.find((c) => c.dayOffset === day)?.confidence ?? null;
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
                <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: RISK_HEX[verdict], marginRight: 6 }} />
                {group.place || `${group.lat.toFixed(2)}, ${group.lon.toFixed(2)}`}
                {group.country ? `, ${group.country}` : ''}
              </span>
              <span className={`badge ${RISK_BADGE[verdict]}`} style={{ fontSize: 10 }}>{RISK_LABEL[verdict]}</span>
              {group.stale && <span className="badge gray" style={{ fontSize: 10 }}>stale</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>{group.headline}</div>
            {confidence && (
              <div style={{ marginTop: 7, maxWidth: 420 }}>
                <ConfidenceBar score={confidence.score} reasons={confidence.reasons} showReasons />
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
            <div>local {group.localTimeNow}</div>
            <div>{group.drivers.length} driver{group.drivers.length === 1 ? '' : 's'}</div>
          </div>
        </div>

        {group.hours && group.hours.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            <HourlyChart hours={group.hours} />
          </div>
        ) : group.slots.length > 0 && (
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

/* ── History types ── */

interface TripSummaryRow {
  _id: string;
  driverName: string;
  driverCountry: string | null;
  driverProject: string | null;
  vehiclePlate: string | null;
  startedAt: string;
  endedAt: string | null;
  distanceMeters: number;
  maxSpeedKmh: number;
  status: string;
  startLocation: { lat: number; lon: number } | null;
  locationName: string | null;
}


/* ── History tab ── */
function WeatherHistory({ projectFilter, countryFilter }: { projectFilter: string; countryFilter: string }) {
  const [trips, setTrips] = useState<TripSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [weatherCache, setWeatherCache] = useState<Record<string, TripRouteWeather | null>>({});
  const [weatherError, setWeatherError] = useState<Record<string, string>>({});
  const [weatherLoading, setWeatherLoading] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState('');

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ limit: '50' });
    if (dateFilter) {
      params.set('from', dateFilter);
      params.set('to', dateFilter);
    }
    api.get<{ trips: TripSummaryRow[] }>(`/api/weather/trip-history?${params}`)
      .then(r => setTrips(r.trips ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [dateFilter]);

  const filtered = trips.filter(t => {
    if (projectFilter && t.driverProject !== projectFilter) return false;
    if (countryFilter && t.driverCountry !== countryFilter) return false;
    return true;
  });

  const toggleExpand = async (tripId: string) => {
    if (expanded === tripId) { setExpanded(null); return; }
    setExpanded(tripId);
    if (weatherCache[tripId] !== undefined) return;
    setWeatherLoading(tripId);
    try {
      // Weather along the whole route at the vehicle's own times, not just where the trip began.
      const r = await api.get<{ weather: TripRouteWeather | null }>(`/api/weather/trip-route/${tripId}`);
      setWeatherCache(c => ({ ...c, [tripId]: r.weather }));
    } catch (e) {
      setWeatherCache(c => ({ ...c, [tripId]: null }));
      setWeatherError(c => ({ ...c, [tripId]: e instanceof Error ? e.message : 'Weather unavailable' }));
    } finally {
      setWeatherLoading(null);
    }
  };


  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input
          type="date"
          className="input"
          style={{ width: 170, fontSize: 12, padding: '4px 6px' }}
          value={dateFilter}
          max={new Date().toISOString().slice(0, 10)}
          onChange={e => setDateFilter(e.target.value)}
        />
        {dateFilter && (
          <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setDateFilter('')}>
            Clear date
          </button>
        )}
      </div>
      <div className="card" style={{ padding: 0, overflow: 'auto', flex: 1, minHeight: 0 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>Loading trips...</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>No completed trips found.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Driver</th>
                <th>Country</th>
                <th>Vehicle</th>
                <th>Date</th>
                <th>Time</th>
                <th>Location</th>
                <th>Distance</th>
                <th>Max Speed</th>
                <th>Weather</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(trip => {
                const weather = weatherCache[trip._id];
                const isExpanded = expanded === trip._id;
                const isLoading = weatherLoading === trip._id;
                return (
                  <React.Fragment key={trip._id}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => toggleExpand(trip._id)}>
                      <td>{trip.driverName}</td>
                      <td>{trip.driverCountry || '—'}</td>
                      <td>{trip.vehiclePlate || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{new Date(trip.startedAt).toLocaleDateString()}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {new Date(trip.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {trip.endedAt && <> — {new Date(trip.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>{trip.locationName || (trip.startLocation ? `${trip.startLocation.lat.toFixed(2)}, ${trip.startLocation.lon.toFixed(2)}` : '—')}</td>
                      <td>{km(trip.distanceMeters)}</td>
                      <td>{Math.round(trip.maxSpeedKmh)} km/h</td>
                      <td>
                        {weather ? (
                          <span className={`badge ${RISK_BADGE[weather.verdict]}`}>{RISK_LABEL[weather.verdict]}</span>
                        ) : isExpanded && isLoading ? (
                          <span style={{ color: 'var(--muted)', fontSize: 11 }}>Loading...</span>
                        ) : isExpanded && weather === null ? (
                          <span style={{ color: 'var(--muted)' }}>—</span>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 11 }}>Click to load</span>
                        )}
                      </td>
                      <td>
                        <button className="btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }}>
                          {isExpanded ? '▲' : '▼'}
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={10} style={{ padding: '10px 16px', background: 'var(--panel-2)' }}>
                          {isLoading || weather ? (
                            <TripWeatherStrip
                              weather={weather ?? null}
                              loading={isLoading}
                              error={null}
                              startMs={new Date(trip.startedAt).getTime()}
                              durationMs={trip.endedAt ? new Date(trip.endedAt).getTime() - new Date(trip.startedAt).getTime() : 0}
                            />
                          ) : (
                            <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, padding: 10 }}>
                              {weatherError[trip._id] ? `Weather unavailable: ${weatherError[trip._id]}` : 'No GPS recorded for this trip, so there is no route to look the weather up along.'}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ── Main component ── */
type WeatherTab = 'forecast' | 'history';

export function Weather() {
  const [tab, setTab] = useState<WeatherTab>('forecast');
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
  const projectScope = useProjectScope();
  useDefaultProject(projectScope, projectFilter, setProjectFilter);

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
  // The cards come with every response (the same forecast), so they stay put while a day loads.
  const outlook = useMemo(() => fleetOutlook(filteredGroups, t?.forecastDays ?? 7), [filteredGroups, t?.forecastDays]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 80px - var(--topbar-h))' }}>
      <div className="page-head">
        <div>
          <h1 className="page-title"><PageIcon name="weather" />Predictive Weather</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
            {tab === 'history' ? 'Historical weather conditions during completed trips' : (() => {
              const d = new Date();
              d.setDate(d.getDate() + day);
              const label = day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : null;
              const dateStr = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
              return label ? `${label} · ${dateStr}` : dateStr;
            })()}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <ProjectSelect scope={projectScope} style={{ width: 130, fontSize: 12, padding: '4px 6px' }}
            value={projectFilter}
            onChange={v => { setProjectFilter(v); setCountryFilter(''); setSelectedDriver(''); setFlyTarget(null); }}
            options={projects.map(p => ({ value: p, label: p }))}
          />
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

      <div style={{ display: 'flex', gap: 6, margin: '0 0 10px' }}>
        <button className={`btn${tab === 'forecast' ? '' : '-ghost'}`} style={{ fontSize: 12, padding: '5px 14px' }} onClick={() => setTab('forecast')}>Forecast</button>
        <button className={`btn${tab === 'history' ? '' : '-ghost'}`} style={{ fontSize: 12, padding: '5px 14px' }} onClick={() => setTab('history')}>History</button>
      </div>

      {tab === 'history' ? <WeatherHistory projectFilter={projectFilter} countryFilter={countryFilter} /> : <>

      {error && <div className="error-text">{error}</div>}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto' }}>
        {/* Date cards: the fleet's next days at a glance; a click opens that day hour by hour below. */}
        <DateCards days={outlook} selected={day} onSelect={setDay} />

        {/* Map */}
        <div className="map-wrap" style={{ height: 380, minHeight: 300, borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--line-2)', flexShrink: 0 }}>
          <MapContainer center={defaultCenter} zoom={5} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapAutoResize />
            <WeatherLayers storageKey="weather" />
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
                        {RISK_LABEL[m.risk]}
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
                day={day}
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
      </>}
    </div>
  );
}
