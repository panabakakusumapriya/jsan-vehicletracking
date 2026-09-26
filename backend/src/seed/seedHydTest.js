/**
 * A Hyderabad test world: project `hyd-test`, GHMC ward polygons as work areas, the OpenStreetMap
 * road network inside them, and a test driver holding the wards the team actually drives in.
 *
 * Why it exists: every real network is Australian, so nobody here can drive-test the driver map
 * — the local matching, the red→blue handover, free drive — from Hyderabad. This builds the same
 * shape of data the customer import builds, from open data, in a project that cannot leak into
 * anyone else's numbers.
 *
 * Walled off, not just labelled:
 *   - its own project, so it never appears in a real project's coverage, areas or reports;
 *   - its own coverage scope ('hyd-test'), so trips recorded here never enter the shared default
 *     scope that global UKM and "already covered" are computed in;
 *   - a new driver of its own. No existing user is modified.
 * `--revert` removes everything this created, and the test driver's own trips with it.
 *
 * Inputs (neither is committed — both are public and reproducible):
 *   --roads=<dir>  Geofabrik OSM roads shapefile for Hyderabad (gis_osm_roads_free_1, clipped).
 *                  The repo-root hyderbad.zip, extracted.
 *   --wards=<file> The GHMC ward boundaries (2022) as KML, from OpenCity (public domain):
 *                    https://data.opencity.in/dataset/hyderabad-wards-info  → ghmc_wards.kml
 *                  NOT OpenStreetMap's copy of the same wards: OSM's relations are derived from
 *                  this file but several are broken — Ward 105 Gachibowli, where most of the
 *                  team's test driving happens, is missing boundary members and leaves 4–8 km
 *                  gaps that cannot be closed honestly. The source file has every ward whole.
 *
 * What is translated, because OSM is not HERE:
 *   - link id      <- osm_id (unique per way)
 *   - func class   <- fclass: motorway/trunk 1, primary 2, secondary 3, tertiary 4,
 *                     residential/unclassified/living_street 5. Everything else — footways, paths,
 *                     steps, cycleways, tracks, and `service` (parking aisles and driveways, which
 *                     would bury the map in red that nobody is meant to drive) — is left out.
 *   - direction    <- oneway, whose Geofabrik B/F/T codes are the same as HERE's DIR_TRAVEL.
 * Links are placed in the ward containing their midpoint — the same rule the customer import
 * uses. Links in no ward are not imported: nobody can be assigned them, and they would only add
 * dead weight to the road collection.
 *
 * Usage:
 *   node src/seed/seedHydTest.js --roads=<dir> --wards=<file>             # dry run
 *   node src/seed/seedHydTest.js --roads=<dir> --wards=<file> --apply
 *   node src/seed/seedHydTest.js --revert --apply
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');
const shapefile = require('../utils/shapefile');
const {
  lineLength, midpointOf, pointInPolygon, simplifyGeometry, Grid,
} = require('../utils/geo');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const APPLY = args.get('apply') === true;
const REVERT = args.get('revert') === true;

const PROJECT_NAME = 'hyd-test';
const PROJECT_CODE = 'HYD-TEST';
const SCOPE_ID = 'hyd-test';
const DRIVER_EMAIL = 'hyd.test@jsan.com';
const DRIVER_NAME = 'Hyd Test Driver';

/**
 * Where the team actually drives, measured from the trips that start inside Hyderabad: ~2 km
 * cells, weighted by trip count. Wards are handed to the test driver nearest-first to these.
 */
const HOTSPOTS = [
  { lat: 17.44, lon: 78.36, trips: 97 }, // Gachibowli / Financial District
  { lat: 17.40, lon: 78.48, trips: 55 }, // central
  { lat: 17.44, lon: 78.58, trips: 25 }, // Uppal side
  { lat: 17.38, lon: 78.38, trips: 12 }, // Manikonda / Narsingi
];

/**
 * Cap on the roads assigned to the test driver. The phone draws at most 20,000 roads across all
 * its areas (MAX_DRAWN_LINKS in the map screen), and anything beyond that is silently not drawn —
 * which in a test reads as "the map is broken". Headroom under the cap on purpose.
 */
const ASSIGN_LINK_BUDGET = 18000;

const FUNC_CLASS = {
  motorway: 1, motorway_link: 1, trunk: 1, trunk_link: 1,
  primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3,
  tertiary: 4, tertiary_link: 4,
  unclassified: 5, residential: 5, living_street: 5,
};

