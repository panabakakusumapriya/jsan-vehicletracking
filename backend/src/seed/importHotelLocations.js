/**
 * Import the worldwide hotel CSV into the HotelLocation collection.
 *
 *   npm run import:hotels -- --dry-run            parse and validate, write NOTHING
 *   npm run import:hotels                         import ../../hotels_worldwide.csv
 *   npm run import:hotels -- --file path/to.csv
 *   npm run import:hotels -- --limit 50000        stop after N rows (a quick partial load)
 *
 * ADDITIVE AND IDEMPOTENT. Every row is an upsert keyed on Overture's own `overture_id`, so
 * running this twice leaves ~1.05 million documents rather than 2.1 million, and a corrected
 * re-delivery updates rows in place. It writes to exactly one collection — HotelLocation — and
 * never deletes anything, in that collection or any other.
 *
 * Why it parses the CSV itself
 * ----------------------------
 * The delivery is 1.03 GB across 1,048,584 rows, and four of its nineteen columns
 * (`all_addresses`, `all_websites`, `all_phones`, `sources`) are JSON blobs that account for the
 * overwhelming majority of those bytes. None of them are stored. So the parser:
 *
 *   - streams a line at a time, never materialising the file (JSON.parse-the-lot is not an option
 *     at this size, and neither is readFileSync);
 *   - stops splitting a row once it has the fifteen columns that are kept, which skips most of
 *     each line's bytes rather than building strings that are immediately discarded;
 *   - still tracks quoting properly, because those JSON blobs are full of commas and escaped
 *     quotes and a naive split(',') would shred every row that has one.
 *
 * A record may legally span lines if a quoted field contains a newline. Quote PARITY detects it:
 * inside a correct CSV every record contains an even number of `"` characters, escapes included,
 * so an odd count means the record continues on the next line.
 *
 * Bad coordinates are rejected, not clamped
 * -----------------------------------------
 * A single out-of-range coordinate makes the 2dsphere index build fail for the entire collection,
 * so anything outside [-180,180]/[-90,90] is skipped and counted. Silently clamping it would put
 * a hotel in the wrong hemisphere and nothing downstream would ever question it.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const HotelLocation = require('../models/HotelLocation');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i !== -1 ? argv[i + 1] : null;
};

const dryRun = has('--dry-run');
const limit = parseInt(valueOf('--limit') || '0', 10) || Infinity;
const file = path.resolve(valueOf('--file') || path.join(__dirname, '../../../hotels_worldwide.csv'));
const BATCH = 2000;
const PROGRESS_EVERY = 50_000;

const log = (...a) => console.log(...a);

/** The columns that are kept, in the order the file declares them. */
const COLUMNS = [
  'overture_id', 'hotel_name', 'category', 'basic_category', 'latitude', 'longitude',
  'address', 'city', 'state_or_region', 'postal_code', 'country_code',
  'website', 'phone', 'email', 'confidence',
];

function countQuotes(s) {
  let n = 0;
  for (let i = s.indexOf('"'); i !== -1; i = s.indexOf('"', i + 1)) n += 1;
  return n;
}

/**
 * Split one CSV record into at most `max` fields, honouring quotes and `""` escapes.
 * Everything past `max` is skipped without being copied — the point of the exercise.
 */
function splitCsv(line, max) {
  const out = [];
  let field = '';
  let inQuotes = false;
  let quotePending = false; // saw a `"` inside quotes; the next char decides what it meant

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (quotePending) {
      quotePending = false;
      if (c === '"') { field += '"'; continue; } // an escaped quote
      inQuotes = false;                           // the field ended; fall through and re-read c
    }

    if (inQuotes) {
      if (c === '"') quotePending = true;
      else field += c;
      continue;
    }

    if (c === '"' && field === '') { inQuotes = true; continue; }
    if (c === ',') {
      out.push(field);
      field = '';
      if (out.length >= max) return out; // the rest of the line is blobs we do not store
      continue;
    }
    if (c === '\r') continue;
    field += c;
  }
  out.push(field);
  return out;
}

const str = (v) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length ? t : null;
};

