/**
 * Turns a forecast into a driving verdict.
 *
 * The manager's question is not "what is the weather" but "does today's work happen, and do I
 * need to do anything about it". So every hour is scored against thresholds that matter to a
 * vehicle — precipitation, visibility and especially wind — and a day is judged by its WORST
 * remaining hour, not an average. A clear morning does not cancel a dangerous evening.
 *
 * This is decision support, not a safety authority: every verdict carries the numbers that
 * produced it so a manager can overrule it.
 *
 * Everything here is pure — no network, no clock beyond what is passed in — and works on
 * NORMALISED slots, so the weather provider can change without touching the rules.
 *
 *   { dt, tempC, windKmh, gustKmh, visibilityM, popPct, precipMm,
 *     severity: 'clear'|'caution'|'unsafe', description, icon }
 */
const env = require('../config/env');

const CLEAR = 'clear';
const CAUTION = 'caution';
const UNSAFE = 'unsafe';
const RANK = { [CLEAR]: 0, [CAUTION]: 1, [UNSAFE]: 2 };

const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/**
 * Score one normalised hour: the condition severity, then the numbers that can make an
 * otherwise unremarkable hour dangerous.
 */
function scoreSlot(slot) {
  const reasons = [];
  let risk = slot.severity || CLEAR;
  if (risk !== CLEAR && slot.description) reasons.push(slot.description);

  // Wind. A high-sided van is pushed around long before a car is, which is why the gust
  // threshold sits well below anything a forecast would call a storm.
  const windKmh = slot.windKmh ?? null;
  const gustKmh = slot.gustKmh ?? null;
  const strongest = Math.round(Math.max(windKmh ?? 0, gustKmh ?? 0));
  // Name it the same way at both levels: calling a gust "wind" in the headline while the
  // slot below shows "49g" reads like two different measurements.
  const windWord = gustKmh && gustKmh > (windKmh ?? 0) ? 'gusts' : 'wind';
  if (strongest >= env.WEATHER_GUST_UNSAFE_KMH) {
    risk = worst(risk, UNSAFE);
    reasons.push(`${windWord} ${strongest} km/h`);
  } else if (strongest >= env.WEATHER_WIND_CAUTION_KMH) {
    risk = worst(risk, CAUTION);
    reasons.push(`${windWord} ${strongest} km/h`);
  }

  // Visibility, reported in metres.
  const visibility = slot.visibilityM;
  if (typeof visibility === 'number') {
    if (visibility < 1000) {
      risk = worst(risk, UNSAFE);
      reasons.push(`visibility ${(visibility / 1000).toFixed(1)} km`);
    } else if (visibility < 4000) {
      risk = worst(risk, CAUTION);
      reasons.push(`visibility ${(visibility / 1000).toFixed(1)} km`);
    }
  }

  // A high chance of rain is worth flagging even when the hour's headline condition is mild.
  const popPct = typeof slot.popPct === 'number' ? slot.popPct : 0;
  if (popPct >= 60 && risk === CLEAR) {
    risk = CAUTION;
    reasons.push(`${popPct}% chance of rain`);
  }

  return {
    ...slot,
    risk,
    reasons,
    windKmh: windKmh == null ? null : Math.round(windKmh),
    gustKmh: gustKmh == null ? null : Math.round(gustKmh),
    tempC: slot.tempC == null ? null : Math.round(slot.tempC),
    visibilityKm: typeof visibility === 'number' ? Math.round(visibility / 100) / 10 : null,
    popPct,
  };
}

/**
 * Local-day index for a UTC timestamp at a place with a fixed UTC offset.
 *
 * "Today" has to mean the driver's local day. A driver in Singapore and one in France do not
 * share one, and using the server's clock would show half the fleet the wrong day.
 */
function localDayIndex(utcSeconds, offsetSeconds) {
  return Math.floor((utcSeconds + offsetSeconds) / 86400);
}

/** "HH:MM" as read at the forecast location. */
function localTime(utcSeconds, offsetSeconds) {
  return new Date((utcSeconds + offsetSeconds) * 1000).toISOString().slice(11, 16);
}

/** "YYYY-MM-DD" as read at the forecast location. */
function localDate(utcSeconds, offsetSeconds) {
  return new Date((utcSeconds + offsetSeconds) * 1000).toISOString().slice(0, 10);
}

/**
 * Collapse repeated reasons to one per kind, keeping the worst number.
 *
 * A windy afternoon produces "wind 44 km/h" at 15:00 and "wind 49 km/h" at 18:00, and a plain
 * de-dupe keeps both — a headline reading "wind 44 km/h · wind 49 km/h" looks like a bug.
 */
