const Trip = require('../models/Trip');
const User = require('../models/User');
const Project = require('../models/Project');
const NetworkVersion = require('../models/NetworkVersion');
const LinkCoverage = require('../models/LinkCoverage');
const Vehicle = require('../models/Vehicle');
const asyncHandler = require('../utils/asyncHandler');
const { liveNetworkVersions } = require('../services/liveNetworks');
const { countryForZone, ensureRegions } = require('../services/deliveryRegions');
const { dayRange, formatDateInZone, isValidTimeZone } = require('../utils/timezone');

/**
 * GET /api/analytics/overview — the admin dashboard. Kilometres and UKM only, by project and
 * region, day by day, week by week or month by month.
 *
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   the period (default: the last 12 weeks), in `tz`
 *   &grain=day|week|month            the bucket size (default week); too many buckets → coarser
 *   &tz=Area/City                    the viewer's zone (days are bucketed in it)
 *   &projectId=&region=              filters — every breakdown ignores its OWN filter, so the
 *                                    project table still lists every project while one is picked
 *
 * The figures:
 *   km           recorded `distanceMeters` (what the Trips page shows), imported trips included
 *   ukm          `effectiveUkmMeters` — the one UKM figure every screen reads (services/ukmBasis.js)
 *   assignedUkm  the part of it from trips measured on their assigned polygons
 *   freeUkm      the part from trips measured on global UKM (free drives, no polygon held)
 *   outsideUkm   first-driven customer roads OUTSIDE the driver's polygons — credit for the
 *                project, not part of the driver's UKM, so shown beside it, never added in
 *   cars         cars by region: on the road now (an active trip, as on the Live map — not limited
 *                to the period) and how many drove in the period. A trip with no vehicle on record
 *                counts as its driver's car. `cars.live` places each car on the road on the map:
 *                its last fix, region, driver and plate.
 *   network      the project's live deliveries: total road length and how much of it has been
 *                driven to date (the Coverage page's number). Not limited to the period.
 *
 * A trip's region is the region of the delivery it was measured against (the Coverage page's
 * "Australia" / "New Zealand", renamable there); a trip with none falls back to the country of
 * its time zone, then of its driver. Parked-GPS-jitter sessions count for nothing, as everywhere.
 * Neither does driving by a driver on no project, on a trip with no project of its own (test
 * accounts, drivers not yet put on a project): with nowhere to file it, it is left out entirely,
 * so the totals still equal the sum of the project rows.
 *
 * One aggregation grouped by driver+project+delivery+zone+day, cut in memory — every breakdown is
 * then guaranteed to add up to the same totals.
 */

const COUNTRY_NAMES = {
  AU: 'Australia', NZ: 'New Zealand', IN: 'India', FR: 'France', DE: 'Germany', IT: 'Italy',
  SE: 'Sweden', FI: 'Finland', AT: 'Austria', ES: 'Spain', PT: 'Portugal', NL: 'Netherlands',
  BE: 'Belgium', CH: 'Switzerland', DK: 'Denmark', NO: 'Norway', PL: 'Poland', IE: 'Ireland',
  GB: 'United Kingdom', UK: 'United Kingdom', CZ: 'Czechia', HU: 'Hungary', GR: 'Greece',
  RO: 'Romania', US: 'United States', CA: 'Canada', SG: 'Singapore', JP: 'Japan',
};
const UNKNOWN = 'Unknown';
const NO_PROJECT = 'none';

const countryOf = (u) => {
  const raw = String(u?.country || '').trim();
  if (!raw) return null;
  return COUNTRY_NAMES[raw.toUpperCase()] || raw;
};

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

