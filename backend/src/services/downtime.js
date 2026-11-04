const Downtime = require('../models/Downtime');
const Trip = require('../models/Trip');
const { dayRange, formatDateInZone, isValidTimeZone } = require('../utils/timezone');

/**
 * Downtime: working time spent stopped, with a reason (models/Downtime.js).
 *
 * What a driver may report — checked here, on the server, so a phone cannot get around it:
 *   - on a day they drove (at least one recorded trip), between 1 minute and 4 hours, not in the
 *     future, and within that one local day;
 *   - never over a trip (that time is counted already) or over another live entry;
 *   - in a gap between trips, or up to 3 hours before the first trip / after the last one (not
 *     after the last while a trip is still running — the day is not over);
 *   - at most 6 hours of downtime in a day.
 * It counts toward working hours as soon as it is saved — there is no approval step (status
 * 'approved' means counted; 'pending' / 'rejected' are only on entries made before that changed).
 */
const MIN = 60 * 1000;
const RULES = {
  minMs: MIN,
  maxEntryMs: 4 * 60 * MIN,
  edgeMs: 3 * 60 * MIN,
  maxDayMs: 6 * 60 * MIN,
};
const LIVE = ['pending', 'approved'];

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const hhmm = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

/** The driver's recorded trips on one local day (parked jitter and imported days left out). */
async function tripsOfDay(driverId, date, tz) {
  const r = dayRange(date, tz);
  return Trip.find({
    driverId,
    startedAt: { $gte: r.from, $lt: r.to },
    parkedJitter: { $ne: true },
    importBatchId: null,
  })
    .select('startedAt endedAt status')
    .sort({ startedAt: 1 })
    .lean();
}

/**
 * Check and save one entry for a driver. Throws a 400 with a sentence the driver can act on.
 * @param input { startAt, endAt, reason, note, tz, clientId }
 */
async function report(driver, input = {}) {
  const tz = isValidTimeZone(input.tz) ? input.tz : isValidTimeZone(driver.timezone) ? driver.timezone : 'UTC';
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) throw bad('Pick a start and an end time');
  if (!Downtime.REASONS.includes(input.reason)) throw bad('Pick a reason');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 300) : '';
  if (input.reason === 'other' && !note) throw bad('Say what the downtime was for');
  const clientId = typeof input.clientId === 'string' && input.clientId.length <= 64 ? input.clientId : null;

  if (clientId) {
    const again = await Downtime.findOne({ driverId: driver._id, clientId }).lean();
    if (again) return again; // a resend of something already saved
  }

  const ms = endAt - startAt;
  if (ms < RULES.minMs) throw bad('Downtime must be at least a minute long');
  if (ms > RULES.maxEntryMs) throw bad('One downtime entry can be at most 4 hours — add another for the rest');
  if (endAt.getTime() > Date.now() + 2 * MIN) throw bad('Downtime cannot end in the future');
  const date = formatDateInZone(startAt, tz);
  if (formatDateInZone(new Date(endAt.getTime() - 1), tz) !== date) throw bad('Downtime has to start and end on the same day');

  const trips = await tripsOfDay(driver._id, date, tz);
  if (!trips.length) throw bad('You can only add downtime on a day you drove');
  const now = Date.now();
  const spans = trips.map((t) => [new Date(t.startedAt).getTime(), t.endedAt ? new Date(t.endedAt).getTime() : now]);
  for (const [s, e] of spans) {
    if (startAt.getTime() < e && endAt.getTime() > s) {
      throw bad(`That time overlaps your trip ${hhmm(new Date(s), tz)}–${hhmm(new Date(e), tz)}, which is already counted`);
    }
  }
  const firstStart = spans[0][0];
  const lastEnd = Math.max(...spans.map(([, e]) => e));
  const running = trips.some((t) => !t.endedAt);
  if (startAt.getTime() < firstStart - RULES.edgeMs) throw bad('Downtime before your first trip can start at most 3 hours before it');
  if (endAt.getTime() > lastEnd) {
    if (running) throw bad('You can add downtime after your last trip once that trip has ended');
    if (endAt.getTime() > lastEnd + RULES.edgeMs) throw bad('Downtime after your last trip can end at most 3 hours after it');
  }

  const r = dayRange(date, tz);
  const others = await Downtime.find({ driverId: driver._id, status: { $in: LIVE }, startAt: { $gte: new Date(r.from.getTime() - RULES.maxEntryMs), $lt: r.to } }).lean();
  for (const o of others) {
    if (startAt < o.endAt && endAt > o.startAt) {
      throw bad(`You already reported downtime ${hhmm(o.startAt, tz)}–${hhmm(o.endAt, tz)} — that time is taken`);
    }
  }
  const dayTotal = others.filter((o) => o.date === date).reduce((a, o) => a + (o.endAt - o.startAt), 0);
  if (dayTotal + ms > RULES.maxDayMs) throw bad('A day can have at most 6 hours of downtime');

  try {
    return (await Downtime.create({
      driverId: driver._id, driverName: driver.name || null, startAt, endAt, reason: input.reason,
      note: note || null, timezone: tz, date, clientId, status: 'approved',
    })).toObject();
  } catch (err) {
    if (err && err.code === 11000 && clientId) return Downtime.findOne({ driverId: driver._id, clientId }).lean();
    throw err;
  }
}

const view = (d) => ({
  id: String(d._id),
  startAt: d.startAt,
  endAt: d.endAt,
  durationMs: d.endAt - d.startAt,
  reason: d.reason,
  note: d.note || null,
  status: d.status,
  date: d.date,
  reviewNote: d.reviewNote || null,
  reviewedByName: d.reviewedByName || null,
  reviewedAt: d.reviewedAt || null,
});

/** A driver's entries on one local day, for my-day. */
async function ofDay(driverId, date, tz) {
  const r = dayRange(date, tz);
  const rows = await Downtime.find({ driverId, startAt: { $gte: r.from, $lt: r.to } }).sort({ startAt: 1 }).lean();
  return rows.map(view);
}

/**
 * Approved and pending downtime per driver-day, the day taken in each driver's zone `tzOf(driverId)`
 * — the same zone the Trips page groups trips in, so a row and its downtime always meet.
 * @returns Map(`${driverId}|${date}` -> { approvedMs, pendingMs, entries })
 */
async function byDriverDay(match, tzOf) {
  const rows = await Downtime.find({ ...match, status: { $in: LIVE } }).select('driverId startAt endAt status').lean();
  const out = new Map();
  for (const d of rows) {
    const key = `${d.driverId}|${formatDateInZone(d.startAt, tzOf(String(d.driverId)))}`;
    const cur = out.get(key) || { approvedMs: 0, pendingMs: 0, entries: 0 };
    if (d.status === 'approved') cur.approvedMs += d.endAt - d.startAt;
    else cur.pendingMs += d.endAt - d.startAt;
    cur.entries += 1;
    out.set(key, cur);
  }
  return out;
}

module.exports = { RULES, report, ofDay, byDriverDay, view };
