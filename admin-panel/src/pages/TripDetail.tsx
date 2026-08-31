import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { DistanceModeToggle, type DistanceMode } from '../components/DistanceModeToggle';
import { ExportButtons } from '../components/ExportButtons';
import { api, downloadFile } from '../lib/api';
import { km, sessionDt, statusBadge } from '../lib/format';
import { Map3D, type Map3DHandle } from '../lib/map3d/Map3D';
import { buildReplayLayers, vehicleAtElapsed } from '../lib/map3d/TripPathLayer';
import { useTripPlayback } from '../lib/map3d/useTripPlayback';
import { decodeRouteShapes } from '../lib/polyline';
import type { Trip } from '../lib/types';

interface PathPoint {
  lat: number;
  lon: number;
  speedKmh: number;
  heading?: number | null;
  recordedAt: string;
}

const SPEEDS = [1, 4, 16];

function formatClock(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Why this distinguishes two cases instead of printing one line: `trip.pointCount` is a counter
 * stored on the trip document as points are ingested, NOT a live count of what the
 * locationpoints collection currently holds. The two diverge the moment points are removed
 * behind the app's back, and the trip then displays a full set of summary stats (distance, max
 * speed, a point count in the thousands) beside an empty map. Saying "not recorded yet" there is
 * actively misleading — the points were recorded, and nothing is coming to fill the gap.
 */
function NoPointsNotice({ pointCount }: { pointCount: number }) {
  const wereRecorded = pointCount > 0;
  return (
    <p className="muted" style={{ marginTop: 12 }}>
      {wereRecorded ? (
        <>
          This trip’s {pointCount.toLocaleString()} recorded location points are no longer available, so its
          route can’t be drawn. The distance, speed and timing figures above were accumulated as the trip
          ran and are unaffected.
        </>
      ) : (
        'No location points recorded for this trip yet.'
      )}
    </p>
  );
}

/**
 * How much of the snapped route is genuinely road-matched.
 *
 * Only rendered in "cleaned" mode, and only when the answer is not "essentially all of it".
 * Where a trace can't be matched — a vehicle circling a car park, or a device that logged 63
 * fixes across 20 km — the backend keeps that stretch's raw GPS geometry rather than dropping it,
 * which keeps the line unbroken but means the route on screen is partly raw. Without this the two
 * cases are indistinguishable: both are just a line on a map, and the more broken the underlying
 * data, the more confident the result looks.
 */
function SnapCoverage({ ratio }: { ratio: number }) {
  const percent = Math.round(ratio * 100);
  const low = percent < 60;
  return (
    <span
      title={`${percent}% of this trip was matched to roads. The rest kept its raw GPS trace because it could not be snapped — usually sparse or missing fixes, or manoeuvring off the road network.`}
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color: low ? 'var(--danger, #dc2626)' : 'var(--muted)',
        background: low ? 'rgba(220,38,38,0.10)' : 'var(--bg)',
      }}
    >
      {percent}% snapped
    </span>
  );
}

/**
 * Context for the UKM figure. Without it a "0.0 km" reads like a bug rather than the correct answer
 * for a driver who spent the day re-covering ground the programme had already driven — which is
 * exactly the case this metric exists to reveal. So when nothing is new, say so in words, and show
 * how much distinct road the trip covered regardless of history.
 *
 * Prefers the GLOBAL figure (road new to every driver and project in the coverage scope) and falls
 * back to the older per-driver one only for trips the global engine has not reached. The two are
 * genuinely different numbers, so the badge says which one is on screen rather than letting a
 * reader assume.
 */
