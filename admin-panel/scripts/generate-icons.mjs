// Generates every PNG the PWA needs from one vector description of the JSAN truck mark.
//
// Deliberately dependency-free: it rasterises a handful of analytic shapes (rounded rects +
// circles) with 4x supersampling and writes the PNGs itself, so `npm run icons` works on a
// clean checkout without pulling in a native image toolchain.
//
//   npm run icons        (re-run only if the mark or the brand colours change)

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// Brand violet, matching --brand / --brand-hover in src/index.css.
const GRAD_FROM = [124, 58, 237];
const GRAD_TO = [91, 33, 182];

/* ───────────────────────── the mark ─────────────────────────
   Shapes live in a 24x24 design grid (same proportions as the sidebar truck icon).
   fill 'fg' paints white; fill 'bg' punches back through to the background, which is how
   the cab window and wheel hubs are cut. Painted in order. */
const SHAPES = [
  { rrect: [1.2, 5.0, 12.6, 11.0, 1.9], fill: 'fg' }, // cargo box
  { rrect: [12.4, 8.4, 7.6, 7.6, 1.6], fill: 'fg' }, // cab
  { rrect: [14.1, 9.9, 4.4, 3.3, 0.9], fill: 'bg' }, // windscreen
  { rrect: [1.2, 14.5, 19.8, 2.7, 1.3], fill: 'fg' }, // chassis rail
  { circle: [6.6, 18.7, 2.75], fill: 'fg' }, // rear wheel
  { circle: [16.4, 18.7, 2.75], fill: 'fg' }, // front wheel
  { circle: [6.6, 18.7, 1.15], fill: 'bg' }, // hubs
  { circle: [16.4, 18.7, 1.15], fill: 'bg' },
];
const GLYPH = { x0: 1.2, y0: 5.0, x1: 21.0, y1: 21.45 }; // bounding box of the shapes above

/* ───────────────────────── geometry ───────────────────────── */

function inRoundRect(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(px, py, [cx, cy, r]) {
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/* ───────────────────────── raster ───────────────────────── */

/**
 * @param size      output edge in px
 * @param glyphFrac how much of the edge the mark's longest side occupies
 * @param rounded   corner radius as a fraction of the edge (0 = full bleed, for maskable)
 * @param mono      transparent background + white mark (Android notification badge)
 */
function render(size, { glyphFrac = 0.62, rounded = 0.22, mono = false } = {}) {
  const SS = 4; // supersampling factor
  const N = size * SS;
  const bgRadius = rounded * N;

  // Fit the mark's bbox into glyphFrac of the canvas, centred.
  const gw = GLYPH.x1 - GLYPH.x0;
  const gh = GLYPH.y1 - GLYPH.y0;
  const scale = (glyphFrac * N) / Math.max(gw, gh);
  const offX = (N - gw * scale) / 2 - GLYPH.x0 * scale;
  const offY = (N - gh * scale) / 2 - GLYPH.y0 * scale;

  // Accumulate premultiplied colour per output pixel, then divide down.
  const acc = new Float64Array(size * size * 4);

  for (let sy = 0; sy < N; sy++) {
    const oy = (sy / SS) | 0;
    for (let sx = 0; sx < N; sx++) {
      // Background: gradient inside a rounded square (or nothing at all in mono mode).
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (!mono && inRoundRect(sx, sy, [0, 0, N, N, bgRadius])) {
        const t = (sx / N + sy / N) / 2; // 135° sweep
        r = GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t;
        g = GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t;
        b = GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t;
        a = 255;
      }
      const bg = [r, g, b, a];

      // Then the mark, in design-grid coordinates.
      const gx = (sx - offX) / scale;
      const gy = (sy - offY) / scale;
      for (const s of SHAPES) {
        const hit = s.rrect ? inRoundRect(gx, gy, s.rrect) : inCircle(gx, gy, s.circle);
        if (!hit) continue;
        if (s.fill === 'fg') {
          r = 255;
          g = 255;
          b = 255;
          a = 255;
        } else {
          [r, g, b, a] = bg;
        }
      }

      const i = (oy * size + ((sx / SS) | 0)) * 4;
      const alpha = a / 255;
      acc[i] += r * alpha;
      acc[i + 1] += g * alpha;
      acc[i + 2] += b * alpha;
      acc[i + 3] += a;
    }
  }

  // Un-premultiply back to straight RGBA so edge pixels blend correctly.
  const px = Buffer.alloc(size * size * 4);
  const samples = SS * SS;
  for (let i = 0; i < size * size; i++) {
    const avgA = acc[i * 4 + 3] / samples; // 0..255
    const aNorm = avgA / 255;
    if (aNorm <= 0) continue; // buffer is already zeroed = fully transparent
    px[i * 4] = Math.min(255, Math.round(acc[i * 4] / samples / aNorm));
    px[i * 4 + 1] = Math.min(255, Math.round(acc[i * 4 + 1] / samples / aNorm));
    px[i * 4 + 2] = Math.min(255, Math.round(acc[i * 4 + 2] / samples / aNorm));
    px[i * 4 + 3] = Math.round(avgA);
  }
  return px;
}

/* ───────────────────────── PNG encoder ───────────────────────── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay 0: deflate / adaptive filtering / no interlace

  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────────────── outputs ───────────────────────── */

const TARGETS = [
  ['icon-192.png', 192, { glyphFrac: 0.6, rounded: 0.22 }],
  ['icon-512.png', 512, { glyphFrac: 0.6, rounded: 0.22 }],
  // Maskable: full bleed, mark inside the 80% safe circle so Android can crop any shape.
  ['icon-192-maskable.png', 192, { glyphFrac: 0.46, rounded: 0 }],
  ['icon-512-maskable.png', 512, { glyphFrac: 0.46, rounded: 0 }],
  // iOS masks the corners itself, so ship it square and opaque.
  ['apple-touch-icon.png', 180, { glyphFrac: 0.58, rounded: 0 }],
  ['favicon-32.png', 32, { glyphFrac: 0.72, rounded: 0.25 }],
  ['favicon-48.png', 48, { glyphFrac: 0.72, rounded: 0.25 }],
  // Android tints the notification badge, so it must be a transparent monochrome stencil.
  ['badge-96.png', 96, { glyphFrac: 0.9, mono: true }],
];

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size, opts] of TARGETS) {
  const png = encodePNG(size, render(size, opts));
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`  ${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`);
}
console.log(`\n✅ ${TARGETS.length} icons written to public/icons/`);