function summariseReasons(list) {
  const byKind = new Map();
  for (const reason of list) {
    const kind = reason.replace(/[\d.]+/g, '#');
    const value = parseFloat((reason.match(/[\d.]+/) || ['0'])[0]);
    const seen = byKind.get(kind);
    if (!seen || value > seen.value) byKind.set(kind, { reason, value });
  }
  return [...byKind.values()].map((v) => v.reason);
}

/**
 * Group scored hours into 3-hour display blocks.
 *
 * Scoring runs hourly because that is the resolution the forecast gives and a single bad hour
 * matters. Showing 24 columns does not — so each block reports the WORST hour inside it, and
 * the strip stays readable without hiding anything.
 */
function toDisplayBlocks(hours, offsetSeconds) {
  const blocks = [];
  for (let i = 0; i < hours.length; i += 3) {
    const chunk = hours.slice(i, i + 3);
    if (!chunk.length) continue;
    const risk = chunk.reduce((acc, h) => worst(acc, h.risk), CLEAR);
    // Show the hour that drove the verdict, so the numbers match the colour.
    const driver = chunk.find((h) => h.risk === risk) || chunk[0];
    blocks.push({
      dt: chunk[0].dt,
      at: localTime(chunk[0].dt, offsetSeconds),
      risk,
      reasons: summariseReasons(chunk.flatMap((h) => h.reasons)),
      tempC: driver.tempC,
      windKmh: Math.max(...chunk.map((h) => h.windKmh ?? 0)) || null,
      gustKmh: Math.max(...chunk.map((h) => h.gustKmh ?? 0)) || null,
      popPct: Math.max(...chunk.map((h) => h.popPct ?? 0)),
      visibilityKm: Math.min(...chunk.map((h) => h.visibilityKm ?? 99)),
      precipMm: Math.round(chunk.reduce((n, h) => n + (h.precipMm || 0), 0) * 10) / 10,
      description: driver.description,
      icon: driver.icon,
      hours: chunk.length,
    });
  }
  return blocks;
}

/**
 * Judge one local day.
 *
 * `dayOffset` 0 = today, 1 = tomorrow, and so on. For today only the hours still ahead are
 * considered: a storm that already passed at 06:00 should not condemn the afternoon.
 */
function assessDay(slots, offsetSeconds, dayOffset = 0, nowSeconds = Math.floor(Date.now() / 1000)) {
  const todayIndex = localDayIndex(nowSeconds, offsetSeconds);
  const targetIndex = todayIndex + dayOffset;

  const hours = slots
    .filter((s) => localDayIndex(s.dt, offsetSeconds) === targetIndex)
    // An hourly slot covers the hour AFTER its timestamp, so the one in progress still counts.
    .filter((s) => (dayOffset === 0 ? s.dt + 3600 > nowSeconds : true))
    .map(scoreSlot);

  if (!hours.length) {
    return { verdict: null, headline: 'No forecast for this day', slots: [], date: null };
  }

  const verdict = hours.reduce((acc, h) => worst(acc, h.risk), CLEAR);
  const flagged = hours.filter((h) => h.risk === verdict && verdict !== CLEAR);

  let headline;
  if (verdict === CLEAR) {
    const temps = hours.map((h) => h.tempC).filter((t) => t != null);
    headline = temps.length
      ? `Good driving conditions · ${Math.min(...temps)}–${Math.max(...temps)}°C`
      : 'Good driving conditions';
  } else {
    // The WINDOW is what makes this actionable — "start early, be back by two".
    const from = localTime(flagged[0].dt, offsetSeconds);
    const to = localTime(flagged[flagged.length - 1].dt + 3600, offsetSeconds);
    const why = summariseReasons(flagged.flatMap((h) => h.reasons)).slice(0, 2).join(' · ');
    headline = `${why} · ${from}–${to}`;
  }

  return {
    verdict,
    headline,
    date: localDate(hours[0].dt, offsetSeconds),
    slots: toDisplayBlocks(hours, offsetSeconds),
    worstWindowFrom: flagged.length ? localTime(flagged[0].dt, offsetSeconds) : null,
    worstWindowTo: flagged.length
      ? localTime(flagged[flagged.length - 1].dt + 3600, offsetSeconds)
      : null,
  };
}

/** Round a position onto the shared-forecast grid, so nearby drivers cost one lookup. */
function gridKey(lat, lon, degrees = env.WEATHER_GRID_DEGREES) {
  const snap = (v) => Math.round(v / degrees) * degrees;
  return `${snap(lat).toFixed(3)},${snap(lon).toFixed(3)}`;
}

module.exports = {
  scoreSlot, assessDay, gridKey, localDayIndex, localTime, localDate,
  summariseReasons, toDisplayBlocks,
  CLEAR, CAUTION, UNSAFE, RANK,
};
