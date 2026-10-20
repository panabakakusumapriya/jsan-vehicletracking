import { useEffect, useRef } from 'react';

/**
 * The login screen's backdrop: a street-view capture drive, seen from a chase camera. A JSAN
 * capture car with a 360° camera on a roof mast drives down a street drawn as a point cloud —
 * road, kerbs, lane markings, building facades with their windows, trees and street lights —
 * coloured by height in blue on white and fading into the distance. Every few seconds the camera
 * takes a frame: a ring flashes out from the camera head and a capture wave sweeps over the
 * street around the car, and the buildings it reaches turn a deeper blue, as captured.
 *
 * Over it sit HUD cards in the panel's own terms (frames, UKM, links matched, sync), ticking as
 * the car drives. All of it is decorative: no real drive or account data is shown.
 *
 * Canvas 2D in one requestAnimationFrame loop. The canvas covers the whole login screen; the car
 * is centred in the left 70%, under the column the grid gives the sign-in card (max(460px, 30%)).
 * Motion is integrated per second, so it runs at the same pace on 60 Hz and 120 Hz screens, and
 * pauses while the tab is hidden. With reduced motion asked for, one still frame is drawn.
 */

type Building = { side: number; z0: number; len: number; x: number; depth: number; hgt: number; cap: number };
type Tree = { side: number; z: number; shape: number; cap: number };
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
const CELL = 0.7; // the facade point grid, metres
const FAR = 190; // how far down the street is drawn
const ROAD_EDGE = 5.6; // the kerb
const LANE_EDGE = 3.4;
const CAPTURE_EVERY_M = 22; // a visible capture every this many metres (the HUD counts a frame every 5 m)
const WAVE_SPEED = 34; // m/s the capture wave travels out from the car
const WAVE_LIFE = 1.4;
const RING_LIFE = 0.9;
const START_KM = 12.4;
const START_FRAME = 4812;

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

/** Four tree canopies as point offsets [x, y, z], shared by every tree on the street. */
const TREE_SHAPES: Array<Array<[number, number, number]>> = Array.from({ length: 4 }, (_, k) => {
  const r = rng(91 + k * 17);
  const pts: Array<[number, number, number]> = [];
  for (let i = 0; i < 70; i++) {
    const u = r() * Math.PI * 2; const v = Math.acos(2 * r() - 1); const d = Math.cbrt(r());
    pts.push([Math.sin(v) * Math.cos(u) * 1.8 * d, 4.6 + Math.cos(v) * 1.5 * d, Math.sin(v) * Math.sin(u) * 1.8 * d]);
  }
  for (let y = 0; y < 3.3; y += 0.35) pts.push([0, y, 0]);
  return pts;
});

const pad = (n: number, len: number) => String(n).padStart(len, '0');

/** A mini coverage map for the HUD: a few streets, with the drive's route drawing itself over them. */
const MINI_STREETS = 'M4 14H116M4 34H116M4 54H116M18 4V60M48 4V60M78 4V60M104 4V60';
const MINI_ROUTE = 'M18 58V34H48V14H78V34H104V54H78';

