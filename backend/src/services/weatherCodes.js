/**
 * WMO weather codes → what they mean for a vehicle.
 *
 * Open-Meteo reports conditions as WMO codes (https://open-meteo.com/en/docs), not free text,
 * so this is both the severity map and the source of the human description shown in the UI.
 *
 * Grouped by driving consequence rather than meteorological family — anything that puts ice
 * on the road sits with the worst of them, because black ice is the same problem whether it
 * arrived as drizzle or as rain.
 */
const CLEAR = 'clear';
const CAUTION = 'caution';
const UNSAFE = 'unsafe';

const CODES = {
  0: ['clear sky', CLEAR],
  1: ['mainly clear', CLEAR],
  2: ['partly cloudy', CLEAR],
  3: ['overcast', CLEAR],

  45: ['fog', CAUTION],
  48: ['freezing fog', UNSAFE], // fog plus ice on the road

  51: ['light drizzle', CLEAR],
  53: ['drizzle', CLEAR],
  55: ['dense drizzle', CAUTION],
  56: ['freezing drizzle', UNSAFE],
  57: ['dense freezing drizzle', UNSAFE],

  61: ['light rain', CLEAR],
  63: ['moderate rain', CAUTION],
  65: ['heavy rain', UNSAFE],
  66: ['freezing rain', UNSAFE],
  67: ['heavy freezing rain', UNSAFE],

  71: ['light snow', CAUTION],
  73: ['moderate snow', CAUTION],
  75: ['heavy snow', UNSAFE],
  77: ['snow grains', CAUTION],

  80: ['light showers', CLEAR],
  81: ['moderate showers', CAUTION],
  82: ['violent showers', UNSAFE],

  85: ['light snow showers', CAUTION],
  86: ['heavy snow showers', UNSAFE],

  95: ['thunderstorm', UNSAFE],
  96: ['thunderstorm with hail', UNSAFE],
  99: ['thunderstorm with heavy hail', UNSAFE],
};

/** Severity + description for a WMO code. Unknown codes are treated as clear, never worse. */
function classifyWmo(code) {
  const hit = CODES[code];
  return hit
    ? { description: hit[0], severity: hit[1] }
    : { description: 'unknown conditions', severity: CLEAR };
}

/**
 * Icon name for a code, matching the small set the panel renders.
 * Deliberately coarse — the verdict colour carries the meaning, the icon is decoration.
 */
function iconFor(code, isDay = true) {
  const d = isDay ? 'd' : 'n';
  if (code === 0 || code === 1) return `sun-${d}`;
  if (code === 2) return `partly-${d}`;
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if (code >= 61 && code <= 67) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 80 && code <= 82) return 'showers';
  if (code >= 95) return 'storm';
  return 'cloud';
}

module.exports = { classifyWmo, iconFor, CODES, CLEAR, CAUTION, UNSAFE };
