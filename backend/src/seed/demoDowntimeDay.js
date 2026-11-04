/**
 * A demo driving day for trying downtime end to end: trips with real GPS points and stops between
 * them, today, for one driver (a test account), plus downtime in each state.
 *
 *   06:40–08:35 drive · 08:35–09:05 stop (weather, APPROVED)
 *   09:05–10:30 drive · 10:30–10:50 stop (vehicle change-over, WAITING for a manager)
 *   10:50–11:45 drive · 11:45–12:20 stop (fuel, NOT APPROVED, with a note)
 *   12:20–13:00 drive
 * The half hour before 06:40 is left free so "Add downtime" can be tried from the app.
 * Times are the driver's local zone; the day must already be past 13:00 there.
 *
 * Everything written carries demoBatch / a "demo:<batch>" clientId:
 *   node src/seed/demoDowntimeDay.js --email=sample@jsan.com [--apply]
 *   node src/seed/demoDowntimeDay.js --undo=<batch> --apply
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');
const { formatDateInZone } = require('../utils/timezone');

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY = args.get('apply') === true;
const log = (...a) => console.log(...a); // eslint-disable-line no-console

/** `hh:mm` on `date` (YYYY-MM-DD) in `tz`, as an instant. */
function at(date, hhmm, tz) {
  const guess = new Date(`${date}T${hhmm}:00Z`);
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(guess).reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  const shown = new Date(`${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}:00Z`);
  return new Date(guess.getTime() - (shown - guess));
}

const R = 6371000;
const step = ([lat, lon], bearing, m) => {
  const d = m / R;
  const b = (bearing * Math.PI) / 180;
  const φ1 = (lat * Math.PI) / 180;
  const λ1 = (lon * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI];
};

/** A drive from `from`, `start` to `end`: a fix every 10 s along streets that turn at right angles. */
function drive(from, start, end, rnd) {
  const pts = [];
  let pos = from;
  let bearing = [0, 90, 180, 270][Math.floor(rnd() * 4)];
  let speed = 30;
  let meters = 0;
  let maxSpeed = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += 10_000) {
    if (rnd() < 0.04) bearing = (bearing + (rnd() < 0.5 ? 90 : 270)) % 360; // a junction
    // Stay round the city: steer back toward the start when far out.
    if (Math.abs(pos[0] - 17.44) > 0.06 || Math.abs(pos[1] - 78.38) > 0.06) bearing = pos[0] > 17.44 ? 180 : 0;
    speed = Math.max(8, Math.min(55, speed + (rnd() - 0.5) * 10));
    if (rnd() < 0.03) speed = 0; // a red light
    const m = (speed / 3.6) * 10;
    pos = step(pos, bearing, m);
    meters += m;
    maxSpeed = Math.max(maxSpeed, speed);
    pts.push({ lat: pos[0], lon: pos[1], speedKmh: Math.round(speed), heading: bearing, recordedAt: new Date(t) });
  }
  return { pts, meters, maxSpeed, end: pos };
}

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  if (args.has('undo')) {
    const batch = String(args.get('undo'));
    const trips = await db.collection('trips').find({ demoBatch: batch }).project({ _id: 1 }).toArray();
    const dt = await db.collection('downtimes').countDocuments({ clientId: new RegExp(`^demo:${batch}:`) });
    log(`Batch ${batch}: ${trips.length} trips, ${dt} downtime entries`);
    if (!APPLY) return log('Dry run — add --apply.');
    await db.collection('locationpoints').deleteMany({ tripId: { $in: trips.map((t) => t._id) } });
    await db.collection('trips').deleteMany({ demoBatch: batch });
    await db.collection('downtimes').deleteMany({ clientId: new RegExp(`^demo:${batch}:`) });
    return log('Removed.');
  }

  const email = String(args.get('email') || '').toLowerCase();
  const driver = await db.collection('users').findOne({ email });
  if (!driver) throw new Error(`No user ${email}`);
  if (driver.role !== 'user') throw new Error(`${email} is not a driver`);
  const tz = driver.timezone || 'UTC';
  const date = formatDateInZone(new Date(), tz);
  if (Date.now() < at(date, '13:05', tz).getTime()) throw new Error(`It is not 13:05 yet in ${tz} — run this after lunch time there`);

  const plan = [['06:40', '08:35'], ['09:05', '10:30'], ['10:50', '11:45'], ['12:20', '13:00']];
  const stops = [
    { from: '08:35', to: '09:05', reason: 'weather', note: 'Heavy rain — waited for it to ease', status: 'approved' },
    { from: '10:30', to: '10:50', reason: 'vehicle_changeover', note: 'Swapped to the spare car', status: 'pending' },
    { from: '11:45', to: '12:20', reason: 'fuel', note: null, status: 'rejected', reviewNote: 'Refuelling is part of the break time' },
  ];
  log(`${driver.name} (${email}) · ${date} in ${tz}`);
  plan.forEach(([a, b]) => log(`  drive ${a}–${b}`));
  stops.forEach((s) => log(`  stop  ${s.from}–${s.to} ${s.reason} → ${s.status}`));
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');

  const batch = `demo-${date}-${crypto.randomBytes(3).toString('hex')}`;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  let pos = [17.4474, 78.3762]; // HITEC City, Hyderabad
  for (const [a, b] of plan) {
    const start = at(date, a, tz);
    const end = at(date, b, tz);
    const d = drive(pos, start, end, rnd);
    const tripId = new mongoose.Types.ObjectId();
    const first = d.pts[0];
    const last = d.pts[d.pts.length - 1];
    await db.collection('trips').insertOne({
      _id: tripId, driverId: driver._id, projectId: (driver.projectIds || [])[0] || null, status: 'completed',
      startedAt: start, endedAt: end, closeReason: 'device',
      startLocation: { lat: pos[0], lon: pos[1] }, endLocation: { lat: last.lat, lon: last.lon },
      lastLocation: { lat: last.lat, lon: last.lon, speed: 0, heading: last.heading, recordedAt: last.recordedAt },
      distanceMeters: Math.round(d.meters), maxSpeedKmh: Math.round(d.maxSpeed), pointCount: d.pts.length,
      // No map matching or coverage claims for a demo: it must not paint anyone's roads.
      mapMatchStatus: 'skipped', linkCoverageStatus: 'skipped', ukmStatus: 'skipped',
      demoBatch: batch, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection('locationpoints').insertMany(d.pts.map((p) => ({ ...p, tripId, driverId: driver._id, isMoving: p.speedKmh > 0, accuracy: 8, receivedAt: p.recordedAt })));
    log(`  trip ${a}–${b}: ${(d.meters / 1000).toFixed(1)} km, ${d.pts.length} points (first ${first.lat.toFixed(4)},${first.lon.toFixed(4)})`);
    pos = d.end;
  }
  let n = 0;
  for (const s of stops) {
    await db.collection('downtimes').insertOne({
      driverId: driver._id, driverName: driver.name, startAt: at(date, s.from, tz), endAt: at(date, s.to, tz),
      reason: s.reason, note: s.note, timezone: tz, date, status: s.status,
      reviewedBy: null, reviewedByName: s.status === 'pending' ? null : 'Demo manager', reviewedAt: s.status === 'pending' ? null : new Date(),
      reviewNote: s.reviewNote || null, clientId: `demo:${batch}:${++n}`, createdAt: new Date(), updatedAt: new Date(),
    });
  }
  log(`\nDone — batch ${batch}. Remove: node src/seed/demoDowntimeDay.js --undo=${batch} --apply`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED', e.message); process.exit(1); }); // eslint-disable-line no-console
