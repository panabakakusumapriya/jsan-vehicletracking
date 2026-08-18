function escapeXml(value) {
  return String(value ?? '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function driverName(trip) {
  return (trip.driverId && typeof trip.driverId === 'object' ? trip.driverId.name : null) || 'Driver';
}

function vehiclePlate(trip) {
  return (trip.vehicleId && typeof trip.vehicleId === 'object' ? trip.vehicleId.plateNumber : null) || null;
}

/** Filesystem-safe slug for a zip entry / download filename component. */
function slug(value) {
  return (
    String(value)
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'trip'
  );
}

/** yyyymmdd_hhmm, safe for filenames (colons in ISO timestamps aren't). */
function filenameDate(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function baseFilename(trip) {
  return `trip_${slug(driverName(trip))}_${filenameDate(trip.startedAt)}`;
}

/* ────────────────────────── cross-platform KML symbology ──────────────────────────
 * No single mechanism styles a KML everywhere, so every export carries two:
 *
 *   <Style>/<LineStyle>   Google Earth and ArcGIS read these and colour the line for you.
 *                         QGIS does not — it reads KML through OGR, which surfaces geometry and
 *                         attributes but ignores KML styling entirely.
 *   <ExtendedData>        QGIS/OGR exposes these as ordinary layer attributes, so a `segment_type`
 *                         field can drive categorized symbology — set the colours once and every
 *                         later export renders the same way.
 *
 * Geometry is a plain <LineString> for the same reason. The animated <gx:Track> is a Google
 * extension: it gives Earth its time-slider replay, but OGR does not read it as geometry, so a
 * gx:Track-only file can open in QGIS with nothing visible at all. Track is kept as an extra
 * placemark for Earth, never as the only geometry.
 */

/**
 * KML wants colours as aabbggrr — alpha, then BLUE, GREEN, RED. Reversed from the #rrggbb most
 * people expect, which is the usual reason exported lines come out the wrong colour.
 */
function kmlColor(hex, alpha = 'ff') {
  const h = hex.replace('#', '').toLowerCase();
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

// Matched to the trip map so an export looks like the screen it came from.
const PALETTE = {
  raw: '#7C3AED',        // violet  — raw GPS trace
  snapped: '#94A3B8',    // slate   — full snapped route, drawn under the UKM overlay
  ukm: '#10B981',        // emerald — UKM: road new to this trip
  start: '#059669',
  end: '#DC2626',
};

function lineStyle(id, hex, width) {
  return `
    <Style id="${id}">
      <LineStyle><color>${kmlColor(hex)}</color><width>${width}</width></LineStyle>
      <PolyStyle><fill>0</fill></PolyStyle>
    </Style>`;
}

function pointStyle(id, hex) {
  return `
    <Style id="${id}">
      <IconStyle>
        <color>${kmlColor(hex)}</color>
        <scale>1.1</scale>
        <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
      </IconStyle>
    </Style>`;
}

/** Attributes QGIS/ArcGIS can style and filter by. */
function extendedData(fields) {
  const rows = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `        <Data name="${k}"><value>${escapeXml(v)}</value></Data>`)
    .join('\n');
  return rows ? `
      <ExtendedData>
${rows}
      </ExtendedData>` : '';
}

const coordList = (path) => path.map(([lon, lat]) => `${lon},${lat},0`).join(' ');

/** A styled, attributed LineString placemark. `path` is [[lon, lat], ...]. */
function linePlacemark({ name, styleId, path, fields }) {
  if (!path || path.length < 2) return '';
  return `
    <Placemark>
      <name>${escapeXml(name)}</name>
      <styleUrl>#${styleId}</styleUrl>${extendedData(fields)}
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${coordList(path)}</coordinates>
      </LineString>
    </Placemark>`;
}

function markerPlacemark(name, styleId, lon, lat, fields) {
  return `
    <Placemark>
      <name>${escapeXml(name)}</name>
      <styleUrl>#${styleId}</styleUrl>${extendedData(fields)}
      <Point><coordinates>${lon},${lat},0</coordinates></Point>
    </Placemark>`;
}

/** Fields repeated on every placemark of a trip, so each feature stands alone in a GIS table. */
function tripFields(trip) {
  return {
    trip_id: String(trip._id ?? ''),
    driver: driverName(trip),
    vehicle: vehiclePlate(trip) || '',
    status: trip.status,
    started_at: trip.startedAt ? new Date(trip.startedAt).toISOString() : '',
    ended_at: trip.endedAt ? new Date(trip.endedAt).toISOString() : '',
    raw_distance_km: ((trip.distanceMeters || 0) / 1000).toFixed(3),
    max_speed_kmh: Math.round(trip.maxSpeedKmh || 0),
  };
}

/**
 * KML with a timestamped gx:Track built from the real recorded points (not
 * resampled), so opening the file in Google Earth replays the drive on its
 * native time-slider -- matches "exactly as it happened".
 */
function buildKml(trip, points) {
  const name = `${driverName(trip)} - ${new Date(trip.startedAt).toISOString().slice(0, 16).replace('T', ' ')}`;
  const plate = vehiclePlate(trip);
  const description = [
    plate ? `Vehicle: ${plate}` : null,
    `Distance: ${((trip.distanceMeters || 0) / 1000).toFixed(2)} km`,
    `Max speed: ${Math.round(trip.maxSpeedKmh || 0)} km/h`,
    `Status: ${trip.status}`,
  ]
    .filter(Boolean)
    .join(' | ');

  const start = points[0];
  const end = points.length > 1 ? points[points.length - 1] : null;
  const fields = tripFields(trip);

  // Plain LineString first: this is the geometry QGIS/ArcGIS will actually read.
  const line = linePlacemark({
    name: 'Raw GPS trace',
    styleId: 'rawTrace',
    path: points.map((p) => [p.lon, p.lat]),
    fields: { ...fields, layer: 'raw', segment_type: 'raw_gps', point_count: points.length },
  });

  // Kept as a SECOND placemark, not the only one — see the symbology note above. Gives Google
  // Earth its time-slider replay; harmless everywhere else.
  const track =
    points.length > 1
      ? `
    <Folder>
      <name>Animated replay (Google Earth)</name>
      <Placemark>
        <name>Route over time</name>
        <styleUrl>#rawTrace</styleUrl>
        <gx:Track>
          <altitudeMode>clampToGround</altitudeMode>
          ${points.map((p) => `<when>${new Date(p.recordedAt).toISOString()}</when>`).join('\n          ')}
          ${points.map((p) => `<gx:coord>${p.lon} ${p.lat} 0</gx:coord>`).join('\n          ')}
        </gx:Track>
      </Placemark>
    </Folder>`
      : '';

  const startPlacemark = start
    ? markerPlacemark('Start', 'startPoint', start.lon, start.lat, { ...fields, segment_type: 'start' })
    : '';
  const endPlacemark = end
    ? markerPlacemark('End', 'endPoint', end.lon, end.lat, { ...fields, segment_type: 'end' })
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <description>${escapeXml(`${description} | Layer: raw GPS trace. Style by the "segment_type" attribute in QGIS.`)}</description>${lineStyle('rawTrace', PALETTE.raw, 4)}${pointStyle('startPoint', PALETTE.start)}${pointStyle('endPoint', PALETTE.end)}${line}${startPlacemark}${endPlacemark}${track}
  </Document>
</kml>
`;
}

/**
 * Snapped-to-road KML: the matched route, with the UKM stretches as their own styled layer on top.
 *
 * The full route and the UKM subset are separate placemarks rather than the route being cut into
 * new/repeated pieces. Overlaying keeps the route continuous — gaps between coloured runs read as
 * missing data — and it mirrors exactly how the trip map draws it. `segment_type` distinguishes
 * them for anyone styling by attribute.
 *
 * `snappedPath` is [[lon, lat], ...]; `ukmPaths` is an array of such paths.
 */
function buildSnappedKml(trip, snappedPath, ukmPaths = []) {
  const name = `${driverName(trip)} - ${new Date(trip.startedAt).toISOString().slice(0, 16).replace('T', ' ')} (snapped)`;
  const fields = tripFields(trip);
  const cleanedKm = trip.cleanedDistanceMeters != null ? (trip.cleanedDistanceMeters / 1000).toFixed(2) : null;
  const ukmKm = trip.ukmMeters != null ? (trip.ukmMeters / 1000).toFixed(2) : null;

  const description = [
    vehiclePlate(trip) ? `Vehicle: ${vehiclePlate(trip)}` : null,
    cleanedKm ? `Snapped distance: ${cleanedKm} km` : null,
    ukmKm ? `UKM (new road): ${ukmKm} km` : null,
    `Raw distance: ${((trip.distanceMeters || 0) / 1000).toFixed(2)} km`,
    trip.cleanedMatchedRatio != null ? `Genuinely snapped: ${Math.round(trip.cleanedMatchedRatio * 100)}%` : null,
    'Style by the "segment_type" attribute in QGIS; colours are embedded for Google Earth/ArcGIS.',
  ].filter(Boolean).join(' | ');

  const shared = {
    ...fields,
    layer: 'snapped',
    snapped_distance_km: cleanedKm,
    ukm_km: ukmKm,
    snapped_ratio_pct: trip.cleanedMatchedRatio != null ? Math.round(trip.cleanedMatchedRatio * 100) : null,
  };

  const route = linePlacemark({
    name: 'Snapped route (full)',
    styleId: 'snappedRoute',
    path: snappedPath,
    fields: { ...shared, segment_type: 'snapped_route_full' },
  });

  const ukm = (ukmPaths || [])
    .filter((p) => p && p.length > 1)
    .map((p, i) =>
      linePlacemark({
        name: `UKM - new road ${i + 1}`,
        styleId: 'ukmNew',
        path: p,
        fields: { ...shared, segment_type: 'ukm_new' },
      })
    )
    .join('');

  const ukmFolder = ukm
    ? `
    <Folder>
      <name>UKM - new road this trip</name>${ukm}
    </Folder>`
    : '';

  const first = snappedPath && snappedPath.length ? snappedPath[0] : null;
  const last = snappedPath && snappedPath.length > 1 ? snappedPath[snappedPath.length - 1] : null;
  const startPlacemark = first ? markerPlacemark('Start', 'startPoint', first[0], first[1], { ...shared, segment_type: 'start' }) : '';
  const endPlacemark = last ? markerPlacemark('End', 'endPoint', last[0], last[1], { ...shared, segment_type: 'end' }) : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <description>${escapeXml(description)}</description>${lineStyle('snappedRoute', PALETTE.snapped, 4)}${lineStyle('ukmNew', PALETTE.ukm, 6)}${pointStyle('startPoint', PALETTE.start)}${pointStyle('endPoint', PALETTE.end)}
    <Folder>
      <name>Snapped route</name>${route}
    </Folder>${ukmFolder}${startPlacemark}${endPlacemark}
  </Document>
</kml>
`;
}

function buildJson(trip, points) {
  return {
    trip: {
      driverName: driverName(trip),
      vehiclePlate: vehiclePlate(trip),
      status: trip.status,
      startedAt: trip.startedAt,
      endedAt: trip.endedAt ?? null,
      distanceMeters: trip.distanceMeters,
      maxSpeedKmh: trip.maxSpeedKmh,
    },
    points: points.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      speedKmh: p.speedKmh,
      heading: p.heading ?? null,
      recordedAt: p.recordedAt,
    })),
  };
}

