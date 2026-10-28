import type { DrivingRisk } from '../../lib/types';

/** Shared look of weather across the Weather tab, the Live Map layers and the trip replay. */
export const RISK_LABEL: Record<DrivingRisk, string> = {
  clear: 'Good to drive',
  caution: 'Drive with caution',
  unsafe: 'Do not drive',
};
export const RISK_BADGE: Record<DrivingRisk, string> = { clear: 'green', caution: 'amber', unsafe: 'red' };
export const RISK_DOT: Record<DrivingRisk, string> = { clear: '🟢', caution: '🟠', unsafe: '🔴' };
export const RISK_COLOR: Record<DrivingRisk, string> = {
  clear: 'var(--green)', caution: 'var(--amber)', unsafe: 'var(--red)',
};
/** Same three, as plain hex for canvas / SVG / WebGL where CSS variables do not reach. */
export const RISK_HEX: Record<DrivingRisk, string> = { clear: '#059669', caution: '#f97316', unsafe: '#dc2626' };

const ICONS: Record<string, string> = {
  'sun-d': '☀️', 'sun-n': '🌙', 'partly-d': '⛅', 'partly-n': '☁️',
  cloud: '☁️', fog: '🌫️', drizzle: '🌦️', rain: '🌧️',
  showers: '🌦️', snow: '🌨️', storm: '⛈️',
};
export const glyphFor = (icon: string | null | undefined) => (icon && ICONS[icon]) || '·';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Meteorological wind direction (where it blows FROM) as a compass word. */
export const compass = (deg: number | null | undefined) =>
  deg == null ? '' : COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** A local "YYYY-MM-DD" (the forecast location's date) as "Wed 29 Oct". */
export function dateLabel(date: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) {
  // Noon UTC keeps the calendar date the same in every viewer's time zone.
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}
