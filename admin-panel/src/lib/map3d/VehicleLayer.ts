import { registerLoaders } from '@loaders.gl/core';
import { OBJLoader } from '@loaders.gl/obj';
import { ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CAR_MODEL_URL, CAR_MODEL_SCALE, headingToYaw } from './carMesh';

// SimpleMeshLayer's `mesh: <url>` form needs a loader registered for the file's extension, or
// it has no way to parse the .obj it fetches.
registerLoaders([OBJLoader]);

const CAR_TEXTURE_URL = CAR_MODEL_URL.replace(/\.obj$/, '.png');

export type VehicleStatus = 'moving' | 'stale';

export interface VehicleInstance {
  id: string;
  lat: number;
  lon: number;
  heading: number;
  status: VehicleStatus;
}

const STATUS_COLOR: Record<VehicleStatus, [number, number, number]> = {
  moving: [5, 150, 105],
  stale: [217, 119, 6],
};

/**
 * Vehicle rendering for the single-vehicle trip pages: a colored ground halo (moving/stale
 * signal) plus a real 3D car model (a real downloaded asset, not a procedural placeholder —
 * see carMesh.ts), oriented to face the direction of travel.
 *
 * Previously this was a 2D emoji billboard (🚗 drawn onto a canvas and used as an IconLayer
 * atlas). That approach had a real, confirmed bug: the rotation formula assumed the emoji's
 * default facing was west, based on how it renders on Apple/most platforms, but on this
 * Windows deployment the system emoji font (Segoe UI Emoji) draws 🚗 facing EAST instead —
 * a 180-degree handedness mismatch, which is exactly "the car drives backwards". A real 3D
 * mesh sidesteps the whole problem — its "front" is real geometry with a known local axis,
 * not a font glyph whose default orientation varies by OS/renderer.
 */
// Ground-level markers get occluded by nearby 3D building extrusions from a tilted/overhead
// camera -- the same reason startEndMarkerLayers (in TripPathLayer.ts) disables depth testing.
// Confirmed this applies to the car model too, not just the flat halo decal: at the close,
// low-angle pitch the replay camera uses, even a properly-sized car model routinely sits
// behind nearby buildings from the camera's viewpoint, since it's much shorter than they are.
// Both layers need this, or the "always be seen" guarantee only holds for the ground glow.
const ALWAYS_ON_TOP = { depthCompare: 'always', depthWriteEnabled: false } as const;

export function createVehicleLayers(idPrefix: string, data: VehicleInstance[]) {
  return [
    new ScatterplotLayer<VehicleInstance>({
      id: `${idPrefix}-halo`,
      data,
      getPosition: (d) => [d.lon, d.lat, 0],
      getFillColor: (d) => [...STATUS_COLOR[d.status], 90],
      getRadius: 6,
      radiusUnits: 'meters',
      radiusMinPixels: 10,
      parameters: ALWAYS_ON_TOP,
    }),
    new SimpleMeshLayer<VehicleInstance>({
      id: `${idPrefix}-model`,
      data,
      mesh: CAR_MODEL_URL,
      texture: CAR_TEXTURE_URL,
      getPosition: (d) => [d.lon, d.lat, 0],
      getOrientation: (d) => [0, headingToYaw(d.heading), 0],
      // carMesh.ts's CAR_MODEL_SCALE converts the model's arbitrary CG units to real metres,
      // then exaggerates past true scale for visibility -- at any zoom useful for "look at
      // this vehicle", a true-to-scale few-metre object is only a handful of screen pixels.
      // Every real navigation/fleet app does the same exaggeration; it's deliberate, not a
      // mistake. Still grows/shrinks with zoom like a real object (unlike the old fixed-28px
      // 2D icon), just anchored around a size that's actually visible.
      sizeScale: CAR_MODEL_SCALE,
      pickable: true,
      // Flat, unlit texture -- matches every other layer on this map (halos, path lines,
      // start/end markers), and avoids the model going unreadably dark from some camera
      // angles under a lighting setup this app has no other use for.
      material: false,
      parameters: ALWAYS_ON_TOP,
    }),
  ];
}