function UkmNote({ trip }: { trip: Trip }) {
  const global = trip.globalUniqueMeters != null;
  const newM = (global ? trip.globalUniqueMeters : trip.ukmMeters) ?? 0;
  const distinctM = (global ? trip.distinctRoadMeters : trip.ukmWithinTripMeters) ?? 0;
  const dupM = trip.historicalDuplicateMeters ?? 0;
  const allRepeated = newM < 50 && distinctM > 0;
  const share = distinctM > 0 ? Math.round((newM / distinctM) * 100) : null;
  const kmOf = (m: number) => (m / 1000).toFixed(1);

  const title = global
    ? 'Global UKM — road this trip covered that NOBODY in the coverage scope had covered before: ' +
      'any driver, any project, including this driver\'s own earlier trips. A road is credited ' +
      'once, to whoever reached it first.' +
      `\n\nDistinct road this trip covered: ${kmOf(distinctM)} km` +
      `\nAlready covered by the programme: ${kmOf(dupM)} km` +
      (trip.sameTripRepeatMeters ? `\nRe-driven within this trip: ${kmOf(trip.sameTripRepeatMeters)} km` : '') +
      (trip.ukmStatus === 'review'
        ? '\n\nFlagged REVIEW: part of the trace could not be snapped to a road, so its identity is not fully established.'
        : '')
    : 'Per-driver UKM — road this trip covered that this DRIVER had not driven before. The global ' +
      'figure (which also excludes road other drivers covered first) has not been computed for ' +
      'this trip yet.' +
      (distinctM > 0 ? `\n\nDistinct road within this trip: ${kmOf(distinctM)} km.` : '');

  return (
    <span
      title={title}
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 7px',
        borderRadius: 999,
        whiteSpace: 'nowrap',
        color: allRepeated ? 'var(--muted)' : 'var(--brand)',
        background: allRepeated ? 'var(--bg)' : 'var(--brand-light)',
      }}
    >
      {allRepeated
        ? 'all previously covered'
        : share != null
          ? `${share}% of ${kmOf(distinctM)} km new`
          : 'new'}
    </span>
  );
}

/**
 * Says which of the two UKM definitions the number beside it is.
 *
 * `per-driver` is deliberately amber, not grey. It is not a neutral label — it means the figure on
 * screen still counts road other drivers may already have covered, so it can only ever be too HIGH.
 * Rendered quietly, it reads as a finished number and nobody asks why it never changed.
 */
function UkmScopeBadge({ trip }: { trip: Trip }) {
  const global = trip.globalUniqueMeters != null;
  return (
    <span
      title={global
        ? `Global UKM: deduplicated across every driver and project in coverage scope "${trip.coverageScopeId ?? 'default'}".`
        : 'NOT the global figure. This counts road that other drivers may already have covered, so it '
          + 'may be too high. The global figure has not been computed for this trip yet.'}
      style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
        padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap',
        color: global ? 'var(--brand)' : '#b45309',
        border: `1px solid ${global ? 'var(--brand)' : '#f0b429'}`,
        background: global ? undefined : 'rgba(217,119,6,0.10)',
      }}
    >
      {global ? 'global' : 'per-driver'}
    </span>
  );
}

/* ── Who already had this road ──
 *
 * The breakdown behind the "Already covered" tile: for every piece of road this trip drove that
 * somebody else got to first, the ledger knows exactly who, on which project, and when.
 *
 * These rows ADD UP to the "Already covered" total, and that is worth stating because the
 * specification warns — correctly — that per-driver overlap figures must never be summed. That
 * warning is about measuring a route separately against each previous driver, where the previous
 * drivers overlap each other and the sum double counts. This is the other thing: every piece of
 * road has exactly ONE first owner, so grouping by that owner partitions the distance. Each metre
 * appears in exactly one row. The backend returns `totalKm` so the sum can be checked rather than
 * assumed.
 */
interface OverlapRow {
  driverId: string;
  driverName: string;
  projectName: string | null;
  projectHint: string | null;
  km: number;
  segments: number;
  tripCount: number;
  sampleTripId: string;
  firstAt: string;
  lastAt: string;
  selfOverlap: boolean;
}
interface OverlapResult {
  computed: boolean;
  totalKm: number;
  unattributedKm: number;
  rows: OverlapRow[];
}

