import { PathLayer, ScatterplotLayer, IconLayer } from '@deck.gl/layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { hm, km, sessionDt, statusBadge, tripMs } from '../lib/format';
import { cleanedPaths } from '../lib/polyline';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';
import { pinUrl, type TripMarker } from './TripMarkers';
import type { Trip } from '../lib/types';

/**
 * One driver-day at once: every session of the day side by side with a map of all of them.
 *
 * Opened from a trip's "Details" on the Trips page. The facts come from the rows the page already
 * holds (/api/trips — UKM split, vehicle, status); the routes from /api/trips/merged-points, the
 * Reports day view's endpoint, which buckets the day in the driver's own zone exactly as the page's
 * day rows do. Snapped route where there is one, the raw GPS line otherwise.
 */

interface Segment {
  tripId: string;
  cleanedRouteShapes?: string[] | null;
  importBatchId?: string | null;
  points: { lat: number; lon: number }[];
}

export interface DaySummaryLite {
  driverId: string;
  driverName: string;
  date: string;
  totalTrips: number;
  totalDistance: number;
  assignedUkm?: number;
  outsideUkm?: number;
  splitTrips?: number;
  workMs?: number;
  importedTrips?: number;
  maxSpeed: number;
  firstStart: string;
  lastEnd: string | null;
}

// Distinct, readable on the light basemap; repeats after ten sessions.
const PALETTE: [number, number, number][] = [
  [37, 99, 235], [5, 150, 105], [217, 119, 6], [124, 58, 237], [219, 39, 119],
  [8, 145, 178], [101, 163, 13], [220, 38, 38], [71, 85, 105], [234, 88, 12],
];
const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

const assignedOf = (t: Trip) => (t.linkUkmNetworkMeters == null ? null : t.linkUkmMeters ?? null);
const outsideOf = (t: Trip) =>
  t.linkUkmNetworkMeters == null ? null : Math.max(0, (t.linkUkmNetworkMeters ?? 0) - (t.linkUkmMeters ?? 0));
const plateOf = (v: Trip['vehicleId']) => (typeof v === 'object' && v ? v.plateNumber : null);
const sourceOf = (t: Trip) => (!t.importBatchId ? null : /^vts-/.test(t.importBatchId) ? 'VTS' : 'imported');

