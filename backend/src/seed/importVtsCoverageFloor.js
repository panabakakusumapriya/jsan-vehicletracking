/**
 * Carry the old VTS app's road coverage into the ledger, so the Coverage map never shows LESS
 * driven road than VTS does for the same ground.
 *
 * Why this exists
 * ---------------
 * importVtsSessions.js brings VTS's driving in as trips, and those trips earn coverage the normal
 * way — snapped route against the customer's links, LINK_COVER_MIN_FRACTION of the link within
 * LINK_COVER_BUFFER_METERS in the link's direction of travel. VTS credits differently: it paints
 * its own OSM road pieces blue wherever a drive came close, in either direction. So after every
 * VTS session is imported, roads remain that VTS shows driven and Atlas does not — the far
 * carriageway of a divided road, a link driven only part of its length, a street VTS painted from
 * a drive Atlas never received (Brisbane audit 2026-10-18/19: ~9 km of VTS-blue road on Atlas-red
 * links in The Gap alone, 94 % of VTS's roads there already blue in Atlas). The business rule is
 * that Atlas may show more than VTS, never less; this script closes the rest.
 *
 * What it writes
 * --------------
 * For every link of the project's live deliveries that the ledger does not hold yet, it measures
 * how much of the link lies along VTS road VTS marks covered — the same 8 m samples the ledger
 * uses, within --buffer metres of a covered VTS piece of compatible heading (either direction,
 * because VTS ignores direction). A link qualifies at --min-fraction of its length OR --min-meters
 * of it, whichever is less demanding: a long link VTS painted for 80 m reads as driven on the VTS
 * map, and the ledger is whole-link.
 *
 * Each qualifying link gets one claim, credited to the driver VTS credits for the most of it
 * (matched to an account here by email) and dated by the earliest VTS track of that driver within
 * 30 m of it. Claims hang off one placeholder trip per driver per delivery — no GPS, 0 km,
 * `mapMatchStatus: 'skipped'` — because a claim needs a trip and must NOT hang off a real one:
 * re-attributing a real trip releases every claim it holds that its own route does not explain.
 * The placeholder is never picked up by the matcher or the catch-up sweeps (both want a matched
 * route), so nothing releases these claims behind the scenes.
 *
 * What it never does
 * ------------------
 *   - Overwrite a claim. Links already in the ledger are skipped; the unique index is the final
 *     guarantee. A real trip that drove a floor link EARLIER takes it over the normal way.
 *   - Touch a road a manager cleared with "Clear driven data" (CoverageReset). That was a decision.
 *   - Give anyone kilometres or UKM. Placeholders carry 0 km and ukmStatus 'skipped'; the claims
 *     do move the area and driver coverage figures, which is the point.
 *   - Survive a full rebuild of a delivery's ledger (rebuildNetworkCoverage clears every row, as it
 *     already does for importCoveredRoads.js). Re-run this afterwards; it is idempotent.
 *
 * Usage
 * -----
 *   node src/seed/importVtsCoverageFloor.js --roads=<geofences_roads.json> --drivers=<drivers.json> [--tracks=<project_tracks.json>]
 *   ... --apply
 *   node src/seed/importVtsCoverageFloor.js --revert=<vtsfloor-…> --apply
 *
 * Inputs are dumps of the VTS API: `geofences/roads?projectId=` ({roads:[{g:[[lat,lon]…],c,by}]}),
 * `drivers`, and optionally `locations/project-tracks` (for dates; without it every claim is dated
 * now). Options: --project="PRJ-025-HE-DRIVE-AUSGNZ" --buffer=15 --min-fraction=0.3 --min-meters=50
 * --create-missing-drivers (inactive placeholder accounts for coverage owners with no account here)
 * --bbox=latMin,latMax,lonMin,lonMax (limit to an area, for checking) --report=<file.json>
 */
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { connectDB } = require('../config/db');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const APPLY = args.get('apply') === true;
const REVERT = args.has('revert') ? String(args.get('revert')) : null;
const CREATE_MISSING = args.get('create-missing-drivers') === true;
// Test logins on VTS — never real driving (as in importVtsSessions.js).
const TEST_EMAILS = new Set(['autest@vts.com', 'projaus@gmail.com']);
const BUFFER = Number(args.get('buffer') || 15);
const MIN_FRACTION = Number(args.get('min-fraction') || 0.3);
const MIN_METERS = Number(args.get('min-meters') || 50);
const BBOX = args.has('bbox') ? String(args.get('bbox')).split(',').map(Number) : null; // latMin,latMax,lonMin,lonMax
// The ledger's own sampling and heading tolerance (services/linkCoverage.js, env.js).
const SAMPLE_METERS = 8;
const HEADING_MAX_DEG = 60;
const DATE_RADIUS_M = 30;
const CELL = 0.0005; // ~50 m: the buffer is always inside the cell and its ring
const COARSE = 0.01; // ~1 km: which areas are worth streaming at all
const log = (...a) => console.log(...a);

