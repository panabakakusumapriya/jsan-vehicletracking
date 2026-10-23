/**
 * One-time clean-up: every stored country becomes its one spelling (utils/country.js), so "AU" and
 * "Australia" (and "FR"/"France", "SE"/"Sweden", "NZ"/"New Zealand", "india") stop showing as two
 * countries in every filter. New writes are normalised by the models' setter; this fixes what is
 * already stored, in users, vehicles, mobile devices and projects.
 *
 * DRY RUN unless --apply. Each change (collection, old value, new value, the ids changed) is
 * recorded in `countrynormalizations` under one batch, and --undo=<batch> puts the old values back.
 *
 * Usage
 *   node src/seed/normalizeCountries.js [--apply]
 *   node src/seed/normalizeCountries.js --undo=<countries-…> --apply
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');
const { normalizeCountry } = require('../utils/country');

const args = new Map(process.argv.slice(2).map((a) => { const [k, ...r] = a.replace(/^--/, '').split('='); return [k, r.length ? r.join('=') : true]; }));
const APPLY = args.get('apply') === true;
const COLLECTIONS = ['users', 'vehicles', 'mobiledevices', 'projects'];
const log = (...a) => console.log(...a);

async function main() {
  await connectDB();
  const db = require('mongoose').connection.db;
  if (args.has('undo')) {
    const rec = await db.collection('countrynormalizations').findOne({ batch: String(args.get('undo')) });
    if (!rec) throw new Error(`No batch ${args.get('undo')}`);
    log(`Undo ${rec.batch}: ${rec.changes.reduce((n, c) => n + c.ids.length, 0)} documents`);
    if (!APPLY) return log('Dry run — add --apply.');
    for (const c of rec.changes) await db.collection(c.collection).updateMany({ _id: { $in: c.ids } }, { $set: { country: c.from } });
    await db.collection('countrynormalizations').deleteOne({ _id: rec._id });
    return log('Restored.');
  }

  const changes = [];
  for (const col of COLLECTIONS) {
    const values = await db.collection(col).distinct('country');
    for (const from of values) {
      if (from == null) continue;
      const to = normalizeCountry(from);
      if (to === from) continue;
      const ids = await db.collection(col).distinct('_id', { country: from });
      changes.push({ collection: col, from, to, ids });
    }
  }
  if (!changes.length) return log('Every stored country already has its one spelling. Nothing to do.');
  for (const c of changes) log(`${c.collection.padEnd(14)} ${JSON.stringify(c.from).padEnd(14)} → ${JSON.stringify(c.to).padEnd(16)} ${c.ids.length}`);
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');

  const batch = `countries-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  await db.collection('countrynormalizations').insertOne({ batch, at: new Date(), changes });
  for (const c of changes) await db.collection(c.collection).updateMany({ _id: { $in: c.ids } }, { $set: { country: c.to } });
  log(`\nDone: ${changes.reduce((n, c) => n + c.ids.length, 0)} documents (batch ${batch}). Undo: node src/seed/normalizeCountries.js --undo=${batch} --apply`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
