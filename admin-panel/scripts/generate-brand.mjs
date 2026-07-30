// Derives every brand asset from the one source logo, so there is a single place to change
// if the logo is ever updated.
//
//   npm run brand
//
// Inputs : scripts/source/jsan-logo.png  (the company wordmark as supplied, 172x56 RGBA)
// Outputs: public/brand/logo.png         the logo, byte-for-byte — what the UI displays
//          public/icons/*.png            PWA + favicon set: the same logo, centred on white
//
// The logo is never recoloured or cropped. The one exception is badge-96.png: Android flattens
// a notification badge to a single tint, which would reduce the wordmark to an illegible blob,
// so that asset alone uses the square glyph as a silhouette.
//
// Dependency-free on purpose: decodes and re-encodes PNG with node's zlib.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'source', 'jsan-logo.png');
const BRAND_DIR = join(HERE, '..', 'public', 'brand');
const ICON_DIR = join(HERE, '..', 'public', 'icons');

/** Brand blue, sampled from the logo itself — used for shadows/accents in the CSS. */
const BLUE = [0, 85, 140];
/** Icons sit on white, because that is the background the wordmark was drawn for. */
const WHITE = [255, 255, 255];

/* ───────────────────────── PNG decode ───────────────────────── */

function decodePNG(buf) {
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`expected 8-bit RGBA, got bitDepth=${bitDepth} colorType=${colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    // Undo the per-scanline filter (PNG spec §9).
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(px, y * stride);
    cur.copy(prev);
  }
  return { width, height, px };
}

/* ───────────────────────── PNG encode ───────────────────────── */

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
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ───────────────────────── helpers ───────────────────────── */

const at = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]];
};

function crop(img, x0, y0, w, h) {
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    img.px.copy(px, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
  }
  return { width: w, height: h, px };
}

/** Bounding box of pixels that are blue rather than near-black wordmark. */
function blueBBox(img) {
  let x0 = img.width, x1 = -1, y0 = img.height, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = at(img, x, y);
      if (a < 128) continue;
      if (!(b > 80 && b > r + 30 && g < b)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Bilinear resample on premultiplied alpha — without premultiplying, transparent pixels drag
 * their (undefined) colour into the edges and the mark gets a dark halo.
 */
function resize(img, w, h) {
  const px = Buffer.alloc(w * h * 4);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      let r = 0, g = 0, b = 0, a = 0;
      for (const [px_, py_, weight] of [
        [x0, y0, (1 - wx) * (1 - wy)], [x1, y0, wx * (1 - wy)],
        [x0, y1, (1 - wx) * wy], [x1, y1, wx * wy],
      ]) {
        const [sr, sg, sb, sa] = at(img, px_, py_);
        const al = sa / 255;
        r += sr * al * weight; g += sg * al * weight; b += sb * al * weight; a += sa * weight;
      }
      const i = (y * w + x) * 4;
      const an = a / 255;
      px[i] = an > 0 ? Math.min(255, Math.round(r / an)) : 0;
      px[i + 1] = an > 0 ? Math.min(255, Math.round(g / an)) : 0;
      px[i + 2] = an > 0 ? Math.min(255, Math.round(b / an)) : 0;
      px[i + 3] = Math.round(a);
    }
  }
  return { width: w, height: h, px };
}

/** Repaint every visible pixel one colour, keeping the shape's alpha. */
function tint(img, [r, g, b]) {
  const px = Buffer.from(img.px);
  for (let i = 0; i < img.width * img.height; i++) {
    if (px[i * 4 + 3] === 0) continue;
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b;
  }
  return { width: img.width, height: img.height, px };
}

function inRoundRect(px, py, x, y, w, h, radius) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + radius), x + w - radius);
  const cy = Math.min(Math.max(py, y + radius), y + h - radius);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/** Centre `fg` on a square canvas of `size`, over an optional rounded background. */
function compose(fg, size, { fraction, background, rounded = 0, opaque = false }) {
  const scale = (fraction * size) / Math.max(fg.width, fg.height);
  const w = Math.max(1, Math.round(fg.width * scale));
  const h = Math.max(1, Math.round(fg.height * scale));
  const art = resize(fg, w, h);
  const offX = Math.round((size - w) / 2);
  const offY = Math.round((size - h) / 2);

  const out = Buffer.alloc(size * size * 4);
  const radius = rounded * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (background && (rounded === 0 || inRoundRect(x, y, 0, 0, size, size, radius))) {
        out[i] = background[0]; out[i + 1] = background[1]; out[i + 2] = background[2]; out[i + 3] = 255;
      } else if (opaque) {
        out[i] = 255; out[i + 1] = 255; out[i + 2] = 255; out[i + 3] = 255;
      }
      const ax = x - offX, ay = y - offY;
      if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
      const [sr, sg, sb, sa] = at(art, ax, ay);
      if (!sa) continue;
      const al = sa / 255;
      const inv = 1 - al;
      out[i] = Math.round(sr * al + out[i] * inv);
      out[i + 1] = Math.round(sg * al + out[i + 1] * inv);
      out[i + 2] = Math.round(sb * al + out[i + 2] * inv);
      out[i + 3] = Math.max(out[i + 3], sa);
    }
  }
  return { width: size, height: size, px: out };
}

/* ───────────────────────── build ───────────────────────── */

const source = decodePNG(readFileSync(SRC));
console.log(`source ${source.width}x${source.height}`);

const box = blueBBox(source);
console.log(`glyph  ${box.w}x${box.h} at (${box.x0},${box.y0})  (badge only)`);

mkdirSync(BRAND_DIR, { recursive: true });
mkdirSync(ICON_DIR, { recursive: true });

const write = (dir, name, img) => {
  const png = encodePNG(img.width, img.height, img.px);
  writeFileSync(join(dir, name), png);
  console.log(`  ${name.padEnd(26)} ${img.width}x${img.height}  ${(png.length / 1024).toFixed(1)} kB`);
};

console.log('\nbrand/');
// The wordmark verbatim — byte-for-byte the supplied file. This is what the UI displays.
writeFileSync(join(BRAND_DIR, 'logo.png'), readFileSync(SRC));
console.log(`  logo.png                   ${source.width}x${source.height} (copied verbatim)`);

console.log('\nicons/  the whole wordmark on white — the logo as supplied, only centred');
const ICONS = [
  ['icon-192.png', 192, { fraction: 0.80, background: WHITE, rounded: 0.22 }],
  ['icon-512.png', 512, { fraction: 0.80, background: WHITE, rounded: 0.22 }],
  // Maskable icons get cropped to a circle/squircle by the launcher, so the artwork must sit
  // inside the safe area — smaller, not edge-to-edge.
  ['icon-192-maskable.png', 192, { fraction: 0.62, background: WHITE, rounded: 0 }],
  ['icon-512-maskable.png', 512, { fraction: 0.62, background: WHITE, rounded: 0 }],
  ['apple-touch-icon.png', 180, { fraction: 0.78, background: WHITE, rounded: 0 }],
  ['favicon-32.png', 32, { fraction: 0.86, background: WHITE, rounded: 0.20 }],
  ['favicon-48.png', 48, { fraction: 0.86, background: WHITE, rounded: 0.20 }],
];
for (const [name, size, opts] of ICONS) write(ICON_DIR, name, compose(source, size, opts));

// Android tints the notification badge a flat colour, so it can only be a silhouette. The
// wordmark would turn into an unreadable blob; the square glyph is the only thing that reads
// at 24dp, so this single asset is derived from the mark.
write(ICON_DIR, 'badge-96.png', compose(tint(crop(source, box.x0, box.y0, box.w, box.h), [255, 255, 255]), 96, { fraction: 0.82 }));

console.log('\n✅ brand assets rebuilt from the source logo');
