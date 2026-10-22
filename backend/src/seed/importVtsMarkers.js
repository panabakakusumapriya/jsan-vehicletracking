/**
 * Import the markers drivers dropped on the old VTS app (jsanvtsnew) as markers here.
 *
 * VTS keeps them in its `custommarkers` collection: who (driver, session), where, when
 * (`timestamp`), and a colour — red, yellow, blue or green — with no category set and no note.
 * (Their `endTime` is just the session's end, stamped on every marker of it; it is not how long
 * anything lasted, so it is not carried over.) Each colour becomes the category of the same colour
 * here: red → Red Flag, yellow → Yellow Marker, blue → Blue Marker, green → Green Marker (created
 * if missing). A marker with no colour is red, VTS's default.
 *
 * Each marker is tied to its driver by email (drivers with no account here are skipped and
 * listed — the session import's --create-missing-drivers makes them), stamped with that driver's
 * name and the session's plate as markers are, and linked to a trip: the trip imported from the
 * same VTS session, else the driver's trip that was under way at that moment.
 *
 * Read-only on VTS: the connection string comes from VTS_MONGODB_URI and is used for queries only.
 *
 * Safety
 *   - DRY RUN unless --apply.
 *   - clientId "vts:<markerId>" is unique here, so a re-run skips what is already in; every
 *     marker of a run carries one importBatchId ("vtsmarkers-…") and --revert=<batch> removes them.
 *
 * Usage
 *   VTS_MONGODB_URI=… node src/seed/importVtsMarkers.js [--apply]
 *   node src/seed/importVtsMarkers.js --revert=<vtsmarkers-…> --apply
 *   Options: --project="PRJ-025-HE-DRIVE-AUSGNZ"  --vts-project=6a3233e935b68ccdc47a9785
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const PROJECT_NAME = String(args.get('project') || 'PRJ-025-HE-DRIVE-AUSGNZ');
const VTS_PROJECT = String(args.get('vts-project') || '6a3233e935b68ccdc47a9785'); // "projaustralia"
const APPLY = args.get('apply') === true;
const REVERT = args.has('revert') ? String(args.get('revert')) : null;
const TEST_EMAILS = new Set(['autest@vts.com', 'projaus@gmail.com']);
// A trip "under way at that moment" may have ended a few minutes before the press was synced.
const TRIP_SLACK_MS = 10 * 60 * 1000;
const log = (...a) => console.log(...a);

// VTS colour → the category of the same colour here.
const COLOURS = {
  red: { name: 'Red Flag', color: '#ef4444' },
  yellow: { name: 'Yellow Marker', color: '#fbbc04' },
  blue: { name: 'Blue Marker', color: '#4285f4' },
  green: { name: 'Green Marker', color: '#34a853' },
};

async function revert(batch) {
  const Marker = require('../models/Marker');
  const n = await Marker.countDocuments({ importBatchId: batch });
  log(`Batch ${batch}: ${n} markers`);
  if (!APPLY) return log('Dry run — add --apply to remove them.');
  const r = await Marker.deleteMany({ importBatchId: batch });
  log(`Removed ${r.deletedCount} markers.`);
}

async function main() {
  await connectDB();
  if (REVERT) return revert(REVERT);
  if (!process.env.VTS_MONGODB_URI) throw new Error('VTS_MONGODB_URI is required (read-only VTS database)');

  const mongoose = require('mongoose');
  const { MongoClient, ObjectId } = mongoose.mongo;
  const Project = require('../models/Project');
  const User = require('../models/User');
  const Trip = require('../models/Trip');
  const Marker = require('../models/Marker');
  const MarkerCategory = require('../models/MarkerCategory');

  const project = await Project.findOne({ name: PROJECT_NAME }).select('_id').lean();
  if (!project) throw new Error(`No project named ${PROJECT_NAME}`);

  const vtsClient = new MongoClient(process.env.VTS_MONGODB_URI, { readPreference: 'secondaryPreferred' });
  await vtsClient.connect();
  const vts = vtsClient.db();
  try {
    const vtsUsers = await vts.collection('users').find({ project: new ObjectId(VTS_PROJECT) }, { projection: { name: 1, email: 1 } }).toArray();
    const vtsUserById = new Map(vtsUsers.map((u) => [String(u._id), u]));
    const markers = await vts.collection('custommarkers')
      .find({ driver: { $in: vtsUsers.map((u) => u._id) } }, { projection: { driver: 1, session: 1, latitude: 1, longitude: 1, color: 1, timestamp: 1 } })
      .sort({ timestamp: 1 })
      .toArray();
    const sessions = new Map(
      (await vts.collection('sessions').find({ _id: { $in: [...new Set(markers.map((m) => String(m.session)))].map((id) => new ObjectId(id)) } }, { projection: { licensePlate: 1 } }).toArray())
        .map((s) => [String(s._id), s])
    );
    log(`VTS markers by projaustralia drivers: ${markers.length.toLocaleString()}`);

    const users = await User.find({ role: 'user' }).select('_id name email').lean();
    const userByEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));
    const already = new Set((await Marker.find({ clientId: /^vts:/ }).select('clientId -_id').lean()).map((m) => m.clientId));

    // Trips imported from VTS sessions, by session id.
    const tripBySession = new Map(
      (await Trip.find({ importSourceId: { $in: [...sessions.keys()].map((id) => `vts:${id}`) } }).select('_id importSourceId').lean())
        .map((t) => [t.importSourceId.slice(4), t._id])
    );

    const stats = { already: 0, test: 0, noAccount: 0, toImport: 0, linkedSession: 0, linkedOverlap: 0, noTrip: 0 };
    const missing = new Map();
    const byColour = {};
    const plan = [];
    const tripCache = new Map(); // driverId -> trips sorted by start
    const tripsOf = async (driverId) => {
      if (!tripCache.has(String(driverId))) {
        tripCache.set(String(driverId), await Trip.find({ driverId, parkedJitter: { $ne: true } }).select('_id startedAt endedAt').sort({ startedAt: 1 }).lean());
      }
      return tripCache.get(String(driverId));
    };

    for (const m of markers) {
      const clientId = `vts:${m._id}`;
      if (already.has(clientId)) { stats.already++; continue; }
      const vu = vtsUserById.get(String(m.driver));
      const email = String(vu?.email || '').toLowerCase();
      if (TEST_EMAILS.has(email)) { stats.test++; continue; }
      const user = userByEmail.get(email);
      if (!user) {
        stats.noAccount++;
        const k = `${vu?.name || '?'} <${email || m.driver}>`;
        missing.set(k, (missing.get(k) || 0) + 1);
        continue;
      }
      const at = new Date(m.timestamp);
      let tripId = tripBySession.get(String(m.session)) || null;
      if (tripId) stats.linkedSession++;
      else {
        const hit = (await tripsOf(user._id)).find((t) => at >= new Date(t.startedAt) && at <= new Date((t.endedAt ? new Date(t.endedAt) : at).getTime() + TRIP_SLACK_MS));
        if (hit) { tripId = hit._id; stats.linkedOverlap++; } else stats.noTrip++;
      }
      const colour = COLOURS[String(m.color || 'red').toLowerCase()] ? String(m.color || 'red').toLowerCase() : 'red';
      byColour[colour] = (byColour[colour] || 0) + 1;
      plan.push({
        clientId, colour, tripId,
        driverId: user._id, driverName: user.name,
        vehiclePlate: sessions.get(String(m.session))?.licensePlate || null,
        lat: m.latitude, lon: m.longitude, recordedAt: at,
      });
      stats.toImport++;
    }

    log(stats);
    log('By colour:', byColour);
    if (missing.size) {
      log('VTS drivers with no account here (skipped — run the session import with --create-missing-drivers first):');
      for (const [k, n] of missing) log(`  ${k}  ${n} markers`);
    }
    if (plan.length) log(`Dates ${plan[0].recordedAt.toISOString().slice(0, 10)} → ${plan.at(-1).recordedAt.toISOString().slice(0, 10)}`);
    if (!APPLY) return log(`\nDry run — nothing written. ${plan.length.toLocaleString()} markers would be imported. Add --apply.`);
    if (!plan.length) return log('Nothing to import.');

    // Categories of the same colours, matched by name, made when missing (Green Marker).
    const categoryOf = {};
    for (const colour of new Set(plan.map((p) => p.colour))) {
      const want = COLOURS[colour];
      let cat = await MarkerCategory.findOne({ name: want.name }).select('_id').lean();
      if (!cat) {
        const last = await MarkerCategory.findOne().sort({ order: -1 }).select('order').lean();
        cat = await MarkerCategory.create({ name: want.name, color: want.color, order: (last?.order || 0) + 1 });
        log(`Created category ${want.name} (${want.color})`);
      }
      categoryOf[colour] = cat._id;
    }

    const batch = `vtsmarkers-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
    log(`Importing ${plan.length.toLocaleString()} markers as batch ${batch}`);
    let written = 0;
    for (let i = 0; i < plan.length; i += 500) {
      const ops = plan.slice(i, i + 500).map(({ colour, ...p }) => ({
        updateOne: {
          filter: { clientId: p.clientId },
          update: { $setOnInsert: { ...p, categoryId: categoryOf[colour], note: null, importBatchId: batch } },
          upsert: true,
        },
      }));
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await Marker.bulkWrite(ops, { ordered: false });
          written += r.upsertedCount;
          break;
        } catch (err) {
          if (attempt >= 5) throw err;
          log(`  retry ${attempt}: ${err.message}`);
          await new Promise((r) => setTimeout(r, 4000 * attempt));
        }
      }
      log(`  ${Math.min(i + 500, plan.length)}/${plan.length}`);
    }
    log(`\nDone: ${written.toLocaleString()} markers written. Undo: node src/seed/importVtsMarkers.js --revert=${batch} --apply`);
  } finally {
    await vtsClient.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
