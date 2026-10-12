const Trip = require('../models/Trip');
const User = require('../models/User');
const Project = require('../models/Project');
const Marker = require('../models/Marker');
const asyncHandler = require('../utils/asyncHandler');
const { workMsExpr } = require('../utils/workHours');
const { dayRange, formatDateInZone, isValidTimeZone } = require('../utils/timezone');

/**
 * GET /api/analytics/overview — the superadmin dashboard: the whole fleet, cut by project,
 * region and country, over a period, with a timeline and the top drivers.
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   the period (default: the last 30 days), in `tz`
 *   &tz=Area/City                    the viewer's zone (days are bucketed in it)
 *   &projectId=&region=&country=     cross-filters — the page sets them by clicking a bar
 *
 * Distance is the recorded `distanceMeters` (what the Trips page shows), UKM is the per-trip
 * effective UKM, working hours are each trip's start to end (imported trips have no real times
 * and are left out of hours only). Parked-GPS-jitter sessions are left out of everything, as on
 * every other screen. A trip belongs to its own project, else to its driver's first project; a
 * trip's region and country are its driver's.
 *
 * The fleet is a few thousand trips, so this groups once in Mongo by driver+project+day and does
 * the cutting in memory — every breakdown is then guaranteed to add up to the same totals.
 */

/** Countries stored as ISO codes on some driver records and as names on others. */
const COUNTRY_NAMES = {
  AU: 'Australia', NZ: 'New Zealand', IN: 'India', FR: 'France', DE: 'Germany', IT: 'Italy',
  SE: 'Sweden', FI: 'Finland', AT: 'Austria', ES: 'Spain', PT: 'Portugal', NL: 'Netherlands',
  BE: 'Belgium', CH: 'Switzerland', DK: 'Denmark', NO: 'Norway', PL: 'Poland', IE: 'Ireland',
  GB: 'United Kingdom', UK: 'United Kingdom', CZ: 'Czechia', HU: 'Hungary', GR: 'Greece',
  RO: 'Romania', US: 'United States', CA: 'Canada', SG: 'Singapore', JP: 'Japan',
};
const EU = new Set(['France', 'Germany', 'Italy', 'Sweden', 'Finland', 'Austria', 'Spain', 'Portugal',
  'Netherlands', 'Belgium', 'Switzerland', 'Denmark', 'Norway', 'Poland', 'Ireland', 'United Kingdom',
  'Czechia', 'Hungary', 'Greece', 'Romania']);
const APAC = new Set(['Australia', 'New Zealand', 'India', 'Singapore', 'Japan']);
const AMER = new Set(['United States', 'Canada']);
const KNOWN_REGIONS = new Set(['EU', 'APAC', 'AMER', 'MEA', 'LATAM', 'NA']);
const NONE = 'Unassigned';

const countryOf = (u) => {
  const raw = String(u?.country || '').trim();
  if (!raw) return NONE;
  return COUNTRY_NAMES[raw.toUpperCase()] || raw;
};
/** The stored region when it is a real one; else derived from the country. */
const regionOf = (u) => {
  const r = String(u?.region || '').trim().toUpperCase();
  if (KNOWN_REGIONS.has(r)) return r;
  const c = countryOf(u);
  if (EU.has(c)) return 'EU';
  if (APAC.has(c)) return 'APAC';
  if (AMER.has(c)) return 'AMER';
  return NONE;
};

const isActiveDriver = (u) => u.active !== false && String(u.driverStatus || '').toLowerCase() !== 'exit';

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** Timeline buckets: days for up to two months, weeks up to a year, then months. */
function bucketOf(date, unit) {
  if (unit === 'day') return date;
  if (unit === 'month') return `${date.slice(0, 7)}-01`;
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday-based weeks
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

async function tripGroups(from, to, tz) {
  return Trip.aggregate([
    { $match: { startedAt: { $gte: from, $lt: to }, parkedJitter: { $ne: true } } },
    {
      $group: {
        _id: {
          driverId: '$driverId',
          projectId: '$projectId',
          day: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: tz } },
        },
        trips: { $sum: 1 },
        km: { $sum: { $ifNull: ['$distanceMeters', 0] } },
        ukm: { $sum: { $ifNull: ['$effectiveUkmMeters', 0] } },
        assignedUkm: { $sum: { $ifNull: ['$linkUkmMeters', 0] } },
        outsideUkm: {
          $sum: {
            $cond: [
              { $ne: [{ $ifNull: ['$linkUkmNetworkMeters', null] }, null] },
              { $max: [0, { $subtract: ['$linkUkmNetworkMeters', { $ifNull: ['$linkUkmMeters', 0] }] }] },
              0,
            ],
          },
        },
        workMs: {
          $sum: {
            $cond: [
              { $ne: [{ $ifNull: ['$importBatchId', null] }, null] },
              0,
              workMsExpr,
            ],
          },
        },
        imported: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$importBatchId', null] }, null] }, 1, 0] } },
      },
    },
  ]);
}