const rad = (x) => (x * Math.PI) / 180;
/** Initial bearing a → b, degrees; points are [lon, lat]. */
function bearing(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function meters(a, b) {
  const dl = rad(b[1] - a[1]);
  const dn = rad(b[0] - a[0]);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dn / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
const axisDelta = (a, b) => {
  const d = Math.abs(a - b) % 180;
  return d > 90 ? 180 - d : d;
};
const inBox = (lon, lat) => !BBOX || (lat > BBOX[0] && lat < BBOX[1] && lon > BBOX[2] && lon < BBOX[3]);
const cellKey = (x, y) => x * 1e6 + y;

async function withRetry(fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 6) throw err;
      log(`  retry ${i} after: ${err.message}`);
      await new Promise((r) => setTimeout(r, 4000 * i));
    }
  }
}

/** VTS's covered road pieces as segments in a ~50 m grid, plus a ~1 km "anything here?" set. */
function loadVtsCoverage(file) {
  const roads = JSON.parse(fs.readFileSync(file, 'utf8')).roads || [];
  const seg = { ax: [], ay: [], bx: [], by: [], brg: [], who: [] };
  const grid = new Map();
  const coarse = new Set();
  const vtsDrivers = [];
  const driverIndex = new Map();
  for (const r of roads) {
    if (!r.c || !Array.isArray(r.g)) continue;
    let w = driverIndex.get(r.by);
    if (w === undefined) {
      w = vtsDrivers.length;
      vtsDrivers.push(r.by);
      driverIndex.set(r.by, w);
    }
    for (let i = 1; i < r.g.length; i++) {
      const a = [r.g[i - 1][1], r.g[i - 1][0]]; // VTS is [lat, lon]
      const b = [r.g[i][1], r.g[i][0]];
      if (!inBox(a[0], a[1])) continue;
      const k = seg.ax.length;
      seg.ax.push(a[0]); seg.ay.push(a[1]); seg.bx.push(b[0]); seg.by.push(b[1]);
      seg.brg.push(bearing(a, b)); seg.who.push(w);
      for (let x = Math.floor(Math.min(a[0], b[0]) / CELL); x <= Math.floor(Math.max(a[0], b[0]) / CELL); x++) {
        for (let y = Math.floor(Math.min(a[1], b[1]) / CELL); y <= Math.floor(Math.max(a[1], b[1]) / CELL); y++) {
          const key = cellKey(x, y);
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(k);
        }
      }
      coarse.add(cellKey(Math.floor(a[0] / COARSE), Math.floor(a[1] / COARSE)));
    }
  }
  return { seg, grid, coarse, vtsDrivers };
}

