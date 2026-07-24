import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';

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

const CAR_EMOJI = '🚗';
const ICON_CANVAS_SIZE = 128;

// deck.gl's getAngle rotates counter-clockwise starting from the icon's own
// default orientation (empirically confirmed with a cardinal-direction test:
// heading=90/east correctly pointed the icon right, but heading=0/north
// pointed it down instead of up until this formula was corrected -- an
// initial derivation from the vertex shader's rotation matrix got the
// handedness backwards). The car emoji is drawn facing left/west by default
// on every major platform (Apple, Noto, Twemoji, Segoe); with a
// counter-clockwise-positive convention, reaching true compass heading H
// from that default (west=270) needs angle = 270 - H.
function headingToIconAngle(heading: number): number {
  return ((270 - heading) % 360 + 360) % 360;
}

interface IconAtlas {
  url: string;
  mapping: Record<
    string,
    { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }
  >;
}

// deck.gl's TextLayer always rasterizes glyphs in solid black and discards
// color (it builds a monochrome alpha mask, then tints uniformly) -- fine
// for plain text, but it flattens a multi-color emoji into a black
// silhouette. Drawing the emoji into a plain <canvas> ourselves (no forced
// fill color, just the browser's normal color-emoji font rendering) and
// using that as an IconLayer atlas keeps the real colors. Built once and
// cached, not per-render.
let cachedIconAtlas: IconAtlas | null = null;

function getCarIconAtlas(): IconAtlas {
  if (cachedIconAtlas) return cachedIconAtlas;
  const canvas = document.createElement('canvas');
  canvas.width = ICON_CANVAS_SIZE;
  canvas.height = ICON_CANVAS_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${Math.round(ICON_CANVAS_SIZE * 0.8)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(CAR_EMOJI, ICON_CANVAS_SIZE / 2, ICON_CANVAS_SIZE / 2);
  cachedIconAtlas = {
    url: canvas.toDataURL(),
    mapping: {
      car: {
        x: 0,
        y: 0,
        width: ICON_CANVAS_SIZE,
        height: ICON_CANVAS_SIZE,
        anchorX: ICON_CANVAS_SIZE / 2,
        anchorY: ICON_CANVAS_SIZE / 2,
        mask: false,
      },
    },
  };
  return cachedIconAtlas;
}

/**
 * Vehicle rendering for the single-vehicle trip pages: a colored ground
 * halo (moving/stale signal) plus the vehicle icon itself, rotated to face
 * the direction of travel.
 */
// Ground-level markers get occluded by nearby 3D building extrusions from a
// tilted/overhead camera -- the same reason startEndMarkerLayers (in
// TripPathLayer.ts) disables depth testing. The vehicle is a flat 2D icon
// billboard at z=0 with no real height, so it's just as susceptible: on a
// narrow street between two buildings, the icon can end up almost entirely
// hidden behind one of them. Always-on-top is correct here too -- a vehicle
// marker's whole job is "be seen".
const ALWAYS_ON_TOP = { depthCompare: 'always', depthWriteEnabled: false } as const;

export function createVehicleLayers(idPrefix: string, data: VehicleInstance[]) {
  const atlas = getCarIconAtlas();
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
    new IconLayer<VehicleInstance>({
      id: `${idPrefix}-model`,
      data,
      iconAtlas: atlas.url,
      iconMapping: atlas.mapping,
      getIcon: () => 'car',
      getPosition: (d) => [d.lon, d.lat, 0],
      getAngle: (d) => headingToIconAngle(d.heading),
      getSize: 28,
      sizeUnits: 'pixels',
      billboard: true,
      pickable: true,
      parameters: ALWAYS_ON_TOP,
    }),
  ];
}
