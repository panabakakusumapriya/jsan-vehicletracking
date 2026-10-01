/**
 * Render the driver-map vehicle sprite from the real 3D car model.
 *
 * MapLibre Native (what the app draws its map with) has no 3D-model layer, so a glTF/OBJ car cannot
 * be placed on the map directly. Every fleet/ride app solves this the same way: a PRE-RENDERED
 * top-down image of a 3D car, drawn as a map symbol and rotated to the vehicle's heading. This
 * script makes that image from the same model the admin panel uses for trip replay
 * (admin-panel/public/models/car — "Car" by Google, via Poly Pizza, CC-BY), so the driver's car and
 * the replay car are the same car.
 *
 * A tiny software renderer, no GPU or browser needed: orthographic top-down view, z-buffer,
 * per-face lighting with a gloss highlight, texture lookup, then a white halo (legible over the
 * red/blue roads) and a soft drop shadow. Rendered at 4x and box-filtered down for clean edges.
 * The car points UP in the image, so the map's icon-rotate is simply the compass heading.
 *
 * Run from JSAN-AUTO-TRACKING:  node scripts/render-car-sprite.mjs
 * Writes assets/images/vehicle-car.png (and a large preview to stdout's path, for eyeballing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_DIR = path.resolve(ROOT, '../admin-panel/public/models/car');
const OUT = path.join(ROOT, 'assets/images/vehicle-car.png');

const SIZE = 192;          // output square, px
const SS = 4;              // supersampling
const W = SIZE * SS;
const CAR_PX = 150;        // car length in the output image
const HALO_PX = 3;         // white outline
const SHADOW = { dx: 3, dy: 5, blur: 6, alpha: 0.38 };

/* ── load the model ── */
const obj = fs.readFileSync(path.join(MODEL_DIR, 'car.obj'), 'utf8').split('\n');
const V = [];
const VT = [];
const F = [];
for (const line of obj) {
  const p = line.trim().split(/\s+/);
  if (p[0] === 'v') V.push(p.slice(1, 4).map(Number));
  else if (p[0] === 'vt') VT.push(p.slice(1, 3).map(Number));
  else if (p[0] === 'f') F.push(p.slice(1).map((t) => t.split('/').map((n) => Number(n) - 1)));
}
const tex = PNG.sync.read(fs.readFileSync(path.join(MODEL_DIR, 'car.png')));

/* ── projection: model is Z-up, front along +X, Y to the car's left ── */
const xs = V.map((v) => v[0]);
const ys = V.map((v) => v[1]);
const cxM = (Math.min(...xs) + Math.max(...xs)) / 2;
const cyM = (Math.min(...ys) + Math.max(...ys)) / 2;
const scale = (CAR_PX * SS) / (Math.max(...xs) - Math.min(...xs));
// Front (+X) up the image; the car's left (+Y) on the image's left.
const project = ([x, y, z]) => [W / 2 - (y - cyM) * scale, W / 2 - (x - cxM) * scale, z];

/* ── shading ── */
const norm3 = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };
const LIGHT = norm3([0.45, 0.35, 1]);          // from above, a little ahead and to the left
const HALF = norm3([LIGHT[0], LIGHT[1], LIGHT[2] + 1]); // Blinn half-vector, viewer straight above

const color = new Float32Array(W * W * 3);
const depth = new Float32Array(W * W).fill(-Infinity);
const cover = new Uint8Array(W * W);

function sample(u, v) {
  const x = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width)));
  const y = Math.min(tex.height - 1, Math.max(0, Math.floor((1 - v) * tex.height)));
  const i = (y * tex.width + x) * 4;
  return [tex.data[i], tex.data[i + 1], tex.data[i + 2]];
}