function OverlapBreakdown({ tripId }: { tripId: string }) {
  const [data, setData] = useState<OverlapResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<OverlapResult>(`/api/trips/${tripId}/ukm-overlap`);
        if (!cancelled) setData(res);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load breakdown');
      }
    })();
    return () => { cancelled = true; };
  }, [tripId]);

  if (error) return <div className="error-text" style={{ padding: '10px 14px' }}>{error}</div>;
  if (!data) return <div className="muted" style={{ padding: '10px 14px', fontSize: 13 }}>Loading breakdown…</div>;
  if (!data.computed) {
    return (
      <div style={{ padding: '4px 14px 10px', fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Not computed yet — this is not zero.</div>
        <div style={{ color: 'var(--muted)' }}>
          Nobody has worked out what this trip re-covered, so the UKM shown above is still the older
          per-driver figure: it excludes road <i>this</i> driver had already driven, but not road
          another driver covered first. It can therefore only be too high, never too low.
          <br /><br />
          Trips are attributed automatically once map-matching finishes. If this trip has been
          matched for a while and still says pending, the server handling it is most likely running
          a build without the global-UKM engine, or the backlog has not reached it — an
          administrator can clear both by deploying the backend and running{' '}
          <code>npm run backfill:global-ukm</code>.
        </div>
      </div>
    );
  }
  if (!data.rows.length) {
    return (
      <div className="muted" style={{ padding: '10px 14px', fontSize: 13 }}>
        Nobody had covered any of this road before — all of it counted as new.
      </div>
    );
  }

  // Own ground versus somebody else's. On this fleet the overwhelming majority of repeat road is a
  // driver re-covering their own earlier route, which is a route-planning problem; another crew
  // getting there first is a coordination problem. Different problems, so they are totalled apart.
  const selfKm = data.rows.filter((r) => r.selfOverlap).reduce((t, r) => t + r.km, 0);
  const othersKm = data.rows.filter((r) => !r.selfOverlap).reduce((t, r) => t + r.km, 0);
  const day = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <div style={{ padding: '4px 0 0' }}>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '0 14px 10px', fontSize: 12.5 }}>
        <span>
          <span style={{ color: 'var(--muted)' }}>Total already covered: </span>
          <b>{data.totalKm.toLocaleString()} km</b>
        </span>
        <span title="Road this same driver had covered on an earlier trip">
          <span style={{ color: 'var(--muted)' }}>Own earlier trips: </span>
          <b>{selfKm.toFixed(2)} km</b>
        </span>
        <span title="Road another driver in the coverage scope covered first">
          <span style={{ color: 'var(--muted)' }}>Other drivers: </span>
          <b style={{ color: othersKm > 0 ? '#dc2626' : undefined }}>{othersKm.toFixed(2)} km</b>
        </span>
        {data.unattributedKm > 0 && (
          <span
            title="Road with no ledger entry — the trip's geometry changed after it was attributed, so these figures are stale. Re-run attribution."
            style={{ color: '#d97706' }}
          >
            <b>{data.unattributedKm.toFixed(2)} km unattributed</b>
          </span>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Covered first by</th>
              <th>Project</th>
              <th>When</th>
              <th style={{ textAlign: 'right' }}>Trips</th>
              <th style={{ textAlign: 'right' }}>Distance</th>
              <th style={{ textAlign: 'right' }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={`${r.driverId}-${r.projectName ?? ''}`}>
                <td>
                  <span style={{ fontWeight: 600 }}>{r.driverName}</span>
                  {r.selfOverlap && (
                    <span
                      title="This trip's own driver, on an earlier trip"
                      style={{
                        marginLeft: 8, fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                        textTransform: 'uppercase', padding: '1px 6px', borderRadius: 4,
                        color: 'var(--muted)', border: '1px solid var(--line-2)',
                      }}
                    >
                      same driver
                    </span>
                  )}
                </td>
                <td>
                  {r.projectName ?? (
                    <span
                      style={{ color: 'var(--muted)' }}
                      title={r.projectHint
                        ? `That trip carried no project. "${r.projectHint}" is the driver's project today, which is not evidence of what they were working on then.`
                        : 'That trip carried no project.'}
                    >
                      {r.projectHint ? `— (now ${r.projectHint})` : '—'}
                    </span>
                  )}
                </td>
                <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>
                  {day(r.firstAt)}
                  {day(r.lastAt) !== day(r.firstAt) && ` – ${day(r.lastAt)}`}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {r.tripCount === 1 ? (
                    <Link to={`/trips/${r.sampleTripId}`} title="Open the trip that covered it">1</Link>
                  ) : r.tripCount}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.km.toLocaleString()} km</td>
                <td style={{ textAlign: 'right', color: 'var(--muted)' }}>
                  {data.totalKm > 0 ? `${((r.km / data.totalKm) * 100).toFixed(1)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ padding: '8px 14px 2px', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.55 }}>
        Every piece of road belongs to exactly one first coverer, so these rows add up to the total
        above — no metre is counted twice. "Trips" is how many of that driver's trips contributed;
        click through when it was just one.
      </div>
    </div>
  );
}

export function TripDetail() {
  const { id } = useParams<{ id: string }>();
  // The trips list passes its filters/page/expanded-rows query string along so "← Back to
  // trips" returns to the exact view this trip was opened from, not a reset page 1.
  const tripsSearch = (useLocation().state as { tripsSearch?: string } | null)?.tripsSearch ?? '';
  const [trip, setTrip] = useState<Trip | null>(null);
  const [points, setPoints] = useState<PathPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<DistanceMode>('raw');
  // The "Already covered" tile is a disclosure: closed it is a number, open it says who had the
  // road first. Fetched only when opened — most readers want the number, not the audit.
  const [showOverlap, setShowOverlap] = useState(false);
  const mapRef = useRef<Map3DHandle>(null);
  const lastFlyRef = useRef(0);

  useEffect(() => {
    if (!id) return;
    api
      .get<{ trip: Trip; points?: PathPoint[] }>(`/api/trips/${id}?points=true`)
      .then((r) => {
        setTrip(r.trip);
        setPoints(r.points ?? []);
      })
      .finally(() => setLoading(false));
  }, [id]);

  // Show the whole recorded route, not just a fixed zoom on its first point.
  useEffect(() => {
    if (points.length > 0) {
      mapRef.current?.fitToRoute(points.map((p) => [p.lon, p.lat]));
    }
  }, [points]);

  const playback = useTripPlayback(points);

  const cleanedAvailable = trip?.mapMatchStatus === 'matched' && !!trip.cleanedRouteShapes?.length;
  const snappedPath = useMemo(
    () => (mode === 'cleaned' ? decodeRouteShapes(trip?.cleanedRouteShapes) : null),
    [mode, trip]
  );
  // Each UKM stretch stays a separate path: joining them would draw a straight line across the
  // repeated road in between and highlight ground the driver had already covered.
  //
  // Prefers ukmUniqueShapes — the GLOBAL verdict, where a street another crew drove first is not
  // highlighted — and falls back to the per-driver ukmNewShapes for trips the global engine has
  // not reached. Both come from the server; nothing here decides what counts as new.
  const ukmPaths = useMemo(() => {
    if (mode !== 'cleaned') return null;
    const shapes = trip?.ukmUniqueShapes?.length ? trip.ukmUniqueShapes : trip?.ukmNewShapes;
    if (!shapes?.length) return null;
    return shapes.map((s) => decodeRouteShapes([s])).filter((p) => p.length > 1);
  }, [mode, trip]);

  // Camera follows the vehicle during playback — rotates to face the driving
  // direction so it feels like you're travelling along the route. Throttled to
  // ~500ms for smooth continuous movement without overwhelming the map.
  useEffect(() => {
    if (!playback.playing || points.length === 0) return;
    const now = Date.now();
    if (now - lastFlyRef.current < 500) return;
    lastFlyRef.current = now;
    const vehicle = vehicleAtElapsed(points, playback.currentTimeMs);
    if (vehicle) {
      mapRef.current?.driveTo([vehicle.lon, vehicle.lat], vehicle.heading);
    }
  }, [playback.currentTimeMs, playback.playing, points]);

  const layers = useMemo(
    () => buildReplayLayers(points, playback.currentTimeMs, playback.playing, snappedPath, ukmPaths),
    [points, playback.currentTimeMs, playback.playing, snappedPath, ukmPaths]
  );

  if (loading) return <div className="muted">Loading trip…</div>;
  if (!trip) return <div className="muted">Trip not found.</div>;

  const start: [number, number] = points[0] ? [points[0].lon, points[0].lat] : [78.45, 17.42];
  const driver = typeof trip.driverId === 'object' ? trip.driverId.name : 'Driver';

  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">
          Trip · {driver} <span className={`badge ${statusBadge(trip.status)}`}>{trip.status}</span>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <DistanceModeToggle mode={mode} onChange={setMode} cleanedAvailable={cleanedAvailable} />
          <ExportButtons
            snappedAvailable={cleanedAvailable}
            onExport={(format, layer) => downloadFile(`/api/trips/${id}/export?format=${format}&layer=${layer}`)}
          />
          <Link to={`/trips${tripsSearch ? `?${tripsSearch}` : ''}`} className="btn-ghost">
            ← Back to trips
          </Link>
        </div>
      </div>

      <div className="stat-row">
        <div className="stat">
          <div className="v">{km(mode === 'cleaned' && trip.cleanedDistanceMeters != null ? trip.cleanedDistanceMeters : trip.distanceMeters)}</div>
          <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span>Distance{mode === 'cleaned' ? ' (snapped)' : ''}</span>
            {mode === 'cleaned' && trip.cleanedMatchedRatio != null && trip.cleanedMatchedRatio < 0.98 && (
              <SnapCoverage ratio={trip.cleanedMatchedRatio} />
            )}
          </div>
        </div>
        {/*
          UKM (unique kilometers) for this trip. Sits next to Distance because the comparison is the
          whole point: 70 km driven of which 12 km unique says something Distance alone cannot.
          Follows the Raw/Snapped filter rather than showing in both: the figure is computed from
          the snapped route, so presenting it beside a raw distance would invite the reader to
          subtract two numbers that were measured differently. Hidden until the trip is matched
          too — a dash would imply "no unique road" when the truth is "not computed yet".
        */}
        {mode === 'cleaned' && (trip.globalUniqueMeters ?? trip.ukmMeters) != null && (
          <div className="stat">
            <div className="v">{km(trip.globalUniqueMeters ?? trip.ukmMeters ?? 0)}</div>
            <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span title="Unique kilometers">UKM</span>
              <UkmScopeBadge trip={trip} />
              <UkmNote trip={trip} />
            </div>
          </div>
        )}
        {/* The road this trip covered that the programme already had. Shown next to UKM because
            the pair is the whole story — 27 km of road of which 12 km was already ours says
            something neither number says alone. */}
        {/* Present on EVERY matched trip, including the ones with no figure yet.
            Hiding it when the answer is unknown was worse than useless: the page then looked
            different from driver to driver for no visible reason, and a reader could only
            conclude the feature was broken. An explicit "—  pending" says which of the two
            situations they are in, and the dropdown explains what to do about it. */}
        {mode === 'cleaned' && cleanedAvailable && (
          <div
            className="stat"
            role="button"
            tabIndex={0}
            onClick={() => setShowOverlap((v) => !v)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowOverlap((v) => !v); } }}
            style={{ cursor: 'pointer' }}
            title={trip.historicalDuplicateMeters != null
              ? 'Show which driver and project covered this road first'
              : 'This trip has no global coverage figure yet'}
          >
            <div className="v" style={{ color: 'var(--muted)' }}>
              {trip.historicalDuplicateMeters != null ? km(trip.historicalDuplicateMeters) : '—'}
            </div>
            <div className="k" style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              <span>Already covered</span>
              {trip.historicalDuplicateMeters == null && (
                <span
                  title="Not yet computed. This is NOT zero — nobody has worked out what this trip re-covered."
                  style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
                    padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap',
                    color: '#b45309', border: '1px solid #f0b429', background: 'rgba(217,119,6,0.10)',
                  }}
                >
                  pending
                </span>
              )}
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: showOverlap ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>
        )}
        <div className="stat">
          <div className="v">{Math.round(trip.maxSpeedKmh)} km/h</div>
          <div className="k">Max speed</div>
        </div>
        <div className="stat">
          <div className="v">{trip.pointCount}</div>
          <div className="k">Points</div>
        </div>
        <div className="stat">
          <div className="v" style={{ fontSize: 15 }}>{sessionDt(trip.startedAt)}</div>
          <div className="k">Started</div>
        </div>
        <div className="stat">
          <div className="v" style={{ fontSize: 15 }}>{sessionDt(trip.endedAt)}</div>
          <div className="k">Ended</div>
        </div>
      </div>

      {showOverlap && mode === 'cleaned' && cleanedAvailable && (
        <div className="card" style={{ padding: '12px 0 6px', marginBottom: 12 }}>
          <div style={{ padding: '0 14px 6px', fontSize: 13, fontWeight: 700 }}>
            Who covered this road first
          </div>
          <OverlapBreakdown tripId={trip._id} />
        </div>
      )}

      <div className="map-wrap" style={{ height: 'calc(100vh - 340px - var(--topbar-h))', minHeight: 380, position: 'relative' }}>
        <Map3D ref={mapRef} center={start} zoom={14} layers={layers} />
        {/* Two colours on a map need saying out loud — without this the muted stretches read as
            a rendering glitch rather than "the driver had been here before". */}
        {ukmPaths && ukmPaths.length > 0 && (
          <div
            style={{
              position: 'absolute', bottom: 12, left: 12, zIndex: 1,
              background: 'var(--panel)', border: '1px solid var(--line-2)',
              borderRadius: 'var(--radius)', padding: '8px 11px',
              display: 'flex', flexDirection: 'column', gap: 6,
              fontSize: 11.5, fontWeight: 600, boxShadow: '0 1px 4px rgba(0,0,0,0.10)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 16, height: 4, borderRadius: 2, background: 'rgb(16,185,129)' }} />
              UKM — new road this trip
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
              <span style={{ width: 16, height: 4, borderRadius: 2, background: 'rgb(148,163,184)' }} />
              {trip.globalUniqueMeters != null ? 'Already covered by the programme' : 'Driven on an earlier trip'}
            </span>
          </div>
        )}
      </div>

      {points.length > 1 && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 12,
            padding: '10px 14px', background: 'var(--panel)', border: '1px solid var(--line-2)',
            borderRadius: 'var(--radius-lg)',
          }}
        >
          <button
            className="btn"
            style={{ minWidth: 72 }}
            onClick={() => {
              if (playback.playing) {
                playback.pause();
                // Zoom back to full route on pause
                if (points.length > 0) {
                  mapRef.current?.fitToRoute(points.map(p => [p.lon, p.lat]));
                }
              } else {
                playback.play();
                lastFlyRef.current = 0;
                // Immediately enter driving view on play start
                const startMs = playback.currentTimeMs >= playback.durationMs ? 0 : playback.currentTimeMs;
                const pos = vehicleAtElapsed(points, startMs);
                if (pos) {
                  mapRef.current?.driveTo([pos.lon, pos.lat], pos.heading);
                }
              }
            }}
          >
            {playback.playing ? '⏸ Pause' : '▶ Play'}
          </button>

          <span style={{ fontSize: 12.5, color: 'var(--muted)', fontFamily: 'monospace', minWidth: 90 }}>
            {formatClock(playback.currentTimeMs)} / {formatClock(playback.durationMs)}
          </span>

          <input
            type="range"
            min={0}
            max={playback.durationMs}
            value={playback.currentTimeMs}
            onChange={(e) => playback.seek(Number(e.target.value))}
            style={{ flex: 1 }}
          />

          <div style={{ display: 'flex', gap: 4 }}>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className="btn-ghost"
                style={{
                  padding: '4px 9px', fontSize: 12, fontWeight: 700,
                  background: playback.speed === s ? 'var(--brand-light)' : undefined,
                  color: playback.speed === s ? 'var(--brand)' : undefined,
                }}
                onClick={() => playback.setSpeed(s)}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      )}

      {points.length === 0 && <NoPointsNotice pointCount={trip.pointCount} />}
    </div>
  );
}
