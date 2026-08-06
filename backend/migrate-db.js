/**
 * Migrate all collections from old Atlas DB to new Railway MongoDB.
 * Usage: node migrate-db.js
 */
const { MongoClient } = require('mongodb');

const OLD_URI = 'mongodb://panabakakusumapriya_db_user:krishna@ac-7wtfdvt-shard-00-00.okk92oh.mongodb.net:27017,ac-7wtfdvt-shard-00-01.okk92oh.mongodb.net:27017,ac-7wtfdvt-shard-00-02.okk92oh.mongodb.net:27017/jsan_tracking?ssl=true&replicaSet=atlas-gfkjyk-shard-0&authSource=admin&retryWrites=true&w=majority&appName=Cluster0';
const NEW_URI = 'mongodb://mongo:CEeeazekNTlmTvkOSOPVIDCCMdQzxivQ@altaria.proxy.rlwy.net:31582';

const BATCH = 1000;

async function migrate() {
  const oldClient = new MongoClient(OLD_URI);
  const newClient = new MongoClient(NEW_URI);

  try {
    await oldClient.connect();
    console.log('✅ Connected to OLD (Atlas)');
    await newClient.connect();
    console.log('✅ Connected to NEW (Railway)');

    const oldDb = oldClient.db('jsan_tracking');
    const newDb = newClient.db('jsan_tracking');

    const collections = await oldDb.listCollections().toArray();
    console.log(`\nFound ${collections.length} collections to migrate:\n`);

    for (const col of collections) {
      const name = col.name;
      const oldCol = oldDb.collection(name);
      const newCol = newDb.collection(name);
      const count = await oldCol.countDocuments();

      if (count === 0) {
        console.log(`  ⏭  ${name}: 0 docs — skipped`);
        continue;
      }

      // Drop existing in new DB to avoid duplicates
      try { await newCol.drop(); } catch (_) { /* doesn't exist yet */ }

      let migrated = 0;
      const cursor = oldCol.find({});

      while (true) {
        const batch = [];
        for (let i = 0; i < BATCH; i++) {
          const doc = await cursor.next();
          if (!doc) break;
          batch.push(doc);
        }
        if (batch.length === 0) break;
        await newCol.insertMany(batch, { ordered: false });
        migrated += batch.length;
        if (migrated % 10000 === 0 || migrated === count) {
          process.stdout.write(`  📦 ${name}: ${migrated}/${count}\r`);
        }
      }

      console.log(`  ✅ ${name}: ${migrated} docs migrated`);

      // Copy indexes
      const indexes = await oldCol.indexes();
      for (const idx of indexes) {
        if (idx.name === '_id_') continue;
        try {
          const { key, ...opts } = idx;
          delete opts.v;
          delete opts.ns;
          await newCol.createIndex(key, opts);
        } catch (e) {
          console.log(`     ⚠  index ${idx.name} on ${name}: ${e.message}`);
        }
      }
    }

    console.log('\n🎉 Migration complete!');
  } finally {
    await oldClient.close();
    await newClient.close();
  }
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
