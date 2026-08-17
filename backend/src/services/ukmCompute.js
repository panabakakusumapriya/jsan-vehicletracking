const LocationPoint = require('../models/LocationPoint');
const UkmEdge = require('../models/UkmEdge');
const { haversineMeters } = require('../utils/geo');

const PRECISION = 10000; // 4 decimal places ≈ 11 m
const round = (v) => Math.round(v * PRECISION);

/**
 * Process a completed trip's location points and insert any NEW unique road edges
 * for this driver. Compound unique index (edgeKey, driverId) means each driver
 * gets their own set — driving a road 3 times stores it once per driver.
 *
 * Returns the number of new unique edges inserted.
 */
async function computeTripUkm(tripId, driverId) {
  const points = await LocationPoint.find({ tripId })
    .sort({ recordedAt: 1 })
    .select('lat lon')
    .lean();

  if (points.length < 2) return 0;

  // Build edge documents for consecutive grid-cell transitions.
  const docs = [];
  let prevCell = null;
  let prev = null;
  for (const pt of points) {
    if (pt.lat == null || pt.lon == null) continue;
    const cellLat = round(pt.lat);
    const cellLon = round(pt.lon);
    const cell = `${cellLat},${cellLon}`;

    if (prev && cell !== prevCell) {
      const edgeKey = prevCell < cell ? `${prevCell}|${cell}` : `${cell}|${prevCell}`;
      const dist = haversineMeters(prev, pt);
      if (dist > 0) {
        docs.push({
          edgeKey,
          distanceMeters: dist,
          driverId,
          tripId,
        });
      }
    }
    prev = pt;
    prevCell = cell;
  }

  if (!docs.length) return 0;

  // Dedupe within this trip (same edge can appear multiple times in one trip).
  const seen = new Set();
  const unique = [];
  for (const d of docs) {
    if (!seen.has(d.edgeKey)) {
      seen.add(d.edgeKey);
      unique.push(d);
    }
  }

  // insertMany with ordered:false inserts non-duplicate docs and throws for duplicates.
  // The non-duplicate docs ARE inserted even when the error is thrown.
  try {
    const result = await UkmEdge.insertMany(unique, { ordered: false });
    return result.length;
  } catch (e) {
    if (e.code === 11000 || e.writeErrors || e.insertedDocs) {
      return e.insertedDocs?.length ?? e.result?.result?.nInserted ?? e.result?.nInserted ?? 0;
    }
    throw e;
  }
}

module.exports = { computeTripUkm };
