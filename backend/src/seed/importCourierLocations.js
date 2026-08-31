/**
 * Import a world courier/delivery-point GeoJSON into the CourierLocation collection.
 *
 *   npm run import:couriers -- --dry-run              parse and validate, write NOTHING
 *   npm run import:couriers                           import ../../carriers_world.geojson
 *   npm run import:couriers -- --file path/to.geojson
 *
 * ADDITIVE AND IDEMPOTENT. Every row is an upsert keyed on the provider's own `sourceId`, so
 * running this twice leaves 67,960 documents rather than 135,920, and a corrected re-delivery of
 * the same file updates rows in place. It writes to exactly one collection — CourierLocation —
 * and never deletes anything, in that collection or any other.
 *
 * Why it streams instead of JSON.parse'ing the file
 * -------------------------------------------------
 * The delivery is 40 MB. `JSON.parse` on that materialises the whole document AND the whole object
 * graph at once — comfortably over a default heap on a small dyno, and pointless besides: the file
 * is a FeatureCollection whose `features` array has one complete feature per line, so it can be
 * read a line at a time at constant memory. That layout is not guaranteed by the GeoJSON spec, so
 * the reader falls back to buffering if it turns out not to hold, and says so rather than silently
 * importing a fraction of the file.
 *
 * Bad coordinates are rejected, not clamped
 * -----------------------------------------
 * A single out-of-range coordinate makes the 2dsphere index build fail for the entire collection,
 * so anything outside [-180,180]/[-90,90] is skipped and counted. Silently clamping it would put a
 * courier depot in the wrong hemisphere and nothing downstream would ever question it.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const CourierLocation = require('../models/CourierLocation');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : null;
};

const dryRun = has('--dry-run');
const file = path.resolve(
  valueOf('--file') || path.join(__dirname, '../../../carriers_world.geojson')
);
const BATCH = 1000;

const log = (...a) => console.log(...a);

/** A GeoJSON Feature -> a CourierLocation document, or null with a reason. */
function toDoc(feature, sourceFile) {
  const p = feature.properties || {};
  if (!p.id) return { error: 'missing id' };

  const coords = feature.geometry && feature.geometry.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return { error: 'missing geometry' };
  const [lon, lat] = coords.map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { error: 'non-numeric coordinates' };
  // The 2dsphere index rejects the whole collection over one of these, so they never get stored.
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return { error: 'coordinates out of range' };

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    doc: {
      sourceId: String(p.id),
      name: str(p.name),
      brand: str(p.brand),
      category: str(p.category),
      basicCategory: str(p.basic_category),
      confidence: Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : null,
      phone: str(p.phone),
      website: str(p.website),
      address: str(p.address),
      isoCountry: str(p.iso_country),
      addrCountry: str(p.addr_country),
      continent: str(p.continent),
      location: { type: 'Point', coordinates: [lon, lat] },
      sourceFile,
    },
  };
}

(async () => {
  if (!fs.existsSync(file)) {
    log(`File not found: ${file}`);
    log('Pass --file <path> to point at it.');
    process.exit(1);
  }
  const sourceFile = path.basename(file);
  const sizeMb = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
  log(`Reading ${sourceFile} (${sizeMb} MB)`);

  if (!dryRun) await connectDB();

  const stats = { seen: 0, valid: 0, skipped: 0, written: 0, reasons: {} };
  const byCountry = new Map();
  let pending = [];

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      // Upsert on sourceId: re-importing the same delivery updates rather than duplicates.
      await CourierLocation.bulkWrite(
        pending.map((d) => ({
          updateOne: { filter: { sourceId: d.sourceId }, update: { $set: d }, upsert: true },
        })),
        { ordered: false }
      );
    }
    stats.written += pending.length;
    pending = [];
    if (stats.written % 10000 === 0) log(`  ${stats.written.toLocaleString()} / ~67,960`);
  };

  const handle = async (feature) => {
    stats.seen += 1;
    const { doc, error } = toDoc(feature, sourceFile);
    if (error) {
      stats.skipped += 1;
      stats.reasons[error] = (stats.reasons[error] || 0) + 1;
      return;
    }
    stats.valid += 1;
    byCountry.set(doc.isoCountry || '(none)', (byCountry.get(doc.isoCountry || '(none)') || 0) + 1);
    pending.push(doc);
    if (pending.length >= BATCH) await flush();
  };

  // Fast path: one complete Feature per line, which is how ogr2ogr and most exporters write a
  // FeatureCollection. Constant memory regardless of file size.
  let linesLookedLikeFeatures = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim().replace(/,$/, '');
    if (!t.startsWith('{') || !t.includes('"Feature"')) continue;
    linesLookedLikeFeatures += 1;
    let feature;
    try {
      feature = JSON.parse(t);
    } catch {
      stats.skipped += 1;
      stats.reasons['unparsable line'] = (stats.reasons['unparsable line'] || 0) + 1;
      continue;
    }
    await handle(feature);
  }
  await flush();

  // The layout assumption did not hold — the file is valid GeoJSON but not line-per-feature. Say
  // so and parse it properly rather than reporting a successful import of nothing.
  if (linesLookedLikeFeatures === 0) {
    log('  Not line-delimited; falling back to a whole-file parse (needs more memory).');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const feature of parsed.features || []) await handle(feature);
    await flush();
  }

  log(`\nParsed ${stats.seen.toLocaleString()} feature(s)`);
  log(`  valid    ${stats.valid.toLocaleString()}`);
  log(`  skipped  ${stats.skipped.toLocaleString()}`);
  for (const [reason, n] of Object.entries(stats.reasons)) log(`    ${reason}: ${n}`);

  const top = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  log(`\n  ${byCountry.size} countries. Top: ${top.map(([c, n]) => `${c}=${n.toLocaleString()}`).join('  ')}`);

  if (dryRun) {
    log('\n--dry-run: nothing was written. No database connection was even opened.');
    return;
  }

  log(`\nUpserted ${stats.written.toLocaleString()} document(s) into CourierLocation.`);

  // Build the indexes explicitly rather than leaving it to Mongoose's background autoIndex, so a
  // failure (an out-of-range coordinate that slipped through) surfaces here instead of as a
  // mysteriously slow query weeks later.
  log('Building indexes (2dsphere over 68k points takes a moment)…');
  await CourierLocation.syncIndexes();

  const total = await CourierLocation.estimatedDocumentCount();
  log(`\nCourierLocation now holds ${total.toLocaleString()} document(s).`);
  log('Nothing else in the database was touched — this script writes to one collection and deletes nothing.');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('importCourierLocations failed:', err);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
