# 3D Live Vehicle & Drive Visualization — Design

## Goal

Upgrade the admin panel's three Leaflet-based map pages to a 3D view: live
multi-vehicle tracking, live single-trip tracking, and trip replay — so ops
can watch vehicles as tilted 3D models moving over real terrain/buildings
instead of flat 2D markers, and can replay any completed trip exactly as it
happened.

## Scope

**In scope:** admin panel only (`admin-panel/`), three existing pages:

- `LiveMap.tsx` — fleet-wide live tracking (all active drivers)
- `SessionMap.tsx` — single active trip, live auto-refreshing view
- `TripDetail.tsx` — single trip replay (usually completed)

**Out of scope (separate projects):**

- 3D visualization inside the mobile driver app (different tech stack —
  `@rnmapbox/maps` or similar — and drivers don't need a 3D view of their own
  vehicle). Revisit only if explicitly requested later.
- Day-wise KML/JSON trip export. Independent subsystem (backend export +
  admin export UI, no rendering overlap); to be brainstormed as its own spec
  immediately after this one.

## Architecture

New module: `admin-panel/src/lib/map3d/`

- **`Map3D.tsx`** — reusable MapLibre GL canvas wrapper. Loads the
  **OpenFreeMap** vector style (free, no API key, no billing — chosen over
  MapTiler specifically to avoid new account/cost dependencies), sets a
  default camera pitch (~55°) and bearing, and mounts a `@deck.gl/mapbox`
  `MapboxOverlay` so deck.gl layers composite onto the MapLibre map. Catches
  WebGL init failure and renders a plain "3D view isn't supported in this
  browser" message instead of crashing.
- **`VehicleLayer.ts`** — wraps deck.gl's `ScenegraphLayer` around one shared
  glTF vehicle model (`public/models/vehicle.glb`, a free CC0/CC-BY asset,
  e.g. from Kenney.nl or Poly Pizza — attribute if the license requires it).
  Takes `(position, heading, tint)` per instance. A colored halo/ring
  underneath the model carries the moving/stale color signal that today's
  `carIcon` SVG encodes directly, since a glTF model's own material isn't
  easily recolored per-instance.
- **`useInterpolatedPosition(fix)`** — hook that takes the latest
  `{lat, lon, heading, speedKmh, recordedAt}` and animates a smooth current
  position via `requestAnimationFrame`: dead-reckons from speed + heading
  between fixes, corrects toward each new fix as it arrives, and freezes
  (stops extrapolating) when the feed is `stale`.
- **`TripPathLayer.ts`** — wraps deck.gl's `TripsLayer` (fading trail,
  driven by each point's real `recordedAt` timestamp — this is what makes
  replay "exactly as it happened" rather than a simplified path) plus one
  `VehicleLayer` instance whose position at a given `currentTime` is
  interpolated between the two bracketing *real* recorded points. Handles
  trips with 0–1 points by rendering a static marker with no trail/animation.
  Falls back to the last known heading when a point's `heading` is null.

Page components stay thin; all 3D rendering, model loading, and
interpolation logic lives once in `map3d/`.

## Per-page design

### `LiveMap.tsx` (fleet, live)

- Left panel (driver cards, stat pills, Socket.IO connection/reconnect,
  `drivers` state) is unchanged — it already produces exactly what the 3D
  layer needs.
- `<MapContainer>` (Leaflet) → `<Map3D>` with one `VehicleLayer` instance per
  entry in `withLoc`, each fed by its own `useInterpolatedPosition(driver.location)`.
- Clicking a driver card focuses the camera via MapLibre's `flyTo` (animated
  pan + pitch/zoom to the vehicle) instead of Leaflet's `panTo`.
- Click/hover on a vehicle shows the same info (name, plate, speed, time) as
  an HTML overlay positioned at the vehicle's projected screen coordinates.
- Empty state ("No active trips right now") unchanged.

### `SessionMap.tsx` (single trip, live)

- Keeps its existing 10s poll appending new points.
- Renders `TripPathLayer` inside `Map3D` with `currentTime` pinned to "now"
  (the latest point) — no scrubber/speed controls.
- The final live segment uses `useInterpolatedPosition` so motion glides
  between polls instead of snapping every 10s.
- Auto-refresh badge/behavior unchanged.

### `TripDetail.tsx` (single trip, replay)

- Fetches the full `points` array once, as today; top stat row (distance,
  max speed, points, started/ended) unchanged.
- Renders `TripPathLayer` inside `Map3D`, with `currentTime` driven by a new
  `useTripPlayback(points)` hook: a `requestAnimationFrame` loop advancing
  `currentTime += delta * speedMultiplier`, clamped to trip duration,
  pausing at the end.
- New playback control bar: play/pause, a scrubbable timeline slider, and a
  speed multiplier (1x/4x/16x). Dragging the slider sets `currentTime`
  directly and pauses auto-advance until Play is pressed again.

## Dependencies

`admin-panel/package.json` additions: `maplibre-gl`, `deck.gl` (or scoped —
`@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/geo-layers` for `TripsLayer`,
`@deck.gl/mapbox` for the MapLibre overlay), `@loaders.gl/gltf`. Plus the
model asset at `public/models/vehicle.glb`. `maplibre-gl` ships its own TS
types, so no `@types/maplibre-gl` needed.

## Error handling

- WebGL unavailable/init failure → friendly in-page message, no crash. No
  parallel 2D fallback is maintained — internal ops tool, controlled
  browsers, a clear message is enough.
- Stale driver feed → vehicle freezes in place (existing `stale` flag).
- Null `heading` → hold last known heading, never default to a nonsensical 0°.
- Trips with 0–1 points → static marker, no trail/animation, no crash.
- Socket/API fetch failures → unchanged from today's existing try/catch and
  empty states.

## Testing

No test runner exists in `admin-panel` today (no test script, no Vitest/RTL).
This project adds none — verification is manual: `npm run dev`, check all
three pages in a real browser (live fleet with multiple drivers, live
single-trip, and replay with scrub/speed controls).

## Rollout

Straight replacement of the Leaflet map in each of the three pages — no
feature flag, no side-by-side 2D/3D toggle. Small, controlled internal user
base (ops/dispatch) can be told directly if something looks off.
