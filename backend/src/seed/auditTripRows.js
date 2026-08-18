/**
 * Fleet-wide invariant: every driver-day row the Trips page shows must expand to exactly the
 * trips it counted. If that holds everywhere, "Details" is always reachable.
 * Replicates both queries the app makes, including the timezone each uses.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const { timezoneForCountry } = require('../utils/countryTimezone');
const { dayRange } = require('../utils/timezone');

(async()=>{
  await connectDB();
  const db = mongoose.connection.db;
  const T=db.collection('trips'), U=db.collection('users');

  const drivers=await U.find({},{projection:{country:1,name:1}}).toArray();
  const tzOf=new Map(drivers.map(d=>[String(d._id), timezoneForCountry(d.country)]));
  const nameOf=new Map(drivers.map(d=>[String(d._id), d.name]));

  // Exactly what mergedSummary does: bucket by the driver's local calendar day.
  const branches=drivers.map(d=>({case:{$eq:['$driverId',d._id]},then:timezoneForCountry(d.country)}));
  const rows=await T.aggregate([
    {$addFields:{dateStr:{$dateToString:{format:'%Y-%m-%d',date:'$startedAt',timezone:branches.length?{$switch:{branches,default:'UTC'}}:'UTC'}}}},
    {$group:{_id:{driverId:'$driverId',date:'$dateStr'},totalTrips:{$sum:1}}},
  ]).toArray();

  console.log(`checking ${rows.length} driver-day rows...\n`);
  let ok=0, mismatched=0, utcWouldBreak=0;
  const bad=[];
  for(const r of rows){
    const tz=tzOf.get(String(r._id.driverId))||'UTC';
    const {from,to}=dayRange(r._id.date, tz);
    const zoned=await T.countDocuments({driverId:r._id.driverId,startedAt:{$gte:from,$lt:to}});
    // What the OLD code did: UTC midnight lower bound, server-local 23:59:59 upper bound.
    const oldFrom=new Date(r._id.date);
    const oldTo=new Date(`${r._id.date}T23:59:59`);
    const legacy=await T.countDocuments({driverId:r._id.driverId,startedAt:{$gte:oldFrom,$lte:oldTo}});

    if(zoned===r.totalTrips) ok++; else { mismatched++; bad.push({...r,tz,zoned}); }
    if(legacy!==r.totalTrips) utcWouldBreak++;
  }

  console.log(`FIXED  expansion matches the row : ${ok}/${rows.length}`);
  console.log(`       mismatched                : ${mismatched}`);
  console.log(`BEFORE rows the old query broke  : ${utcWouldBreak}/${rows.length}  (${(utcWouldBreak/rows.length*100).toFixed(1)}% expanded wrong or empty)`);
  if(bad.length){ process.exitCode = 1;
    console.log(`\nrows still wrong:`);
    bad.slice(0,15).forEach(b=>console.log(`  ${nameOf.get(String(b._id.driverId))}  ${b._id.date}  tz=${b.tz}  row says ${b.totalTrips}, expansion returns ${b.zoned}`));
  }

  // Nothing destroyed along the way.
  console.log(`\n=== data integrity ===`);
  console.log(`  trips          : ${await T.countDocuments({})}`);
  console.log(`  locationpoints : ${(await db.collection('locationpoints').estimatedDocumentCount()).toLocaleString()}`);
  console.log(`  ukmedges       : ${(await db.collection('ukmedges').estimatedDocumentCount()).toLocaleString()}`);
  await mongoose.disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
