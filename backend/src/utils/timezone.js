/**
 * Timezone-correct month boundaries, with no dependency.
 *
 * Why this exists: "June" for a Singapore driver starts 7 hours before "June" for a French
 * one. A custody report that quietly assumes UTC hands back day-counts that are wrong at
 * every month boundary — a stint that ended at 09:00 on 1 July in Sydney is a June stint in
 * UTC. So the report takes an explicit timezone and converts once, here.
 */

/** Milliseconds that `tz` is ahead of UTC at the given instant (DST-aware). */
function offsetMsAt(instant, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(instant)
    .reduce((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // some locales render midnight as "24"
    Number(parts.minute),
    Number(parts.second)
  );
  return asIfUtc - instant.getTime();
}

/** The UTC instant of local midnight on `y-m-d` in `tz`. */
function zonedStartOfDay(y, m, d, tz) {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  // First pass uses the offset at the naive instant; a second pass settles the rare case
  // where that guess lands on the other side of a DST transition.
  let ts = naive - offsetMsAt(new Date(naive), tz);
  ts = naive - offsetMsAt(new Date(ts), tz);
  return new Date(ts);
}

function isValidTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Half-open [from, to) UTC range covering the calendar month `YYYY-MM` as lived in `tz`.
 * Half-open on purpose: it matches the overlap predicate, so a stint starting exactly at
 * midnight on the 1st belongs to one month only.
 */
function monthRange(month, tz = 'UTC') {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) throw new Error('month must look like 2026-06');
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const y = Number(match[1]);
  const m = Number(match[2]);
  if (m < 1 || m > 12) throw new Error('month must be between 01 and 12');

  return {
    from: zonedStartOfDay(y, m, 1, zone),
    to: m === 12 ? zonedStartOfDay(y + 1, 1, 1, zone) : zonedStartOfDay(y, m + 1, 1, zone),
    tz: zone,
  };
}

/**
 * Half-open [from, to) UTC range covering the single calendar day `YYYY-MM-DD` as lived in
 * `tz`. Same half-open reasoning as monthRange: a trip starting exactly at local midnight
 * belongs to one day only, never double-counted at the boundary.
 *
 * Passing `d + 1` straight into zonedStartOfDay relies on Date.UTC's own month/year rollover
 * (day 32 of a 31-day month becomes day 1 of the next) — the same trick monthRange already
 * leans on for `m + 1`, so no separate end-of-month special case is needed here either.
 */
function dayRange(date, tz = 'UTC') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!match) throw new Error('date must look like 2026-08-10');
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) throw new Error('date must be a real calendar date');

  return {
    from: zonedStartOfDay(y, m, d, zone),
    to: zonedStartOfDay(y, m, d + 1, zone),
    tz: zone,
  };
}

/** Format an instant as YYYY-MM-DD as seen in `tz` (for report rows and CSV). */
function formatDateInZone(instant, tz = 'UTC') {
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parts; // en-CA gives YYYY-MM-DD
}

module.exports = { monthRange, dayRange, formatDateInZone, isValidTimeZone, zonedStartOfDay, offsetMsAt };
