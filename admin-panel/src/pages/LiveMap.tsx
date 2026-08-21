import { useCallback, useEffect, useRef, useState } from 'react';
import { divIcon } from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { MapAutoResize } from '../lib/MapAutoResize';
import { useSocket, useSocketEvent } from '../lib/socket';
import { useAuth } from '../lib/auth';
import { km } from '../lib/format';
import type { LiveDriver, LocationEvent, ParkedDriver, User } from '../lib/types';

function Recenter({ focus }: { focus: [number, number] | null }) {
  const map = useMap();
  useEffect(() => { if (focus) map.panTo(focus, { animate: true }); }, [focus, map]);
  return null;
}

/**
 * Three states, not two.
 *
 * "Stale" used to mean "no GPS fix for 60s", which fired on every traffic light and every delivery
 * stop — the device stops producing fixes the moment the vehicle stops moving. The server now
 * separates "not moving but the app is still heartbeating" from "we have genuinely lost this
 * driver", which are very different things to a dispatcher looking at the map.
 *
 * `state` falls back to the old boolean so a cached client, or a driver whose app does not send
 * heartbeats yet, still renders sensibly.
 */
type DriverState = 'moving' | 'stopped' | 'stale';
const driverState = (d: { state?: string; stale: boolean }): DriverState =>
  (d.state as DriverState) ?? (d.stale ? 'stale' : 'moving');

const STATE_UI: Record<DriverState, { fill: string; label: string; badge: string; hint: string }> = {
  moving:  { fill: '#059669', label: 'Moving',    badge: 'green', hint: 'Reporting a fresh GPS position' },
  stopped: { fill: '#d97706', label: 'Stopped',   badge: 'amber', hint: 'Not moving, but the app is still reporting — parked or waiting' },
  stale:   { fill: '#dc2626', label: 'No signal', badge: 'red',   hint: 'No GPS and no app heartbeat — we cannot account for this driver' },
};

// Active car marker, coloured by state.
function carIcon(heading: number | null | undefined, state: DriverState) {
  const fill = STATE_UI[state].fill;
  const rot = typeof heading === 'number' && isFinite(heading) ? heading : 0;
  const svg = `
    <svg viewBox="0 0 32 32" width="30" height="30" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="3" width="14" height="26" rx="6" fill="${fill}" stroke="#ffffff" stroke-width="1.6"/>
      <path d="M11.5 9 Q16 6.3 20.5 9 L19.6 12.6 Q16 11 12.4 12.6 Z" fill="rgba(255,255,255,0.9)"/>
      <path d="M12.4 23.6 Q16 22.2 19.6 23.6 L20.5 20.4 Q16 21.9 11.5 20.4 Z" fill="rgba(255,255,255,0.6)"/>
      <circle cx="16" cy="16.2" r="1.5" fill="rgba(255,255,255,0.85)"/>
    </svg>`;
  return divIcon({
    className: 'car-marker',
    html: `<div style="transform: rotate(${rot}deg); transform-origin: center; width:30px; height:30px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));">${svg}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15],
  });
}

// Inactive / parked car marker — orange with "P" badge.
function parkedCarIcon() {
  const svg = `
    <svg viewBox="0 0 32 32" width="30" height="30" xmlns="http://www.w3.org/2000/svg">
      <rect x="9" y="3" width="14" height="26" rx="6" fill="#f97316" stroke="#ffffff" stroke-width="1.6"/>
      <path d="M11.5 9 Q16 6.3 20.5 9 L19.6 12.6 Q16 11 12.4 12.6 Z" fill="rgba(255,255,255,0.7)"/>
      <path d="M12.4 23.6 Q16 22.2 19.6 23.6 L20.5 20.4 Q16 21.9 11.5 20.4 Z" fill="rgba(255,255,255,0.4)"/>
      <text x="16" y="19" text-anchor="middle" font-size="9" font-weight="bold" fill="white" font-family="sans-serif">P</text>
    </svg>`;
  return divIcon({
    className: 'car-marker',
    html: `<div style="width:30px; height:30px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.25));">${svg}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15],
  });
}

