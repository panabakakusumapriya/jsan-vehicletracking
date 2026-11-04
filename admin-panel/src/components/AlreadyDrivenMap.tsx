import { PathLayer } from '@deck.gl/layers';
import type { PickingInfo } from '@deck.gl/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { km } from '../lib/format';
import { decodeRouteShapes } from '../lib/polyline';

/**
 * "Already driven before", on the trip's map: the stretches of this trip that somebody had driven
 * earlier — so they are not new road for it (no UKM) — each earlier drive in its own colour, with
 * who and when ("already driven on 3 Oct by Ravi") on hover and in a list under the map. Picking a
 * row shows just that drive's road.
 *
 * From GET /api/trips/:id/already-driven?shapes=1 (backend services/alreadyDriven.js), which is
 * measured on the customer's road network when the trip has one — the basis of the UKM figures.
 * Drawn as a wide band under the route line, so the route stays readable on top of it.
 */

type Row = {
  tripId: string;
  driverId: string;
  driverName: string;
  at: string;
  tripStartedAt: string | null;
  meters: number;
  insideMeters: number;
  outsideMeters: number;
  self: boolean;
  shapes?: string[];
};
type Result = {
  computed: boolean;
  reason?: string;
  basis?: 'network' | 'global';
  hasAreas?: boolean;
  repeatMeters?: number;
  rows?: Row[];
  moreTrips?: number;
  moreMeters?: number;
  moreShapes?: string[];
};

/** Not green (new road), amber (outside area) or grey (the rest): those already mean something here. */
const PALETTE: [number, number, number][] = [
  [220, 38, 38], [192, 38, 211], [37, 99, 235], [219, 39, 119], [124, 58, 237],
  [8, 145, 178], [190, 18, 60], [67, 56, 202], [14, 116, 144], [162, 28, 175],
];
const OTHERS: [number, number, number] = [100, 116, 139];
const rgb = (c: [number, number, number]) => `rgb(${c.join(',')})`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

type Piece = { path: [number, number][]; color: [number, number, number]; i: number; row: Row | null };

export function useAlreadyDriven(tripId: string | undefined, enabled: boolean) {
  const [res, setRes] = useState<Result | null>(null);
  const [on, setOn] = useState(true);
  const [picked, setPicked] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!tripId || !enabled) return;
    let alive = true;
    setLoading(true);
    api.get<Result>(`/api/trips/${tripId}/already-driven?shapes=1`)
      .then((r) => { if (alive) setRes(r); })
      .catch(() => { if (alive) setRes(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tripId, enabled]);

  const pieces = useMemo<Piece[]>(() => {
    if (!res?.computed) return [];
    const out: Piece[] = [];
    (res.rows ?? []).forEach((row, i) => {
      for (const s of row.shapes ?? []) {
        const path = decodeRouteShapes([s]) as [number, number][];
        if (path.length > 1) out.push({ path, color: PALETTE[i % PALETTE.length], i, row });
      }
    });
    for (const s of res.moreShapes ?? []) {
      const path = decodeRouteShapes([s]) as [number, number][];
      if (path.length > 1) out.push({ path, color: OTHERS, i: -1, row: null });
    }
    return out;
  }, [res]);

  const layers = useMemo(() => (on && pieces.length ? [
    new PathLayer<Piece>({
      id: 'already-driven',
      data: pieces,
      getPath: (d) => d.path,
      getColor: (d) => [...d.color, picked === null || picked === d.i ? 210 : 35] as [number, number, number, number],
      getWidth: 11,
      widthUnits: 'pixels',
      widthMinPixels: 6,
      capRounded: true,
      jointRounded: true,
      pickable: true,
      updateTriggers: { getColor: [picked] },
    }),
  ] : []), [on, pieces, picked]);

  const getTooltip = useCallback((info: PickingInfo) => {
    if (info.layer?.id !== 'already-driven' || !info.object) return null;
    const p = info.object as Piece;
    if (!p.row) return { html: '<div style="font:12px/1.5 system-ui">Already driven before (one of the earlier drives not listed)</div>' };
    const who = p.row.self ? 'this same driver' : p.row.driverName;
    return {
      html: `<div style="font:12px/1.5 system-ui;padding:2px"><b>Already driven before</b><div>on ${when(p.row.at)}</div><div>by ${who.replace(/</g, '&lt;')}</div><div style="opacity:.7">not new road for this trip</div></div>`,
    };
  }, []);

  return { res, loading, on, setOn, picked, setPicked, layers, getTooltip, hasRoad: pieces.length > 0 };
}

