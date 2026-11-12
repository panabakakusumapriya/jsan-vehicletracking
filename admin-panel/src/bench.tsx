/**
 * Frame-rate test page for the coverage map (dev tool, not part of the panel build).
 *
 * Mounts the real <CoverageMap> against a stand-in API that serves saved copies of the areas, the
 * road files and the driven state, then moves the camera by script and records the time between
 * frames (window.__bench, window.__info). Built with vite.bench.config.ts.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './index.css';
import './premium.css';
import { Map as MaplibreMap } from 'maplibre-gl';
import { createRoot } from 'react-dom/client';
import { CoverageMap } from './components/CoverageMap';

type AnyMap = MaplibreMap & { painter: { context: { gl: WebGL2RenderingContext } } };
const w = window as unknown as Record<string, unknown>;
const q = new URLSearchParams(location.search);

// The map and the deck.gl overlay, for the script below. Map3D keeps both private.
const proto = MaplibreMap.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
const addControl = proto.addControl;
proto.addControl = function patched(this: unknown, ...a: unknown[]) {
  w.__map = this;
  if (a[0] && typeof (a[0] as { setProps?: unknown }).setProps === 'function') w.__overlay = a[0];
  return addControl.apply(this, a);
};
const setStyle = proto.setStyle;
proto.setStyle = function patched(this: unknown, ...a: unknown[]) {
  const style = q.get('style');
  if (style && typeof a[0] === 'string') a[0] = `https://tiles.openfreemap.org/styles/${style}`;
  return setStyle.apply(this, a);
};

// Long frames and what ran in them (Chrome's long-animation-frame entries).
w.__loaf = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as unknown as { duration: number; renderStart: number; startTime: number; scripts: { duration: number; invoker: string; sourceFunctionName: string; sourceCharPosition: number }[] }[]) {
      if (e.duration < 80) continue;
      (w.__loaf as unknown[]).push({ ms: Math.round(e.duration), scripts: e.scripts.map((x) => `${Math.round(x.duration)}ms ${x.invoker} ${x.sourceFunctionName}@${x.sourceCharPosition}`).slice(0, 6) });
    }
  }).observe({ type: 'long-animation-frame', buffered: true });
} catch { /* not supported */ }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const total = ms.reduce((a, b) => a + b, 0);
  return {
    frames: ms.length,
    seconds: +(total / 1000).toFixed(2),
    fps: +(1000 * ms.length / total).toFixed(1),
    medianMs: +at(0.5).toFixed(1),
    p95Ms: +at(0.95).toFixed(1),
    p99Ms: +at(0.99).toFixed(1),
    maxMs: +s[s.length - 1].toFixed(1),
    // A frame is "dropped" at 60 Hz when it took more than one and a half refresh intervals.
    over25ms: ms.filter((x) => x > 25).length,
    over50ms: ms.filter((x) => x > 50).length,
    over100ms: ms.filter((x) => x > 100).length,
    low1pctFps: +(1000 / at(0.99)).toFixed(1),
  };
}

/** Frame intervals with nothing moving: what the display and browser give when idle. */
w.__idle = async (seconds = 2) => {
  const ms: number[] = [];
  let last = await nextFrame();
  const end = last + seconds * 1000;
  while (last < end) { const t = await nextFrame(); ms.push(t - last); last = t; }
  return stats(ms);
};

w.__info = () => {
  const map = w.__map as AnyMap | undefined;
  if (!map) return null;
  const gl = map.painter.context.gl;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const deck = (w.__overlay as { _deck?: { layerManager?: { getLayers(): { id: string; props: { data?: { length?: number; attributes?: { getPath?: { value: { length: number } } } } } }[] } } })?._deck;
  const layers = deck?.layerManager?.getLayers() || [];
  let links = 0;
  let vertices = 0;
  for (const l of layers) {
    if (!l.id.startsWith('roads-')) continue;
    links += l.props.data?.length || 0;
    vertices += (l.props.data?.attributes?.getPath?.value.length || 0) / 2;
  }
  return {
    webgl: gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1',
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    dpr: devicePixelRatio,
    deckLayers: layers.length,
    roadLayers: layers.filter((l) => l.id.startsWith('roads-')).length,
    roadLinks: links,
    roadVertices: vertices,
    zoom: +map.getZoom().toFixed(2),
    center: map.getCenter().toArray().map((n) => +n.toFixed(4)),
  };
};

/**
 * Move the camera by script for `seconds` and time every frame.
 *   pan  — a circle a quarter of the view wide, once every 4 s
 *   zoom — in and out by one zoom level, once every 4 s
 */
w.__bench = async (o: { center: [number, number]; zoom: number; kind: 'pan' | 'zoom'; seconds?: number; settle?: number }) => {
  const map = w.__map as AnyMap;
  const seconds = o.seconds ?? 6;
  map.jumpTo({ center: o.center, zoom: o.zoom });
  // Let the basemap's tiles for this place arrive, so the run measures drawing, not downloading.
  await Promise.race([new Promise((r) => map.once('idle', r)), sleep(o.settle ?? 12000)]);
  await sleep(500);
  const b = map.getBounds();
  const rx = (b.getEast() - b.getWest()) * 0.125;
  const ry = (b.getNorth() - b.getSouth()) * 0.125;
  const ms: number[] = [];
  const t0 = await nextFrame();
  let last = t0;
  while (last - t0 < seconds * 1000) {
    const a = ((last - t0) / 4000) * 2 * Math.PI;
    if (o.kind === 'pan') map.jumpTo({ center: [o.center[0] + rx * Math.cos(a), o.center[1] + ry * Math.sin(a)] });
    else map.jumpTo({ zoom: o.zoom + Math.sin(a) });
    const t = await nextFrame();
    ms.push(t - last);
    last = t;
  }
  const out = { ...o, ...stats(ms), series: ms.map((x) => +x.toFixed(1)) };
  ((w.__runs as unknown[]) ||= []).push(out);
  return out;
};

const roads = (q.get('roads') || 'all') as 'off' | 'assigned' | 'covered' | 'all';
createRoot(document.getElementById('root')!).render(
  <CoverageMap
    versionId={q.get('scope') || undefined}
    mode="assignment"
    height="100vh"
    roadScope={roads}
    showAreas={q.get('areas') !== '0'}
  />
);