const emptyRow = () => ({ drivers: 0, activeDrivers: 0, drivingDrivers: 0, trips: 0, km: 0, ukm: 0, assignedUkm: 0, outsideUkm: 0, workMs: 0, markers: 0 });
function addTo(row, g) {
  row.trips += g.trips; row.km += g.km; row.ukm += g.ukm; row.assignedUkm += g.assignedUkm;
  row.outsideUkm += g.outsideUkm; row.workMs += g.workMs;
}

exports.overview = asyncHandler(async (req, res) => {
  const tz = isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
  const today = formatDateInZone(new Date(), tz);
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  let toDate = DATE.test(String(req.query.to || '')) ? String(req.query.to) : today;
  let fromDate = DATE.test(String(req.query.from || '')) ? String(req.query.from) : addDays(toDate, -29);
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  const span = daysBetween(fromDate, toDate) + 1;
  if (span > 3660) return res.status(400).json({ error: 'Pick a period of ten years or less' });
  const from = dayRange(fromDate, tz).from;
  const to = dayRange(toDate, tz).to;
  // The period before, the same length, for the change figures.
  const prevTo = from;
  const prevFrom = dayRange(addDays(fromDate, -span), tz).from;

  const filter = {
    projectId: /^[a-f\d]{24}$/i.test(String(req.query.projectId || '')) ? String(req.query.projectId) : null,
    region: req.query.region ? String(req.query.region) : null,
    country: req.query.country ? String(req.query.country) : null,
  };

  const [drivers, projects, groups, prevGroups, markers] = await Promise.all([
    User.find({ role: 'user' }).select('name projectIds country region active driverStatus').lean(),
    Project.find({}).select('name active').lean(),
    tripGroups(from, to, tz),
    tripGroups(prevFrom, prevTo, tz),
    Marker.find({ recordedAt: { $gte: from, $lt: to } }).select('driverId').lean(),
  ]);

  const projectName = new Map(projects.map((p) => [String(p._id), p.name]));
  const driverById = new Map(drivers.map((d) => [String(d._id), d]));
  const firstProject = (d) => (d && d.projectIds && d.projectIds.length ? String(d.projectIds[0]) : null);

  /** A trip group's project / region / country, and whether it passes the filters. */
  const place = (g) => {
    const d = driverById.get(String(g._id.driverId));
    const projectId = g._id.projectId ? String(g._id.projectId) : firstProject(d);
    return { d, projectId, region: regionOf(d), country: countryOf(d) };
  };
  const passes = (p, skip) =>
    (skip === 'project' || !filter.projectId || p.projectId === filter.projectId) &&
    (skip === 'region' || !filter.region || p.region === filter.region) &&
    (skip === 'country' || !filter.country || p.country === filter.country);

  // Roster: a driver counts in every project they are on; their region and country are theirs.
  const rosterRows = drivers.map((d) => ({
    d,
    projectIds: (d.projectIds || []).length ? d.projectIds.map(String) : [null],
    region: regionOf(d),
    country: countryOf(d),
    active: isActiveDriver(d),
  }));
  const rosterPasses = (r, skip) =>
    (skip === 'project' || !filter.projectId || r.projectIds.includes(filter.projectId)) &&
    (skip === 'region' || !filter.region || r.region === filter.region) &&
    (skip === 'country' || !filter.country || r.country === filter.country);

  /**
   * One breakdown. Each dimension ignores its OWN filter (so the project chart still shows every
   * project while one is selected — the selection is highlighted, not the only bar left) and
   * honours the others.
   */
  const breakdown = (dim) => {
    const rows = new Map();
    const row = (k) => { if (!rows.has(k)) rows.set(k, { key: k, driving: new Set(), ...emptyRow() }); return rows.get(k); };
    for (const r of rosterRows) {
      if (!rosterPasses(r, dim)) continue;
      const keys = dim === 'project' ? r.projectIds : [dim === 'region' ? r.region : r.country];
      for (const k of keys) {
        const x = row(k || NONE);
        x.drivers += 1;
        if (r.active) x.activeDrivers += 1;
      }
    }
    for (const g of groups) {
      const p = place(g);
      if (!passes(p, dim)) continue;
      const k = (dim === 'project' ? p.projectId : dim === 'region' ? p.region : p.country) || NONE;
      const x = row(k);
      addTo(x, g);
      x.driving.add(String(g._id.driverId));
    }
    for (const m of markers) {
      const d = driverById.get(String(m.driverId));
      const p = { projectId: firstProject(d), region: regionOf(d), country: countryOf(d) };
      if (!passes(p, dim)) continue;
      row((dim === 'project' ? p.projectId : dim === 'region' ? p.region : p.country) || NONE).markers += 1;
    }
    return [...rows.values()]
      .map(({ driving, ...x }) => ({
        ...x,
        drivingDrivers: driving.size,
        name: dim === 'project' ? (x.key === NONE ? 'No project' : projectName.get(x.key) || 'Deleted project') : x.key,
        km: Math.round(x.km), ukm: Math.round(x.ukm), assignedUkm: Math.round(x.assignedUkm), outsideUkm: Math.round(x.outsideUkm),
      }))
      .filter((x) => x.drivers || x.trips || x.markers)
      .sort((a, b) => b.km - a.km || b.drivers - a.drivers || a.name.localeCompare(b.name));
  };

  // Totals and the timeline honour every filter.
  const totals = { ...emptyRow() };
  const driving = new Set();
  const unit = span <= 62 ? 'day' : span <= 366 ? 'week' : 'month';
  const series = new Map();
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const b = bucketOf(d, unit);
    if (!series.has(b)) series.set(b, { date: b, trips: 0, km: 0, ukm: 0, workMs: 0, drivers: new Set() });
  }
  const perDriver = new Map();
  for (const g of groups) {
    const p = place(g);
    if (!passes(p)) continue;
    addTo(totals, g);
    const id = String(g._id.driverId);
    driving.add(id);
    const s = series.get(bucketOf(g._id.day, unit));
    if (s) { s.trips += g.trips; s.km += g.km; s.ukm += g.ukm; s.workMs += g.workMs; s.drivers.add(id); }
    if (!perDriver.has(id)) perDriver.set(id, { driverId: id, ...emptyRow(), days: new Set() });
    const pd = perDriver.get(id);
    addTo(pd, g);
    pd.days.add(g._id.day);
  }
  for (const r of rosterRows) {
    if (!rosterPasses(r)) continue;
    totals.drivers += 1;
    if (r.active) totals.activeDrivers += 1;
  }
  totals.drivingDrivers = driving.size;
  totals.markers = markers.filter((m) => {
    const d = driverById.get(String(m.driverId));
    return passes({ projectId: firstProject(d), region: regionOf(d), country: countryOf(d) });
  }).length;

  const previous = { trips: 0, km: 0, ukm: 0, workMs: 0, drivingDrivers: 0 };
  const prevDriving = new Set();
  for (const g of prevGroups) {
    if (!passes(place(g))) continue;
    previous.trips += g.trips; previous.km += g.km; previous.ukm += g.ukm; previous.workMs += g.workMs;
    prevDriving.add(String(g._id.driverId));
  }
  previous.drivingDrivers = prevDriving.size;

  const topDrivers = [...perDriver.values()]
    .sort((a, b) => b.km - a.km)
    .slice(0, 15)
    .map((x) => {
      const d = driverById.get(x.driverId);
      return {
        driverId: x.driverId,
        name: d?.name || 'Unknown',
        project: projectName.get(firstProject(d)) || null,
        country: countryOf(d),
        region: regionOf(d),
        active: d ? isActiveDriver(d) : false,
        trips: x.trips,
        days: x.days.size,
        km: Math.round(x.km),
        ukm: Math.round(x.ukm),
        workMs: x.workMs,
      };
    });

  const round = (o) => ({ ...o, km: Math.round(o.km), ukm: Math.round(o.ukm), assignedUkm: Math.round(o.assignedUkm || 0), outsideUkm: Math.round(o.outsideUkm || 0) });

  res.json({
    period: { from: fromDate, to: toDate, days: span, tz, unit, previousFrom: addDays(fromDate, -span), previousTo: addDays(fromDate, -1) },
    filter,
    totals: round(totals),
    previous: { ...previous, km: Math.round(previous.km), ukm: Math.round(previous.ukm) },
    byProject: breakdown('project'),
    byRegion: breakdown('region'),
    byCountry: breakdown('country'),
    timeline: [...series.values()].map((s) => ({ date: s.date, trips: s.trips, km: Math.round(s.km), ukm: Math.round(s.ukm), workMs: s.workMs, drivers: s.drivers.size })),
    topDrivers,
  });
});

exports._test = { countryOf, regionOf, bucketOf };