export function StreetCapture() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const el = useRef<Record<string, HTMLElement | null>>({});
  const bind = (key: string) => (node: HTMLElement | null) => { el.current[key] = node; };

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
    let frameNo = START_FRAME;
    let link = 12084471;
    let gps = 0.8;
    let hudAt = 0;
    let chip = 0;
    let chipAt = 0;
    const buildings: Building[] = [];
    const trees: Tree[] = [];
    const nextBuilding = [0, 0]; // per side (left, right): where the next building starts
    const nextTree = [4, 11];
    let pulses: Pulse[] = [];
    const buckets: number[][] = PALETTE.map(() => []);
    const pointer = { x: 0, on: false };
    let par = 0; // eased pointer parallax
    let raf = 0; let last = 0; let disposed = false;

    /** Extend the street ahead of the camera and drop what has passed behind it. */
    function grow() {
      for (let s = 0; s < 2; s++) {
        const side = s ? 1 : -1;
        while (nextBuilding[s] < camZ + FAR + 40) {
          const z0 = nextBuilding[s] + 2 + rand() * 5;
          const len = 8 + rand() * 16;
          buildings.push({ side, z0, len, x: 10.5 + rand() * 3.5, depth: 8 + rand() * 6, hgt: 6 + rand() * rand() * 20, cap: 0 });
          nextBuilding[s] = z0 + len;
        }
        while (nextTree[s] < camZ + FAR + 40) {
          trees.push({ side, z: nextTree[s], shape: Math.floor(rand() * TREE_SHAPES.length), cap: 0 });
          nextTree[s] += 11 + rand() * 8;
        }
      }
      for (let i = buildings.length - 1; i >= 0; i--) if (buildings[i].z0 + buildings[i].len < camZ - 2) buildings.splice(i, 1);
      for (let i = trees.length - 1; i >= 0; i--) if (trees[i].z < camZ - 4) trees.splice(i, 1);
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
      hy = h * 0.42;
      f = h * 0.95;
      layoutHud(leftW);
      if (still) draw(performance.now());
    }

    /** Show only the HUD pieces that fit beside the car, and park the frame card above its right. */
    function layoutHud(leftW: number) {
      const carHalf = (f / CAR_AHEAD) * 1.05;
      const cards = el.current.cards;
      const padL = Math.min(72, Math.max(28, w * 0.045)); // the cards' CSS left: clamp(28px, 4.5vw, 72px)
      if (cards) cards.style.display = carCx - carHalf > padL + 236 + 16 ? '' : 'none';
      const card = floatRef.current;
      if (card) {
        const left = carCx + carHalf * 0.55;
        card.style.left = `${left}px`;
        card.style.top = `${Math.max(120, hy - 150)}px`;
        card.style.display = left + 250 < leftW - 16 ? '' : 'none';
      }
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
      const sy = hy + (f * (CAM_H + bob - y)) / zr;
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
      const kmh = 46 + 6 * Math.sin(t / 7) + 2 * Math.sin(t / 2.3);
      const v = kmh / 3.6;
      camZ += v * dt;
      dist += v * dt;
      if (dist >= nextCapture) {
        nextCapture += CAPTURE_EVERY_M;
        pulses.push({ born: now, z: camZ + CAR_AHEAD });
        capture();
      }
      pulses = pulses.filter((p) => now - p.born < Math.max(WAVE_LIFE, RING_LIFE) * 1000);
      grow();
      if (now - hudAt > 250) { hudAt = now; tick(kmh); }
      if (now - chipAt > 3200) { chipAt = now; chip = (chip + 1) % 4; setChip(); }
    }

    /** A frame taken: the frame card shows it, briefly flashing. */
    function capture() {
      frameNo = START_FRAME + Math.floor(dist / 5);
      if (rand() < 0.45) link += 1 + Math.floor(rand() * 40);
      gps = Math.min(1.2, Math.max(0.5, gps + (rand() - 0.5) * 0.2));
      const e = el.current;
      if (e.fFrame) e.fFrame.textContent = pad(frameNo, 6);
      if (e.fLink) e.fLink.textContent = String(link);
      if (e.fGps) e.fGps.textContent = `±${gps.toFixed(1)} m`;
      if (e.fHead) e.fHead.textContent = `N ${pad(10 + Math.round(rand() * 5), 3)}°`;
      const card = floatRef.current;
      if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
    }

    /** The HUD's running numbers. */
    function tick(kmh: number) {
      const e = el.current;
      const set = (k: string, s: string) => { const n = e[k]; if (n && n.textContent !== s) n.textContent = s; };
      set('frames', pad(START_FRAME + Math.floor(dist / 5), 6));
      set('speed', `${Math.round(kmh)} km/h`);
      set('km', `${(START_KM + dist / 1000).toFixed(1)} km`);
      set('cov', `${Math.min(99.9, 61.4 + (dist / 1000) * 0.8).toFixed(1)}%`);
      set('links', (1284 + Math.floor(dist / 120)).toLocaleString('en-AU'));
      set('stamp', `FRAMES ${(START_FRAME + Math.floor(dist / 5)).toLocaleString('en-AU')}`);
    }

    function setChip() {
      hudRef.current?.querySelectorAll('.sc-chip').forEach((c, i) => c.classList.toggle('on', i === chip));
    }

    /** The capture car from behind: white body, blue glass and light bar, a 360° camera on a mast. */
    function drawCar(g: CanvasRenderingContext2D, now: number) {
      const s = f / CAR_AHEAD; // px per metre at the car
      const cx = vx + (f * (CAR_X - camX)) / CAR_AHEAD;
      const gy = hy + (f * (CAM_H + bob)) / CAR_AHEAD + (still ? 0 : Math.sin(now / 110) * 0.5);
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

      // The road surface: a ground grid locked to the street, sparser with distance.
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
      // Street lights, every 32 m, staggered across the street.
      const p0 = Math.floor(camZ / 32);
      for (let k = p0; k * 32 < camZ + FAR; k++) {
        for (const sd of [-1, 1]) {
          const z = k * 32 + (sd > 0 ? 16 : 0);
          const x = sd * 6.2;
          const lit = litAt(x, z, now);
          for (let y = 0; y <= 8; y += 0.3) point(x, y, z, 5, 0.85, lit);
          for (let a = 0.2; a <= 1.6; a += 0.2) point(x - sd * a, 8 + a * 0.12, z, 6, 0.85, lit);
        }
      }

      // Trees on the footpath.
      for (const t of trees) {
        const x0 = t.side * 7.6;
        const lit = litAt(x0, t.z, now);
        if (lit > 0.45) t.cap = 1;
        for (const [dx, dy, dz] of TREE_SHAPES[t.shape]) point(x0 + dx, dy, t.z + dz, dy > 3 ? 3 + t.cap : 4, 0.7, lit);
      }

      // Building facades, windows left open, with the near end wall and a firmer roof line.
      for (const b of buildings) {
        const nearZr = b.z0 - camZ;
        if (b.z0 + b.len < camZ + 1.2 || nearZr > FAR) continue;
        // Coarser cells further away, in whole multiples so the near grid never shifts.
        const lod = nearZr < 40 ? 1 : nearZr < 90 ? 2 : 4;
        const stepM = CELL * lod;
        const X = b.side * b.x;
        const litNear = litAt(X, Math.max(b.z0, camZ + CAR_AHEAD), now);
        if (litNear > 0.45) b.cap = 1;
        const rows = Math.floor(b.hgt / CELL);
        const cols = Math.floor(b.len / CELL);
        const toneOf = (y: number) => Math.min(7, 1 + Math.round((5 * y) / 24) + b.cap);
        const base = 0.72 + b.cap * 0.2;
        for (let col = 0; col <= cols; col += lod) {
          const zz = b.z0 + col * CELL;
          const lit = litAt(X, zz, now);
          for (let row = 0; row <= rows; row += lod) {
            // Windows: three-by-two holes in the facade, between floors and piers.
            if (lod === 1 && row > 1 && row < rows - 1 && col % 4 !== 0 && row % 3 !== 0) continue;
            const y = row * CELL;
            point(X, y, zz, toneOf(y), base, lit);
          }
          point(X, rows * CELL, zz + stepM / 2, Math.min(7, toneOf(b.hgt) + 1), base + 0.15, lit);
        }
        // The corners, drawn denser and deeper, so each building reads as a box.
        for (let y = 0; y <= rows * CELL; y += stepM / 2) {
          point(X, y, b.z0, Math.min(7, toneOf(y) + 1), base + 0.15, litNear);
          point(X, y, b.z0 + cols * CELL, Math.min(7, toneOf(y) + 1), base + 0.15, litNear);
        }
        if (b.z0 > camZ + 1.2) {
          for (let xx = 0; xx <= b.depth; xx += stepM) {
            for (let y = 0; y <= rows * CELL; y += stepM) point(X + b.side * xx, y, b.z0, toneOf(y), base * 0.7, litNear);
          }
        }
      }

      for (let i = 0; i < buckets.length; i++) {
        const q = buckets[i];
        if (!q.length) continue;
        g.fillStyle = PALETTE[i];
        g.beginPath();
        for (let j = 0; j < q.length; j += 3) g.rect(q[j], q[j + 1], q[j + 2], q[j + 2]);
        g.fill();
      }

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
    tick(48);
    setChip();
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

  return (
    <>
      <canvas ref={canvasRef} className="sc-canvas" aria-hidden="true" />
      <div ref={hudRef} className="sc-hud" aria-hidden="true">
        <div className="sc-cards" ref={bind('cards')}>
          <div className="sc-card">
            <div className="sc-card-head"><i className="sc-live" /> Capture live</div>
            <dl>
              <dt>Frames</dt><dd ref={bind('frames')}>—</dd>
              <dt>Interval</dt><dd>5.0 m</dd>
              <dt>Camera</dt><dd>360° · 6 lens</dd>
              <dt>Speed</dt><dd ref={bind('speed')}>—</dd>
            </dl>
          </div>
          <div className="sc-card">
            <div className="sc-card-head">Road coverage</div>
            <svg className="sc-mini" viewBox="0 0 120 64">
              <path d={MINI_STREETS} />
              <path className="sc-mini-route" d={MINI_ROUTE} pathLength={100} />
            </svg>
            <dl>
              <dt>UKM today</dt><dd ref={bind('km')}>—</dd>
              <dt>Network</dt><dd className="sc-good" ref={bind('cov')}>—</dd>
              <dt>Links matched</dt><dd ref={bind('links')}>—</dd>
              <dt>Sync</dt><dd className="sc-good">Up to date</dd>
            </dl>
          </div>
        </div>

        <div className="sc-float" ref={floatRef}>
          <div className="sc-card-head sc-good">Frame captured</div>
          <dl>
            <dt>Frame</dt><dd ref={bind('fFrame')}>{pad(START_FRAME, 6)}</dd>
            <dt>Link ID</dt><dd ref={bind('fLink')}>12084471</dd>
            <dt>Heading</dt><dd ref={bind('fHead')}>N 012°</dd>
            <dt>GPS</dt><dd ref={bind('fGps')}>±0.8 m</dd>
          </dl>
          <div className="sc-float-foot">Front · Rear · Left · Right</div>
        </div>

        <div className="sc-chips">
          {['360°', 'Front', 'Left', 'Right'].map((c) => <span className="sc-chip" key={c}>{c}</span>)}
        </div>
        <div className="sc-stamp"><span ref={bind('stamp')}>FRAMES</span> · GPS locked</div>
      </div>
    </>
  );
}
