import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { km } from '../lib/format';

/**
 * Hovering a trip on the Trips page: the road it drove that somebody had ALREADY driven — on which
 * date, by whom, inside or outside the area — none of which counts toward this trip's UKM. So a
 * trip with 30 km driven and 2 km of UKM explains itself. GET /api/trips/:id/already-driven,
 * backend/src/services/alreadyDriven.js.
 */

interface AlreadyDriven {
  computed: boolean;
  reason?: string;
  basis?: 'network' | 'global';
  hasAreas?: boolean;
  ownInsideMeters?: number;
  ownOutsideMeters?: number;
  repeatMeters?: number;
  clearedMeters?: number;
  moreTrips?: number;
  moreMeters?: number;
  rows?: {
    tripId: string;
    driverName: string;
    at: string;
    meters: number;
    insideMeters: number;
    outsideMeters: number;
    self: boolean;
  }[];
}

// One answer per trip for the life of the page: hovering back and forth must not refetch.
const cache = new Map<string, Promise<AlreadyDriven>>();
function load(tripId: string) {
  let p = cache.get(tripId);
  if (!p) {
    p = api.get<AlreadyDriven>(`/api/trips/${tripId}/already-driven`);
    // A failure is not remembered, so the next hover tries again.
    p.catch(() => cache.delete(tripId));
    cache.set(tripId, p);
  }
  return p;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const REASON: Record<string, string> = {
  pending: 'Not worked out yet — the trip is still open or waiting to be snapped to roads.',
  failed: 'The route could not be snapped to roads, so there is nothing to compare.',
  skipped: 'A parked-phone session, not a drive — it counts for nothing.',
  review: 'Only part of the route could be snapped to roads.',
};

export function AlreadyDrivenTip({ tripId, x, y }: { tripId: string; x: number; y: number }) {
  const [data, setData] = useState<AlreadyDriven | null>(null);
  const [error, setError] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 16, top: y + 14 });

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    load(tripId)
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [tripId]);

  // Beside the pointer, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = x + 16;
    let top = y + 14;
    if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 16);
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 14);
    setPos({ left, top });
  }, [x, y, data, error]);

  const repeat = data?.repeatMeters ?? 0;
  return (
    <div ref={ref} className="ad-tip" style={{ left: pos.left, top: pos.top }} role="tooltip">
      {error ? (
        <div className="ad-muted">Could not load what was driven before.</div>
      ) : !data ? (
        <div className="ad-muted">Checking what was already driven…</div>
      ) : !data.computed ? (
        <div className="ad-muted">{REASON[data.reason || ''] || 'Nothing to compare yet.'}</div>
      ) : (
        <>
          <div className="ad-head">
            {repeat > 0 ? (
              <>Already driven before — <b>{km(repeat)}</b> not counted in this trip</>
            ) : (
              <>Nothing on this trip had been driven before — all of it counts</>
            )}
          </div>
          {(data.rows ?? []).map((r) => (
            <div key={r.tripId} className="ad-row">
              <span className="ad-date">{day(r.at)}</span>
              <span className="ad-who">{r.self ? 'their own earlier drive' : r.driverName}</span>
              <span className="ad-km">{km(r.meters)}</span>
              {data.hasAreas && (
                <span className="ad-where">
                  {r.insideMeters > 0 && r.outsideMeters > 0
                    ? `${km(r.insideMeters)} inside · ${km(r.outsideMeters)} outside`
                    : r.insideMeters > 0 ? 'inside area' : 'outside area'}
                </span>
              )}
            </div>
          ))}
          {(data.moreTrips ?? 0) > 0 && (
            <div className="ad-row ad-muted">and {data.moreTrips} more earlier drives · {km(data.moreMeters ?? 0)}</div>
          )}
          {(data.clearedMeters ?? 0) > 0 && (
            <div className="ad-row ad-muted">{km(data.clearedMeters ?? 0)} in an area whose driven data was cleared since — counts for no one</div>
          )}
          <div className="ad-foot">
            This trip earned{' '}
            {data.hasAreas ? (
              <>
                <b>{km(data.ownInsideMeters ?? 0)}</b> assigned · <b>{km(data.ownOutsideMeters ?? 0)}</b> outside
              </>
            ) : (
              <>
                <b>{km(data.ownOutsideMeters ?? 0)}</b> {data.basis === 'global' ? 'of new road' : 'outside (no area held)'}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
