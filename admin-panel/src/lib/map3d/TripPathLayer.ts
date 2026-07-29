import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { bearingDeg, lerpHeadingDeg, lerpLatLon } from './geo';
import { createVehicleLayers } from './VehicleLayer';

export interface TripPoint {
  lat: number;
  lon: number;
  heading?: number | null;
  speedKmh?: number;
  recordedAt: string;
}

const TINT: [number, number, number] = [124, 58, 237];
const START_COLOR: [number, number, number] = [5, 150, 105]; // matches the old 2D start markers
const MARKER_LINE_COLOR: [number, number, number] = [255, 255, 255];

/**
 * Start/End ground markers, matching the old 2D Leaflet circle markers.
 * Floated 3m above ground and rendered with depth testing off: these are flat
 * discs at ground level, which nearby 3D building extrusions can occlude from
 * a tilted camera. The vehicle icon (VehicleLayer.ts) gets the same
 * always-on-top treatment for the same reason. Always-on-top is the right
 * call for a marker whose whole job is "be seen".
 */
function startEndMarkerLayers(idPrefix: string, points: TripPoint[], endColor: [number, number, number]) {
  if (points.length === 0) return [];
  const markers: (TripPoint & { kind: 'start' | 'end' })[] = [{ ...points[0], kind: 'start' }];
  if (points.length > 1) markers.push({ ...points[points.length - 1], kind: 'end' });

  return [
    new ScatterplotLayer<TripPoint & { kind: 'start' | 'end' }>({
      id: `${idPrefix}-markers`,
      data: markers,
      getPosition: (d) => [d.lon, d.lat, 3],
      getFillColor: (d) => (d.kind === 'start' ? START_COLOR : endColor),
      getLineColor: MARKER_LINE_COLOR,
      lineWidthMinPixels: 2,
      stroked: true,
      getRadius: 9,
      radiusUnits: 'pixels',
      parameters: { depthCompare: 'always', depthWriteEnabled: false },
    }),
  ];
}

/** Vehicle's interpolated lat/lon/heading at `elapsedMs` since the trip's first point, tracing the real recorded points -- not a simplified path. */
export function vehicleAtElapsed(points: TripPoint[], elapsedMs: number) {
  if (points.length === 0) return null;
  if (points.length === 1) {
    return { lat: points[0].lat, lon: points[0].lon, heading: points[0].heading ?? 0 };
  }

  const t0 = new Date(points[0].recordedAt).getTime();
  const targetMs = t0 + elapsedMs;

  let i = 0;
  while (i < points.length - 2 && new Date(points[i + 1].recordedAt).getTime() < targetMs) {
    i++;
  }
  const a = points[i];
  const b = points[i + 1];
  const ta = new Date(a.recordedAt).getTime();
  const tb = new Date(b.recordedAt).getTime();
  const t = tb > ta ? Math.min(1, Math.max(0, (targetMs - ta) / (tb - ta))) : 0;

  const [lat, lon] = lerpLatLon(a.lat, a.lon, b.lat, b.lon, t);
  // Face the direction actually being animated (the real bearing from A to
  // B), not an interpolation between the two recorded heading *values* --
  // during a sharp turn/U-turn those can be ~180 degrees apart, where
  // "shortest angular path" is ambiguous and can spin the icon through the
  // wrong side of the turn. A geometric bearing between the two points it's
  // moving between can never point the "wrong way" relative to its own
  // on-screen motion. Falls back to the recorded headings when A and B are
  // too close together to give a meaningful bearing (e.g. a real stop).
  const heading =
    bearingDeg(a.lat, a.lon, b.lat, b.lon) ?? lerpHeadingDeg(a.heading ?? b.heading ?? 0, b.heading ?? a.heading ?? 0, t);
  return { lat, lon, heading };
}

/**
 * Replay view (TripDetail): an animated fading trail driven by the points'
 * real recorded timestamps, plus the vehicle at `elapsedMs` into playback.
 * `fading` is only true while actively playing -- TripsLayer's fade shader
 * dims everything toward transparent as it gets further from `currentTime`,
 * which looks fine mid-animation but would make the idle "show the whole
 * completed route" view (currentTime pinned at the end) fade to near-invisible
 * at the start of the route, so it's switched off outside active playback.
 */
export function buildReplayLayers(points: TripPoint[], elapsedMs: number, fading: boolean) {
  if (points.length === 0) return [];

  const t0 = new Date(points[0].recordedAt).getTime();
  const path = points.map((p) => [p.lon, p.lat]);
  const timestamps = points.map((p) => (new Date(p.recordedAt).getTime() - t0) / 1000);

  const layers = [];
  if (points.length > 1) {
    layers.push(
      new TripsLayer({
        id: 'trip-replay-path',
        data: [{ path, timestamps }],
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: TINT,
        opacity: 0.85,
        widthMinPixels: 4,
        fadeTrail: fading,
        trailLength: Math.max(timestamps[timestamps.length - 1], 1),
        currentTime: elapsedMs / 1000,
        capRounded: true,
        jointRounded: true,
      })
    );
  }

  // Fixed start/end markers -- unlike the vehicle (which moves as you scrub),
  // these always show where the trip actually began and finished.
  layers.push(...startEndMarkerLayers('trip-replay', points, [220, 38, 38]));

  const vehicle = vehicleAtElapsed(points, elapsedMs);
  if (vehicle) {
    layers.push(...createVehicleLayers('trip-replay-vehicle', [{ id: 'trip-vehicle', status: 'moving', ...vehicle }]));
  }
  return layers;
}

/**
 * Live view (SessionMap): the full route travelled so far as a static,
 * speed-colored path (no fade/reveal animation -- always shows everything
 * recorded up to now), with the vehicle placed at a separately animated
 * position so motion glides between polls.
 */
export function buildLivePathLayers(
  points: TripPoint[],
  vehicle: { lat: number; lon: number; heading: number } | null,
  stale: boolean
) {
  const layers = [];
  if (points.length > 1) {
    const segments: { path: number[][]; speedKmh: number }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      segments.push({
        path: [[a.lon, a.lat], [b.lon, b.lat]],
        speedKmh: a.speedKmh ?? 0,
      });
    }
    layers.push(
      new PathLayer({
        id: 'trip-live-path',
        data: segments,
        getPath: (d) => d.path,
        getColor: (d) => (d.speedKmh < 40 ? [5, 150, 105] : d.speedKmh < 80 ? [217, 119, 6] : [220, 38, 38]),
        getWidth: 5,
        widthMinPixels: 4,
        capRounded: true,
        jointRounded: true,
      })
    );
  }
  layers.push(...startEndMarkerLayers('trip-live', points, [220, 38, 38]));
  if (vehicle) {
    layers.push(
      ...createVehicleLayers('trip-live-vehicle', [
        { id: 'trip-vehicle', status: stale ? 'stale' : 'moving', ...vehicle },
      ])
    );
  }
  return layers;
}
