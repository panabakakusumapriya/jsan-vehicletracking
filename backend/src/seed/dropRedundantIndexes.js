/**
 * Remove indexes that are strict prefixes of another index, and therefore pure overhead.
 *
 *   node src/seed/dropRedundantIndexes.js --dry-run   report only
 *   node src/seed/dropRedundantIndexes.js             apply
 *
 * Needed as a separate step because Mongoose only ever CREATES indexes from the schema — removing
 * a declaration leaves the existing index in place on the database, silently costing storage and
 * a write on every insert forever. (`syncIndexes()` would drop them, but it drops anything not in
 * the schema, which is too blunt to point at a live database.)
 *
 * Safe: every index dropped here is a prefix of one that remains, so no query loses its support.
 * Dropping is also reversible — the index can be rebuilt from the schema at any time.
 */
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');

const dryRun = process.argv.includes('--dry-run');

// name -> the index that already covers it
const REDUNDANT = {
  locationpoints: {
    tripId_1: 'tripId_1_recordedAt_1 (same leading field)',
  },
  ukmedges: {
    driverId_1: 'ukm_driver_edge_dist (same leading field)',
  },
};

(async () => {
  await connectDB();
  const db = mongoose.connection.db;
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

  for (const [collection, drops] of Object.entries(REDUNDANT)) {
    let stats;
    try {
      stats = await db.command({ collStats: collection });
    } catch {
      console.log(`${collection}: not present, skipping`);
      continue;
    }
    const existing = await db.collection(collection).indexes();
    const sizes = stats.indexSizes || {};
    console.log(`\n${collection} — total index size ${mb(stats.totalIndexSize)}`);

    for (const [name, coveredBy] of Object.entries(drops)) {
      const found = existing.find((i) => i.name === name);
      if (!found) {
        console.log(`  ${name}: already gone`);
        continue;
      }
      // Never drop something that is carrying a constraint, whatever the config says.
      if (found.unique) {
        console.log(`  ${name}: SKIPPED — it is unique, so it enforces a constraint`);
        continue;
      }
      const covering = existing.find((i) => i.name === coveredBy.split(' ')[0]);
      if (!covering) {
        console.log(`  ${name}: SKIPPED — the index that should cover it (${coveredBy}) does not exist yet`);
        continue;
      }
      console.log(`  ${name}: ${mb(sizes[name] || 0)}, covered by ${coveredBy}${dryRun ? ' (dry run)' : ''}`);
      if (!dryRun) {
        await db.collection(collection).dropIndex(name);
        console.log(`    dropped`);
      }
    }

    if (!dryRun) {
      const after = await db.command({ collStats: collection });
      console.log(`  total index size now ${mb(after.totalIndexSize)}`);
    }
  }

  if (dryRun) console.log('\n--dry-run: nothing dropped.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error('dropRedundantIndexes failed:', err);
  process.exit(1);
});
