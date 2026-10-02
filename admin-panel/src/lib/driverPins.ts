import type { DriverPosition } from './types';

/**
 * The "where each driver left off" pins on the coverage map: the artwork, and the words.
 *
 * The words live here rather than in the page because three places say them — the pin's tooltip,
 * the crew list and the driver's card — and "left off 3 h ago" in one and "2 h ago" in another
 * would be a bug that only shows on a screenshot.
 */

/** One pin as the map draws it. Built by the page from a DriverPosition. */
export interface DriverPin {
  kind: 'pin';
  driverId: string;
  name: string;
  lon: number;
  lat: number;
  state: DriverPosition['state'];
  /** The driver's colour — the same one their polygons, tracks and crew row use. */
  color: [number, number, number];
  /** 0–255. A drive that ended long ago is drawn fainter: still true, no longer news. */
  alpha: number;
  /** Tooltip lines. */
  status: string;
  where: string;
}

const MINUTE = 60_000;
/** Past this, a finished drive's pin fades and its age is given as a date. */
const OLD_AFTER_DAYS = 30;

/** "12 min ago", "3 h ago", "5 days ago", then a date — "on 12 Jun". */
export function agoText(iso: string, now: number): string {
  const then = new Date(iso);
  const min = Math.max(0, Math.floor((now - then.getTime()) / MINUTE));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days <= OLD_AFTER_DAYS) return `${days} day${days === 1 ? '' : 's'} ago`;
  const sameYear = then.getFullYear() === new Date(now).getFullYear();
  return `on ${then.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}`;
}

/** The one-line answer to "where is this driver up to?". */
export function statusText(p: DriverPosition, now: number): string {
  if (p.state === 'moving') return 'Driving now';
  if (p.state === 'stopped') return 'Stopped — drive still open';
  if (p.state === 'stale') return `No signal · last seen ${agoText(p.at, now)}`;
  return `Left off ${agoText(p.at, now)}`;
}

export function whereText(p: DriverPosition): string {
  return p.area ? `in ${p.area.name}` : 'outside every work area';
}

export function pinAlpha(p: DriverPosition, now: number): number {
  const old = p.state === 'ended' && now - new Date(p.at).getTime() > OLD_AFTER_DAYS * 24 * 60 * MINUTE;
  return old ? 140 : 255;
}

/** Draw order: finished drives underneath, whoever is out there now on top. */
export const PIN_RANK: Record<DriverPosition['state'], number> = { ended: 0, stale: 1, stopped: 2, moving: 3 };

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/* ---------------------------------------------------------------- artwork */

// The fonts an SVG rendered through <img> can actually reach: system ones only. The panel's own
// web font is not available inside a data-URL image, so the tag is measured and drawn in these.
const TAG_FAMILY = '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const TAG_FONT = `600 12px ${TAG_FAMILY}`;
const TAG_MAX_CHARS = 20;

/** The pin is the trip-marker teardrop (48×64) at three-quarter size. */
const PIN_SCALE = 0.75;
const PIN_W = 48 * PIN_SCALE + 2;
const ICON_H = 50;
/** Rasterised at twice the drawn size, so the name stays sharp on a high-density screen. */
const RASTER = 2;

let measurer: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string): number {
  if (measurer === undefined) {
    measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!measurer) return text.length * 7;
  measurer.font = TAG_FONT;
  return measurer.measureText(text).width;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = (w: string) => Array.from(w)[0] || '';
  const two = words.length > 1 ? first(words[0]) + first(words[words.length - 1]) : Array.from(words[0] || '?').slice(0, 2).join('');
  return two.toUpperCase();
}

export interface PinIcon {
  url: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
}

const iconCache = new Map<string, PinIcon>();

/**
 * A teardrop in the driver's colour carrying their initials, with their name on a tag beside it —
 * so "which pin is Sam" never needs a hover. A dot on the pin says whether the drive is still
 * open: green while the vehicle is moving, amber while it is stopped or out of contact.
 *
 * The TIP of the teardrop is the position; the icon is anchored there.
 */
export function pinIcon(name: string, color: [number, number, number], state: DriverPosition['state']): PinIcon {
  const key = `${name}|${color.join(',')}|${state}`;
  const hit = iconCache.get(key);
  if (hit) return hit;

  const chars = Array.from(name.trim() || 'Driver');
  const label = chars.length > TAG_MAX_CHARS ? `${chars.slice(0, TAG_MAX_CHARS - 1).join('')}…` : chars.join('');
  const tagW = Math.ceil(textWidth(label)) + 18;
  const width = Math.ceil(PIN_W + tagW + 1);
  const rgb = `rgb(${color.join(',')})`;
  const badge =
    state === 'ended'
      ? ''
      : `<circle cx="40" cy="9" r="7.5" fill="${state === 'moving' ? '#059669' : '#d97706'}" stroke="#ffffff" stroke-width="2.5"/>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * RASTER}" height="${ICON_H * RASTER}" viewBox="0 0 ${width} ${ICON_H}">` +
    // The tag first, so the pin's edge sits over its left end.
    `<rect x="${PIN_W - 3}" y="7.5" width="${tagW + 3}" height="22" rx="11" fill="#ffffff" stroke="rgba(15,23,42,0.28)"/>` +
    `<text x="${PIN_W + 7}" y="22.6" font-family='${TAG_FAMILY}' font-size="12" font-weight="600" fill="#0f172a">${escapeHtml(label)}</text>` +
    `<g transform="translate(1,1) scale(${PIN_SCALE})">` +
    `<path d="M24 2C12.4 2 3 11.4 3 23c0 15.8 21 39 21 39s21-23.2 21-39C45 11.4 35.6 2 24 2z" fill="${rgb}" stroke="#ffffff" stroke-width="3"/>` +
    '<circle cx="24" cy="23" r="14.5" fill="#ffffff"/>' +
    `<text x="24" y="28.4" text-anchor="middle" font-family='${TAG_FAMILY}' font-size="15" font-weight="700" fill="${rgb}">${escapeHtml(initials(name))}</text>` +
    badge +
    '</g></svg>';

  const icon: PinIcon = {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: width * RASTER,
    height: ICON_H * RASTER,
    anchorX: (1 + 24 * PIN_SCALE) * RASTER,
    anchorY: (1 + 62 * PIN_SCALE) * RASTER,
  };
  iconCache.set(key, icon);
  return icon;
}

/** Drawn height of a pin in pixels — the icon is authored 1:1 at this size. */
export const PIN_SIZE = ICON_H;
