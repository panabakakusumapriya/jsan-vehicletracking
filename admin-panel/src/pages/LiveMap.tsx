import { useEffect, useRef, useState } from 'react';
import { divIcon } from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { api } from '../lib/api';
import { createSocket } from '../lib/socket';
import { useAuth } from '../lib/auth';
import { km } from '../lib/format';
import type { LiveDriver, LocationEvent, ParkedDriver } from '../lib/types';

function Recenter({ focus }: { focus: [number, number] | null }) {
  const map = useMap();
  useEffect(() => { if (focus) map.panTo(focus, { animate: true }); }, [focus, map]);
  return null;
}

// Active car marker — green when moving, amber when stale.
function carIcon(heading: number | null | undefined, stale: boolean) {
  const fill = stale ? '#d97706' : '#059669';
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

// Inactive / parked car marker — gray with "P" badge.
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
  const [drivers, setDrivers] = useState<Record<string, LiveDriver>>({});
  const [parked, setParked] = useState<ParkedDriver[]>([]);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [connected, setConnected] = useState(false);
  const [countryFilter, setCountryFilter] = useState('');

  useEffect(() => {
    let socket: Socket | undefined;
    (async () => {
      try {
        const [liveRes, parkedRes] = await Promise.all([
          api.get<{ drivers: LiveDriver[] }>('/api/tracking/live'),
          api.get<{ parked: ParkedDriver[] }>('/api/tracking/parked'),
        ]);
        const map: Record<string, LiveDriver> = {};
        liveRes.drivers.forEach(d => { map[d.driver._id] = d; });
        setDrivers(map);
        setParked(parkedRes.parked ?? []);
      } catch {}

      if (!token) return;
      socket = createSocket(token);
      socket.on('connect', () => setConnected(true));
      socket.on('disconnect', () => setConnected(false));
      socket.on('location', (e: LocationEvent) => {
        setDrivers(prev => {
          if (e.ended) { const next = { ...prev }; delete next[e.driverId]; return next; }
          const existing = prev[e.driverId];
          return {
            ...prev,
            [e.driverId]: {
              tripId: e.tripId,
              driver: existing?.driver ?? { _id: e.driverId, name: e.driverName, email: '' },
              vehicle: existing?.vehicle ?? null,
              location: { lat: e.lat, lon: e.lon, speed: e.speedKmh, heading: e.heading, recordedAt: e.recordedAt },
              startedAt: existing?.startedAt ?? e.recordedAt,
              distanceMeters: existing?.distanceMeters ?? 0,
              maxSpeedKmh: Math.max(existing?.maxSpeedKmh ?? 0, e.speedKmh),
              stale: false,
            },
          };
        });
        // Remove from parked list when a driver goes active.
        setParked(prev => prev.filter(p => p.driver._id !== e.driverId));
      });
    })();
    return () => { socket?.close(); };
  }, [token]);

  const allList   = Object.values(drivers);
  const withLoc   = allList.filter(d => d.location);

  // Collect unique countries across active + parked drivers.
  const countries = Array.from(new Set([
    ...allList.map(d => d.driver.country).filter(Boolean),
    ...parked.map(p => p.driver.country).filter(Boolean),
  ])).sort() as string[];

  // Apply country filter.
  const list = countryFilter
    ? allList.filter(d => d.driver.country === countryFilter)
    : allList;
  const filteredWithLoc = list.filter(d => d.location);
  const filteredParked  = countryFilter
    ? parked.filter(p => p.driver.country === countryFilter)
    : parked;

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

        {/* Country filter */}
        <select
          className="input"
          style={{ width: '100%', margin: '8px 0 4px', fontSize: 13 }}
          value={countryFilter}
          onChange={e => setCountryFilter(e.target.value)}
        >
          <option value="">All countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        {/* Stat pills */}
        <div className="live-stats">
          <div className="live-stat-pill">
            <div className="v" style={{ color: 'var(--green)' }}>{filteredWithLoc.length}</div>
            <div className="k">Active</div>
          </div>
          <div className="live-stat-pill">
            <div className="v" style={{ color: '#94a3b8' }}>{filteredParked.length}</div>
            <div className="k">Parked</div>
          </div>
          <div className="live-stat-pill">
            <div className="v">{list.length}</div>
            <div className="k">On duty</div>
          </div>
        </div>

        {/* Empty */}
        {list.length === 0 && filteredParked.length === 0 && (
          <div style={{
            background: 'var(--panel)', border: '1.5px dashed var(--line-2)',
            borderRadius: 'var(--radius-lg)', textAlign: 'center',
            padding: '36px 20px',
          }}>
            <div style={{ fontSize: 36, marginBottom: 10, opacity: 0.25 }}>🚗</div>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
              No drivers found{countryFilter ? ` in ${countryFilter}` : ''}.<br />
              {!countryFilter && 'Drivers appear here when moving.'}
            </p>
          </div>
        )}

        {/* Active driver cards */}
        {list.map(d => (
          <div
            key={d.driver._id}
            className="driver-card"
            onClick={() => d.location && setFocus([d.location.lat, d.location.lon])}
          >
            <div className="row" style={{ marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                  background: d.stale ? 'var(--amber-bg)' : 'var(--brand-light)',
                  border: `1px solid ${d.stale ? 'rgba(217,119,6,0.25)' : 'rgba(124,58,237,0.2)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: d.stale ? 'var(--amber)' : 'var(--brand)',
                  fontSize: 11, fontWeight: 800,
                }}>
                  {d.driver.name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase()}
                </div>
                <div>
                  <span className="driver-name">{d.driver.name}</span>
                  {d.driver.country && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{d.driver.country}</div>
                  )}
                </div>
              </div>
              <span className={`badge ${d.stale ? 'amber' : 'green'}`}>
                {d.stale ? 'Stale' : 'Moving'}
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
        ))}

        {/* Parked driver cards */}
        {filteredParked.map(p => (
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
                  {p.driver.country && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 1 }}>{p.driver.country}</div>
                  )}
                </div>
              </div>
              <span className="badge gray">Inactive</span>
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
        ))}
      </div>

      {/* ── Map ── */}
      <div className="map-wrap">
        <MapContainer center={initialCenter.current} zoom={13} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <Recenter focus={focus} />

          {/* Active vehicles */}
          {filteredWithLoc.map(d => (
            <Marker
              key={d.driver._id}
              position={[d.location!.lat, d.location!.lon]}
              icon={carIcon(d.location!.heading, d.stale)}
            >
              <Popup>
                <b>{d.driver.name}</b><br />
                {d.vehicle?.plateNumber && <><span>{d.vehicle.plateNumber}</span><br /></>}
                {d.driver.country && <><span>{d.driver.country}</span><br /></>}
                {Math.round(d.location!.speed ?? 0)} km/h<br />
                {d.location!.recordedAt ? new Date(d.location!.recordedAt).toLocaleTimeString() : ''}
              </Popup>
            </Marker>
          ))}

          {/* Parked / inactive vehicles */}
          {filteredParked.filter(p => p.location).map(p => (
            <Marker
              key={`parked-${p.driver._id}`}
              position={[p.location!.lat, p.location!.lon]}
              icon={parkedCarIcon()}
            >
              <Popup>
                <b>{p.driver.name}</b><br />
                {p.vehicle?.plateNumber && <><span>{p.vehicle.plateNumber}</span><br /></>}
                {p.driver.country && <><span>{p.driver.country}</span><br /></>}
                <span style={{ color: '#94a3b8' }}>Inactive · parked</span><br />
                {p.endedAt ? new Date(p.endedAt).toLocaleTimeString() : ''}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
