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

  const track =
    points.length > 1
      ? `
    <Placemark>
      <name>Route</name>
      <gx:Track>
        <altitudeMode>clampToGround</altitudeMode>
        ${points.map((p) => `<when>${new Date(p.recordedAt).toISOString()}</when>`).join('\n        ')}
        ${points.map((p) => `<gx:coord>${p.lon} ${p.lat} 0</gx:coord>`).join('\n        ')}
      </gx:Track>
    </Placemark>`
      : '';

  const startPlacemark = start
    ? `
    <Placemark>
      <name>Start</name>
      <Point><coordinates>${start.lon},${start.lat},0</coordinates></Point>
    </Placemark>`
    : '';

  const endPlacemark = end
    ? `
    <Placemark>
      <name>End</name>
      <Point><coordinates>${end.lon},${end.lat},0</coordinates></Point>
    </Placemark>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${escapeXml(name)}</name>
    <description>${escapeXml(description)}</description>${track}${startPlacemark}${endPlacemark}
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

module.exports = { buildKml, buildJson, driverName, baseFilename };
