import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DomEvent, DomUtil, type Map as LeafletMap } from 'leaflet';
import { useMap } from 'react-leaflet';
import { api } from '../../lib/api';
import type { WeatherGridField } from '../../lib/types';

/**
 * Animated weather on a Leaflet map — rain, cloud and wind — drawn UNDER everything the map is
 * for. The canvases live in their own pane between the base tiles (200) and the vector overlays
 * (polygons, roads: 400) and markers (vehicles: 600), so turning weather on never hides a car,
 * an assigned area or a driven road.
 *
 * Data: GET /api/weather/grid, a coarse 24-hour field over the current view (≤ 11×11 points,
 * cached server-side). Everything visual is computed here:
 *   rain / cloud — bilinear in space and linear in time between the forecast hours, rendered at a
 *                  quarter resolution and smoothed up by the browser (fields this coarse have no
 *                  detail to lose, and it keeps a pan at 60 fps);
 *   wind         — particles advected through the interpolated u/v field, with fading trails.
 *
 * Mercator makes longitude linear in x and latitude a function of y alone, so a frame needs one
 * projection per column and per row rather than one per pixel.
 *
 * Drop <WeatherLayers storageKey="…" /> inside any <MapContainer>; it brings its own panel, top-right
 * (`top` moves it down past a control that already lives there).
 */

interface Toggles { rain: boolean; clouds: boolean; wind: boolean }
const OFF: Toggles = { rain: false, clouds: false, wind: false };
const SCALE = 4; // field canvas: one pixel per 4×4 screen pixels
const PANE = 'weatherPane';
const GRID_MAX_CELLS = 10; // services/weatherGrid.js

function readToggles(key: string): Toggles {
  try {
    const raw = localStorage.getItem(`weatherLayers:${key}`);
    if (raw) return { ...OFF, ...JSON.parse(raw) };
  } catch { /* private window, blocked storage */ }
  return OFF;
}

/** Rain colour ramp, mm per hour → rgba. Light drizzle barely tints; a downpour is unmistakable. */
const RAIN_STOPS: [number, [number, number, number, number]][] = [
  [0.05, [96, 165, 250, 0]],
  [0.2, [96, 165, 250, 0.32]],
  [1, [37, 99, 235, 0.48]],
  [3, [29, 78, 216, 0.6]],
  [7, [124, 58, 237, 0.68]],
  [15, [219, 39, 119, 0.74]],
  [30, [220, 38, 38, 0.8]],
];
function rainRgba(mm: number): [number, number, number, number] {
  if (mm < RAIN_STOPS[0][0]) return [0, 0, 0, 0];
  for (let i = 1; i < RAIN_STOPS.length; i++) {
    const [m1, c1] = RAIN_STOPS[i];
    if (mm <= m1) {
      const [m0, c0] = RAIN_STOPS[i - 1];
      const f = (mm - m0) / (m1 - m0);
      return [0, 1, 2, 3].map((k) => c0[k] + (c1[k] - c0[k]) * f) as [number, number, number, number];
    }
  }
  return RAIN_STOPS[RAIN_STOPS.length - 1][1];
}

/** Per-hour u (east) / v (north) components, so wind is interpolated as a vector, not an angle. */
function windVectors(field: WeatherGridField) {
  return field.windKmh.map((speeds, h) => {
    const u = new Float32Array(speeds.length);
    const v = new Float32Array(speeds.length);
    for (let i = 0; i < speeds.length; i++) {
      const rad = ((field.windDirDeg[h][i] ?? 0) * Math.PI) / 180;
      // The reading is where the wind comes FROM; it blows the other way.
      u[i] = -Math.sin(rad) * speeds[i];
      v[i] = -Math.cos(rad) * speeds[i];
    }
    return { u, v };
  });
}