export function DayDrawer({
  day,
  trips,
  markers,
  focusTripId,
  onClose,
  backSearch,
}: {
  day: DaySummaryLite;
  trips: Trip[];
  markers: TripMarker[];
  /** The session whose Details was clicked: its card is scrolled into view. The map opens on the
   *  whole day; a session is highlighted only when one is clicked. */
  focusTripId: string | null;
  onClose: () => void;
  /** The Trips page's query string, so "Open trip" comes back to the same view. */
  backSearch: string;
}) {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusTripId) return;
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-trip="${focusTripId}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [focusTripId]);
  const mapRef = useRef<Map3DHandle>(null);
  const ordered = useMemo(() => [...trips].sort((a, b) => +new Date(a.startedAt) - +new Date(b.startedAt)), [trips]);
  const colorOf = useMemo(() => new Map(ordered.map((t, i) => [t._id, PALETTE[i % PALETTE.length]])), [ordered]);

  useEffect(() => {
    let alive = true;
    setSegments(null);
    setError(null);
    api.get<{ trips: Segment[] }>(`/api/trips/merged-points?driverId=${day.driverId}&date=${day.date}`)
      .then((r) => { if (alive) setSegments(r.trips || []); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'The routes could not be loaded'); });
    return () => { alive = false; };
  }, [day.driverId, day.date]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Each session's lines: snapped where there is one, the raw GPS otherwise. */
  const paths = useMemo(() => {
    const out = new Map<string, { lines: [number, number][][]; snapped: boolean }>();
    for (const s of segments || []) {
      const snapped = cleanedPaths(s);
      if (snapped.length) out.set(s.tripId, { lines: snapped, snapped: true });
      else if (s.points.length > 1) out.set(s.tripId, { lines: [s.points.map((p) => [p.lon, p.lat] as [number, number])], snapped: false });
    }
    return out;
  }, [segments]);

  const allCoords = useMemo(() => [...paths.values()].flatMap((p) => p.lines.flat()), [paths]);

  // Frame the whole day once the routes are in, or the picked session when there is one.
  useEffect(() => {
    if (!allCoords.length) return;
    const pick = selected && paths.get(selected);
    const coords = pick ? pick.lines.flat() : allCoords;
    requestAnimationFrame(() => mapRef.current?.fitToRoute(coords));
  }, [allCoords, selected, paths]);

  const layers = useMemo<Layer[]>(() => {
    const data = [...paths.entries()].flatMap(([tripId, p]) => p.lines.map((path) => ({ tripId, path })));
    const ends = [...paths.entries()].flatMap(([tripId, p]) => {
      const first = p.lines[0]?.[0];
      const lastLine = p.lines[p.lines.length - 1];
      const last = lastLine?.[lastLine.length - 1];
      return [first && { tripId, pos: first, kind: 'start' }, last && { tripId, pos: last, kind: 'end' }].filter(Boolean) as { tripId: string; pos: [number, number]; kind: string }[];
    });
    const dim = (id: string) => selected != null && selected !== id;
    return [
      new PathLayer({
        id: 'day-routes',
        data,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: (d: { tripId: string }) => [...(colorOf.get(d.tripId) || PALETTE[0]), dim(d.tripId) ? 70 : 235],
        getWidth: (d: { tripId: string }) => (selected === d.tripId ? 6 : 4),
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        pickable: true,
        onClick: (info: PickingInfo) => { const o = info.object as { tripId: string } | undefined; if (o) setSelected(o.tripId); },
        updateTriggers: { getColor: [selected], getWidth: [selected] },
      }),
      new ScatterplotLayer({
        id: 'day-ends',
        data: ends,
        getPosition: (d: { pos: [number, number] }) => d.pos,
        getFillColor: (d: { kind: string; tripId: string }) => (d.kind === 'start' ? [16, 185, 129, dim(d.tripId) ? 90 : 255] : [239, 68, 68, dim(d.tripId) ? 90 : 255]),
        getLineColor: [255, 255, 255],
        lineWidthMinPixels: 2,
        stroked: true,
        radiusUnits: 'pixels',
        getRadius: 6,
        updateTriggers: { getFillColor: [selected] },
      }),
      new IconLayer({
        id: 'day-markers',
        data: markers,
        getPosition: (m: TripMarker) => [m.lon, m.lat],
        getIcon: (m: TripMarker) => ({ url: pinUrl(m.category?.color), width: 64, height: 80, anchorY: 80 }),
        getSize: 30,
        sizeUnits: 'pixels',
        pickable: true,
      }),
    ];
  }, [paths, colorOf, selected, markers]);

  const snappedTotal = ordered.reduce((s, t) => s + (t.cleanedDistanceMeters ?? 0), 0);
  const measured = (day.splitTrips ?? 0) > 0;
  const center: [number, number] = allCoords[0] || [133.8, -25.3];

  return (
    <div className="dd-backdrop" onClick={onClose}>
      <aside className="dd-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${day.driverName} · ${day.date}`}>
        <header className="dd-head">
          <div>
            <div className="dd-title">{day.driverName}</div>
            <div className="dd-sub">
              {new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
              {' · '}{sessionDt(day.firstStart)} → {day.lastEnd ? sessionDt(day.lastEnd) : 'still driving'}
            </div>
          </div>
          <button type="button" className="dd-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="dd-stats">
          <div><b>{day.totalTrips}</b><span>sessions</span></div>
          <div><b>{km(day.totalDistance)}</b><span>GPS distance</span></div>
          <div><b>{snappedTotal ? km(snappedTotal) : '—'}</b><span>snapped</span></div>
          <div className="blue"><b>{measured ? km(day.assignedUkm ?? 0) : '—'}</b><span>assigned UKM</span></div>
          <div className="amber"><b>{measured ? km(day.outsideUkm ?? 0) : '—'}</b><span>outside UKM</span></div>
          <div><b>{(day.importedTrips ?? 0) >= day.totalTrips ? '—' : hm(day.workMs)}</b><span>working hours</span></div>
          <div><b>{Math.round(day.maxSpeed)}</b><span>km/h top</span></div>
          <div><b>{markers.length}</b><span>markers</span></div>
        </div>

        <div className="dd-body">
          <div className="dd-list" ref={listRef}>
            {selected && (
              <button type="button" className="dd-all" onClick={() => setSelected(null)}>Show the whole day</button>
            )}
            {ordered.map((t, i) => {
              const c = colorOf.get(t._id) || PALETTE[0];
              const p = paths.get(t._id);
              const on = selected === t._id;
              const src = sourceOf(t);
              const tripMarkers = markers.filter((m) => m.tripId === t._id).length;
              return (
                <div
                  key={t._id}
                  data-trip={t._id}
                  className={`dd-card${on ? ' on' : ''}${selected && !on ? ' dim' : ''}`}
                  style={{ borderLeftColor: rgb(c) }}
                  onClick={() => setSelected(on ? null : t._id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setSelected(on ? null : t._id); }}
                >
                  <div className="dd-card-top">
                    <span className="dd-num" style={{ background: rgb(c) }}>{i + 1}</span>
                    <span className="dd-time">{sessionDt(t.startedAt)} → {t.endedAt ? sessionDt(t.endedAt).split(' ').pop() : 'now'}</span>
                    <span className={`badge ${statusBadge(t.status)}`}>{t.status === 'active' ? 'live' : t.status.replace('_', ' ')}</span>
                    {src && <span className="badge gray">{src}</span>}
                  </div>
                  <dl className="dd-facts">
                    <div><dt>Duration</dt><dd>{t.importBatchId ? '—' : hm(tripMs(t))}</dd></div>
                    <div><dt>GPS distance</dt><dd>{km(t.distanceMeters)}</dd></div>
                    <div><dt>Snapped</dt><dd>{t.cleanedDistanceMeters != null ? km(t.cleanedDistanceMeters) : t.status === 'active' ? 'after the trip' : '—'}</dd></div>
                    <div><dt>Assigned UKM</dt><dd className="blue">{assignedOf(t) == null ? (t.linkUkmNetworkMeters == null ? '—' : 'no area') : km(assignedOf(t) ?? 0)}</dd></div>
                    <div><dt>Outside UKM</dt><dd className="amber">{outsideOf(t) == null ? '—' : km(outsideOf(t) ?? 0)}</dd></div>
                    <div><dt>Max speed</dt><dd>{t.importBatchId && !t.pointCount ? '—' : `${Math.round(t.maxSpeedKmh)} km/h`}</dd></div>
                    <div><dt>GPS points</dt><dd>{t.pointCount ? t.pointCount.toLocaleString() : '—'}</dd></div>
                    <div><dt>Vehicle</dt><dd>{plateOf(t.vehicleId) || '—'}</dd></div>
                  </dl>
                  <div className="dd-card-foot">
                    <span className="dd-route-kind">
                      {!segments ? 'loading route…' : !p ? 'no route recorded' : p.snapped ? 'snapped route' : 'raw GPS line (not snapped yet)'}
                      {tripMarkers ? ` · ${tripMarkers} marker${tripMarkers === 1 ? '' : 's'}` : ''}
                    </span>
                    <Link
                      to={t.status === 'active' ? `/trips/${t._id}/map` : `/trips/${t._id}`}
                      state={{ tripsSearch: backSearch }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t.status === 'active' ? 'Live map →' : 'Open trip →'}
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="dd-map">
            {error && <div className="dd-map-note error">{error}</div>}
            {!error && !segments && <div className="dd-map-note">Loading the day’s routes…</div>}
            {segments && !allCoords.length && <div className="dd-map-note">No route was recorded for this day.</div>}
            <Map3D ref={mapRef} center={center} zoom={11} layers={layers} northUp basemap="light" />
          </div>
        </div>
      </aside>
    </div>
  );
}
