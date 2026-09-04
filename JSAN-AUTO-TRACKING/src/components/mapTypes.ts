import type { StyleProp, ViewStyle } from 'react-native';

/**
 * The driver map's contract — shared by the screen (app/map.tsx), the engine
 * (MapNative.tsx) and the engine selector (DriverMap.tsx).
 *
 * Types keep their historical MapGL* names: they predate the native engine and are
 * referenced throughout the screen; renaming them would churn every call site for zero
 * behaviour change.
 */

/**
 * One road exactly as GET /api/tracking/my-roads puts it on the wire — positional, not an object,
 * because 20,000 of these travel over mobile data:
 *   [linkId, funcClass, covered (0 | 1), [[lon, lat], [lon, lat], ...]]
 * Coordinates arrive already rounded to 5 dp (~1 m) by the server.
 */
export type RoadTuple = [string, number, 0 | 1, [number, number][]];

/**
 * A work area to outline. Structurally a subset of MyArea from src/lib/api.ts, so the response of
 * apiMyAreas can be passed straight through with no mapping step.
 */
export interface MapGLArea {
  id: string;
  name: string;
  outline: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: number[][][] | number[][][][];
  } | null;
  bbox?: [number, number, number, number] | null;
}

/**
 * The current drive.
 *
 * `lines` is one entry per unbroken run of positions rather than one flat path, because both
 * sources of a trace come in pieces and the pieces mean something:
 *  - raw GPS has gaps (tunnel, dead battery, permission revoked), and joining across a gap draws a
 *    straight line through streets nobody drove;
 *  - a snapped route is Trip.cleanedRouteShapes, one polyline6 string per matched chunk, and the
 *    space between two chunks is exactly the stretch Valhalla refused to match.
 * decodeRouteShapeLines() in src/lib/polyline.ts produces this shape from cleanedRouteShapes.
 *
 * `kind` drives the visual: raw is dashed to read as provisional, snapped is solid. Per the trace
 * contract the caller switches to 'snapped' once trip.mapMatchStatus === 'matched' and
 * cleanedRouteShapes is non-empty, and drops its cached raw copy at that point.
 */
export interface MapGLTrace {
  kind: 'raw' | 'snapped';
  lines: [number, number][][];
  /** Which trip this trace belongs to — roadCache's TripTrace carries it for free. */
  tripId?: string;
  /**
   * The parts of this drive outside the driver's assigned polygons (Trip.outAreaShapes, decoded),
   * drawn orange over the green trace. Only ever present on a snapped trace — the split is decided
   * server-side after map matching, so a live raw trace has none yet.
   */
  outsideLines?: [number, number][][];
}

/**
 * Every earlier closed trip in the driver's history window, as one flat list of lines.
 * `version` is the change key — same version, nothing re-derived.
 */
export interface MapGLHistory {
  version: string;
  lines: [number, number][][];
}

/** Driver-dropped markers, ready to draw: category colour + id for tap-lookup. */
export interface MapGLMarkers {
  /** Change key — same version, nothing re-derived. */
  version: string;
  points: { id: string; lon: number; lat: number; color: string }[];
}

/**
 * The live breadcrumb drawn ON the phone, from the service's own fixes — no upload, no poll,
 * so the line grows the moment the vehicle moves even when the network is gone. Bounded to
 * the recent stretch: the server's raw trace carries the full route within a poll or two.
 * `version` is a change key — same version, nothing re-derived.
 */
export interface MapGLTrail {
  version: number;
  line: [number, number][];
}

export interface MapGLProps {
  /**
   * Roads from my-roads.
   *
   * IMPORTANT: keep this array reference stable across renders. The engine memoises its derived
   * layer data on IDENTITY — building the array fresh inside the parent's render (say
   * `roads={data.links.map(...)}`) re-derives and re-uploads 20,000 polylines every 15 seconds.
   * The my-roads response is client-cached by `version` precisely so this can stay stable.
   */
  roads?: RoadTuple[];
  /** Work-area outlines. Same stability rule as `roads`. */
  areas?: MapGLArea[];
  /** Current drive. Safe to pass a new object every poll — cheap to re-derive. */
  trace?: MapGLTrace | null;
  /** Live position, [lon, lat]. */
  vehicle?: [number, number] | null;
  /** Route history. Re-derived only when `version` changes. */
  history?: MapGLHistory | null;
  showHistory?: boolean;
  /** Driver-dropped markers. Re-derived only when `version` changes. */
  markers?: MapGLMarkers | null;
  /** Fires when a marker dot is tapped, with the marker's id. */
  onMarkerTap?: (id: string) => void;
  /** Live local breadcrumb for the current trip. */
  trail?: MapGLTrail | null;
  style?: StyleProp<ViewStyle>;
  /**
   * Fires when the map cannot be drawn at all (style failed to load, no GL). The component
   * already shows its own readable message; this exists so the screen can react.
   */
  onUnsupported?: (reason: string) => void;

  /** Basemap style URL. Changing it swaps the style in place. */
  styleUrl?: string;
  /** Camera to open at, from the driver's saved preferences. Overrides auto-framing. */
  initialCamera?: { center: [number, number]; zoom: number } | null;
  /** Layer visibility. Applied live. */
  showAreas?: boolean;
  showRoads?: boolean;
  /**
   * Fires when the driver stops moving the map, so the caller can persist the view. Emitted on
   * move-end after the first real user interaction — it is not a per-frame callback, and
   * auto-framing at load never fires it.
   */
  onCamera?: (center: [number, number], zoom: number) => void;
}

/** Imperative controls, for on-screen zoom and recentre buttons. */
export interface MapGLHandle {
  zoomIn(): void;
  zoomOut(): void;
  /** Centre on the live vehicle if there is one. */
  recenter(): void;
  /** Fly to an explicit [lon, lat] — where the my-location button lands. */
  flyTo(center: [number, number], zoom?: number): void;
}