/** The VTS driver (index) whose covered piece lies nearest `p` within the buffer at a compatible heading, or -1. */
function vtsDriverAt(vts, p, brg) {
  const { seg, grid } = vts;
  const cx = Math.floor(p[0] / CELL);
  const cy = Math.floor(p[1] / CELL);
  const mx = Math.cos(rad(p[1])) * 111320;
  const my = 110540;
  let best = -1;
  let bestD2 = BUFFER * BUFFER;
  for (let x = cx - 1; x <= cx + 1; x++) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      const list = grid.get(cellKey(x, y));
      if (!list) continue;
      for (const k of list) {
        if (axisDelta(brg, seg.brg[k]) > HEADING_MAX_DEG) continue;
        const px = (p[0] - seg.ax[k]) * mx;
        const py = (p[1] - seg.ay[k]) * my;
        const dx = (seg.bx[k] - seg.ax[k]) * mx;
        const dy = (seg.by[k] - seg.ay[k]) * my;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? (px * dx + py * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - t * dx;
        const ey = py - t * dy;
        const d2 = ex * ex + ey * ey;
        if (d2 <= bestD2) {
          bestD2 = d2;
          best = seg.who[k];
        }
      }
    }
  }
  return best;
}

/** VTS track points in a grid, each with its driver and its session's start: what dates a claim. */
function loadTracks(file) {
  if (!file) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tracks = Array.isArray(raw) ? raw : raw.tracks || Object.values(raw).find(Array.isArray) || [];
  const grid = new Map();
  const firstByDriver = new Map();
  for (const t of tracks) {
    const driver = String((t.driver && (t.driver._id || t.driver)) || '');
    const at = new Date(t.startTime).getTime();
    if (!driver || !Number.isFinite(at)) continue;
    if (!firstByDriver.has(driver) || at < firstByDriver.get(driver)) firstByDriver.set(driver, at);
    for (const p of t.points || []) {
      const key = cellKey(Math.floor(p[1] / CELL), Math.floor(p[0] / CELL));
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push([p[1], p[0], driver, at]);
    }
  }
  return { grid, firstByDriver };
}

/** Earliest VTS session start of `driver` with a track point within DATE_RADIUS_M of any of `pts`. */
function earliestTrackAt(tracks, driver, pts) {
  if (!tracks) return null;
  let best = null;
  for (const p of pts) {
    const cx = Math.floor(p[0] / CELL);
    const cy = Math.floor(p[1] / CELL);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const q of tracks.grid.get(cellKey(x, y)) || []) {
          if (q[2] !== driver || (best !== null && q[3] >= best)) continue;
          if (meters(p, q) <= DATE_RADIUS_M) best = q[3];
        }
      }
    }
  }
  return best;
}

async function revert(batch) {
  if (!/^vtsfloor-/.test(batch)) throw new Error('Only a vtsfloor-… batch can be reverted by this script');
  const Trip = require('../models/Trip');
  const LinkCoverage = require('../models/LinkCoverage');
  const claims = await LinkCoverage.countDocuments({ importBatchId: batch });
  const trips = await Trip.countDocuments({ importBatchId: batch });
  log(`Batch ${batch}: ${claims} claims, ${trips} placeholder trips`);
  if (!APPLY) return log('Dry run — add --apply to remove them.');
  const c = await LinkCoverage.deleteMany({ importBatchId: batch });
  const t = await Trip.deleteMany({ importBatchId: batch });
  const u = await require('../models/User').collection.deleteMany({ importBatchId: batch, active: false });
  log(`Removed ${c.deletedCount} claims, ${t.deletedCount} trips and ${u.deletedCount} placeholder accounts.`);
}