const OUTLINE_TOLERANCE_M = 25; // same as the customer import
const INSERT_BATCH = 2000;

/* ── ward polygons from the GHMC KML ────────────────────────────────────────── */

const samePt = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Signed shoelace area in degree space: > 0 is counter-clockwise. */
function signedArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return s / 2;
}

/** Square metres of a ring, planar at its own latitude — plenty at ward size. */
function ringAreaSqm(ring) {
  const lat = ring[0][1];
  const mx = 111320 * Math.cos((lat * Math.PI) / 180);
  const my = 110540;
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] * mx) * (ring[i][1] * my) - (ring[i][0] * mx) * (ring[j][1] * my);
  }
  return Math.abs(s / 2);
}

/** Drop consecutive repeats — the 2dsphere index rejects them. */
function dedupe(coords) {
  const out = [];
  for (const c of coords) if (!out.length || !samePt(out[out.length - 1], c)) out.push(c);
  return out;
}

/** A KML <coordinates> body -> closed [lon, lat] ring. */
function kmlRing(text) {
  const pts = text.trim().split(/\s+/)
    .map((t) => t.split(',').map(Number))
    .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map((c) => [c[0], c[1]]);
  const ring = dedupe(pts);
  if (ring.length && !samePt(ring[0], ring[ring.length - 1])) ring.push(ring[0]);
  return ring;
}

const titleCase = (t) => t.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

/**
 * One ward per GHMC ward number. A ward delivered as several placemarks (a ward split by a
 * river or a railway) is MERGED into one MultiPolygon rather than becoming two work areas with
 * the same code, which is what the driver and the manager both mean by "ward 105".
 */
function parseWards(kml) {
  const byCode = new Map();
  const problems = [];
  for (const pm of kml.split('<Placemark').slice(1)) {
    const field = (n) => (new RegExp(`<SimpleData name="${n}">([^<]*)</SimpleData>`).exec(pm) || [])[1] || '';
    const label = field('ward').trim();                         // e.g. "105-GACHIBOWLI"
    const m = /^(\d+)\s*-\s*(.+)$/.exec(label);
    if (!m) { problems.push(`placemark without a ward label: "${label}"`); continue; }
    const code = `GHMC-W${m[1].padStart(3, '0')}`;
    const polys = [];
    for (const poly of pm.split('<Polygon>').slice(1)) {
      const outerM = /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(poly);
      if (!outerM) continue;
      let outer = kmlRing(outerM[1]);
      if (outer.length < 4) continue;
      // GeoJSON / MongoDB orientation: outer rings counter-clockwise, holes clockwise.
      if (signedArea(outer) < 0) outer = outer.reverse();
      const rings = [outer];
      for (const innerM of poly.matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) {
        let hole = kmlRing(innerM[1]);
        if (hole.length < 4) continue;
        if (signedArea(hole) > 0) hole = hole.reverse();
        rings.push(hole);
      }
      polys.push(rings);
    }
    if (!polys.length) { problems.push(`${label}: no polygon`); continue; }
    const entry = byCode.get(code) || {
      code,
      name: `Ward ${Number(m[1])} ${titleCase(m[2].trim())}`,
      circle: titleCase(field('CIRCLE').replace(/^\d+\s*-\s*/, '').trim()) || 'GHMC',
      polys: [],
    };
    entry.polys.push(...polys);
    byCode.set(code, entry);
  }

  const wards = [];
  for (const w of byCode.values()) {
    let W = Infinity; let S = Infinity; let E = -Infinity; let N = -Infinity;
    for (const p of w.polys) for (const [x, y] of p[0]) {
      if (x < W) W = x; if (x > E) E = x; if (y < S) S = y; if (y > N) N = y;
    }
    const geometry = w.polys.length === 1
      ? { type: 'Polygon', coordinates: w.polys[0] }
      : { type: 'MultiPolygon', coordinates: w.polys };
    const areaSqm = w.polys.reduce(
      (acc, p) => acc + ringAreaSqm(p[0]) - p.slice(1).reduce((h, r) => h + ringAreaSqm(r), 0), 0
    );
    wards.push({ ...w, geometry, bbox: [W, S, E, N], areaSqm, centroid: [(W + E) / 2, (S + N) / 2] });
  }
  wards.sort((a, b) => a.code.localeCompare(b.code));
  return { wards, problems };
}

/* ── main ───────────────────────────────────────────────────────────────────── */