/** The bucket a day falls in: itself, its Monday, or the 1st of its month. */
function bucketOf(date, grain) {
  if (grain === 'day') return date;
  if (grain === 'month') return `${date.slice(0, 7)}-01`;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Days are readable up to ~3 months, weeks up to ~2 years; beyond that the grain coarsens. */
function fitGrain(grain, span) {
  let g = ['day', 'week', 'month'].includes(grain) ? grain : 'week';
  if (g === 'day' && span > 92) g = 'week';
  if (g === 'week' && span > 731) g = 'month';
  return g;
}

// A car is the trip's vehicle; a trip with none on record (a driver not given one in the panel)
// counts as its driver's car, so it is neither lost nor counted twice.
const CAR = { $ifNull: [{ $toString: '$vehicleId' }, { $concat: ['driver:', { $toString: '$driverId' }] }] };
const isImported = { $ne: [{ $ifNull: ['$importBatchId', null] }, null] };
async function tripGroups(from, to, tz) {
  return Trip.aggregate([
    { $match: { startedAt: { $gte: from, $lt: to }, parkedJitter: { $ne: true } } },
    {
      $group: {
        _id: {
          driverId: '$driverId',
          projectId: '$projectId',
          versionId: '$assignedNetworkVersionId',
          zone: '$timezone',
          day: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: tz } },
        },
        km: { $sum: { $ifNull: ['$distanceMeters', 0] } },
        ukm: { $sum: { $ifNull: ['$effectiveUkmMeters', 0] } },
        assignedUkm: {
          $sum: { $cond: [{ $eq: ['$ukmBasis', 'assigned'] }, { $ifNull: ['$effectiveUkmMeters', 0] }, 0] },
        },
        outsideUkm: {
          $sum: {
            $cond: [
              { $ne: [{ $ifNull: ['$linkUkmNetworkMeters', null] }, null] },
              { $max: [0, { $subtract: ['$linkUkmNetworkMeters', { $ifNull: ['$linkUkmMeters', 0] }] }] },
              0,
            ],
          },
        },
        trips: { $sum: 1 },
        cars: { $addToSet: CAR },
        imported: { $sum: { $cond: [isImported, 1, 0] } },
      },
    },
  ]);
}

const zero = () => ({ km: 0, ukm: 0, assignedUkm: 0, freeUkm: 0, outsideUkm: 0 });
function add(row, g) {
  row.km += g.km;
  row.ukm += g.ukm;
  row.assignedUkm += g.assignedUkm;
  row.freeUkm += g.ukm - g.assignedUkm;
  row.outsideUkm += g.outsideUkm;
}
const rounded = (r) => ({
  km: Math.round(r.km), ukm: Math.round(r.ukm), assignedUkm: Math.round(r.assignedUkm),
  freeUkm: Math.round(r.freeUkm), outsideUkm: Math.round(r.outsideUkm),
});