/**
 * Build a single merged KML from multiple trips (same driver, same date).
 * All trip segments appear as separate Placemarks within one Document.
 */
function buildMergedKml(driverNameStr, vehiclePlateStr, date, tripsWithPoints) {
  const allPoints = tripsWithPoints.flatMap(t => t.points);
  let totalDistance = 0;
  let maxSpeed = 0;
  for (const t of tripsWithPoints) {
    totalDistance += t.trip.distanceMeters || 0;
    maxSpeed = Math.max(maxSpeed, t.trip.maxSpeedKmh || 0);
  }

  const description = [
    vehiclePlateStr ? `Vehicle: ${vehiclePlateStr}` : null,
    `Trips: ${tripsWithPoints.length}`,
    `Total distance: ${(totalDistance / 1000).toFixed(2)} km`,
    `Max speed: ${Math.round(maxSpeed)} km/h`,
    `Date: ${date}`,
  ].filter(Boolean).join(' | ');

  let placemarks = '';
  for (let i = 0; i < tripsWithPoints.length; i++) {
    const { trip, points } = tripsWithPoints[i];
    if (points.length < 2) continue;
    placemarks += `
    <Placemark>
      <name>Trip ${i + 1} (${new Date(trip.startedAt).toISOString().slice(11, 16)} - ${trip.endedAt ? new Date(trip.endedAt).toISOString().slice(11, 16) : 'ongoing'})</name>
      <gx:Track>
        <altitudeMode>clampToGround</altitudeMode>
        ${points.map(p => `<when>${new Date(p.recordedAt).toISOString()}</when>`).join('\n        ')}
        ${points.map(p => `<gx:coord>${p.lon} ${p.lat} 0</gx:coord>`).join('\n        ')}
      </gx:Track>
    </Placemark>`;
  }

  // Start and end markers from first and last points overall
  const first = allPoints[0];
  const last = allPoints.length > 1 ? allPoints[allPoints.length - 1] : null;
  if (first) {
    placemarks += `
    <Placemark>
      <name>Day Start</name>
      <Point><coordinates>${first.lon},${first.lat},0</coordinates></Point>
    </Placemark>`;
  }
  if (last) {
    placemarks += `
    <Placemark>
      <name>Day End</name>
      <Point><coordinates>${last.lon},${last.lat},0</coordinates></Point>
    </Placemark>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${escapeXml(driverNameStr)} - ${escapeXml(date)}</name>
    <description>${escapeXml(description)}</description>${placemarks}
  </Document>
</kml>
`;
}

/**
 * Build a single merged JSON from multiple trips (same driver, same date).
 */
function buildMergedJson(driverNameStr, vehiclePlateStr, date, tripsWithPoints) {
  let totalDistance = 0;
  let maxSpeed = 0;
  for (const t of tripsWithPoints) {
    totalDistance += t.trip.distanceMeters || 0;
    maxSpeed = Math.max(maxSpeed, t.trip.maxSpeedKmh || 0);
  }

  return {
    driver: driverNameStr,
    vehicle: vehiclePlateStr,
    date,
    totalTrips: tripsWithPoints.length,
    totalDistanceMeters: totalDistance,
    maxSpeedKmh: maxSpeed,
    trips: tripsWithPoints.map(({ trip, points }) => ({
      tripId: trip._id,
      status: trip.status,
      startedAt: trip.startedAt,
      endedAt: trip.endedAt ?? null,
      distanceMeters: trip.distanceMeters,
      maxSpeedKmh: trip.maxSpeedKmh,
      points: points.map(p => ({
        lat: p.lat,
        lon: p.lon,
        speedKmh: p.speedKmh,
        heading: p.heading ?? null,
        recordedAt: p.recordedAt,
      })),
    })),
    allPoints: tripsWithPoints.flatMap(({ points }) =>
      points.map(p => ({
        lat: p.lat,
        lon: p.lon,
        speedKmh: p.speedKmh,
        heading: p.heading ?? null,
        recordedAt: p.recordedAt,
      }))
    ),
  };
}

/**
 * Merged snapped KML: one file, one folder per trip, each carrying that trip's matched route and
 * its UKM stretches as separate styled placemarks. Trips that were never matched are skipped
 * rather than silently falling back to raw geometry — mixing snapped and raw lines in a file
 * labelled "snapped" would quietly misrepresent which parts had been corrected.
 */
function buildMergedSnappedKml(driverNameStr, vehiclePlateStr, date, tripsWithPaths) {
  const usable = tripsWithPaths.filter((t) => t.route && t.route.length > 1);
  const totalUkm = usable.reduce((sum, t) => sum + (t.trip.ukmMeters || 0), 0);
  const totalCleaned = usable.reduce((sum, t) => sum + (t.trip.cleanedDistanceMeters || 0), 0);

  const description = [
    vehiclePlateStr ? `Vehicle: ${vehiclePlateStr}` : null,
    `Trips: ${usable.length} of ${tripsWithPaths.length} (only map-matched trips are included)`,
    `Snapped distance: ${(totalCleaned / 1000).toFixed(2)} km`,
    `UKM (new road): ${(totalUkm / 1000).toFixed(2)} km`,
    `Date: ${date}`,
    'Style by the "segment_type" attribute in QGIS; colours are embedded for Google Earth/ArcGIS.',
  ].filter(Boolean).join(' | ');

  let folders = '';
  usable.forEach(({ trip, route, ukm }, i) => {
    const shared = { ...tripFields(trip), layer: 'snapped', trip_index: i + 1, ukm_km: trip.ukmMeters != null ? (trip.ukmMeters / 1000).toFixed(3) : null };
    const routeLine = linePlacemark({ name: `Trip ${i + 1} - snapped route`, styleId: 'snappedRoute', path: route, fields: { ...shared, segment_type: 'snapped_route_full' } });
    const ukmLines = (ukm || []).filter((p) => p && p.length > 1)
      .map((p, k) => linePlacemark({ name: `Trip ${i + 1} - UKM ${k + 1}`, styleId: 'ukmNew', path: p, fields: { ...shared, segment_type: 'ukm_new' } }))
      .join('');
    folders += `
    <Folder>
      <name>Trip ${i + 1} (${new Date(trip.startedAt).toISOString().slice(11, 16)})</name>${routeLine}${ukmLines}
    </Folder>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${escapeXml(driverNameStr)} - ${escapeXml(date)} (snapped)</name>
    <description>${escapeXml(description)}</description>${lineStyle('snappedRoute', PALETTE.snapped, 4)}${lineStyle('ukmNew', PALETTE.ukm, 6)}${pointStyle('startPoint', PALETTE.start)}${pointStyle('endPoint', PALETTE.end)}${folders}
  </Document>
</kml>
`;
}

module.exports = {
  buildKml,
  buildSnappedKml,
  buildMergedSnappedKml,
  buildJson,
  buildMergedKml,
  buildMergedJson,
  driverName,
  vehiclePlate,
  baseFilename,
  slug,
  filenameDate,
  kmlColor,
};
