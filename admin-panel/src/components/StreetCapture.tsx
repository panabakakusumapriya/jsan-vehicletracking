import { useEffect, useRef } from 'react';
import { WORLD_LAND } from './worldLand';

/**
 * The login screen's backdrop: a street-view capture drive, seen from a chase camera. A JSAN
 * capture car with a 360° camera on a roof mast drives down a street lined with 3D buildings:
 * solid white-and-blue volumes with a lit facade to the road, a shaded end wall, windows set into
 * both, and on some a setback upper tier. The road and footpaths are pale surfaces with a point
 * cloud of road grid, kerbs and lane markings over them. Everything fades into a pale haze with distance. The buildings are
 * what it captures: every few seconds the camera takes a frame, a ring flashes out from the camera
 * head and a wave sweeps the street, a viewfinder frames the next building on each side, and that
 * building's windows light up deep blue, as captured.
 *
 * Above the street, in a pale blue sky, the world as a bright, glowing dot-matrix with location
 * pins dropping onto it one by one: the programme's reach behind the one street being driven.
 * When `launching` turns true (the user has just signed in) the drive carries on under the launch
 * panel and the map glows brighter still — the hand-over from the sign-in to the workspace.
 * `onStats` reports the drive (km, frames, buildings captured) a few times a second, for the
 * cards the page lays over the street.
 *
 * Canvas 2D in one requestAnimationFrame loop. The canvas covers the whole login screen; the car
 * is centred in the left 70%, under the column the grid gives the sign-in card (max(460px, 30%)).
 * Motion is integrated per second, so it runs at the same pace on 60 Hz and 120 Hz screens, and
 * pauses while the tab is hidden. With reduced motion asked for, one still frame is drawn.
 */

type Building = {
  side: number; z0: number; len: number; x: number; depth: number; hgt: number;
  tierH: number; tierIn: number; // a setback upper storey (tierH 0 = none)
  bay: number; floor: number; ribbon: boolean; // window spacing, storey height, banded or punched windows
  cap: number; shotAt: number;
};
type Pulse = { born: number; z: number };

// Tones, lightest to deepest: the land-dot blue (--brand-2) down to the brand blue (--brand).
const TONES: Array<[number, number, number]> = [
  [188, 216, 240], [160, 200, 236], [125, 184, 232], [96, 160, 222],
  [59, 142, 232], [34, 116, 204], [14, 96, 186], [0, 80, 169],
];
const ALPHAS = 10;
const PALETTE = TONES.flatMap(([r, g, b]) => Array.from({ length: ALPHAS }, (_, a) => `rgba(${r}, ${g}, ${b}, ${(a / (ALPHAS - 1)).toFixed(2)})`));
const BRAND = '0, 80, 169';
const ACCENT = '59, 142, 232';
const NAVY = '#0d1b33';

const CAR_X = -1.7; // the car keeps to the left lane
const CAR_AHEAD = 5.5; // metres from the chase camera to the car's rear
const CAM_H = 2.6; // the chase camera's height above the road
const NEAR = 1.5; // faces closer than this to the camera are clipped
const FAR = 190; // how far down the street is drawn
const ROAD_EDGE = 5.6; // the kerb
const LANE_EDGE = 3.4;
const CAPTURE_EVERY_M = 22; // a capture every this many metres
const WAVE_SPEED = 34; // m/s the capture wave travels out from the car
const WAVE_LIFE = 1.4;
const RING_LIFE = 0.9;
const SHOT_LIFE = 1.3; // how long a building's viewfinder stays up
const LIFT_S = 1.8; // how long the map takes to brighten once signed in
const MAP_BLUE = '62, 146, 240'; // the sky map's land: a bright sky blue
const SKY_FADE = 64; // px over which the buildings fade out below the map
const MAP_GLOW = 'rgba(120, 186, 255, 0.95)';

/** [lon, lat] of the pins on the sky map: places the programme works, never labelled. */
const PINS: Array<[number, number]> = [
  [151.2, -33.9], [153.0, -27.5], [145.0, -37.8], [115.9, -31.9], [138.6, -34.9], [174.8, -36.9], [172.6, -43.5],
  [103.8, 1.3], [139.7, 35.7], [116.4, 39.9], [78.5, 17.4], [72.9, 19.1], [55.3, 25.2], [28.0, -26.2],
  [-0.1, 51.5], [8.7, 50.1], [-3.7, 40.4], [12.5, 41.9], [-74.0, 40.7], [-87.6, 41.9], [-118.2, 34.1],
  [-79.4, 43.7], [-99.1, 19.4], [-46.6, -23.5], [-58.4, -34.6], [36.8, -1.3], [106.8, -6.2],
  [-122.4, 37.8], [-122.3, 47.6], [-104.9, 39.7], [-95.4, 29.8], [-80.2, 25.8], [-77.0, 38.9], [-71.1, 42.4],
  [-73.6, 45.5], [-114.1, 51.0], [-43.2, -22.9], [-70.6, -33.4], [-77.0, -12.0], [-74.1, 4.7],
  [2.4, 48.9], [4.9, 52.4], [13.4, 52.5], [16.4, 48.2], [18.1, 59.3], [10.8, 59.9], [24.9, 60.2], [21.0, 52.2],
  [-9.1, 38.7], [9.2, 45.5], [23.7, 38.0], [28.9, 41.0], [37.6, 55.8], [31.2, 30.0], [3.4, 6.5], [32.6, 0.3],
  [46.7, 24.7], [51.4, 35.7], [67.0, 24.9], [77.2, 28.6], [77.6, 13.0], [80.3, 13.1], [88.4, 22.6],
  [100.5, 13.8], [101.7, 3.1], [121.0, 14.6], [114.2, 22.3], [121.5, 31.2], [127.0, 37.6], [135.5, 34.7],
  [144.0, -38.2], [147.3, -42.9], [130.8, -12.5], [146.8, -19.3], [174.8, -41.3], [168.7, -45.0],
];