export function AlreadyDrivenPanel({ state }: { state: ReturnType<typeof useAlreadyDriven> }) {
  const { res, loading, on, setOn, picked, setPicked, hasRoad } = state;
  if (loading && !res) {
    return (
      <div className="card" style={{ marginTop: 12, padding: '12px 14px', fontSize: 13, color: 'var(--muted)' }}>
        Checking which of this trip’s road had been driven before…
      </div>
    );
  }
  if (!res?.computed) return null;
  const rows = res.rows ?? [];
  const total = res.repeatMeters ?? 0;

  return (
    <div className="card" style={{ padding: 0, marginTop: 12, overflow: 'hidden' }}>
      <style>{`
        .adp-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
        .adp-head h3 { margin: 0; font-size: 14px; }
        .adp-sub { color: var(--muted); font-size: 12.5px; }
        .adp-toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-2); cursor: pointer; }
        .adp-row { display: grid; grid-template-columns: 14px 1fr auto auto; gap: 10px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--line); cursor: pointer; font-size: 13px; }
        .adp-row:last-child { border-bottom: none; }
        .adp-row:hover { background: var(--panel-2); }
        .adp-row.on { background: var(--brand-light); }
        .adp-row.dim { opacity: .5; }
        .adp-sw { width: 14px; height: 6px; border-radius: 3px; }
        .adp-who b { font-weight: 700; }
        .adp-when { color: var(--muted); font-size: 12px; }
        .adp-km { font-weight: 700; font-variant-numeric: tabular-nums; }
        .adp-split { color: var(--muted); font-size: 11.5px; }
        .adp-link { font-size: 12px; font-weight: 600; }
      `}</style>
      <div className="adp-head">
        <h3>Already driven before</h3>
        <span className="adp-sub">
          {total > 0
            ? `${km(total)} of this trip had been driven before — not new road, so not in its UKM`
            : 'Nothing on this trip had been driven before — all of it was new road'}
        </span>
        {hasRoad && (
          <label className="adp-toggle">
            <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> Show on map
          </label>
        )}
      </div>
      {rows.map((r, i) => {
        const color = PALETTE[i % PALETTE.length];
        const isOn = picked === i;
        return (
          <div
            key={r.tripId}
            className={`adp-row${isOn ? ' on' : ''}${picked !== null && !isOn ? ' dim' : ''}`}
            onClick={() => setPicked(isOn ? null : i)}
            title={isOn ? 'Show every earlier drive again' : 'Show only this drive’s road on the map'}
          >
            <span className="adp-sw" style={{ background: rgb(color) }} />
            <span className="adp-who">
              Already driven on <b>{when(r.at)}</b> by <b>{r.self ? 'this same driver' : r.driverName}</b>
              {res.hasAreas && (r.insideMeters > 0 || r.outsideMeters > 0) && (
                <span className="adp-split">
                  {' · '}{km(r.insideMeters)} inside the driver’s areas, {km(r.outsideMeters)} outside
                </span>
              )}
            </span>
            <span className="adp-km">{km(r.meters)}</span>
            <Link className="adp-link" to={`/trips/${r.tripId}`} onClick={(e) => e.stopPropagation()}>That trip →</Link>
          </div>
        );
      })}
      {(res.moreTrips ?? 0) > 0 && (
        <div className="adp-row" style={{ cursor: 'default' }}>
          <span className="adp-sw" style={{ background: rgb(OTHERS) }} />
          <span className="adp-when">+ {res.moreTrips} more earlier drive{res.moreTrips === 1 ? '' : 's'}</span>
          <span className="adp-km">{km(res.moreMeters ?? 0)}</span>
          <span />
        </div>
      )}
    </div>
  );
}