async function main() {
  await connectDB();
  if (REVERT) return revert(REVERT);
  if (!args.has('roads') || !args.has('drivers')) throw new Error('--roads=<file> and --drivers=<file> are required');

  const Project = require('../models/Project');
  const User = require('../models/User');
  const Trip = require('../models/Trip');
  const RoadLink = require('../models/RoadLink');
  const WorkArea = require('../models/WorkArea');
  const LinkCoverage = require('../models/LinkCoverage');
  const CoverageReset = require('../models/CoverageReset');
  const { liveNetworkVersions } = require('../services/liveNetworks');

  const project = await Project.findOne({ name: PROJECT_NAME }).select('_id name').lean();
  if (!project) throw new Error(`Project ${PROJECT_NAME} not found`);

  const vts = loadVtsCoverage(String(args.get('roads')));
  log(`VTS covered road pieces: ${vts.seg.ax.length.toLocaleString()}`);
  const tracks = loadTracks(args.has('tracks') ? String(args.get('tracks')) : null);

  // VTS driver → account here, by email, exactly as importVtsSessions.js matches them.
  const vtsList = JSON.parse(fs.readFileSync(String(args.get('drivers')), 'utf8'));
  const vtsById = new Map((Array.isArray(vtsList) ? vtsList : vtsList.drivers || []).map((d) => [String(d._id), d]));
  const users = await User.find({ role: 'user' }).select('_id name email').lean();
  const userByEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));
  // A VTS driver with no account here — or one VTS itself no longer knows (deleted there, while the
  // roads they drove stay painted on its map) — gets an inactive placeholder with --create-missing-
  // drivers, so their roads are not the ones left below VTS. Ids are fixed now so claims can name
  // them in a dry run; the accounts are written only with --apply. VTS test logins are never credited.
  const placeholders = new Map();
  const accountFor = (vtsDriverId) => {
    const d = vtsById.get(String(vtsDriverId));
    const email = String((d && d.email) || '').toLowerCase();
    if (TEST_EMAILS.has(email)) return null;
    const existing = email ? userByEmail.get(email) : null;
    if (existing || !CREATE_MISSING) return existing || null;
    if (!placeholders.has(String(vtsDriverId))) {
      placeholders.set(String(vtsDriverId), {
        _id: new mongoose.Types.ObjectId(),
        name: d ? String(d.name).replace(/\s+(HTL?|SMD)\d+$/i, '').trim() : `VTS driver ${String(vtsDriverId).slice(-6)} (removed from VTS)`,
        email: email || `vts-${vtsDriverId}@removed.vts.invalid`,
        placeholder: true,
      });
    }
    return placeholders.get(String(vtsDriverId));
  };

  const cleared = new Set(
    (await CoverageReset.find({ projectId: project._id }).select('linkIds').lean()).flatMap((r) => r.linkIds || [])
  );
  const versions = await liveNetworkVersions([project._id]);
  const nearVts = (bb) => {
    if (!bb) return true;
    for (let x = Math.floor(bb[0] / COARSE); x <= Math.floor(bb[2] / COARSE); x++) {
      for (let y = Math.floor(bb[1] / COARSE); y <= Math.floor(bb[3] / COARSE); y++) {
        if (vts.coarse.has(cellKey(x, y))) return true;
      }
    }
    return false;
  };

  const claims = []; // { version, link, fraction, vtsDriver, user, at }
  const skipped = { cleared: 0, clearedKm: 0, noAccount: new Map() };
  for (const version of versions) {
    const held = new Set(
      (await withRetry(() => LinkCoverage.find({ networkVersionId: version._id }).select('linkId -_id').lean())).map((c) => c.linkId)
    );
    const areas = await withRetry(() => WorkArea.find({ networkVersionId: version._id }).select('_id bbox').lean());
    const todo = [...areas.filter((a) => nearVts(a.bbox)).map((a) => a._id), null]; // null: links outside every area
    let seen = 0;
    for (const areaId of todo) {
      const links = await withRetry(() =>
        RoadLink.find({ networkVersionId: version._id, areaId })
          .select('linkId geometry.coordinates lengthMeters areaId priority funcClass -_id')
          .lean()
      );
      for (const link of links) {
        const coords = link.geometry && link.geometry.coordinates;
        if (!coords || coords.length < 2 || held.has(link.linkId)) continue;
        let lo0 = Infinity, la0 = Infinity, lo1 = -Infinity, la1 = -Infinity;
        for (const p of coords) {
          if (p[0] < lo0) lo0 = p[0]; if (p[0] > lo1) lo1 = p[0];
          if (p[1] < la0) la0 = p[1]; if (p[1] > la1) la1 = p[1];
        }
        if (!nearVts([lo0, la0, lo1, la1])) continue;

        let samples = 0;
        const hits = [];
        const byDriver = new Map();
        for (let i = 1; i < coords.length; i++) {
          const p = coords[i - 1];
          const q = coords[i];
          const len = meters(p, q);
          if (!len) continue;
          const brg = bearing(p, q);
          const n = Math.max(1, Math.ceil(len / SAMPLE_METERS));
          for (let j = 0; j < n; j++) {
            const t = (j + 0.5) / n;
            const s = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
            samples += 1;
            const w = vtsDriverAt(vts, s, brg);
            if (w < 0) continue;
            hits.push(s);
            byDriver.set(w, (byDriver.get(w) || 0) + 1);
          }
        }
        if (!samples || !hits.length) continue;
        const fraction = hits.length / samples;
        const vtsMeters = fraction * (link.lengthMeters || 0);
        if (fraction < MIN_FRACTION && vtsMeters < MIN_METERS) continue;

        if (cleared.has(link.linkId)) {
          skipped.cleared += 1;
          skipped.clearedKm += (link.lengthMeters || 0) / 1000;
          continue;
        }
        const vtsDriver = vts.vtsDrivers[[...byDriver.entries()].sort((a, b) => b[1] - a[1])[0][0]];
        const user = accountFor(vtsDriver);
        if (!user) {
          const d = vtsById.get(String(vtsDriver));
          const key = d ? `${d.name} <${d.email}>` : `VTS driver ${vtsDriver}`;
          const row = skipped.noAccount.get(key) || { links: 0, km: 0 };
          row.links += 1;
          row.km += (link.lengthMeters || 0) / 1000;
          skipped.noAccount.set(key, row);
          continue;
        }
        const at = earliestTrackAt(tracks, String(vtsDriver), hits.filter((_, i) => i % 4 === 0))
          ?? tracks?.firstByDriver.get(String(vtsDriver))
          ?? Date.now();
        claims.push({ version: version._id, link, fraction, vtsMeters, user, at: new Date(at) });
      }
      if (++seen % 50 === 0) log(`  delivery ${String(version._id).slice(-6)}: ${seen}/${todo.length} areas, ${claims.length.toLocaleString()} links to lift so far`);
    }
  }

  const km = (m) => (m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const totalM = claims.reduce((s, c) => s + (c.link.lengthMeters || 0), 0);
  log(`\nLinks VTS shows driven that the ledger does not hold: ${claims.length.toLocaleString()} (${km(totalM)} km of link, ${km(claims.reduce((s, c) => s + c.vtsMeters, 0))} km of it painted by VTS)`);
  const perDriver = new Map();
  for (const c of claims) {
    const k = c.user.name;
    const row = perDriver.get(k) || { links: 0, m: 0 };
    row.links += 1;
    row.m += c.link.lengthMeters || 0;
    perDriver.set(k, row);
  }
  log('Credited to:');
  for (const [name, r] of [...perDriver].sort((a, b) => b[1].m - a[1].m)) log(`  ${name.padEnd(36)} ${String(r.links).padStart(6)} links ${km(r.m).padStart(8)} km`);
  for (const p of placeholders.values()) log(`${APPLY ? 'Creating' : 'Would create'} inactive placeholder account: ${p.name} <${p.email}>`);
  if (skipped.cleared) log(`Left alone — cleared by a manager: ${skipped.cleared} links, ${skipped.clearedKm.toFixed(1)} km`);
  for (const [k, r] of skipped.noAccount) log(`Left alone — no account here for ${k}: ${r.links} links, ${r.km.toFixed(1)} km`);
  if (args.has('report')) {
    fs.writeFileSync(String(args.get('report')), JSON.stringify(claims.map((c) => ({
      v: String(c.version), id: c.link.linkId, area: c.link.areaId && String(c.link.areaId), m: c.link.lengthMeters,
      f: +c.fraction.toFixed(3), driver: c.user.name, at: c.at,
    }))));
  }
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');
  if (!claims.length) return log('\nNothing to write.');

  const batch = `vtsfloor-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  for (const p of placeholders.values()) {
    if (!claims.some((c) => c.user === p)) continue;
    const u = new User({
      _id: p._id,
      name: p.name,
      email: p.email,
      role: 'user',
      projectIds: [project._id],
      country: 'AU',
      // Inactive on purpose: the account exists to own VTS's coverage, not to be signed into.
      active: false,
    });
    await u.setPassword(crypto.randomBytes(24).toString('hex'));
    await withRetry(() => u.save());
    // Not a User schema field, so written past the model: it is only what lets --revert remove
    // exactly the accounts this batch made.
    await withRetry(() => User.collection.updateOne({ _id: u._id }, { $set: { importBatchId: batch } }));
    log(`Created placeholder ${p.name} <${p.email}>`);
  }

  // One placeholder trip per (driver, delivery).
  const groups = new Map();
  for (const c of claims) {
    const key = `${c.user._id}:${c.version}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const tripIdFor = new Map();
  const tripDocs = [...groups].map(([key, list]) => {
    const [driverId, versionId] = key.split(':');
    const first = new Date(Math.min(...list.map((c) => c.at.getTime())));
    return {
      clientTripId: `${batch}:${key}`,
      importBatchId: batch,
      driverId: new mongoose.Types.ObjectId(driverId),
      projectId: project._id,
      status: 'completed',
      startedAt: first,
      endedAt: first,
      timezone: 'Australia/Brisbane',
      distanceMeters: 0,
      cleanedDistanceMeters: 0,
      pointCount: 0,
      mapMatchStatus: 'skipped',
      mapMatchError: 'Road coverage carried over from VTS — roads VTS shows driven that no trip here was credited for. No GPS of its own.',
      ukmStatus: 'skipped',
      linkCoverageStatus: 'computed',
      linkCoverageComputedAt: new Date(),
      linkCoveredCount: list.length,
      assignedNetworkVersionId: new mongoose.Types.ObjectId(versionId),
    };
  });
  const inserted = await withRetry(() => Trip.insertMany(tripDocs, { ordered: false }));
  inserted.forEach((t) => tripIdFor.set(t.clientTripId.slice(batch.length + 1), t._id));
  log(`\nBatch ${batch}: ${inserted.length} placeholder trips`);

  let written = 0;
  for (let i = 0; i < claims.length; i += 2000) {
    const rows = claims.slice(i, i + 2000).map((c) => ({
      projectId: project._id,
      networkVersionId: c.version,
      importBatchId: batch,
      linkId: c.link.linkId,
      lengthMeters: c.link.lengthMeters,
      areaId: c.link.areaId || null,
      priority: c.link.priority ?? null,
      funcClass: c.link.funcClass ?? null,
      firstTripId: tripIdFor.get(`${c.user._id}:${c.version}`),
      firstDriverId: c.user._id,
      firstAt: c.at,
      firstFraction: Math.min(1, c.fraction),
      passes: 1,
      lastTripId: tripIdFor.get(`${c.user._id}:${c.version}`),
      lastAt: c.at,
    }));
    // ordered:false + swallowing E11000: a trip that claimed one of these links while this ran
    // keeps it. The unique (networkVersionId, linkId) index is the final word.
    await withRetry(async () => {
      try {
        await LinkCoverage.insertMany(rows, { ordered: false });
      } catch (err) {
        if (err.code !== 11000 && !err.writeErrors) throw err;
      }
    });
    written += rows.length;
    log(`  claims written: ${written.toLocaleString()} / ${claims.length.toLocaleString()}`);
  }
  log(`\nDone. Undo: node src/seed/importVtsCoverageFloor.js --revert=${batch} --apply`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