/** Bilinear lookup in one hour's flattened grid. gx/gy in grid units, may be fractional. */
function bilinear(arr: ArrayLike<number>, cols: number, rows: number, gx: number, gy: number) {
  if (gx < 0 || gy < 0 || gx > cols - 1 || gy > rows - 1) return NaN;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(x0 + 1, cols - 1);
  const y1 = Math.min(y0 + 1, rows - 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const a = arr[y0 * cols + x0];
  const b = arr[y0 * cols + x1];
  const c = arr[y1 * cols + x0];
  const d = arr[y1 * cols + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

interface Particle { x: number; y: number; age: number; life: number }

export function WeatherLayers({ storageKey, top = 10 }: { storageKey: string; top?: number }) {
  const map = useMap();
  const [on, setOn] = useState<Toggles>(() => readToggles(storageKey));
  const [field, setField] = useState<WeatherGridField | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hourF, setHourF] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(false);
  const any = on.rain || on.clouds || on.wind;

  useEffect(() => {
    try { localStorage.setItem(`weatherLayers:${storageKey}`, JSON.stringify(on)); } catch { /* ignore */ }
  }, [on, storageKey]);

  // Start on the hour in progress, not on the first hour of a field fetched an hour ago.
  useEffect(() => {
    if (!field?.times.length) return;
    const now = Date.now() / 1000;
    const i = field.times.findIndex((t) => t > now) - 1;
    setHourF(Math.max(0, i < 0 ? 0 : i + (now - field.times[i]) / 3600));
  }, [field]);

  /* ── fetching: only while a layer is on, only when the view leaves the field we have ── */
  const fieldRef = useRef<WeatherGridField | null>(null);
  fieldRef.current = field;
  useEffect(() => {
    if (!any) return;
    let timer: number | undefined;
    let alive = true;
    const load = () => {
      const b = map.getBounds();
      const view = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
      const span = Math.max(view.e - view.w, view.n - view.s);
      const f = fieldRef.current;
      // Keep the field we have while the view is inside it and the right size for it.
      if (f && view.w >= f.w && view.e <= f.e && view.s >= f.s && view.n <= f.n &&
          span > f.step * 2.5 && span <= f.step * GRID_MAX_CELLS) return;
      setLoading(true);
      const q = new URLSearchParams({
        w: view.w.toFixed(3), s: view.s.toFixed(3), e: view.e.toFixed(3), n: view.n.toFixed(3),
      });
      api.get<WeatherGridField>(`/api/weather/grid?${q}`)
        .then((r) => { if (alive) { setField(r); setError(null); } })
        .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Weather unavailable'); })
        .finally(() => { if (alive) setLoading(false); });
    };
    const debounced = () => { window.clearTimeout(timer); timer = window.setTimeout(load, 350); };
    load();
    map.on('moveend', debounced);
    return () => { alive = false; window.clearTimeout(timer); map.off('moveend', debounced); };
  }, [any, map]);

  /* ── play: one forecast hour every 1.2 s, looping ── */
  useEffect(() => {
    if (!playing || !field) return;
    let raf = 0;
    let last = performance.now();
    const max = field.times.length - 1;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setHourF((h) => (h + dt / 1200 > max ? 0 : h + dt / 1200));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, field]);

  /* ── the canvases ── */
  const winds = useMemo(() => (field ? windVectors(field) : null), [field]);
  const stateRef = useRef({ on, field, winds, hourF });
  // Set by the canvas effect: marks the rain / cloud field for a redraw on the next frame.
  const redrawRef = useRef<() => void>(() => {});
  stateRef.current = { on, field, winds, hourF };

  useEffect(() => {
    if (!any) return;
    const pane = map.getPane(PANE) ?? map.createPane(PANE);
    pane.style.zIndex = '350';
    pane.style.pointerEvents = 'none';
    pane.style.display = '';

    const fieldCanvas = DomUtil.create('canvas', 'weather-field', pane) as HTMLCanvasElement;
    const windCanvas = DomUtil.create('canvas', 'weather-wind', pane) as HTMLCanvasElement;
    for (const c of [fieldCanvas, windCanvas]) {
      c.style.position = 'absolute';
      c.style.left = '0';
      c.style.top = '0';
    }
    const fctx = fieldCanvas.getContext('2d')!;
    const wctx = windCanvas.getContext('2d')!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let W = 0;
    let H = 0;
    let lonOfX: Float64Array = new Float64Array(0); // per screen column
    let latOfY: Float64Array = new Float64Array(0); // per screen row
    let particles: Particle[] = [];
    let fieldDirty = true;
    let raf = 0;
    let zooming = false;

    const resize = () => {
      const size = map.getSize();
      W = size.x;
      H = size.y;
      fieldCanvas.width = Math.ceil(W / SCALE);
      fieldCanvas.height = Math.ceil(H / SCALE);
      fieldCanvas.style.width = `${W}px`;
      fieldCanvas.style.height = `${H}px`;
      windCanvas.width = Math.round(W * dpr);
      windCanvas.height = Math.round(H * dpr);
      windCanvas.style.width = `${W}px`;
      windCanvas.style.height = `${H}px`;
      wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const project = () => {
      // Pin both canvases to the container's top-left inside the moving map pane.
      const origin = map.containerPointToLayerPoint([0, 0]);
      DomUtil.setPosition(fieldCanvas, origin);
      DomUtil.setPosition(windCanvas, origin);
      lonOfX = new Float64Array(W + 1);
      latOfY = new Float64Array(H + 1);
      const left = map.containerPointToLatLng([0, 0]).lng;
      const right = map.containerPointToLatLng([W, 0]).lng;
      for (let x = 0; x <= W; x++) lonOfX[x] = left + ((right - left) * x) / W;
      for (let y = 0; y <= H; y++) latOfY[y] = map.containerPointToLatLng([0, y]).lat;
    };

    const gridXY = (f: WeatherGridField, lat: number, lon: number) => {
      let l = lon;
      while (l < f.w) l += 360;
      while (l > f.e + 1e-9 && l - 360 >= f.w) l -= 360;
      return [(l - f.w) / f.step, (f.n - lat) / f.step] as const;
    };

    const timeMix = (f: WeatherGridField, h: number) => {
      const max = f.times.length - 1;
      const h0 = Math.max(0, Math.min(Math.floor(h), max));
      const h1 = Math.min(h0 + 1, max);
      return { h0, h1, t: Math.min(Math.max(h - h0, 0), 1) };
    };

    const drawField = () => {
      const { on: o, field: f, hourF: h } = stateRef.current;
      const fw = fieldCanvas.width;
      const fh = fieldCanvas.height;
      fctx.clearRect(0, 0, fw, fh);
      if (!f || (!o.rain && !o.clouds)) return;
      const img = fctx.createImageData(fw, fh);
      const px = img.data;
      const { h0, h1, t } = timeMix(f, h);
      const r0 = f.precipMm[h0], r1 = f.precipMm[h1];
      const c0 = f.cloudPct[h0], c1 = f.cloudPct[h1];
      for (let y = 0; y < fh; y++) {
        const lat = latOfY[Math.min(y * SCALE + 2, H)];
        for (let x = 0; x < fw; x++) {
          const [gx, gy] = gridXY(f, lat, lonOfX[Math.min(x * SCALE + 2, W)]);
          let r = 0, g = 0, b = 0, a = 0;
          if (o.clouds) {
            const cv = bilinear(c0, f.cols, f.rows, gx, gy) * (1 - t) + bilinear(c1, f.cols, f.rows, gx, gy) * t;
            if (cv > 15) {
              // Slate, not white: the base map is light, and white cloud on it would vanish.
              const ca = Math.min(((cv - 15) / 85) * 0.42, 0.42);
              r = 71; g = 85; b = 105; a = ca;
            }
          }
          if (o.rain) {
            const rv = bilinear(r0, f.cols, f.rows, gx, gy) * (1 - t) + bilinear(r1, f.cols, f.rows, gx, gy) * t;
            const [rr, rg, rb, ra] = rainRgba(rv);
            if (ra > 0) {
              // Rain over cloud: "over" compositing, so a wet patch inside an overcast sky stays blue.
              const out = ra + a * (1 - ra);
              r = (rr * ra + r * a * (1 - ra)) / out;
              g = (rg * ra + g * a * (1 - ra)) / out;
              b = (rb * ra + b * a * (1 - ra)) / out;
              a = out;
            }
          }
          if (a > 0) {
            const i = (y * fw + x) * 4;
            px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a * 255;
          }
        }
      }
      fctx.putImageData(img, 0, 0);
    };

    const spawn = (p?: Particle): Particle => {
      const q = p ?? { x: 0, y: 0, age: 0, life: 0 };
      q.x = Math.random() * W;
      q.y = Math.random() * H;
      q.age = 0;
      q.life = 50 + Math.random() * 70;
      return q;
    };
    const seed = () => {
      const n = Math.min(2600, Math.round((W * H) / 900));
      particles = Array.from({ length: n }, () => {
        const p = spawn();
        p.age = Math.random() * p.life; // stagger, so they do not all respawn on one frame
        return p;
      });
      wctx.clearRect(0, 0, W, H);
    };

    const windAt = (f: WeatherGridField, w: NonNullable<typeof stateRef.current.winds>, h: number, x: number, y: number) => {
      const xi = x | 0;
      const yi = y | 0;
      if (xi < 0 || yi < 0 || xi > W || yi > H) return null;
      const [gx, gy] = gridXY(f, latOfY[yi], lonOfX[xi]);
      const { h0, h1, t } = timeMix(f, h);
      const u = bilinear(w[h0].u, f.cols, f.rows, gx, gy) * (1 - t) + bilinear(w[h1].u, f.cols, f.rows, gx, gy) * t;
      const v = bilinear(w[h0].v, f.cols, f.rows, gx, gy) * (1 - t) + bilinear(w[h1].v, f.cols, f.rows, gx, gy) * t;
      return Number.isNaN(u) || Number.isNaN(v) ? null : [u, v] as const;
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (zooming) return;
      if (fieldDirty) { drawField(); fieldDirty = false; }
      const { on: o, field: f, winds: w, hourF: h } = stateRef.current;
      if (!o.wind || !f || !w) { if (particles.length) { wctx.clearRect(0, 0, W, H); particles = []; } return; }
      if (!particles.length) seed();
      // Fade the trails: keep 92% of last frame.
      wctx.globalCompositeOperation = 'destination-in';
      wctx.fillStyle = 'rgba(0,0,0,0.92)';
      wctx.fillRect(0, 0, W, H);
      wctx.globalCompositeOperation = 'source-over';
      wctx.lineWidth = 1.25;
      wctx.lineCap = 'round';
      // Two passes by strength, so each frame sets the stroke colour twice, not per particle.
      for (const strong of [false, true]) {
        wctx.beginPath();
        wctx.strokeStyle = strong ? 'rgba(234,88,12,0.85)' : 'rgba(30,41,59,0.55)';
        for (const p of particles) {
          const uv = windAt(f, w, h, p.x, p.y);
          if (!uv) { if (!strong) spawn(p); continue; }
          const speed = Math.hypot(uv[0], uv[1]);
          if ((speed >= 40) !== strong) continue;
          // Screen speed grows gently with wind speed; a calm day still visibly drifts.
          const k = 0.028;
          const nx = p.x + uv[0] * k;
          const ny = p.y - uv[1] * k;
          wctx.moveTo(p.x, p.y);
          wctx.lineTo(nx, ny);
          p.x = nx;
          p.y = ny;
          p.age += 1;
          if (p.age > p.life || nx < 0 || ny < 0 || nx > W || ny > H) spawn(p);
        }
        wctx.stroke();
      }
    };

    const onMove = () => { project(); fieldDirty = true; if (particles.length) seed(); };
    const onResize = () => { resize(); onMove(); };
    const onZoomStart = () => { zooming = true; pane.style.visibility = 'hidden'; };
    const onZoomEnd = () => { zooming = false; pane.style.visibility = ''; onMove(); };

    resize();
    project();
    map.on('move', onMove);
    map.on('resize', onResize);
    map.on('zoomstart', onZoomStart);
    map.on('zoomend', onZoomEnd);
    raf = requestAnimationFrame(frame);
    redrawRef.current = () => { fieldDirty = true; };

    return () => {
      cancelAnimationFrame(raf);
      map.off('move', onMove);
      map.off('resize', onResize);
      map.off('zoomstart', onZoomStart);
      map.off('zoomend', onZoomEnd);
      fieldCanvas.remove();
      windCanvas.remove();
      pane.style.visibility = '';
      redrawRef.current = () => {};
    };
  }, [any, map]);

  useEffect(() => { redrawRef.current(); }, [field, hourF, on.rain, on.clouds]);

  const toggle = useCallback((k: keyof Toggles) => setOn((o) => ({ ...o, [k]: !o[k] })), []);

  return createPortal(
    <WeatherPanel
      map={map}
      top={top}
      open={open || any}
      setOpen={setOpen}
      on={on}
      toggle={toggle}
      field={field}
      hourF={hourF}
      setHourF={(h) => { setPlaying(false); setHourF(h); }}
      playing={playing}
      setPlaying={setPlaying}
      loading={loading}
      error={error}
    />,
    map.getContainer(),
  );
}

function WeatherPanel(props: {
  map: LeafletMap;
  top: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  on: Toggles;
  toggle: (k: keyof Toggles) => void;
  field: WeatherGridField | null;
  hourF: number;
  setHourF: (h: number) => void;
  playing: boolean;
  setPlaying: (v: boolean) => void;
  loading: boolean;
  error: string | null;
}) {
  const { top, open, setOpen, on, toggle, field, hourF, setHourF, playing, setPlaying, loading, error } = props;
  const ref = useRef<HTMLDivElement>(null);
  // Clicks and drags on the panel are the panel's — they must not pan or zoom the map.
  useEffect(() => {
    if (!ref.current) return;
    DomEvent.disableClickPropagation(ref.current);
    DomEvent.disableScrollPropagation(ref.current);
  }, [open]);

  const any = on.rain || on.clouds || on.wind;
  const label = field?.times.length
    ? new Date((field.times[0] + Math.floor(hourF) * 3600) * 1000).toLocaleString([], {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
      })
    : '';

  const box: CSSProperties = {
    position: 'absolute', top, right: 10, zIndex: 1000,
    background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 10,
    boxShadow: '0 2px 10px rgba(0,0,0,0.14)', fontSize: 12, color: 'var(--text)',
  };

  if (!open) {
    return (
      <div ref={ref} style={box}>
        <button className="btn-ghost" style={{ padding: '6px 10px', fontSize: 12, fontWeight: 700 }} onClick={() => setOpen(true)}
          title="Show animated rain, cloud and wind on this map">
          🌦️ Weather
        </button>
      </div>
    );
  }

  const chip = (k: keyof Toggles, text: string) => (
    <button
      key={k}
      onClick={() => toggle(k)}
      className="btn-ghost"
      aria-pressed={on[k]}
      style={{
        padding: '4px 9px', fontSize: 11.5, fontWeight: 700, borderRadius: 999,
        background: on[k] ? 'var(--brand)' : undefined, color: on[k] ? '#fff' : undefined,
        border: on[k] ? '1px solid var(--brand)' : '1px solid var(--line-2)',
      }}
    >
      {text}
    </button>
  );

  return (
    <div ref={ref} style={{ ...box, padding: '9px 11px', width: 248 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7 }}>
        <b style={{ fontSize: 12.5, flex: 1 }}>Weather layers</b>
        {loading && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>loading…</span>}
        {!any && (
          <button className="btn-ghost" style={{ padding: '0 6px', fontSize: 14, lineHeight: 1 }} onClick={() => setOpen(false)} aria-label="Close">×</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {chip('rain', '🌧 Rain')}
        {chip('clouds', '☁ Clouds')}
        {chip('wind', '💨 Wind')}
      </div>

      {any && field && field.times.length > 1 && (
        <div style={{ marginTop: 9 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => setPlaying(!playing)}
              title={playing ? 'Pause' : 'Play the next 24 hours'}>
              {playing ? '⏸' : '▶'}
            </button>
            <input type="range" min={0} max={field.times.length - 1} step={0.05} value={hourF}
              onChange={(e) => setHourF(Number(e.target.value))} style={{ flex: 1 }} aria-label="Forecast hour" />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2, fontWeight: 600 }}>{label}</div>
        </div>
      )}

      {on.rain && (
        <div style={{ marginTop: 8 }}>
          <div style={{
            height: 7, borderRadius: 4,
            background: 'linear-gradient(90deg, rgba(96,165,250,.35), rgba(37,99,235,.6), rgba(124,58,237,.75), rgba(219,39,119,.8), rgba(220,38,38,.85))',
          }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9.5, color: 'var(--muted)', marginTop: 2 }}>
            <span>0.2</span><span>1</span><span>7</span><span>15</span><span>30+ mm/h</span>
          </div>
        </div>
      )}
      {on.wind && (
        <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 6 }}>
          Streaks follow the wind; <span style={{ color: '#ea580c', fontWeight: 700 }}>orange</span> is 40 km/h or more.
        </div>
      )}
      {error && <div style={{ fontSize: 10.5, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
      {any && (
        <div style={{ fontSize: 9.5, color: 'var(--muted)', marginTop: 7, lineHeight: 1.4 }}>
          Forecast model (Open-Meteo), not radar or vehicle readings.
          {field?.stale ? ' Showing the last good forecast.' : ''}
        </div>
      )}
    </div>
  );
}