export function LiveMap() {
  const { token } = useAuth();
  const { connected } = useSocket();
  const [drivers, setDrivers] = useState<Record<string, LiveDriver>>({});
  const [parked, setParked] = useState<ParkedDriver[]>([]);
  const [allDriverUsers, setAllDriverUsers] = useState<User[]>([]);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [projectFilter, setProjectFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLinkDriver = searchParams.get('driver');

  // Keep a ref so the socket callback can access the latest user data without
  // re-subscribing every time allDriverUsers changes.
  const userByIdRef = useRef<Record<string, User>>({});
  useEffect(() => {
    const map: Record<string, User> = {};
    allDriverUsers.forEach(u => { map[u._id] = u; });
    userByIdRef.current = map;
  }, [allDriverUsers]);

  useEffect(() => {
    (async () => {
      try {
        const [liveRes, parkedRes, usersRes] = await Promise.all([
          api.get<{ drivers: LiveDriver[] }>('/api/tracking/live'),
          api.get<{ parked: ParkedDriver[] }>('/api/tracking/parked'),
          api.get<{ users: User[] }>('/api/users?role=user'),
        ]);
        const usersList = usersRes.users ?? [];
        setAllDriverUsers(usersList);

        // Build map immediately so we can enrich live drivers
        const uMap: Record<string, User> = {};
        usersList.forEach(u => { uMap[u._id] = u; });
        userByIdRef.current = uMap;

        const map: Record<string, LiveDriver> = {};
        (liveRes.drivers ?? []).forEach(d => {
          // Enrich driver with country/project from users list if missing
          const uInfo = uMap[d.driver._id];
          map[d.driver._id] = {
            ...d,
            driver: {
              ...d.driver,
              country: d.driver.country ?? uInfo?.country ?? null,
              project: d.driver.project ?? uInfo?.project ?? null,
            },
          };
        });
        setDrivers(map);
        setParked(parkedRes.parked ?? []);
      } catch {}
    })();
  }, [token]);

  useSocketEvent<LocationEvent>('location', useCallback((e: LocationEvent) => {
    setDrivers(prev => {
      if (e.ended) { const next = { ...prev }; delete next[e.driverId]; return next; }
      const existing = prev[e.driverId];
      // Enrich with stored user info when driver is new to the map
      const uInfo = userByIdRef.current[e.driverId];
      return {
        ...prev,
        [e.driverId]: {
          tripId: e.tripId,
          driver: existing?.driver ?? {
            _id: e.driverId,
            name: e.driverName,
            email: '',
            country: uInfo?.country ?? null,
            project: uInfo?.project ?? null,
          },
          vehicle: existing?.vehicle ?? null,
          location: { lat: e.lat, lon: e.lon, speed: e.speedKmh, heading: e.heading, recordedAt: e.recordedAt },
          startedAt: existing?.startedAt ?? e.recordedAt,
          distanceMeters: existing?.distanceMeters ?? 0,
          maxSpeedKmh: Math.max(existing?.maxSpeedKmh ?? 0, e.speedKmh),
          // A live fix just arrived, so this driver is moving whatever the last poll said.
          stale: false,
          state: 'moving',
        },
      };
    });
    // Remove from parked list when a driver goes active.
    setParked(prev => prev.filter(p => p.driver._id !== e.driverId));
  }, []));

  // Centre on the driver named in the URL once we know where they are.
  useEffect(() => {
    if (!deepLinkDriver) return;
    const hit =
      drivers[deepLinkDriver]?.location ??
      parked.find(p => p.driver._id === deepLinkDriver)?.location;
    if (!hit) return;
    setFocus([hit.lat, hit.lon]);
    setSearchParams({}, { replace: true });
  }, [deepLinkDriver, drivers, parked, setSearchParams]);

  const allList = Object.values(drivers);
  const withLoc = allList.filter(d => d.location);

  // Collect unique projects from all driver users.
  const projects = Array.from(new Set(
    allDriverUsers.map(d => d.project).filter(Boolean)
  )).sort() as string[];

  // Countries filtered by selected project (cascade).
  const countries = Array.from(new Set(
    allDriverUsers
      .filter(d => !projectFilter || d.project === projectFilter)
      .map(d => d.country)
      .filter(Boolean)
  )).sort() as string[];

  // When project changes, reset country if it no longer belongs to the new project.
  const handleProjectChange = (val: string) => {
    setProjectFilter(val);
    if (countryFilter) {
      const valid = allDriverUsers
        .filter(d => !val || d.project === val)
        .map(d => d.country)
        .filter(Boolean);
      if (!valid.includes(countryFilter)) setCountryFilter('');
    }
  };

  // Helper to get country/project for a driver, falling back to the users list.
  const getDriverCountry = (driverId: string, driverCountry?: string | null) =>
    driverCountry ?? userByIdRef.current[driverId]?.country ?? null;
  const getDriverProject = (driverId: string, driverProject?: string | null) =>
    driverProject ?? userByIdRef.current[driverId]?.project ?? null;

  // Apply filters to active drivers.
  const list = allList.filter(d => {
    const country = getDriverCountry(d.driver._id, d.driver.country);
    const project = getDriverProject(d.driver._id, d.driver.project);
    if (countryFilter && country !== countryFilter) return false;
    if (projectFilter && project !== projectFilter) return false;
    return true;
  });
  const filteredWithLoc = list.filter(d => d.location);
  // Only drivers we cannot account for — a stopped vehicle is not a problem to flag.
  const filteredStale = list.filter(d => driverState(d) === 'stale');

  // Apply filters to parked drivers.
  const filteredParked = parked.filter(p => {
    const country = getDriverCountry(p.driver._id, p.driver.country);
    const project = getDriverProject(p.driver._id, p.driver.project);
    if (countryFilter && country !== countryFilter) return false;
    if (projectFilter && project !== projectFilter) return false;
    return true;
  });

  // Total = active drivers (on duty + parked) matching the current filters.
  // Derived from the combined on-duty and parked lists so it stays consistent.
  const totalActive = list.length + filteredParked.length;

  // Stable initial center.
  const initialCenter = useRef<[number, number]>([17.42, 78.45]);
  if (withLoc[0]?.location && initialCenter.current[0] === 17.42 && initialCenter.current[1] === 78.45) {
    initialCenter.current = [withLoc[0].location.lat, withLoc[0].location.lon];
  }

  return (
    <div className="live-grid">
      {/* ── Left panel ── */}
      <div className="live-list">
        {/* Header */}
        <div style={{ marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <h1 className="page-title">Live Map</h1>
            <span className={`badge ${connected ? 'green' : 'gray'}`}>
              {connected ? '● Live' : '○ Offline'}
            </span>
          </div>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12.5 }}>
            Real-time driver positions
          </p>
        </div>

        {/* Filters — Project first, then Country (cascaded by project) */}
        <select
          className="input"
          style={{ width: '100%', margin: '8px 0 4px', fontSize: 13 }}
          value={projectFilter}
          onChange={e => handleProjectChange(e.target.value)}
        >
          <option value="">All projects</option>
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select
          className="input"
          style={{ width: '100%', margin: '4px 0 4px', fontSize: 13 }}
          value={countryFilter}
          onChange={e => setCountryFilter(e.target.value)}
        >
          <option value="">All countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        {/* Stat pills — Total | On Duty | Stale | Parked */}
        <div className="live-stats">
          <div className="live-stat-pill">
            <div className="v">{totalActive}</div>
            <div className="k">Total</div>
          </div>
          <div className="live-stat-pill">
            <div className="v" style={{ color: 'var(--green)' }}>{list.length}</div>
            <div className="k">On Duty</div>
          </div>
          <div className="live-stat-pill">
            <div className="v" style={{ color: '#d97706' }}>{filteredStale.length}</div>
            <div className="k">Stale</div>
          </div>
          <div className="live-stat-pill">
            <div className="v" style={{ color: '#f97316' }}>{filteredParked.length}</div>
            <div className="k">Parked</div>
          </div>
        </div>

        {/* Empty state */}
        {list.length === 0 && filteredParked.length === 0 && (
          <div style={{
            background: 'var(--panel)', border: '1.5px dashed var(--line-2)',
            borderRadius: 'var(--radius-lg)', textAlign: 'center',
            padding: '36px 20px',
          }}>
            <div style={{ fontSize: 36, marginBottom: 10, opacity: 0.25 }}>🚗</div>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
              No drivers found{projectFilter ? ` in project ${projectFilter}` : ''}{countryFilter ? ` in ${countryFilter}` : ''}.<br />
              {!projectFilter && !countryFilter && 'Drivers appear here when moving.'}
            </p>
          </div>
        )}

        {/* Active driver cards */}
        {list.map(d => {
          const country = getDriverCountry(d.driver._id, d.driver.country);
          const project = getDriverProject(d.driver._id, d.driver.project);
          return (
            <div
              key={d.driver._id}
              className="driver-card"
              onClick={() => d.location && setFocus([d.location.lat, d.location.lon])}
            >
              <div className="row" style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                    background: driverState(d) === 'moving' ? 'var(--brand-light)' : 'var(--amber-bg)',
                    border: `1px solid ${driverState(d) === 'moving' ? 'rgba(124,58,237,0.2)' : 'rgba(217,119,6,0.25)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: driverState(d) === 'moving' ? 'var(--brand)' : 'var(--amber)',
                    fontSize: 11, fontWeight: 800,
                  }}>
                    {d.driver.name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()}
                  </div>
                  <div>
                    <span className="driver-name">{d.driver.name}</span>
                    {(project || country) && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                        {[project, country].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                </div>
                <span className={`badge ${STATE_UI[driverState(d)].badge}`} title={STATE_UI[driverState(d)].hint}>
                  {STATE_UI[driverState(d)].label}
                </span>
              </div>
              <div className="driver-meta" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {d.vehicle?.plateNumber && (
                  <span style={{
                    background: 'var(--panel-2)', border: '1px solid var(--line-2)',
                    borderRadius: 5, padding: '1px 7px',
                    fontSize: 11.5, fontWeight: 700, fontFamily: 'monospace',
                    color: 'var(--text-2)',
                  }}>
                    {d.vehicle.plateNumber}
                  </span>
                )}
                <span>{d.location ? `${Math.round(d.location.speed ?? 0)} km/h` : 'No fix'}</span>
                <span>{km(d.distanceMeters)}</span>
                <Link
                  to={`/trips/${d.tripId}/map`}
                  style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--brand)', marginLeft: 'auto' }}
                  onClick={e => e.stopPropagation()}
                >
                  View route →
                </Link>
              </div>
            </div>
          );
        })}

        {/* Parked driver cards */}
        {filteredParked.map(p => {
          const country = getDriverCountry(p.driver._id, p.driver.country);
          const project = getDriverProject(p.driver._id, p.driver.project);
          return (
            <div
              key={p.driver._id}
              className="driver-card"
              style={{ opacity: 0.75 }}
              onClick={() => p.location && setFocus([p.location.lat, p.location.lon])}
            >
              <div className="row" style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                    background: '#f1f5f9', border: '1px solid #e2e8f0',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#94a3b8', fontSize: 11, fontWeight: 800,
                  }}>
                    {p.driver.name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()}
                  </div>
                  <div>
                    <span className="driver-name">{p.driver.name}</span>
                    {(project || country) && (
                      <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>
                        {[project, country].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                </div>
                <span className="badge gray">Parked</span>
              </div>
              <div className="driver-meta" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                {p.vehicle?.plateNumber && (
                  <span style={{
                    background: 'var(--panel-2)', border: '1px solid var(--line-2)',
                    borderRadius: 5, padding: '1px 7px',
                    fontSize: 11.5, fontWeight: 700, fontFamily: 'monospace',
                    color: 'var(--text-2)',
                  }}>
                    {p.vehicle.plateNumber}
                  </span>
                )}
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  Parked · {p.endedAt ? new Date(p.endedAt).toLocaleTimeString() : ''}
                </span>
                <Link
                  to={`/trips/${p.tripId}/map`}
                  style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginLeft: 'auto' }}
                  onClick={e => e.stopPropagation()}
                >
                  Last route →
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Map ── */}
      <div className="map-wrap">
        <MapContainer center={initialCenter.current} zoom={13} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <MapAutoResize />
          <Recenter focus={focus} />

          {/* Active vehicles */}
          {filteredWithLoc.map(d => {
            const country = getDriverCountry(d.driver._id, d.driver.country);
            const project = getDriverProject(d.driver._id, d.driver.project);
            return (
              <Marker
                key={d.driver._id}
                position={[d.location!.lat, d.location!.lon]}
                icon={carIcon(d.location!.heading, driverState(d))}
              >
                <Popup>
                  <b>{d.driver.name}</b><br />
                  {d.vehicle?.plateNumber && <><span>{d.vehicle.plateNumber}</span><br /></>}
                  {project && <><span style={{ color: '#6366f1' }}>{project}</span><br /></>}
                  {country && <><span>{country}</span><br /></>}
                  <span className={`badge ${STATE_UI[driverState(d)].badge}`} style={{ fontSize: 11 }} title={STATE_UI[driverState(d)].hint}>
                    {STATE_UI[driverState(d)].label}
                  </span><br />
                  {Math.round(d.location!.speed ?? 0)} km/h · {km(d.distanceMeters)}<br />
                  {d.location!.recordedAt ? new Date(d.location!.recordedAt).toLocaleTimeString() : ''}<br />
                  <span style={{ fontSize: 10, color: '#6b7280' }}>
                    {d.location!.lat.toFixed(6)}, {d.location!.lon.toFixed(6)}
                  </span>
                </Popup>
              </Marker>
            );
          })}

          {/* Parked / inactive vehicles */}
          {filteredParked.filter(p => p.location).map(p => {
            const country = getDriverCountry(p.driver._id, p.driver.country);
            const project = getDriverProject(p.driver._id, p.driver.project);
            return (
              <Marker
                key={`parked-${p.driver._id}`}
                position={[p.location!.lat, p.location!.lon]}
                icon={parkedCarIcon()}
              >
                <Popup>
                  <b>{p.driver.name}</b><br />
                  {p.vehicle?.plateNumber && <><span>{p.vehicle.plateNumber}</span><br /></>}
                  {project && <><span style={{ color: '#6366f1' }}>{project}</span><br /></>}
                  {country && <><span>{country}</span><br /></>}
                  <span style={{ color: '#f97316', fontWeight: 600, fontSize: 11 }}>Parked</span><br />
                  {p.endedAt ? new Date(p.endedAt).toLocaleTimeString() : ''}<br />
                  <span style={{ fontSize: 10, color: '#6b7280' }}>
                    {p.location!.lat.toFixed(6)}, {p.location!.lon.toFixed(6)}
                  </span>
                </Popup>
              </Marker>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
}
