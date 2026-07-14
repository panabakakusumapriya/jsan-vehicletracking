import { useEffect, useRef, useState } from 'react';
import { divIcon } from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { Link } from 'react-router-dom';
import type { Socket } from 'socket.io-client';
import { api } from '../lib/api';
import { createSocket } from '../lib/socket';
import { useAuth } from '../lib/auth';
import { km } from '../lib/format';
import type { LiveDriver, LocationEvent } from '../lib/types';

function Recenter({ focus }: { focus: [number, number] | null }) {
  const map = useMap();
  // panTo preserves the user's current zoom level instead of forcing a fixed zoom.
  useEffect(() => { if (focus) map.panTo(focus, { animate: true }); }, [focus, map]);
  return null;
}

// Top-down car marker that rotates to point in the driver's direction of travel.
// Green = moving, amber = stale (no recent fix).
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

export function LiveMap() {
  const { token } = useAuth();
  const [drivers, setDrivers] = useState<Record<string, LiveDriver>>({});
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket: Socket | undefined;
    (async () => {
      try {
        const { drivers: list } = await api.get<{ drivers: LiveDriver[] }>('/api/tracking/live');
        const map: Record<string, LiveDriver> = {};
        list.forEach(d => { map[d.driver._id] = d; });
        setDrivers(map);
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
      });
    })();
    return () => { socket?.close(); };
  }, [token]);

  const list    = Object.values(drivers);
  const withLoc = list.filter(d => d.location);

  // Stable initial center — captured once when the first driver location arrives.
  // Never updated after that so socket events don't cause MapContainer to reset the view.
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

        {/* Stat pills */}
        <div className="live-stats">
          <div className="live-stat-pill">
            <div className="v" style={{ color: 'var(--green)' }}>{withLoc.length}</div>
            <div className="k">Active</div>
          </div>
          <div className="live-stat-pill">
            <div className="v">{list.length}</div>
            <div className="k">On duty</div>
          </div>
        </div>

        {/* Empty */}
        {list.length === 0 && (
          <div style={{
            background: 'var(--panel)', border: '1.5px dashed var(--line-2)',
            borderRadius: 'var(--radius-lg)', textAlign: 'center',
            padding: '36px 20px',
          }}>
            <div style={{ fontSize: 36, marginBottom: 10, opacity: 0.25 }}>🚗</div>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13, lineHeight: 1.6 }}>
              No active trips right now.<br />Drivers appear here when moving.
            </p>
          </div>
        )}

        {/* Driver cards */}
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
                <span className="driver-name">{d.driver.name}</span>
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
      </div>

      {/* ── Map ── */}
      <div className="map-wrap">
        <MapContainer center={initialCenter.current} zoom={13} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <Recenter focus={focus} />
          {withLoc.map(d => (
            <Marker
              key={d.driver._id}
              position={[d.location!.lat, d.location!.lon]}
              icon={carIcon(d.location!.heading, d.stale)}
            >
              <Popup>
                <b>{d.driver.name}</b><br />
                {d.vehicle?.plateNumber && <><span>{d.vehicle.plateNumber}</span><br /></>}
                {Math.round(d.location!.speed ?? 0)} km/h<br />
                {d.location!.recordedAt ? new Date(d.location!.recordedAt).toLocaleTimeString() : ''}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
