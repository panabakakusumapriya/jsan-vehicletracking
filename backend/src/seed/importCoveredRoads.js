/**
 * Import historical covered-road data from a customer shapefile's ATTRIBUTE TABLE.
 *
 * What this is for
 * ----------------
 * Before the app existed, coverage was tracked in GIS: a copy of the customer's road network with
 * `Driver` and `Date` columns filled in as streets were driven. That history is real work and
 * belongs in the ledger, but it never passed through a phone, so no amount of waiting will make
 * the app produce it. This script puts it in.
 *
 * Why no geometry is read
 * -----------------------
 * The attribute table carries the customer's own `LINK_ID`, which is the identity `LinkCoverage`
 * is keyed by. So a claim can be written directly, with no map-matching and no geometry: the
 * 83 MB .shp beside the .dbf is never opened. The roads turn blue on the coverage map because the
 * ledger says they are covered, which is the same reason they turn blue for a recorded drive.
 *
 * What it therefore CANNOT produce
 * --------------------------------
 * Routes. There is no GPS in the source, so the sessions it creates have no line to draw: they
 * are marked `mapMatchStatus: 'skipped'` and will never appear in the "Driven tracks" layer. A
 * route stitched together from the covered links would look like a recording and would be a
 * fabrication, so this script does not offer it.
 *
 * Safety
 * ------
 *   - DRY RUN unless `--apply` is passed. The dry run reads the live database and writes nothing.
 *   - Every document created carries one `importBatchId`, so `--revert=<id>` undoes exactly this
 *     import and nothing else.
 *   - Existing claims are never modified. A link already in the ledger is skipped and counted,
 *     even where the imported date is earlier and the ledger's own first-cover-wins rule would
 *     hand it over — that override is deliberate: figures already reported must not move.
 *   - Drivers are matched to existing accounts by first name and must match exactly one. Anything
 *     ambiguous aborts rather than guessing, because the wrong guess credits the wrong person.
 *
 * Usage
 * -----
 *   node src/seed/importCoveredRoads.js --file="../Final Merge/P2/VIC_P2_Nav" --year=2025
 *   node src/seed/importCoveredRoads.js --file="..." --year=2025 --apply
 *   node src/seed/importCoveredRoads.js --revert=<importBatchId>
 *
 * Options: --project="PRJ-025-HE-DRIVE-AUSGNZ"  --create-missing-drivers  --no-ukm
 */
const fs = require('fs');
const path = require('path');

const { connectDB } = require('../config/db');
const { DbfReader, readCpg } = require('../utils/shapefile');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);

const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const APPLY = args.get('apply') === true;
const CREATE_MISSING = args.get('create-missing-drivers') === true;
const WRITE_UKM = args.get('no-ukm') !== true;

/**
 * Months that are unambiguously UTC+10, so a session's local working day can be placed without a
 * timezone library.
 *
 * Australian DST runs from the first Sunday in October to the first Sunday in April, so May
 * through September carry no transition anywhere that observes it — and Queensland, where much of
 * this data comes from, never observes it at all. April and October are excluded because a
 * transition falls inside them and a date alone cannot say which side of it a session sat on.
 * Anything outside the window aborts rather than silently drifting an hour.
 */
const AEST_OFFSET_HOURS = 10;
const SAFE_MONTHS = new Set([5, 6, 7, 8, 9]);
const WORK_START_LOCAL = 8;
const WORK_END_LOCAL = 16;

/** `1008` is 10 August; `109` is 1 September — the numeric column drops the leading zero. */
function parseDdmm(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d{3,4}$/.test(s)) return null;
  const mm = Number(s.slice(-2));
  const dd = Number(s.slice(0, -2));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return { dd, mm };
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Collapse the case and spelling variants one name arrives in: SOFYANE, Sofyane, yaan, Yann. */
function normaliseDriver(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || /^[\d*]+$/.test(s)) return null; // a date that landed in the Driver column
  if (s.startsWith('yaan') || s.startsWith('yann')) return 'Yann';
  if (s.startsWith('ali')) return 'Ali';
  if (s.startsWith('shekar') || s.startsWith('sekhar')) return 'Shekar';
  if (s.startsWith('sofyane')) return 'Sofyane';
  return s[0].toUpperCase() + s.slice(1);
}