async function revert() {
  const Project = require('../models/Project');
  const User = require('../models/User');
  const NetworkVersion = require('../models/NetworkVersion');
  const WorkArea = require('../models/WorkArea');
  const RoadLink = require('../models/RoadLink');
  const AreaAssignment = require('../models/AreaAssignment');
  const LinkCoverage = require('../models/LinkCoverage');
  const Trip = require('../models/Trip');
  const LocationPoint = require('../models/LocationPoint');

  const project = await Project.findOne({ name: PROJECT_NAME }).lean();
  const driver = await User.findOne({ email: DRIVER_EMAIL }).lean();
  if (!project && !driver) { console.log('Nothing to revert — no hyd-test project or test driver.'); return; }

  const pid = project?._id;
  const tripIds = driver ? (await Trip.find({ driverId: driver._id }).select('_id').lean()).map((t) => t._id) : [];
  const counts = {
    assignments: pid ? await AreaAssignment.countDocuments({ projectId: pid }) : 0,
    coverage: pid ? await LinkCoverage.countDocuments({ projectId: pid }) : 0,
    links: pid ? await RoadLink.countDocuments({ projectId: pid }) : 0,
    areas: pid ? await WorkArea.countDocuments({ projectId: pid }) : 0,
    versions: pid ? await NetworkVersion.countDocuments({ projectId: pid }) : 0,
    driverTrips: tripIds.length,
    driverPoints: tripIds.length ? await LocationPoint.countDocuments({ tripId: { $in: tripIds } }) : 0,
  };
  console.log('Would remove:', counts, `project=${!!project}`, `driver=${!!driver}`);
  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to remove.'); return; }

  if (pid) {
    await AreaAssignment.deleteMany({ projectId: pid });
    await LinkCoverage.deleteMany({ projectId: pid });
    await RoadLink.deleteMany({ projectId: pid });
    await WorkArea.deleteMany({ projectId: pid });
    await NetworkVersion.deleteMany({ projectId: pid });
  }
  if (tripIds.length) {
    await LocationPoint.deleteMany({ tripId: { $in: tripIds } });
    await Trip.deleteMany({ _id: { $in: tripIds } });
  }
  if (driver) await User.deleteOne({ _id: driver._id });
  if (pid) await Project.deleteOne({ _id: pid });
  console.log('Removed.');
}

