/**
 * The vehicle model: a real OBJ+MTL+texture asset (`public/models/car/car.obj`), not a
 * procedural placeholder. Source: "Car" by Poly by Google, via poly.pizza — 1,069 vertices /
 * ~1,100 quads (~2.1k triangles once loaders.gl triangulates them), a single 256x256 texture.
 * Licensed Creative Commons Attribution — credit "Car by Google, via Poly Pizza" wherever the
 * app credits third-party assets.
 *
 * The file here is NOT the untouched download: the source model is Y-up (X=width, Y=up,
 * Z=front-to-back, in arbitrary CG units — a real 4.5m car spans ~89 of them), which is a
 * different convention from what this app's rendering expects. It was re-axised once, offline,
 * into Z-up with the front along local +X (see the git history of this file for the exact
 * transform: newX=oldZ, newY=oldX, newZ=oldY — a determinant +1 rotation, so it preserves
 * winding/handedness and needed no face-flip). That specific remapping — and which end is
 * actually the front — was then confirmed empirically against the real replay map (forced
 * top-down camera, real due-north/due-east test trips), the same way headingToYaw below was:
 * a model's "obvious" front in a static viewer can still end up pointing the wrong way once
 * real map rotation math is involved, so it isn't safe to assume from the source file alone.
 */

export const CAR_MODEL_URL = '/models/car/car.obj';

/**
 * The source model is modeled at arbitrary CG units, not meters (bounding box ~45.5 x 32.3 x
 * 89.1 units for a real ~1.8m x 1.5m x 4.5m car) — SCALE_TO_METERS converts that to actual
 * real-world size. VISIBILITY_BOOST then exaggerates past true scale on top, same as the old
 * procedural mesh did: at any zoom useful for "look at this vehicle", a true-to-scale few-metre
 * object is only a handful of screen pixels. Every real navigation/fleet app does this same
 * exaggeration for its vehicle marker — it's a deliberate legibility choice, not a mistake.
 */
const SCALE_TO_METERS = 4.5 / 89.112803; // calibrated off the model's own recorded length
const VISIBILITY_BOOST = 3;
export const CAR_MODEL_SCALE = SCALE_TO_METERS * VISIBILITY_BOOST;

/**
 * Compass heading (0=N, 90=E, clockwise) -> SimpleMeshLayer yaw (degrees).
 *
 * This was derived empirically against the ACTUAL replay map, not from theory, and went
 * through two wrong answers first — worth recording so nobody re-derives this from an
 * abstract test again and reintroduces the bug:
 *
 * 1. An isolated OrthographicView test (a flat arrow mesh, local +X as its tip) suggested
 *    yaw=0 -> +X, increasing yaw rotating CLOCKWISE, giving yaw = heading - 90. Checked
 *    against a real due-north test trip (forced top-down bearing=0 camera, front tip marked
 *    with an unmistakable colored block): the marker pointed south while the vehicle drove
 *    north. Exactly 180 degrees off.
 * 2. Adding 180 (yaw = heading + 90) fixed north... but a SECOND independent test, due east,
 *    then showed the marker pointing west instead of east — proving the first "fix" was not
 *    a real correction, just a coincidence that happens to cancel out at heading=0 (adding
 *    180 and negating both leave 0 unchanged, so a north-only check can't tell them apart).
 *
 * The actual issue: the real MapView (LNGLAT/Mercator coordinate system) rotates the
 * instanced-mesh yaw the OPPOSITE handedness from the abstract OrthographicView test —
 * counter-clockwise as yaw increases, not clockwise. That's a mirror, not a shift, so no
 * single additive constant could ever have fixed both headings at once. The correct mapping
 * (yaw = 90 - heading) was verified against BOTH the north and the east test trip before
 * being trusted. If this ever needs re-deriving, verify with at least two non-opposite
 * headings, not one — a single test cannot distinguish a mirror from a rotation. This formula
 * assumes the mesh's own front is along local +X, same as carMesh's re-axised OBJ.
 */
export function headingToYaw(heading: number): number {
  return ((90 - heading) % 360 + 360) % 360;
}