function triangle(a, b, c) {
  const pa = project(V[a[0]]);
  const pb = project(V[b[0]]);
  const pc = project(V[c[0]]);
  const e1 = V[b[0]].map((n, i) => n - V[a[0]][i]);
  const e2 = V[c[0]].map((n, i) => n - V[a[0]][i]);
  let n = norm3([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]);
  if (n[2] < 0) n = n.map((c) => -c);             // the face seen from above faces the viewer
  const diffuse = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
  const spec = Math.pow(Math.max(0, n[0] * HALF[0] + n[1] * HALF[1] + n[2] * HALF[2]), 40);
  const shade = 0.45 + 0.6 * diffuse;

  const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
  const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
  const maxY = Math.min(W - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
  const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((pb[0] - px) * (pc[1] - py) - (pb[1] - py) * (pc[0] - px)) / area;
      const w1 = ((pc[0] - px) * (pa[1] - py) - (pc[1] - py) * (pa[0] - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * pa[2] + w1 * pb[2] + w2 * pc[2];
      const k = y * W + x;
      if (z <= depth[k]) continue;
      depth[k] = z;
      const uvA = VT[a[1]] || [0, 0];
      const uvB = VT[b[1]] || [0, 0];
      const uvC = VT[c[1]] || [0, 0];
      const [r, g, bl] = sample(w0 * uvA[0] + w1 * uvB[0] + w2 * uvC[0], w0 * uvA[1] + w1 * uvB[1] + w2 * uvC[1]);
      // Glass reflects more than paint; tyres and trim barely at all.
      const gloss = (r + g + bl) / 3 > 200 ? 0.55 : (r + g + bl) / 3 > 90 ? 0.35 : 0.1;
      color[k * 3] = Math.min(255, r * shade + 255 * spec * gloss);
      color[k * 3 + 1] = Math.min(255, g * shade + 255 * spec * gloss);
      color[k * 3 + 2] = Math.min(255, bl * shade + 255 * spec * gloss);
      cover[k] = 1;
    }
  }
}
for (const face of F) for (let i = 1; i + 1 < face.length; i++) triangle(face[0], face[i], face[i + 1]);

/* ── halo and shadow from the silhouette ── */
function dilate(mask, r) {
  const out = new Uint8Array(mask.length);
  const r2 = r * r;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const X = x + dx; const Y = y + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < W) out[Y * W + X] = 1;
    }
  }
  return out;
}
function blur(src, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < W; y++) {
    let acc = 0;
    for (let x = -r; x < W + r; x++) {
      if (x + r < W) acc += src[y * W + x + r] || 0;
      if (x - r - 1 >= 0) acc -= src[y * W + x - r - 1];
      if (x >= 0 && x < W) tmp[y * W + x] = acc / (2 * r + 1);
    }
  }
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = -r; y < W + r; y++) {
      if (y + r < W) acc += tmp[(y + r) * W + x];
      if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * W + x];
      if (y >= 0 && y < W) out[y * W + x] = acc / (2 * r + 1);
    }
  }
  return out;
}
const halo = dilate(cover, HALO_PX * SS);
const shadowSrc = new Float32Array(W * W);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const sx = x - SHADOW.dx * SS; const sy = y - SHADOW.dy * SS;
  if (sx >= 0 && sy >= 0 && sx < W && sy < W && halo[sy * W + sx]) shadowSrc[y * W + x] = 1;
}
const shadow = blur(blur(shadowSrc, SHADOW.blur * SS), SHADOW.blur * SS);

/* ── composite (premultiplied) and downsample ── */
const png = new PNG({ width: SIZE, height: SIZE });
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  let R = 0; let G = 0; let B = 0; let A = 0;
  for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
    const k = (y * SS + sy) * W + (x * SS + sx);
    let r; let g; let b; let a;
    if (cover[k]) { r = color[k * 3]; g = color[k * 3 + 1]; b = color[k * 3 + 2]; a = 1; }
    else if (halo[k]) { r = 255; g = 255; b = 255; a = 1; }
    else { r = 15; g = 23; b = 42; a = shadow[k] * SHADOW.alpha; }
    R += r * a; G += g * a; B += b * a; A += a;
  }
  const n = SS * SS;
  const i = (y * SIZE + x) * 4;
  const alpha = A / n;
  png.data[i] = alpha ? Math.round(R / A) : 0;
  png.data[i + 1] = alpha ? Math.round(G / A) : 0;
  png.data[i + 2] = alpha ? Math.round(B / A) : 0;
  png.data[i + 3] = Math.round(alpha * 255);
}
fs.writeFileSync(OUT, PNG.sync.write(png));
console.log(`wrote ${path.relative(ROOT, OUT)} (${SIZE}x${SIZE}) from ${F.length} faces`);