/** Land cells of the world map as [col, row]. */
function decodeLand(): Array<[number, number]> {
  const bytes = Uint8Array.from(atob(WORLD_LAND.bits), (ch) => ch.charCodeAt(0));
  const cells: Array<[number, number]> = [];
  const total = WORLD_LAND.cols * WORLD_LAND.rows;
  for (let i = 0; i < total; i++) {
    if (bytes[i >> 3] & (1 << (i & 7))) cells.push([i % WORLD_LAND.cols, Math.floor(i / WORLD_LAND.cols)]);
  }
  return cells;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Small seeded generator, so the street is different on every load but stable within one. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DriveStats = { km: number; kmh: number; frames: number; buildings: number };

export function StreetCapture({ launching = false, onStats }: { launching?: boolean; onStats?: (s: DriveStats) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  // Read by the animation loop on every frame, so a change needs no restart of the effect.
  const launchRef = useRef(launching);
  launchRef.current = launching;
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const rand = rng(Math.floor(Math.random() * 1e9));

    let w = 0; let h = 0; let dpr = 1;
    let f = 600; // focal length, px
    let hy = 0; // the horizon
    let carCx = 0; // the car's (and the vanishing point's) x
    let camZ = 0; // the chase camera's distance along the street
    let dist = 0; // metres driven since the page opened
    let nextCapture = CAPTURE_EVERY_M * 0.5;
    const buildings: Building[] = [];
    const nextBuilding = [0, 0]; // per side (left, right): where the next building starts
    let pulses: Pulse[] = [];
    const buckets: number[][] = PALETTE.map(() => []);
    const pointer = { x: 0, on: false };
    let par = 0; // eased pointer parallax
    let raf = 0; let last = 0; let disposed = false;
    // Take-off: when it began (0 = not yet), and how far along it is, 0–1.
    let launchAt = 0;
    let lift = 0;
    const camH = CAM_H;
    // What the drive has done, for the cards over the street.
    let frames = 0; let captured = 0; let lastStats = 0;
    // The sky map: land dots in screen space, and where each pin sits.
    const land = decodeLand();
    let mapX = 0; let mapY = 0; let mapScale = 1; let mapDot = 1;
    let skyLine = 0; // nothing of the street is drawn above this: the map's lower edge, plus a gap
    const born = performance.now();

    /** Extend the street ahead of the camera and drop what has passed behind it. */
    function grow() {
      for (let s = 0; s < 2; s++) {
        const side = s ? 1 : -1;
        while (nextBuilding[s] < camZ + FAR + 40) {
          const z0 = nextBuilding[s] + 2 + rand() * 5;
          // Low-rise: mostly two to four storeys, the odd taller one, set a little back from the kerb.
          const len = 6 + rand() * 11;
          const hgt = 5 + rand() * rand() * 11;
          const tiered = hgt > 9 && rand() < 0.35;
          buildings.push({
            side, z0, len, x: 10 + rand() * 3, depth: 6 + rand() * 5, hgt,
            tierH: tiered ? 2.5 + rand() * 3 : 0, tierIn: 1.5 + rand() * 1.2,
            bay: 2.2 + rand() * 1.1, floor: 3.1 + rand() * 0.5, ribbon: rand() < 0.3,
            cap: 0, shotAt: 0,
          });
          nextBuilding[s] = z0 + len;
        }
      }
      for (let i = buildings.length - 1; i >= 0; i--) if (buildings[i].z0 + buildings[i].len < camZ - 2) buildings.splice(i, 1);
    }

    function resize() {
      const rect = host!.getBoundingClientRect();
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas!.width = Math.round(w * dpr);
      canvas!.height = Math.round(h * dpr);
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      const leftW = w > 960 ? w - Math.max(460, w * 0.3) : w;
      carCx = leftW / 2;
      hy = h * 0.47;
      f = h * 0.88;
      // The map fills the sky from just right of the title to the sign-in card; the skyline rises
      // in front of its lower edge. On a narrow screen it spans the width behind the title.
      mapX = leftW > 900 ? leftW * 0.36 : 12;
      const mapW = Math.min(leftW - mapX + 40, 940);
      mapScale = mapW / 360;
      mapY = h * 0.025;
      mapDot = Math.max(1, WORLD_LAND.step * mapScale * 0.34);
      skyLine = mapY + WORLD_LAND.rows * WORLD_LAND.step * mapScale + 10;
      paintLand();
      // Where the car sits, for the labels the page places beside it.
      host!.style.setProperty('--sc-car-x', `${carCx}px`);
      if (still) draw(performance.now());
    }

    /**
     * The land, painted once per size into its own canvas: dots nearly touching, so each continent
     * reads as one bright shape, with a soft glow round it. With the blur this is far too slow to
     * repeat every frame; as an image it costs one copy.
     */
    const landCanvas = document.createElement('canvas');
    const LAND_PAD = 24;
    function paintLand() {
      const cell = WORLD_LAND.step * mapScale;
      const lw = WORLD_LAND.cols * cell + LAND_PAD * 2;
      const lh = WORLD_LAND.rows * cell + LAND_PAD * 2;
      landCanvas.width = Math.round(lw * dpr);
      landCanvas.height = Math.round(lh * dpr);
      const c = landCanvas.getContext('2d');
      if (!c) return;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, lw, lh);
      const dots = (r: number) => {
        c.beginPath();
        for (const [col, row] of land) {
          const x = LAND_PAD + (col + 0.5) * cell;
          const y = LAND_PAD + (row + 0.5) * cell;
          c.moveTo(x + r, y);
          c.arc(x, y, r, 0, Math.PI * 2);
        }
      };
      // A white halo, so the map reads against the buildings it floats over; then the continents'
      // body: overlapping discs, blurred, so the land is one luminous shape; then the dots over it
      // in full colour; then a white sheen across their tops.
      c.shadowColor = 'rgba(255, 255, 255, 1)'; c.shadowBlur = 22;
      c.fillStyle = 'rgba(255, 255, 255, 0.75)'; dots(cell * 1.25); c.fill();
      c.shadowColor = MAP_GLOW; c.shadowBlur = 16;
      c.fillStyle = 'rgba(160, 205, 252, 0.8)'; dots(cell * 0.72); c.fill();
      c.shadowBlur = 4;
      c.fillStyle = `rgb(${MAP_BLUE})`; dots(mapDot); c.fill();
      c.shadowBlur = 0;
      const sheen = c.createLinearGradient(0, LAND_PAD, 0, lh - LAND_PAD);
      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.45)'); sheen.addColorStop(0.55, 'rgba(255, 255, 255, 0.12)'); sheen.addColorStop(1, 'rgba(255, 255, 255, 0.3)');
      c.globalCompositeOperation = 'source-atop';
      c.fillStyle = sheen; c.fillRect(0, 0, lw, lh);
      c.globalCompositeOperation = 'source-over';
    }

    /** A capture frames the nearest building ahead on each side that hasn't been captured yet. */
    function frameBuildings(now: number) {
      for (const side of [-1, 1]) {
        let best: Building | null = null;
        for (const b of buildings) {
          const zr = b.z0 - camZ;
          if (b.side !== side || b.cap || b.shotAt || zr < 14 || zr > 70) continue;
          if (!best || b.z0 < best.z0) best = b;
        }
        if (best) { best.shotAt = now; captured += 1; }
      }
    }

    /** The viewfinder over a building being captured: corner brackets round its facade, and a flash. */
    function drawShot(g: CanvasRenderingContext2D, b: Building, now: number) {
      const age = (now - b.shotAt) / 1000;
      if (age > SHOT_LIFE) return;
      const X = b.side * b.x;
      const zA = Math.max(b.z0, camZ + 2);
      const zB = b.z0 + b.len;
      if (zB <= zA) return;
      const sx = (z: number) => vx + (f * (X - camX)) / (z - camZ);
      const sy = (y: number, z: number) => hy + (f * (camH + bob - y)) / (z - camZ);
      const x0 = Math.min(sx(zA), sx(zB)); const x1 = Math.max(sx(zA), sx(zB));
      const top = b.hgt + b.tierH;
      const y0 = Math.min(sy(top, zA), sy(top, zB)); const y1 = Math.max(sy(0, zA), sy(0, zB));
      const pad = 6;
      const L = x0 - pad; const R = x1 + pad; const T = y0 - pad; const B = y1 + pad;
      // The brackets close in a little as the frame is taken, then fade.
      const settle = Math.min(1, age / 0.25);
      const grow = (1 - settle) * 10;
      const fade = age < SHOT_LIFE - 0.4 ? 1 : (SHOT_LIFE - age) / 0.4;
      if (age < 0.3) {
        g.fillStyle = `rgba(${ACCENT}, ${(0.14 * (1 - age / 0.3)).toFixed(3)})`;
        g.fillRect(L, T, R - L, B - T);
      }
      const arm = Math.max(8, Math.min(22, (R - L) * 0.22, (B - T) * 0.22));
      g.lineWidth = 2; g.strokeStyle = `rgba(${BRAND}, ${(0.9 * fade).toFixed(3)})`;
      g.beginPath();
      for (const [cx, cy, dx, dy] of [[L - grow, T - grow, 1, 1], [R + grow, T - grow, -1, 1], [L - grow, B + grow, 1, -1], [R + grow, B + grow, -1, -1]]) {
        g.moveTo(cx + dx * arm, cy); g.lineTo(cx, cy); g.lineTo(cx, cy + dy * arm);
      }
      g.stroke();
    }

    /** Screen position of a world point (in front of the camera). */
    const proj = (x: number, y: number, z: number): [number, number] => {
      const zr = z - camZ;
      return [vx + (f * (x - camX)) / zr, hy + (f * (camH + bob - y)) / zr];
    };
    /** Add a world-space quad to the current path. */
    function quad(g: CanvasRenderingContext2D, pts: Array<[number, number, number]>) {
      pts.forEach(([x, y, z], i) => { const [px, py] = proj(x, y, z); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.closePath();
    }

    /**
     * One block of a building as a solid: its facade to the road (x = X, from za to zb), its end
     * wall towards the camera (z = z0, running back from the road), windows set into both, and its
     * edges. A captured building's windows turn deep blue.
     */
    function drawBlock(g: CanvasRenderingContext2D, b: Building, X: number, z0: number, za: number, zb: number, y0: number, y1: number, depth: number) {
      const sd = b.side;
      const back = X + sd * depth;
      const lit = sd < 0 ? 1 : 0.97; // light from the left: left-hand facades a touch brighter
      const cap = b.cap;
      const far = zb - camZ;
      const showWindows = (f * 1.4) / far > 2.2;

      // End wall, in shade.
      if (z0 >= camZ + NEAR) {
        g.beginPath(); quad(g, [[X, y0, z0], [back, y0, z0], [back, y1, z0], [X, y1, z0]]);
        g.fillStyle = cap ? '#c9dcf1' : '#d6e3f2'; g.fill();
        g.lineWidth = 1; g.strokeStyle = `rgba(${BRAND}, 0.3)`; g.stroke();
        if (showWindows) {
          g.beginPath();
          for (let fy = y0 + 1.1; fy + 1.5 < y1 - 0.5; fy += b.floor) {
            if (b.ribbon) { quad(g, [[X + sd * 0.8, fy, z0], [back - sd * 0.8, fy, z0], [back - sd * 0.8, fy + 1.3, z0], [X + sd * 0.8, fy + 1.3, z0]]); continue; }
            for (let wx = 1; wx + 1.3 < depth - 0.6; wx += b.bay) {
              quad(g, [[X + sd * wx, fy, z0], [X + sd * (wx + 1.3), fy, z0], [X + sd * (wx + 1.3), fy + 1.5, z0], [X + sd * wx, fy + 1.5, z0]]);
            }
          }
          g.fillStyle = cap ? 'rgba(0, 80, 169, 0.62)' : 'rgba(125, 184, 232, 0.42)'; g.fill();
        }
      }

      // Facade to the road, lit, darker towards its foot.
      const [, ty] = proj(X, y1, za);
      const [, by] = proj(X, y0, za);
      const grad = g.createLinearGradient(0, ty, 0, by);
      grad.addColorStop(0, cap ? '#eef5fd' : '#fbfdff');
      grad.addColorStop(1, cap ? '#d7e6f6' : '#e2ebf6');
      g.beginPath(); quad(g, [[X, y0, za], [X, y1, za], [X, y1, zb], [X, y0, zb]]);
      g.globalAlpha *= lit;
      g.fillStyle = grad; g.fill();
      g.globalAlpha /= lit;
      g.lineWidth = 1; g.strokeStyle = `rgba(${BRAND}, 0.32)`; g.stroke();
      if (showWindows) {
        g.beginPath();
        for (let fy = y0 + 1.1; fy + 1.5 < y1 - 0.5; fy += b.floor) {
          if (b.ribbon) {
            const a = Math.max(za, z0 + 0.8); const e = zb - 0.8;
            if (e > a) quad(g, [[X, fy, a], [X, fy + 1.3, a], [X, fy + 1.3, e], [X, fy, e]]);
            continue;
          }
          for (let wz = z0 + 1; wz + 1.4 < zb - 0.6; wz += b.bay) {
            if (wz < za) continue;
            quad(g, [[X, fy, wz], [X, fy + 1.5, wz], [X, fy + 1.5, wz + 1.4], [X, fy, wz + 1.4]]);
          }
        }
        g.fillStyle = cap ? 'rgba(0, 80, 169, 0.72)' : 'rgba(125, 184, 232, 0.5)'; g.fill();
      }
      // Parapet: a firmer line along the roof edge.
      g.beginPath();
      const [p0x, p0y] = proj(X, y1, za); const [p1x, p1y] = proj(X, y1, zb);
      g.moveTo(p0x, p0y); g.lineTo(p1x, p1y);
      g.lineWidth = 1.6; g.strokeStyle = `rgba(${BRAND}, 0.45)`; g.stroke();
    }

    /** The buildings, far to near so nearer ones cover those behind, each fading into the haze. */
    function drawBuildings(g: CanvasRenderingContext2D, now: number) {
      const shown = buildings.filter((b) => b.z0 + b.len > camZ + NEAR + 0.5 && b.z0 - camZ < FAR);
      shown.sort((a, b) => b.z0 - a.z0);
      for (const b of shown) {
        // Captured once its frame is taken; its windows light up from then on.
        if (b.shotAt && !b.cap && now - b.shotAt > 250) b.cap = 1;
        const za = Math.max(b.z0, camZ + NEAR);
        const zb = b.z0 + b.len;
        const zr = za - camZ;
        g.globalAlpha = Math.max(0, Math.min(1, Math.pow(1 - zr / FAR, 1.1)));
        const X = b.side * b.x;
        if (b.tierH) {
          const tz0 = b.z0 + 1.5; const tzb = zb - 1.5;
          if (tzb > Math.max(tz0, camZ + NEAR)) {
            drawBlock(g, b, X + b.side * b.tierIn, tz0, Math.max(tz0, camZ + NEAR), tzb, b.hgt, b.hgt + b.tierH, Math.max(2, b.depth - b.tierIn - 1));
          }
        }
        drawBlock(g, b, X, b.z0, za, zb, 0, b.hgt, b.depth);
      }
      g.globalAlpha = 1;
    }

    /** The capture wave's brightness at a ground position: a ring travelling out from each capture. */
    function litAt(x: number, z: number, now: number) {
      let lit = 0;
      for (const p of pulses) {
        const age = (now - p.born) / 1000;
        if (age > WAVE_LIFE) continue;
        const d = Math.hypot(x - CAR_X, z - p.z) - age * WAVE_SPEED;
        const v = Math.exp(-(d * d) / 5) * (1 - age / WAVE_LIFE);
        if (v > lit) lit = v;
      }
      return lit;
    }

    let camX = CAR_X; let bob = 0; let vx = 0;
    /** Queue one point of the cloud for drawing: tone 0–7 by height, faded by distance. */
    function point(x: number, y: number, z: number, tone: number, base: number, lit: number) {
      const zr = z - camZ;
      if (zr < 1.2 || zr > FAR) return;
      const sx = vx + (f * (x - camX)) / zr;
      if (sx < -4 || sx > w + 4) return;
      const sy = hy + (f * (camH + bob - y)) / zr;
      if (sy < -4 || sy > h + 4) return;
      const fog = Math.pow(1 - zr / FAR, 1.3) * Math.min(1, (zr - 1.2) / 5);
      const a = Math.min(1, base * fog * (1 + lit * 1.4));
      const ai = Math.round(a * (ALPHAS - 1));
      if (ai <= 0) return;
      const t = Math.min(7, Math.round(tone + lit * 4));
      const size = Math.min(3.2, Math.max(1, (f * 0.075) / zr)) * (1 + lit * 0.7);
      buckets[t * ALPHAS + ai].push(sx - size / 2, sy - size / 2, size);
    }

    function step(dt: number, now: number) {
      const t = now / 1000;
      if (launchRef.current && !launchAt) launchAt = now;
      lift = launchAt ? easeInOut(Math.min(1, (now - launchAt) / 1000 / LIFT_S)) : 0;
      const kmh = 46 + 6 * Math.sin(t / 7) + 2 * Math.sin(t / 2.3);
      const v = kmh / 3.6;
      camZ += v * dt;
      dist += v * dt;
      if (dist >= nextCapture) {
        nextCapture += CAPTURE_EVERY_M;
        frames += 1;
        pulses.push({ born: now, z: camZ + CAR_AHEAD });
        frameBuildings(now);
      }
      pulses = pulses.filter((p) => now - p.born < Math.max(WAVE_LIFE, RING_LIFE) * 1000);
      grow();
      if (now - lastStats > 250) {
        lastStats = now;
        statsRef.current?.({ km: dist / 1000, kmh, frames, buildings: captured });
      }
    }

    /** A map pin: a blue drop with a white centre, its point at (x, y). */
    function drawPin(g: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number) {
      const r = size * 0.42;
      const cy = y - size + r;
      g.globalAlpha = alpha;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x - r * 1.15, cy + r * 0.7, x - r, cy);
      g.arc(x, cy, r, Math.PI, 0);
      g.quadraticCurveTo(x + r * 1.15, cy + r * 0.7, x, y);
      g.fillStyle = `rgb(${BRAND})`; g.fill();
      g.beginPath(); g.arc(x, cy, r * 0.42, 0, Math.PI * 2);
      g.fillStyle = '#ffffff'; g.fill();
      g.globalAlpha = 1;
    }

    /** The sky map: the world as faint dots, pins dropping onto it, all brighter on take-off. */
    function drawSky(g: CanvasRenderingContext2D, now: number) {
      const ox = mapX - par * 25;
      const oy = mapY;
      // Fades in over the first second, and glows brighter once signed in.
      const lw = landCanvas.width / dpr;
      const lh = landCanvas.height / dpr;
      g.globalAlpha = still ? 1 : Math.min(1, (now - born) / 900);
      g.drawImage(landCanvas, ox - LAND_PAD, oy - LAND_PAD, lw, lh);
      if (lift > 0) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = lift * 0.22;
        g.drawImage(landCanvas, ox - LAND_PAD, oy - LAND_PAD, lw, lh);
        g.globalCompositeOperation = 'source-over';
      }
      g.globalAlpha = 1;
      // Pins drop in one after another, overshoot a touch, then send out a slow ring.
      const age = (now - born) / 1000;
      const size = Math.max(7, Math.min(12, mapScale * 5.5));
      PINS.forEach(([lon, lat], i) => {
        const t = still ? 1 : Math.min(1, Math.max(0, (age - 0.4 - i * 0.05) / 0.45));
        if (t <= 0) return;
        const x = ox + (lon + 180) * mapScale;
        const y = oy + (WORLD_LAND.latTop - lat) * mapScale;
        const back = 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2); // ease-out with a small overshoot
        if (t === 1 && !still) {
          const p = ((now / 1000) * (1 + lift * 2) + i * 0.37) % 2.4 / 2.4;
          g.beginPath(); g.arc(x, y, 2 + p * 10, 0, Math.PI * 2);
          g.lineWidth = 1.2; g.strokeStyle = `rgba(${ACCENT}, ${((1 - p) * (0.45 + lift * 0.4)).toFixed(3)})`; g.stroke();
        }
        drawPin(g, x, y - (1 - back) * 16, size, Math.min(1, t * 1.6));
      });
    }

    /** The capture car from behind: white body, blue glass and light bar, a 360° camera on a mast. */
    function drawCar(g: CanvasRenderingContext2D, now: number) {
      const s = f / CAR_AHEAD; // px per metre at the car
      const cx = vx + (f * (CAR_X - camX)) / CAR_AHEAD;
      const gy = hy + (f * (camH + bob)) / CAR_AHEAD + (still ? 0 : Math.sin(now / 110) * 0.5);
      const X = (m: number) => cx + m * s;
      const Y = (m: number) => gy - m * s;
      const rr = (x0: number, y0: number, x1: number, y1: number, r: number) => {
        const L = X(x0); const R = X(x1); const T = Y(y1); const B = Y(y0); const q = r * s;
        g.beginPath();
        g.moveTo(L + q, T); g.lineTo(R - q, T); g.arcTo(R, T, R, T + q, q); g.lineTo(R, B - q); g.arcTo(R, B, R - q, B, q);
        g.lineTo(L + q, B); g.arcTo(L, B, L, B - q, q); g.lineTo(L, T + q); g.arcTo(L, T, L + q, T, q); g.closePath();
      };

      // Shadow on the road.
      const sh = g.createRadialGradient(cx, Y(0.02), 0, cx, Y(0.02), 1.4 * s);
      sh.addColorStop(0, 'rgba(13, 27, 51, 0.22)'); sh.addColorStop(1, 'rgba(13, 27, 51, 0)');
      g.save(); g.translate(cx, Y(0.02)); g.scale(1, 0.2); g.translate(-cx, -Y(0.02));
      g.fillStyle = sh; g.beginPath(); g.arc(cx, Y(0.02), 1.4 * s, 0, Math.PI * 2); g.fill(); g.restore();

      // Wheels.
      g.fillStyle = NAVY;
      rr(-0.95, 0, -0.62, 0.44, 0.07); g.fill();
      rr(0.62, 0, 0.95, 0.44, 0.07); g.fill();

      // Roof, seen from above and behind, then the rear glass below it.
      g.beginPath();
      g.moveTo(X(-0.66), Y(1.42)); g.lineTo(X(-0.52), Y(1.74)); g.lineTo(X(0.52), Y(1.74)); g.lineTo(X(0.66), Y(1.42)); g.closePath();
      g.fillStyle = '#f3f7fc'; g.fill();
      g.lineWidth = 1; g.strokeStyle = `rgba(${BRAND}, 0.22)`; g.stroke();
      // Roof bars.
      g.strokeStyle = `rgba(${BRAND}, 0.35)`; g.lineWidth = Math.max(1, 0.025 * s);
      for (const y of [1.52, 1.66]) { g.beginPath(); g.moveTo(X(-0.56), Y(y)); g.lineTo(X(0.56), Y(y)); g.stroke(); }

      const glass = g.createLinearGradient(0, Y(1.42), 0, Y(1.02));
      glass.addColorStop(0, 'rgba(0, 80, 169, 0.78)'); glass.addColorStop(1, 'rgba(125, 184, 232, 0.7)');
      g.beginPath();
      g.moveTo(X(-0.86), Y(1.04)); g.lineTo(X(-0.66), Y(1.42)); g.lineTo(X(0.66), Y(1.42)); g.lineTo(X(0.86), Y(1.04)); g.closePath();
      g.fillStyle = glass; g.fill();
      // A sky reflection across the glass.
      g.beginPath();
      g.moveTo(X(-0.5), Y(1.04)); g.lineTo(X(-0.2), Y(1.42)); g.lineTo(X(0.02), Y(1.42)); g.lineTo(X(-0.28), Y(1.04)); g.closePath();
      g.fillStyle = 'rgba(255, 255, 255, 0.16)'; g.fill();

      // Body and bumper.
      const body = g.createLinearGradient(0, Y(1.06), 0, Y(0.24));
      body.addColorStop(0, '#ffffff'); body.addColorStop(1, '#dfe9f5');
      rr(-0.98, 0.5, 0.98, 1.06, 0.2); g.fillStyle = body; g.fill();
      g.lineWidth = 1; g.strokeStyle = `rgba(${BRAND}, 0.25)`; g.stroke();
      rr(-0.94, 0.24, 0.94, 0.58, 0.14); g.fillStyle = '#e8eff8'; g.fill(); g.stroke();

      // Light bar, glowing in the accent blue.
      g.save();
      g.shadowColor = `rgba(${ACCENT}, 0.9)`; g.shadowBlur = 0.18 * s;
      rr(-0.88, 0.86, 0.88, 0.94, 0.04); g.fillStyle = `rgb(${ACCENT})`; g.fill();
      rr(-0.92, 0.82, -0.7, 0.97, 0.05); g.fillStyle = `rgb(${BRAND})`; g.fill();
      rr(0.7, 0.82, 0.92, 0.97, 0.05); g.fill();
      g.restore();

      // Plate.
      rr(-0.28, 0.42, 0.28, 0.6, 0.03); g.fillStyle = '#ffffff'; g.fill();
      g.strokeStyle = `rgba(${BRAND}, 0.4)`; g.stroke();
      g.fillStyle = NAVY; g.font = `800 ${Math.max(8, 0.12 * s)}px Inter, "Segoe UI", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('JSAN', cx, Y(0.51));

      // Mast and GNSS puck.
      g.fillStyle = NAVY;
      g.fillRect(X(-0.025), Y(2.06), 0.05 * s, 0.4 * s);
      rr(-0.16, 1.66, 0.16, 1.74, 0.03); g.fill();
      rr(0.3, 1.6, 0.46, 1.66, 0.03); g.fillStyle = `rgb(${BRAND})`; g.fill();

      // 360° camera head: a white ball in a blue ring, its lenses around it.
      const hx = cx; const hyy = Y(2.16); const hr = 0.13 * s;
      const sinceCapture = pulses.length ? (now - pulses[pulses.length - 1].born) / 1000 : 9;
      if (sinceCapture < 0.35) {
        const fl = g.createRadialGradient(hx, hyy, 0, hx, hyy, hr * 6);
        fl.addColorStop(0, `rgba(${ACCENT}, ${(0.5 * (1 - sinceCapture / 0.35)).toFixed(3)})`); fl.addColorStop(1, `rgba(${ACCENT}, 0)`);
        g.fillStyle = fl; g.beginPath(); g.arc(hx, hyy, hr * 6, 0, Math.PI * 2); g.fill();
      }
      // The housing: a short drum under a dome, with a blue band where the lenses sit.
      const hw = hr * 1.15; const hh = hr * 0.75;
      g.beginPath();
      g.ellipse(hx, hyy - hh, hw * 0.82, hr * 0.62, 0, Math.PI, 0);
      g.lineTo(hx + hw, hyy - hh * 0.4); g.lineTo(hx + hw, hyy + hh); g.lineTo(hx - hw, hyy + hh); g.lineTo(hx - hw, hyy - hh * 0.4); g.closePath();
      g.fillStyle = '#ffffff'; g.fill();
      g.lineWidth = Math.max(1.2, 0.022 * s); g.strokeStyle = `rgb(${BRAND})`; g.stroke();
      g.fillStyle = `rgba(${ACCENT}, 0.35)`;
      g.fillRect(hx - hw, hyy - hh * 0.05, hw * 2, hh * 0.5);
      // Six lenses round the drum, turning slowly; only those facing the viewer show.
      const spin = still ? 0.3 : now / 1400;
      for (let i = 0; i < 6; i++) {
        const a = spin + (i / 6) * Math.PI * 2;
        const front = Math.sin(a);
        if (front <= 0.05) continue;
        const lx = hx + Math.cos(a) * hw * 0.82;
        const lr = hr * 0.2 * (0.45 + 0.55 * front);
        g.beginPath(); g.ellipse(lx, hyy + hh * 0.2, lr * front, lr, 0, 0, Math.PI * 2);
        g.fillStyle = NAVY; g.fill();
        g.beginPath(); g.arc(lx - lr * 0.3 * front, hyy + hh * 0.2 - lr * 0.3, Math.max(0.6, lr * 0.25), 0, Math.PI * 2);
        g.fillStyle = 'rgba(255, 255, 255, 0.8)'; g.fill();
      }

      // Capture rings from the camera head.
      for (const p of pulses) {
        const age = (now - p.born) / 1000;
        if (age > RING_LIFE) continue;
        const k = age / RING_LIFE;
        g.beginPath(); g.arc(hx, hyy, hr + k * 5 * s * 0.25, 0, Math.PI * 2);
        g.lineWidth = 1.5; g.strokeStyle = `rgba(${ACCENT}, ${((1 - k) * 0.7).toFixed(3)})`; g.stroke();
      }
    }

    function draw(now: number) {
      const g = ctx!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      par += ((pointer.on ? (pointer.x - carCx) / Math.max(1, w) : 0) - par) * 0.05;
      vx = carCx - par * 60;
      camX = CAR_X + (still ? 0 : Math.sin(now / 5200) * 0.12);
      bob = still ? 0 : Math.sin(now / 1700) * 0.03;

      // A faint haze along the horizon, where the street fades out.
      const haze = g.createLinearGradient(0, hy - h * 0.18, 0, hy + h * 0.12);
      haze.addColorStop(0, 'rgba(125, 184, 232, 0)'); haze.addColorStop(0.6, 'rgba(125, 184, 232, 0.1)'); haze.addColorStop(1, 'rgba(125, 184, 232, 0)');
      g.fillStyle = haze; g.fillRect(0, hy - h * 0.18, w, h * 0.3);

      for (const b of buckets) b.length = 0;

      // The ground as surfaces: the carriageway and the footpaths, fading out towards the horizon.
      const zN = camZ + NEAR; const zF = camZ + FAR;
      const ground = (x0: number, x1: number, near: string) => {
        const grad = g.createLinearGradient(0, hy, 0, h);
        grad.addColorStop(0, 'rgba(255, 255, 255, 0)'); grad.addColorStop(0.35, near); grad.addColorStop(1, near);
        g.beginPath(); quad(g, [[x0, 0, zN], [x1, 0, zN], [x1, 0, zF], [x0, 0, zF]]);
        g.fillStyle = grad; g.fill();
      };
      ground(-ROAD_EDGE, ROAD_EDGE, '#e8eff8');
      ground(-14, -ROAD_EDGE, '#f3f7fc');
      ground(ROAD_EDGE, 14, '#f3f7fc');

      // The road grid: points locked to the street, sparser with distance.
      const g0 = Math.ceil((camZ + 1.2) / 1.6);
      for (let k = g0; k * 1.6 < camZ + FAR; k++) {
        const zr = k * 1.6 - camZ;
        if ((zr > 45 && k % 2) || (zr > 90 && k % 4)) continue;
        const z = k * 1.6;
        // Alternate rows are offset half a cell, so the grid reads as a surface, not as rails.
        for (let x = -9 + (k % 2) * 0.75; x <= 9; x += 1.5) {
          point(x, 0, z, 0, Math.abs(x) < ROAD_EDGE ? 0.42 : 0.3, litAt(x, z, now));
        }
      }
      // Kerbs, lane edges and the centre line's dashes.
      const l0 = Math.ceil((camZ + 1.2) / 0.6);
      for (let k = l0; k * 0.6 < camZ + FAR; k++) {
        const zr = k * 0.6 - camZ;
        if ((zr > 40 && k % 2) || (zr > 80 && k % 4)) continue;
        const z = k * 0.6;
        for (const sd of [-1, 1]) {
          point(sd * ROAD_EDGE, 0.15, z, 4, 0.85, litAt(sd * ROAD_EDGE, z, now));
          point(sd * LANE_EDGE, 0, z, 2, 0.55, 0);
        }
        if ((z % 9) < 3.2) point(0, 0, z, 6, 0.9, 0);
      }
      drawBuildings(g, now);

      for (let i = 0; i < buckets.length; i++) {
        const q = buckets[i];
        if (!q.length) continue;
        g.fillStyle = PALETTE[i];
        g.beginPath();
        for (let j = 0; j < q.length; j += 3) g.rect(q[j], q[j + 1], q[j + 2], q[j + 2]);
        g.fill();
      }

      for (const b of buildings) if (b.shotAt) drawShot(g, b, now);

      // The skyline stops short of the map. The nearest buildings would otherwise rise to the top
      // of the screen and run into it, so the street (viewfinders too) is erased above the map's lower edge and
      // fades in over the next few dozen pixels: the buildings dissolve into the sky below the map.
      g.save();
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      g.fillRect(0, 0, w, skyLine);
      const fade = g.createLinearGradient(0, skyLine, 0, skyLine + SKY_FADE);
      fade.addColorStop(0, 'rgba(0, 0, 0, 1)');
      fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
      g.fillStyle = fade;
      g.fillRect(0, skyLine, w, SKY_FADE);
      g.restore();
      drawSky(g, now);
      drawCar(g, now);
    }

    function frame(now: number) {
      if (disposed) return;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
      last = now;
      step(dt, now);
      draw(now);
      raf = requestAnimationFrame(frame);
    }

    const onMove = (e: PointerEvent) => { pointer.x = e.clientX - canvas!.getBoundingClientRect().left; pointer.on = true; };
    const onLeave = () => { pointer.on = false; };
    const onVisibility = () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
    };

    camZ = 0;
    grow();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    if (!still) {
      host.addEventListener('pointermove', onMove);
      host.addEventListener('pointerleave', onLeave);
      document.addEventListener('visibilitychange', onVisibility);
      raf = requestAnimationFrame(frame);
    }
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="sc-canvas" aria-hidden="true" />;
}