function resolveBundle(fileArg) {
  const base = path.resolve(String(fileArg).replace(/\.(dbf|shp|shx|prj|cpg)$/i, ''));
  const dbf = `${base}.dbf`;
  if (!fs.existsSync(dbf)) throw new Error(`No .dbf at ${dbf}`);
  return { base, dbf, cpg: `${base}.cpg` };
}

async function main() {
  const mongoose = require('mongoose');
  await connectDB();

  const Project = require('../models/Project');
  const NetworkVersion = require('../models/NetworkVersion');
  const RoadLink = require('../models/RoadLink');
  const LinkCoverage = require('../models/LinkCoverage');
  const Trip = require('../models/Trip');
  const User = require('../models/User');

  /* ---------------------------------------------------------------- revert */
  if (args.get('revert')) {
    const batchId = String(args.get('revert'));
    const claims = await LinkCoverage.countDocuments({ importBatchId: batchId });
    const trips = await Trip.countDocuments({ importBatchId: batchId });
    console.log(`\nbatch ${batchId}: ${claims.toLocaleString()} claims, ${trips.toLocaleString()} sessions`);
    if (!APPLY) {
      console.log('DRY RUN — re-run with --apply to delete them.');
    } else {
      const c = await LinkCoverage.deleteMany({ importBatchId: batchId });
      const t = await Trip.deleteMany({ importBatchId: batchId });
      console.log(`deleted ${c.deletedCount.toLocaleString()} claims and ${t.deletedCount.toLocaleString()} sessions`);
      console.log('Driver accounts created by the import are left in place — remove them by hand if unwanted.');
    }
    await mongoose.disconnect();
    return;
  }

  if (!args.get('file')) throw new Error('--file="<path to shapefile base>" is required');
  const year = Number(args.get('year'));
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error('--year=<YYYY> is required (the source dates carry no year)');
  }
  const bundle = resolveBundle(args.get('file'));

  /* ------------------------------------------------------- project + network */
  const project = await Project.findOne({ name: PROJECT_NAME }).lean();
  if (!project) throw new Error(`No project named "${PROJECT_NAME}"`);
  const version = await NetworkVersion.findOne({ projectId: project._id, status: 'active' }).lean();
  if (!version) throw new Error(`Project "${PROJECT_NAME}" has no ACTIVE network version`);
  console.log(`project: ${project.name}`);
  console.log(`network: ${version.label} · ${version.counts.links.toLocaleString()} links · ${version.counts.areas} areas`);
  console.log(`source : ${bundle.base}`);
  console.log(`mode   : ${APPLY ? 'APPLY — will write' : 'DRY RUN — reads only'}\n`);

  /* -------------------------------------------------------------- read rows */
  const dbf = new DbfReader(bundle.dbf, readCpg(bundle.cpg));
  const columns = dbf.fields.map((f) => f.name);
  for (const needed of ['LINK_ID', 'Driver', 'Date']) {
    if (!columns.includes(needed)) throw new Error(`Source has no "${needed}" column (found: ${columns.join(', ')})`);
  }
  const hasMonth = columns.includes('Month');

  const sessions = new Map(); // "Driver|ddmm" -> { driverKey, dd, mm, linkIds:Set }
  let rows = 0, noDriver = 0, noDate = 0, badDate = 0, monthMismatch = 0;

  for (let i = 0; i < dbf.recordCount; i++) {
    const r = dbf.record(i);
    rows++;
    const driverKey = normaliseDriver(r.Driver);
    if (!driverKey) { noDriver++; continue; }
    const when = parseDdmm(r.Date);
    if (!when) { if (String(r.Date || '').trim()) badDate++; else noDate++; continue; }
    if (!SAFE_MONTHS.has(when.mm)) {
      throw new Error(
        `Row ${i} has month ${when.mm}. This script only places July–September sessions, where ` +
        `Melbourne is reliably UTC+${AEST_OFFSET_HOURS}. Extend it deliberately rather than drifting an hour.`
      );
    }
    /**
     * The `Month` column is a REPORTING label, not the drive month, so it is counted and never
     * obeyed.
     *
     * Measured on VIC_P2_Nav: 16,193 rows whose date ends in 07 carry the label "Aug" — July
     * driving filed in the August batch — and ~2,000 September dates still say "Aug" where the
     * label was never updated, while the same dates are blank on most of their other rows. The
     * date itself is unambiguous in a way the label is not: all 113,561 values parse as a valid
     * day against a month of exactly 07, 08 or 09. Were the format MMDD instead, tails would run
     * up to 31. So the tail is the month, and a disagreeing label is the thing that is wrong.
     */
    if (hasMonth && r.Month) {
      const label = String(r.Month).trim().toLowerCase().slice(0, 3);
      const idx = MONTH_NAMES.indexOf(label);
      if (idx >= 0 && idx + 1 !== when.mm) monthMismatch++;
    }
    const linkId = String(parseInt(r.LINK_ID, 10));
    if (!linkId || linkId === 'NaN' || linkId === '0') continue;

    const key = `${driverKey}|${String(when.dd).padStart(2, '0')}${String(when.mm).padStart(2, '0')}`;
    let s = sessions.get(key);
    if (!s) {
      s = { driverKey, dd: when.dd, mm: when.mm, linkIds: new Set() };
      sessions.set(key, s);
    }
    s.linkIds.add(linkId);
  }
  dbf.close();

  console.log(`rows read: ${rows.toLocaleString()}`);
  console.log(`  no driver: ${noDriver.toLocaleString()} · no date: ${noDate.toLocaleString()} · unreadable date: ${badDate.toLocaleString()}`);
  console.log(`  Month label disagrees with the date (label ignored): ${monthMismatch.toLocaleString()}`);
  console.log(`sessions (driver × date): ${sessions.size.toLocaleString()}`);
  // An unreadable date is the real alarm: it would mean the column is not DDMM at all.
  if (badDate > rows * 0.01) {
    throw new Error('More than 1% of dates are unreadable as DDMM — the format is not what this script assumes.');
  }

  /* ------------------------------------------------------------- drivers */
  const users = await User.find({ projectIds: project._id, role: 'user' }).select('name email active').lean();
  const wanted = [...new Set([...sessions.values()].map((s) => s.driverKey))].sort();
  const userByKey = new Map();
  const missing = [];
  for (const key of wanted) {
    const hits = users.filter((u) => String(u.name).trim().split(/\s+/)[0].toLowerCase() === key.toLowerCase());
    if (hits.length === 1) userByKey.set(key, hits[0]);
    else if (hits.length === 0) missing.push(key);
    else {
      throw new Error(
        `"${key}" matches ${hits.length} drivers on this project (${hits.map((h) => h.name).join(', ')}). ` +
        `Refusing to guess which one drove those roads.`
      );
    }
  }
  console.log('\ndrivers:');
  for (const key of wanted) {
    const u = userByKey.get(key);
    console.log(`  ${key.padEnd(10)} → ${u ? `${u.name} <${u.email}>` : 'NO ACCOUNT ON THIS PROJECT'}`);
  }
  if (missing.length && !CREATE_MISSING) {
    console.log(`\n${missing.length} driver(s) have no account: ${missing.join(', ')}`);
    console.log('Re-run with --create-missing-drivers to create them (inactive, placeholder email).');
    if (APPLY) throw new Error('Refusing to apply while some drivers are unmatched.');
  }

  /* ------------------------------------------------------- our network */
  console.log('\nloading the network…');
  const ours = new Map();
  for await (const l of RoadLink.find({ networkVersionId: version._id })
    .select('linkId lengthMeters areaId priority funcClass -_id')
    .lean()
    .cursor()) {
    ours.set(l.linkId, l);
  }
  const claimed = new Set();
  for await (const c of LinkCoverage.find({ networkVersionId: version._id }).select('linkId -_id').lean().cursor()) {
    claimed.add(c.linkId);
  }
  console.log(`  ${ours.size.toLocaleString()} links in the network · ${claimed.size.toLocaleString()} already covered`);

  /**
   * One claim per link, owned by the EARLIEST session that drove it — the same first-cover-wins
   * rule the live ledger uses. Later sessions over the same street become `passes`, exactly as a
   * second recorded drive would.
   */
  const ordered = [...sessions.values()].sort((a, b) => a.mm - b.mm || a.dd - b.dd || a.driverKey.localeCompare(b.driverKey));
  const claimOf = new Map(); // linkId -> { first: session, last: session, passes }
  let unmatched = 0, collided = 0;
  for (const s of ordered) {
    s.matched = 0;
    s.matchedMeters = 0;
    for (const linkId of s.linkIds) {
      const link = ours.get(linkId);
      if (!link) { unmatched++; continue; }
      s.matched++;
      s.matchedMeters += link.lengthMeters || 0;
      if (claimed.has(linkId)) { collided++; continue; }
      const existing = claimOf.get(linkId);
      if (!existing) claimOf.set(linkId, { first: s, last: s, passes: 1 });
      else { existing.last = s; existing.passes++; }
    }
  }
  // What each session is credited with: counted once per link it first-covered, never per row.
  for (const [linkId, c] of claimOf) {
    const link = ours.get(linkId);
    const metres = link.lengthMeters || 0;
    c.first.firstCovered = (c.first.firstCovered || 0) + 1;
    c.first.firstMeters = (c.first.firstMeters || 0) + metres;
    if (link.areaId) c.first.firstMetersInArea = (c.first.firstMetersInArea || 0) + metres;
  }

  const newClaims = claimOf.size;
  const newMeters = [...claimOf.keys()].reduce((sum, id) => sum + (ours.get(id).lengthMeters || 0), 0);
  console.log('\nwhat this import would do:');
  console.log(`  links in source sessions not in our network : ${unmatched.toLocaleString()} (skipped)`);
  console.log(`  links already claimed by a recorded trip    : ${collided.toLocaleString()} (left untouched)`);
  console.log(`  NEW claims                                  : ${newClaims.toLocaleString()} (${(newMeters / 1000).toFixed(0)} km)`);
  console.log(`  coverage ${claimed.size.toLocaleString()} → ${(claimed.size + newClaims).toLocaleString()} links ` +
    `(${((claimed.size / version.counts.links) * 100).toFixed(2)}% → ${(((claimed.size + newClaims) / version.counts.links) * 100).toFixed(2)}%)`);

  console.log('\nper driver:');
  const perDriver = new Map();
  for (const s of ordered) {
    const d = perDriver.get(s.driverKey) || { sessions: 0, first: 0, km: 0 };
    d.sessions++;
    d.first += s.firstCovered || 0;
    d.km += (s.firstMeters || 0) / 1000;
    perDriver.set(s.driverKey, d);
  }
  for (const [k, d] of [...perDriver].sort((a, b) => b[1].km - a[1].km)) {
    console.log(`  ${k.padEnd(10)} ${String(d.sessions).padStart(3)} sessions · ${String(d.first).padStart(6)} new links · ${d.km.toFixed(0)} km`);
  }
  console.log(`\nUKM fields on the imported sessions: ${WRITE_UKM ? 'WRITTEN (credit follows the coverage)' : 'left null (--no-ukm)'}`);

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to commit.');
    await mongoose.disconnect();
    return;
  }

  /* ------------------------------------------------------------- write */
  const batchId = `import-${path.basename(bundle.base)}-${year}-${Date.now().toString(36)}`;
  console.log(`\nAPPLYING as batch ${batchId}`);

  for (const key of missing) {
    const email = `${key.toLowerCase()}.imported@jsan.invalid`;
    const u = new User({
      name: key,
      email,
      role: 'user',
      projectIds: [project._id],
      // Inactive on purpose: the account exists to own historical work, not to be signed into.
      // Give it a real email and activate it deliberately if this person is still driving.
      active: false,
    });
    await u.setPassword(require('crypto').randomBytes(24).toString('hex'));
    await u.save();
    userByKey.set(key, u);
    console.log(`  created driver ${key} <${email}> (inactive)`);
  }

  const localToUtc = (dd, mm, hour) => new Date(Date.UTC(year, mm - 1, dd, hour - AEST_OFFSET_HOURS, 0, 0));

  /**
   * A session that matched nothing is not a session.
   *
   * A merged file can carry a driver's work from more than one network — Merge111 holds Victoria
   * and Queensland together — so importing it against one of them leaves the other's days with no
   * link in range. Writing those as trips would put 0 km sessions in the driver's history and the
   * Trips list, describing work that did happen but not here.
   */
  const empty = ordered.filter((s) => !s.matched).length;
  const sessionsToWrite = ordered.filter((s) => s.matched > 0);
  if (empty) {
    console.log(`  skipping ${empty} session(s) that matched no link in this network`);
  }

  const tripIdBySession = new Map();
  const tripDocs = sessionsToWrite.map((s) => {
    const driver = userByKey.get(s.driverKey);
    const ddmm = `${String(s.dd).padStart(2, '0')}${String(s.mm).padStart(2, '0')}`;
    return {
      clientTripId: `${batchId}:${s.driverKey}:${ddmm}`,
      importBatchId: batchId,
      driverId: driver._id,
      projectId: project._id,
      status: 'completed',
      startedAt: localToUtc(s.dd, s.mm, WORK_START_LOCAL),
      endedAt: localToUtc(s.dd, s.mm, WORK_END_LOCAL),
      timezone: 'Australia/Melbourne',
      // Distance is what the session drove, measured on OUR geometry so it agrees with the ledger
      // rather than with the source file's own Len column.
      distanceMeters: Math.round(s.matchedMeters || 0),
      cleanedDistanceMeters: Math.round(s.matchedMeters || 0),
      pointCount: 0,
      // No GPS in the source: never hand these to the matcher, and never draw them as a route.
      mapMatchStatus: 'skipped',
      mapMatchError: `Imported from ${path.basename(bundle.base)} — source has no GPS`,
      linkCoverageStatus: 'computed',
      linkCoverageComputedAt: new Date(),
      linkCoveredCount: s.firstCovered || 0,
      assignedNetworkVersionId: version._id,
      ...(WRITE_UKM
        ? {
            linkUkmMeters: Math.round(s.firstMetersInArea || 0),
            linkUkmNetworkMeters: Math.round(s.firstMeters || 0),
            effectiveUkmMeters: Math.round(s.firstMetersInArea || 0),
            ukmBasis: 'assigned',
            ukmStatus: 'computed',
          }
        : {}),
    };
  });

  const inserted = await Trip.insertMany(tripDocs, { ordered: false });
  inserted.forEach((t) => tripIdBySession.set(t.clientTripId, t._id));
  console.log(`  created ${inserted.length.toLocaleString()} sessions`);

  const idFor = (s) => tripIdBySession.get(`${batchId}:${s.driverKey}:${String(s.dd).padStart(2, '0')}${String(s.mm).padStart(2, '0')}`);

  let written = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    // ordered:false + swallowing E11000: the unique (networkVersionId, linkId) index is the final
    // guarantee that an existing claim is never overwritten, whatever this script believes.
    try {
      await LinkCoverage.insertMany(batch, { ordered: false });
    } catch (err) {
      if (err.code !== 11000 && !err.writeErrors) throw err;
    }
    written += batch.length;
    batch = [];
    process.stdout.write(`\r  claims written: ${written.toLocaleString()}`);
  };

  for (const [linkId, c] of claimOf) {
    const link = ours.get(linkId);
    batch.push({
      projectId: project._id,
      networkVersionId: version._id,
      importBatchId: batchId,
      linkId,
      lengthMeters: link.lengthMeters,
      areaId: link.areaId || null,
      priority: link.priority ?? null,
      funcClass: link.funcClass ?? null,
      firstTripId: idFor(c.first),
      firstDriverId: userByKey.get(c.first.driverKey)._id,
      firstAt: localToUtc(c.first.dd, c.first.mm, WORK_START_LOCAL),
      firstFraction: 1,
      passes: c.passes,
      lastTripId: idFor(c.last),
      lastAt: localToUtc(c.last.dd, c.last.mm, WORK_END_LOCAL),
    });
    if (batch.length >= 2000) await flush();
  }
  await flush();

  console.log(`\n\ndone. batch id: ${batchId}`);
  console.log(`undo with: node src/seed/importCoveredRoads.js --revert=${batchId} --apply`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
