/**
 * Merge a duplicate driver login into the driver's real account, then remove the duplicate.
 *
 * For when a second login is created for a driver who already has one (2026-10-23: "Samsun",
 * gachunusam@jsan.com, made by mistake for Samson Gachunu, gachunusam@gmail.com). Everything the
 * duplicate owns moves to the real account:
 *   trips and their GPS points, markers (with the real account's name stamped), app activity,
 *   live area assignments (released instead when the real account already holds that area),
 *   road-credit ownership (LinkCoverage / CoverageSegment first and last driver) and the legacy
 *   per-driver UkmEdge rows (a road both accounts drove keeps the real account's row).
 * The moved trips are then re-attributed, so their assigned / outside UKM is measured against the
 * real account's polygons, and the real account's per-driver UKM is recomputed.
 *
 * --carry-password copies the duplicate's password onto the real account: when the real account
 * was made by an import (random password, never signed in) and the driver only knows the one the
 * duplicate was given, this keeps them able to sign in — with the real account's email.
 *
 * Nothing is lost: the duplicate user (password hash included) is copied to `archivedusers`
 * together with the ids of everything moved and the real account's previous password hash, and
 * --undo=<batch> puts it back. DRY RUN unless --apply.
 *
 * Usage
 *   node src/seed/mergeDriverAccounts.js --from=<duplicate userId> --into=<real userId> [--carry-password] [--apply]
 *   node src/seed/mergeDriverAccounts.js --undo=<merge-…> --apply
 */
const crypto = require('crypto');
const { connectDB } = require('../config/db');

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.length ? rest.join('=') : true];
  })
);
const APPLY = args.get('apply') === true;
const log = (...a) => console.log(...a);

async function main() {
  await connectDB();
  const mongoose = require('mongoose');
  const db = mongoose.connection.db;
  const { ObjectId } = mongoose.Types;
  if (args.has('undo')) return undo(String(args.get('undo')), db);

  const from = await db.collection('users').findOne({ _id: new ObjectId(String(args.get('from'))) });
  const into = await db.collection('users').findOne({ _id: new ObjectId(String(args.get('into'))) });
  if (!from || !into) throw new Error('--from and --into must both be existing users');
  if (from.role !== 'user' || into.role !== 'user') throw new Error('Both accounts must be drivers');
  if (String(from._id) === String(into._id)) throw new Error('--from and --into are the same account');
  const open = await db.collection('trips').countDocuments({ driverId: from._id, status: 'active' });
  if (open) throw new Error(`${from.name} has ${open} trip(s) still being driven — merge once they have ended`);

  const tripIds = await db.collection('trips').distinct('_id', { driverId: from._id });
  const markerIds = await db.collection('markers').distinct('_id', { driverId: from._id });
  const activityIds = await db.collection('appactivities').distinct('_id', { driverId: from._id });
  const fromAreas = await db.collection('areaassignments').find({ driverId: from._id, releasedAt: null }).toArray();
  const intoAreaIds = new Set((await db.collection('areaassignments').find({ driverId: into._id, releasedAt: null }).project({ areaId: 1 }).toArray()).map((a) => String(a.areaId)));
  const moveAreas = fromAreas.filter((a) => !intoAreaIds.has(String(a.areaId)));
  const releaseAreas = fromAreas.filter((a) => intoAreaIds.has(String(a.areaId)));
  const counts = {
    trips: tripIds.length,
    points: await db.collection('locationpoints').countDocuments({ driverId: from._id }),
    markers: markerIds.length,
    appActivity: activityIds.length,
    areasMoved: moveAreas.length,
    areasReleased: releaseAreas.length,
    linkCredit: await db.collection('linkcoverages').countDocuments({ firstDriverId: from._id }),
    roadSegments: await db.collection('coveragesegments').countDocuments({ $or: [{ firstDriverId: from._id }, { lastDriverId: from._id }] }),
    ukmEdges: await db.collection('ukmedges').countDocuments({ driverId: from._id }),
  };
  log(`Merge "${from.name}" <${from.email}>  →  "${into.name}" <${into.email}>`);
  log(counts);
  if (moveAreas.length) log('Areas moving:', moveAreas.map((a) => `${a.areaName} [${a.areaCode}]`).join(', '));
  if (args.get('carry-password') === true) log(`Password: ${into.name} gets the password ${from.name} signs in with (sign in as ${into.email}).`);
  if (!APPLY) return log('\nDry run — nothing written. Add --apply.');

  const batch = `merge-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
  // 1. The duplicate, archived with everything needed to undo.
  await db.collection('archivedusers').insertOne({
    ...from,
    archive: {
      batch, reason: 'duplicate login merged', at: new Date(), into: into._id,
      intoPasswordHashBefore: args.get('carry-password') === true ? into.passwordHash : undefined,
      tripIds, markerIds, activityIds,
      movedAreaIds: moveAreas.map((a) => a._id), releasedAreaIds: releaseAreas.map((a) => a._id),
    },
  });
  // 2. Ownership moves.
  const set = (col, filter, update) => db.collection(col).updateMany(filter, update);
  await set('trips', { driverId: from._id }, { $set: { driverId: into._id } });
  await set('locationpoints', { driverId: from._id }, { $set: { driverId: into._id } });
  await set('markers', { driverId: from._id }, { $set: { driverId: into._id, driverName: into.name } });
  await set('appactivities', { driverId: from._id }, { $set: { driverId: into._id } });
  await set('linkcoverages', { firstDriverId: from._id }, { $set: { firstDriverId: into._id } });
  await set('coveragesegments', { firstDriverId: from._id }, { $set: { firstDriverId: into._id } });
  await set('coveragesegments', { lastDriverId: from._id }, { $set: { lastDriverId: into._id } });
  if (moveAreas.length) await set('areaassignments', { _id: { $in: moveAreas.map((a) => a._id) } }, { $set: { driverId: into._id, driverName: into.name } });
  if (releaseAreas.length) await set('areaassignments', { _id: { $in: releaseAreas.map((a) => a._id) } }, { $set: { releasedAt: new Date() } });
  // Legacy per-driver edges are unique on (edgeKey, driverId): a road both drove keeps the real row.
  const intoEdges = new Set(await db.collection('ukmedges').distinct('edgeKey', { driverId: into._id }));
  const fromEdges = await db.collection('ukmedges').find({ driverId: from._id }).project({ edgeKey: 1 }).toArray();
  const dupIds = fromEdges.filter((e) => intoEdges.has(e.edgeKey)).map((e) => e._id);
  if (dupIds.length) await db.collection('ukmedges').deleteMany({ _id: { $in: dupIds } });
  await set('ukmedges', { driverId: from._id }, { $set: { driverId: into._id } });
  // 3. Password, then the duplicate login itself.
  if (args.get('carry-password') === true) {
    await db.collection('users').updateOne({ _id: into._id }, { $set: { passwordHash: from.passwordHash } });
  }
  await db.collection('users').deleteOne({ _id: from._id });
  log(`\nMoved and removed the duplicate (batch ${batch}). Re-figuring ${tripIds.length} trips against ${into.name}'s areas…`);

  // 4. Figures follow the new owner.
  const { attributeTripLinks } = require('../services/linkCoverage');
  const { recomputeDriverUkm } = require('../services/roadSegments');
  for (const id of tripIds) await attributeTripLinks(id).catch((e) => log(`  link coverage failed ${id}: ${e.message}`));
  await recomputeDriverUkm(into._id).catch((e) => log(`  driver UKM failed: ${e.message}`));
  log(`Done. Undo: node src/seed/mergeDriverAccounts.js --undo=${batch} --apply`);
}