async function seed() {
  const fs = require('fs');
  const roadsDir = args.get('roads');
  const wardsFile = args.get('wards');
  if (typeof roadsDir !== 'string' || typeof wardsFile !== 'string') {
    throw new Error('--roads=<dir> and --wards=<file> are required');
  }

  const Project = require('../models/Project');
  const User = require('../models/User');
  const NetworkVersion = require('../models/NetworkVersion');
  const WorkArea = require('../models/WorkArea');
  const RoadLink = require('../models/RoadLink');
  const AreaAssignment = require('../models/AreaAssignment');

  if (await Project.findOne({ name: PROJECT_NAME }).lean()) {
    throw new Error(`Project "${PROJECT_NAME}" already exists — run with --revert --apply first.`);
  }
  if (await User.findOne({ email: DRIVER_EMAIL }).lean()) {
    throw new Error(`User ${DRIVER_EMAIL} already exists — run with --revert --apply first.`);
  }

  /* wards */
  const { wards, problems } = parseWards(fs.readFileSync(wardsFile, 'utf8'));
  console.log(`wards parsed          : ${wards.length}`);
  for (const p of problems) console.log(`  ! ${p}`);

  const grid = new Grid(0.05);
  wards.forEach((w, i) => grid.insert(w.bbox, i));
  const locate = (pt) => {
    for (const i of grid.near(pt)) {
      const w = wards[i];
      if (pt[0] < w.bbox[0] || pt[0] > w.bbox[2] || pt[1] < w.bbox[1] || pt[1] > w.bbox[3]) continue;
      for (const poly of w.polys) if (pointInPolygon(pt, poly)) return i;
    }
    return -1;
  };

  /* roads: one pass, held in memory (tens of thousands of lines — well within reach) */
  const [bundle] = shapefile.findShapefiles(roadsDir);
  if (!bundle) throw new Error(`No shapefile found in ${roadsDir}`);
  const perWard = wards.map(() => ({ links: 0, meters: 0 }));
  const links = [];
  const seenIds = new Set();
  let total = 0; let skippedClass = 0; let orphans = 0; let dupes = 0; let degenerate = 0;
  for (const { attrs, parts } of shapefile.features(bundle)) {
    total++;
    const funcClass = FUNC_CLASS[String(attrs.fclass || '').trim()];
    if (!funcClass) { skippedClass++; continue; }
    const linkId = String(attrs.osm_id ?? '').trim();
    if (!linkId) { degenerate++; continue; }
    if (seenIds.has(linkId)) { dupes++; continue; }
    const coords = dedupe((parts[0] || []).map((p) => [p[0], p[1]]));
    if (coords.length < 2) { degenerate++; continue; }
    const wi = locate(midpointOf(coords));
    if (wi < 0) { orphans++; continue; }
    seenIds.add(linkId);
    const metres = lineLength(coords);
    perWard[wi].links++;
    perWard[wi].meters += metres;
    const dirRaw = String(attrs.oneway ?? 'B').trim().toUpperCase();
    links.push({
      wi, linkId, funcClass, metres, coords,
      name: String(attrs.name ?? '').trim() || String(attrs.ref ?? '').trim() || null,
      dirTravel: ['B', 'F', 'T'].includes(dirRaw) ? dirRaw : 'B',
    });
  }
  console.log(`OSM road lines        : ${total.toLocaleString()}`);
  console.log(`  not drivable / class: ${skippedClass.toLocaleString()} (footways, service, tracks…)`);
  console.log(`  outside every ward  : ${orphans.toLocaleString()}`);
  console.log(`  duplicate / degenerate: ${dupes} / ${degenerate}`);
  console.log(`  imported            : ${links.length.toLocaleString()} links, ${(links.reduce((a, l) => a + l.metres, 0) / 1000).toFixed(0)} km`);
  const busiest = Math.max(...perWard.map((p) => p.links));
  console.log(`  largest ward        : ${busiest.toLocaleString()} links (per-area server cap is 20,000)`);

  /* which wards the test driver gets: containing a hotspot first, then nearest by weight */
  const distKm = (a, b) => {
    const dx = (a[0] - b[0]) * 111.32 * Math.cos((a[1] * Math.PI) / 180);
    const dy = (a[1] - b[1]) * 110.54;
    return Math.hypot(dx, dy);
  };
  const containing = new Set(HOTSPOTS.map((h) => locate([h.lon, h.lat])).filter((i) => i >= 0));
  const ranked = wards
    .map((w, i) => ({
      i,
      score: Math.min(...HOTSPOTS.map((h) => distKm(w.centroid, [h.lon, h.lat]) / Math.sqrt(h.trips))),
    }))
    .sort((a, b) => (containing.has(b.i) - containing.has(a.i)) || a.score - b.score);
  const assigned = [];
  let budget = 0;
  for (const { i } of ranked) {
    const n = perWard[i].links;
    if (!n) continue;
    if (budget + n > ASSIGN_LINK_BUDGET) continue;
    assigned.push(i);
    budget += n;
  }
  console.log(`\nassigned to ${DRIVER_NAME}: ${assigned.length} wards, ${budget.toLocaleString()} roads`);
  for (const i of assigned) {
    console.log(`  ${wards[i].code.padEnd(12)} ${wards[i].name.padEnd(34)} ${String(perWard[i].links).padStart(5)} roads${containing.has(i) ? '  ← hotspot' : ''}`);
  }
  const missed = HOTSPOTS.filter((h) => { const i = locate([h.lon, h.lat]); return i < 0 || !assigned.includes(i); });
  if (missed.length) console.log(`  ! hotspot(s) not covered: ${missed.map((h) => `${h.lat},${h.lon}`).join(' ')}`);

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }

  /* write — project, version, areas, links, driver, assignments */
  const project = await Project.create({
    name: PROJECT_NAME, code: PROJECT_CODE, country: 'India',
    enabledModules: ['dashboard', 'map'], coverageScopeId: SCOPE_ID,
  });
  const version = await NetworkVersion.create({
    projectId: project._id, label: 'OSM Hyderabad — GHMC wards (test seed)', status: 'building',
  });
  let committed = false;
  try {
    const areaRows = wards.map((w, i) => ({
      projectId: project._id, networkVersionId: version._id, areaCode: w.code, name: w.name,
      parentName: w.circle, priority: 1, geometry: w.geometry,
      outline: simplifyGeometry(w.geometry, OUTLINE_TOLERANCE_M), bbox: w.bbox,
      areaSqm: Math.round(w.areaSqm), targetMeters: perWard[i].meters, targetLinks: perWard[i].links,
      props: { source: 'opencity-ghmc-wards-2022', roads: 'osm-geofabrik' },
    }));
    const areaIds = new Array(wards.length).fill(null);
    let areaRejects = 0;
    for (let i = 0; i < areaRows.length; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        areaIds[i] = (await WorkArea.create(areaRows[i]))._id;
      } catch (e) {
        areaRejects++;
        console.log(`  ! ward ${wards[i].name} rejected: ${e.message.slice(0, 140)}`);
      }
    }

    let written = 0; let linkRejects = 0; let batch = [];
    const funcTally = new Map();
    let totalMeters = 0;
    const flush = async () => {
      if (!batch.length) return;
      try {
        const res = await RoadLink.insertMany(batch, { ordered: false });
        written += res.length;
      } catch (e) {
        const ok = e.insertedDocs ? e.insertedDocs.length : (e.result?.insertedCount ?? 0);
        written += ok;
        linkRejects += batch.length - ok;
      }
      batch = [];
      process.stdout.write(`\r  links written ${written.toLocaleString()}`);
    };
    for (const l of links) {
      const areaId = areaIds[l.wi];
      if (!areaId) continue;
      totalMeters += l.metres;
      const t = funcTally.get(l.funcClass) || { links: 0, meters: 0 };
      t.links++; t.meters += l.metres; funcTally.set(l.funcClass, t);
      batch.push({
        projectId: project._id, networkVersionId: version._id, linkId: l.linkId, name: l.name,
        funcClass: l.funcClass, dirTravel: l.dirTravel, autoAccess: true,
        areaId, areaCode: wards[l.wi].code, priority: 1,
        geometry: { type: 'LineString', coordinates: l.coords }, lengthMeters: l.metres,
      });
      // eslint-disable-next-line no-await-in-loop
      if (batch.length >= INSERT_BATCH) await flush();
    }
    await flush();
    console.log('');

    version.status = 'active';
    version.activatedAt = new Date();
    version.counts = { areas: areaIds.filter(Boolean).length, links: written, orphanLinks: 0 };
    version.targetMeters = totalMeters;
    version.orphanMeters = 0;
    version.byPriority = [{
      priority: 1, areas: areaIds.filter(Boolean).length, links: written, meters: totalMeters,
    }];
    version.byFuncClass = [...funcTally.entries()]
      .map(([funcClass, r]) => ({ funcClass, links: r.links, meters: r.meters }))
      .sort((a, b) => a.funcClass - b.funcClass);
    await version.save();
    committed = true;
    console.log(`areas written: ${areaIds.filter(Boolean).length} (${areaRejects} rejected), links: ${written.toLocaleString()} (${linkRejects} rejected)`);

    /* the test driver */
    const password = crypto.randomBytes(6).toString('base64url');
    const driver = new User({
      name: DRIVER_NAME, email: DRIVER_EMAIL, role: 'user', projectIds: [project._id],
      project: PROJECT_NAME, country: 'India', timezone: 'Asia/Kolkata',
    });
    await driver.setPassword(password);
    await driver.save();

    let assignedCount = 0;
    for (const i of assigned) {
      if (!areaIds[i]) continue;
      // eslint-disable-next-line no-await-in-loop
      await AreaAssignment.create({
        projectId: project._id, networkVersionId: version._id, areaId: areaIds[i],
        driverId: driver._id, areaName: wards[i].name, areaCode: wards[i].code,
        driverName: DRIVER_NAME, assignedBy: null, assignedAt: new Date(),
      });
      assignedCount++;
    }

    console.log(`\nproject   : ${PROJECT_NAME} (${project._id}), coverage scope '${SCOPE_ID}'`);
    console.log(`driver    : ${DRIVER_EMAIL}`);
    console.log(`password  : ${password}`);
    console.log(`assigned  : ${assignedCount} wards`);
  } catch (err) {
    if (!committed) {
      // A half-built network is worse than none.
      await RoadLink.deleteMany({ networkVersionId: version._id }).catch(() => {});
      await WorkArea.deleteMany({ networkVersionId: version._id }).catch(() => {});
      await NetworkVersion.deleteOne({ _id: version._id }).catch(() => {});
      await Project.deleteOne({ _id: project._id }).catch(() => {});
    }
    throw err;
  }
}

(async () => {
  const mongoose = require('mongoose');
  await connectDB();
  try {
    console.log(`mode: ${APPLY ? 'APPLY — will write' : 'DRY RUN — reads only'}${REVERT ? ' (revert)' : ''}\n`);
    if (REVERT) await revert(); else await seed();
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error('\nERROR:', e.message);
  process.exit(1);
});