exports.overview = asyncHandler(async (req, res) => {
  const tz = isValidTimeZone(req.query.tz) ? req.query.tz : 'UTC';
  const today = formatDateInZone(new Date(), tz);
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  let toDate = DATE.test(String(req.query.to || '')) ? String(req.query.to) : today;
  let fromDate = DATE.test(String(req.query.from || '')) ? String(req.query.from) : addDays(toDate, -83);
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  const span = daysBetween(fromDate, toDate) + 1;
  if (span > 3660) return res.status(400).json({ error: 'Pick a period of ten years or less' });
  const grain = fitGrain(String(req.query.grain || ''), span);
  const from = dayRange(fromDate, tz).from;
  const to = dayRange(toDate, tz).to;
  // The period just before, the same length, for the change figures.
  const prevFrom = dayRange(addDays(fromDate, -span), tz).from;

  const filter = {
    projectId: /^[a-f\d]{24}$/i.test(String(req.query.projectId || '')) ? String(req.query.projectId) : null,
    region: req.query.region ? String(req.query.region) : null,
  };

  const projects = await Project.find({}).select('name code active').lean();
  const [drivers, groups, prevGroups, live, onTheRoad] = await Promise.all([
    User.find({ role: 'user' }).select('name projectIds country active driverStatus').lean(),
    tripGroups(from, to, tz),
    tripGroups(prevFrom, from, tz),
    liveNetworkVersions(projects.map((p) => p._id)),
    Trip.find({ status: 'active' })
      .select('driverId projectId assignedNetworkVersionId timezone vehicleId lastLocation startLocation')
      .lean(),
  ]);
  const plates = new Map(
    (await Vehicle.find({ _id: { $in: onTheRoad.map((tr) => tr.vehicleId).filter(Boolean) } }).select('plateNumber').lean())
      .map((v) => [String(v._id), v.plateNumber])
  );
  // Live trips in the same shape as a trip group, so place() files them the same way.
  const nowGroups = onTheRoad.map((tr) => ({
    _id: { driverId: tr.driverId, projectId: tr.projectId, versionId: tr.assignedNetworkVersionId, zone: tr.timezone },
    cars: [tr.vehicleId ? String(tr.vehicleId) : `driver:${tr.driverId}`],
    trip: tr,
  }));

  // Every delivery a trip was measured against, plus the live ones the network figures come from.
  const versionIds = new Set(live.map((v) => String(v._id)));
  for (const g of [...groups, ...prevGroups, ...nowGroups]) if (g._id.versionId) versionIds.add(String(g._id.versionId));
  const versions = await NetworkVersion.find({ _id: { $in: [...versionIds] } })
    .select('projectId region label targetMeters')
    .lean();
  await ensureRegions(versions.filter((v) => !v.region)).catch(() => {});
  const versionById = new Map(versions.map((v) => [String(v._id), v]));

  const projectName = new Map(projects.map((p) => [String(p._id), p.name]));
  const driverById = new Map(drivers.map((d) => [String(d._id), d]));
  const firstProject = (d) => (d && d.projectIds && d.projectIds.length ? String(d.projectIds[0]) : null);

  /** A trip group's project and region. */
  const place = (g) => {
    const d = driverById.get(String(g._id.driverId));
    const projectId = g._id.projectId ? String(g._id.projectId) : firstProject(d) || NO_PROJECT;
    const v = g._id.versionId ? versionById.get(String(g._id.versionId)) : null;
    const region = v?.region || countryForZone(g._id.zone) || countryOf(d) || UNKNOWN;
    return { projectId, region };
  };
  const passes = (p, skip) =>
    p.projectId !== NO_PROJECT &&
    (skip === 'project' || !filter.projectId || p.projectId === filter.projectId) &&
    (skip === 'region' || !filter.region || p.region === filter.region);

  // Buckets, gaps included, so a quiet week shows as a zero rather than vanishing.
  const buckets = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) {
    const b = bucketOf(d, grain);
    if (buckets[buckets.length - 1] !== b) buckets.push(b);
  }
  const bucketIndex = new Map(buckets.map((b, i) => [b, i]));

  // Live network per project+region: total length, and driven to date.
  const covered = live.length
    ? await LinkCoverage.aggregate([
      { $match: { networkVersionId: { $in: live.map((v) => v._id) } } },
      { $group: { _id: '$networkVersionId', meters: { $sum: '$lengthMeters' } } },
    ])
    : [];
  const coveredBy = new Map(covered.map((c) => [String(c._id), c.meters]));
  const networks = live.map((lv) => {
    const v = versionById.get(String(lv._id)) || lv;
    return {
      projectId: String(lv.projectId),
      region: v.region || UNKNOWN,
      targetMeters: v.targetMeters || 0,
      coveredMeters: coveredBy.get(String(lv._id)) || 0,
    };
  });
  const networkOf = (pred) => {
    const n = { targetMeters: 0, coveredMeters: 0 };
    for (const x of networks) if (pred(x)) { n.targetMeters += x.targetMeters; n.coveredMeters += x.coveredMeters; }
    n.targetMeters = Math.round(n.targetMeters);
    n.coveredMeters = Math.round(n.coveredMeters);
    return n;
  };

  /**
   * One breakdown: a row per project (or region) with the period's figures and the same figures
   * per bucket, for the project-by-week / project-by-month table.
   */
  const breakdown = (dim) => {
    const rows = new Map();
    const row = (k) => {
      if (!rows.has(k)) rows.set(k, { key: k, ...zero(), drivers: new Set(), series: buckets.map(() => ({ km: 0, ukm: 0 })) });
      return rows.get(k);
    };
    for (const g of groups) {
      const p = place(g);
      if (!passes(p, dim)) continue;
      const x = row(dim === 'project' ? p.projectId : p.region);
      add(x, g);
      x.drivers.add(String(g._id.driverId));
      const s = x.series[bucketIndex.get(bucketOf(g._id.day, grain))];
      if (s) { s.km += g.km; s.ukm += g.ukm; }
    }
    // A project or region with a network but no driving in the period still gets a row.
    for (const n of networks) {
      if (!passes(n, dim)) continue;
      row(dim === 'project' ? n.projectId : n.region);
    }
    return [...rows.values()]
      .map(({ drivers: ds, series, ...x }) => ({
        ...x,
        ...rounded(x),
        name: dim === 'project'
          ? projectName.get(x.key) || 'Deleted project'
          : x.key,
        drivers: ds.size,
        series: series.map((s) => ({ km: Math.round(s.km), ukm: Math.round(s.ukm) })),
        network: networkOf((n) => (dim === 'project' ? n.projectId === x.key : n.region === x.key) && passes(n, dim)),
      }))
      .sort((a, b) => b.km - a.km || b.network.targetMeters - a.network.targetMeters || a.name.localeCompare(b.name));
  };

  // Totals, timeline and drivers honour every filter.
  const totals = zero();
  const timeline = buckets.map((date) => ({ date, ...zero() }));
  const perDriver = new Map();
  let trips = 0;
  for (const g of groups) {
    const p = place(g);
    if (!passes(p)) continue;
    add(totals, g);
    trips += g.trips;
    const t = timeline[bucketIndex.get(bucketOf(g._id.day, grain))];
    if (t) add(t, g);
    const id = String(g._id.driverId);
    if (!perDriver.has(id)) perDriver.set(id, { driverId: id, ...zero(), days: new Set(), projects: new Map(), regions: new Map() });
    const pd = perDriver.get(id);
    add(pd, g);
    pd.days.add(g._id.day);
    pd.projects.set(p.projectId, (pd.projects.get(p.projectId) || 0) + g.km);
    pd.regions.set(p.region, (pd.regions.get(p.region) || 0) + g.km);
  }
  // Cars by region. The rows ignore the region filter (the picked one is highlighted, like the
  // region table); the totals honour it. A car seen in two regions counts once in the total.
  const carRows = new Map();
  const carTotals = { now: new Set(), period: new Set() };
  for (const [kind, list] of [['period', groups], ['now', nowGroups]]) {
    for (const g of list) {
      const p = place(g);
      if (!passes(p, 'region')) continue;
      if (!carRows.has(p.region)) carRows.set(p.region, { now: new Set(), period: new Set() });
      for (const c of g.cars) {
        carRows.get(p.region)[kind].add(c);
        if (passes(p)) carTotals[kind].add(c);
      }
    }
  }
  // Where each car on the road is. A driver in two live trips at once (two phones) is one dot.
  const onMap = new Map();
  for (const g of nowGroups) {
    const p = place(g);
    const fix = g.trip.lastLocation?.lat != null ? g.trip.lastLocation : g.trip.startLocation;
    if (!passes(p, 'region') || fix?.lat == null || fix?.lon == null || onMap.has(g.cars[0])) continue;
    onMap.set(g.cars[0], {
      region: p.region,
      lat: fix.lat,
      lon: fix.lon,
      at: fix.recordedAt || null,
      driver: driverById.get(String(g._id.driverId))?.name || 'Unknown driver',
      plate: g.trip.vehicleId ? plates.get(String(g.trip.vehicleId)) || null : null,
    });
  }

  const cars = {
    now: carTotals.now.size,
    live: [...onMap.values()],
    period: carTotals.period.size,
    byRegion: [...carRows.entries()]
      .map(([region, x]) => ({ region, now: x.now.size, period: x.period.size }))
      .sort((a, b) => b.now - a.now || b.period - a.period || a.region.localeCompare(b.region)),
  };

  const previous = zero();
  for (const g of prevGroups) if (passes(place(g))) add(previous, g);

  const most = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const byDriver = [...perDriver.values()]
    .map((x) => {
      const d = driverById.get(x.driverId);
      const pid = most(x.projects);
      return {
        driverId: x.driverId,
        name: d?.name || 'Unknown driver',
        active: Boolean(d && d.active !== false && String(d.driverStatus || '').toLowerCase() !== 'exit'),
        project: projectName.get(pid) || null,
        region: most(x.regions),
        days: x.days.size,
        ...rounded(x),
      };
    })
    .sort((a, b) => b.km - a.km);

  res.json({
    period: {
      from: fromDate, to: toDate, days: span, tz, grain,
      previousFrom: addDays(fromDate, -span), previousTo: addDays(fromDate, -1),
    },
    filter,
    totals: { ...rounded(totals), trips, drivers: perDriver.size, network: networkOf((n) => passes(n)) },
    previous: rounded(previous),
    cars,
    timeline: timeline.map((t) => ({ date: t.date, ...rounded(t) })),
    byProject: breakdown('project'),
    byRegion: breakdown('region'),
    byDriver,
  });
});

exports._test = { bucketOf, fitGrain };