async function undo(batch, db) {
  const a = await db.collection('archivedusers').findOne({ 'archive.batch': batch });
  if (!a) throw new Error(`No merge ${batch}`);
  const { archive, ...user } = a;
  log(`Undo ${batch}: restore "${user.name}" <${user.email}> with ${archive.tripIds.length} trips, ${archive.markerIds.length} markers`);
  if (!APPLY) return log('Dry run — add --apply.');
  await db.collection('users').insertOne(user);
  const into = archive.into;
  await db.collection('trips').updateMany({ _id: { $in: archive.tripIds } }, { $set: { driverId: user._id } });
  await db.collection('locationpoints').updateMany({ tripId: { $in: archive.tripIds } }, { $set: { driverId: user._id } });
  await db.collection('markers').updateMany({ _id: { $in: archive.markerIds } }, { $set: { driverId: user._id, driverName: user.name } });
  await db.collection('appactivities').updateMany({ _id: { $in: archive.activityIds } }, { $set: { driverId: user._id } });
  await db.collection('linkcoverages').updateMany({ firstTripId: { $in: archive.tripIds } }, { $set: { firstDriverId: user._id } });
  await db.collection('coveragesegments').updateMany({ firstTripId: { $in: archive.tripIds } }, { $set: { firstDriverId: user._id } });
  await db.collection('areaassignments').updateMany({ _id: { $in: archive.movedAreaIds } }, { $set: { driverId: user._id, driverName: user.name } });
  await db.collection('areaassignments').updateMany({ _id: { $in: archive.releasedAreaIds } }, { $set: { releasedAt: null } });
  if (archive.intoPasswordHashBefore) await db.collection('users').updateOne({ _id: into }, { $set: { passwordHash: archive.intoPasswordHashBefore } });
  await db.collection('archivedusers').deleteOne({ _id: a._id });
  log('Restored. Re-run attribution for those trips (backfillLinkCoverage.js) to re-measure them against the restored account.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
