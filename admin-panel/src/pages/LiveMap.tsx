import { useEffect, useState } from 'react';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import type { Socket } from 'socket.io-client';
import { api } from '../lib/api';
import { createSocket } from '../lib/socket';
import { useAuth } from '../lib/auth';
import { km } from '../lib/format';
import type { LiveDriver, LocationEvent } from '../lib/types';

function Recenter({ focus }: { focus: [number, number] | null }) {
  const map = useMap();
  useEffect(() => { if (focus) map.setView(focus, 15, { animate: true }); }, [focus, map]);
  return null;
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
  const center: [number, number] = withLoc[0]?.location
    ? [withLoc[0].location!.lat, withLoc[0].location!.lon]
    : [17.42, 78.45];

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
            <div className="driver-meta" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
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
            </div>
          </div>
        ))}
      </div>

      {/* ── Map ── */}
      <div className="map-wrap">
        <MapContainer center={center} zoom={13} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution="&copy; OpenStreetMap contributors"
          />
          <Recenter focus={focus} />
          {withLoc.map(d => (
            <CircleMarker
              key={d.driver._id}
              center={[d.location!.lat, d.location!.lon]}
              radius={10}
              pathOptions={{
                color: '#fff', weight: 2.5,
                fillColor: d.stale ? '#d97706' : '#059669',
                fillOpacity: 1,
              }}
            >
              <Popup>
                <b>{d.driver.name}</b><br />
                {d.vehicle?.plateNumber && <><span>{d.vehicle.plateNumber}</span><br /></>}
                {Math.round(d.location!.speed ?? 0)} km/h<br />
                {d.location!.recordedAt ? new Date(d.location!.recordedAt).toLocaleTimeString() : ''}
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