/** One CSV record -> a HotelLocation document, or an error describing why not. */
function toDoc(values, index, sourceFile) {
  const get = (name) => values[index[name]];

  const sourceId = str(get('overture_id'));
  if (!sourceId) return { error: 'missing overture_id' };

  if (!str(get('latitude')) || !str(get('longitude'))) return { error: 'missing coordinates' };
  const lat = Number(get('latitude'));
  const lon = Number(get('longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { error: 'non-numeric coordinates' };
  // The 2dsphere index rejects the whole collection over one of these, so they never get stored.
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) return { error: 'coordinates out of range' };

  const confidence = Number(get('confidence'));
  const country = str(get('country_code'));

  return {
    doc: {
      sourceId,
      name: str(get('hotel_name')),
      category: str(get('category')),
      basicCategory: str(get('basic_category')),
      confidence: str(get('confidence')) && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null,
      phone: str(get('phone')),
      website: str(get('website')),
      email: str(get('email')),
      address: str(get('address')),
      city: str(get('city')),
      stateOrRegion: str(get('state_or_region')),
      postalCode: str(get('postal_code')),
      isoCountry: country ? country.toUpperCase() : null,
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
  log(`Reading ${sourceFile} (${sizeMb} MB)${limit !== Infinity ? `, first ${limit.toLocaleString()} rows` : ''}`);

  if (!dryRun) await connectDB();

  const stats = { seen: 0, valid: 0, skipped: 0, written: 0, reasons: {} };
  const byCountry = new Map();
  const byCategory = new Map();
  let pending = [];
  let index = null; // header name -> column position
  const startedAt = Date.now();

  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) {
      // Upsert on sourceId: re-importing the same delivery updates rather than duplicates.
      await HotelLocation.bulkWrite(
        pending.map((d) => ({
          updateOne: { filter: { sourceId: d.sourceId }, update: { $set: d }, upsert: true },
        })),
        { ordered: false }
      );
    }
    stats.written += pending.length;
    pending = [];
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let carry = '';       // a record whose quotes have not balanced yet
  let carryQuotes = 0;

  for await (const raw of rl) {
    let record;
    if (carry) {
      carry += `\n${raw}`;
      carryQuotes += countQuotes(raw);
      if (carryQuotes % 2 !== 0) continue; // still inside a quoted field
      record = carry;
      carry = '';
      carryQuotes = 0;
    } else {
      const q = countQuotes(raw);
      if (q % 2 !== 0) { carry = raw; carryQuotes = q; continue; }
      record = raw;
    }
    if (!record.trim()) continue;

    if (!index) {
      const header = splitCsv(record, 64).map((h) => h.trim().replace(/^﻿/, ''));
      index = {};
      header.forEach((h, i) => { index[h] = i; });
      const missing = COLUMNS.filter((c) => index[c] === undefined);
      if (missing.length) {
        log(`Header is missing expected column(s): ${missing.join(', ')}`);
        log(`Found: ${header.join(', ')}`);
        process.exit(1);
      }
      continue;
    }

    stats.seen += 1;
    // Only the kept columns are split out; the JSON blobs after them are never copied.
    const keep = Math.max(...COLUMNS.map((c) => index[c])) + 1;
    const { doc, error } = toDoc(splitCsv(record, keep), index, sourceFile);
    if (error) {
      stats.skipped += 1;
      stats.reasons[error] = (stats.reasons[error] || 0) + 1;
    } else {
      stats.valid += 1;
      const k = doc.isoCountry || '(none)';
      byCountry.set(k, (byCountry.get(k) || 0) + 1);
      const c = doc.category || '(none)';
      byCategory.set(c, (byCategory.get(c) || 0) + 1);
      pending.push(doc);
      if (pending.length >= BATCH) await flush();
    }

    if (stats.seen % PROGRESS_EVERY === 0) {
      const secs = (Date.now() - startedAt) / 1000;
      log(`  ${stats.seen.toLocaleString()} rows · ${stats.valid.toLocaleString()} valid · ${Math.round(stats.seen / secs).toLocaleString()}/s`);
    }
    if (stats.seen >= limit) break;
  }
  rl.close();
  await flush();

  if (carry) log(`  Warning: the file ended inside an unclosed quoted field; the last partial record was dropped.`);

  log(`\nParsed ${stats.seen.toLocaleString()} row(s) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  log(`  valid    ${stats.valid.toLocaleString()}`);
  log(`  skipped  ${stats.skipped.toLocaleString()}`);
  for (const [reason, n] of Object.entries(stats.reasons)) log(`    ${reason}: ${n.toLocaleString()}`);

  const topCountries = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  log(`\n  ${byCountry.size} countries. Top: ${topCountries.map(([c, n]) => `${c}=${n.toLocaleString()}`).join('  ')}`);
  const topCategories = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  log(`  ${byCategory.size} categories. Top: ${topCategories.map(([c, n]) => `${c}=${n.toLocaleString()}`).join('  ')}`);

  if (dryRun) {
    log('\n--dry-run: nothing was written. No database connection was even opened.');
    return;
  }

  log(`\nUpserted ${stats.written.toLocaleString()} document(s) into HotelLocation.`);

  // Build the indexes explicitly rather than leaving it to Mongoose's background autoIndex, so a
  // failure (an out-of-range coordinate that slipped through) surfaces here instead of as a
  // mysteriously slow query weeks later. Over a million points this takes a while.
  log('Building indexes (a 2dsphere over ~1M points is not instant)…');
  await HotelLocation.createIndexes();

  const total = await HotelLocation.estimatedDocumentCount();
  log(`\nHotelLocation now holds ${total.toLocaleString()} document(s).`);
  log('Nothing else in the database was touched — this script writes to one collection and deletes nothing.');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('importHotelLocations failed:', err);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
