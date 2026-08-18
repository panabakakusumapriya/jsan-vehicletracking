const Trip = require('../models/Trip');
const env = require('../config/env');
const { emitAlert } = require('../realtime/io');
const { sendToUsers, watcherIdsForDriver, isConfigured } = require('./push');
const { closeDeadTrips, driversWithLiveApp } = require('./tripLifecycle');

/**
 * Background watchdog: notices when a driver on an active trip stops reporting and tells
 * their manager (and the admins) about it — over web push, so it lands even when nobody
 * has the panel open, plus over Socket.IO for panels that are open right now.
 *
 * Why a background job at all: nothing else in the system runs when the fleet goes quiet.
 * Ingest only fires when a device talks to us, and the live map only self-heals while
 * someone is looking at it. "Driver went silent" is by definition the absence of traffic,
 * so it needs a clock, not a request.
 *
 * De-dupe is a conditional update, not in-memory state: an alert is only sent by whoever
 * wins `offlineNotifiedAt: null -> now`. A restart, or a second server instance, therefore
 * cannot re-send an alert that already went out.
 */

// Alerts sent per tick. Not a cap on coverage — unclaimed trips are picked up on the next
// tick — just a throttle so a backend-side network blip can't fire the whole fleet at once.
const MAX_ALERTS_PER_TICK = 20;

let timer = null;
let running = false;

function minutesSince(date) {
  if (!date) return null;
  return Math.max(1, Math.round((Date.now() - new Date(date).getTime()) / 60000));
}

// Builds the notification a manager actually reads, for both transports.
function buildAlert(type, trip) {
  const driver = trip.driverId || {};
  const plate = trip.vehicleId && trip.vehicleId.plateNumber;
  const lastSeen = trip.lastLocation && trip.lastLocation.recordedAt;
  const silentMinutes = minutesSince(lastSeen || trip.startedAt);
  const name = driver.name || 'A driver';
  const suffix = plate ? ` · ${plate}` : '';

  const copy =
    type === 'driver-offline'
      ? {
          title: '🔴 Driver offline',
          body: `${name} stopped reporting ${silentMinutes} min ago${suffix}`,
        }
      : {
          title: '🟢 Driver back online',
          body: `${name} is reporting again${suffix}`,
        };

  return {
    type,
    ...copy,
    driverId: driver._id ? driver._id.toString() : null,
    driverName: driver.name || null,
    managerId: driver.managerId ? driver.managerId.toString() : null,
    tripId: trip._id.toString(),
    vehiclePlate: plate || null,
    country: driver.country || null,
    lastSeenAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    silentMinutes,
    // Tag per driver so a repeat alert replaces the old one in the tray instead of stacking.
    tag: `driver:${driver._id ? driver._id.toString() : trip._id}`,
    url: driver._id ? `/?driver=${driver._id}` : '/',
    ts: new Date().toISOString(),
  };
}

async function dispatch(alert, driver) {
  emitAlert(alert);
  if (!isConfigured()) return;
  try {
    const watchers = await watcherIdsForDriver(driver);
    await sendToUsers(watchers, alert);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('watchdog: push fan-out failed:', err.message);
  }
}

// Active trips whose last heartbeat is older than the offline threshold, not yet alerted.
async function raiseOfflineAlerts() {
  const cutoff = new Date(Date.now() - env.DRIVER_OFFLINE_AFTER_SECONDS * 1000);
  const candidates = await Trip.find({
    status: 'active',
    offlineNotifiedAt: null,
    $or: [
      { 'lastLocation.recordedAt': { $lt: cutoff } },
      { lastLocation: null, startedAt: { $lt: cutoff } },
    ],
  })
    .select('_id')
    .limit(MAX_ALERTS_PER_TICK);

  let sent = 0;
  for (const { _id } of candidates) {
    // Claim first, notify second — losing this race means someone else already alerted.
    const trip = await Trip.findOneAndUpdate(
      { _id, status: 'active', offlineNotifiedAt: null },
      { $set: { offlineNotifiedAt: new Date() } },
      { new: true }
    )
      .populate('driverId', 'name managerId country')
      .populate('vehicleId', 'plateNumber');

    if (!trip || !trip.driverId) continue;
    await dispatch(buildAlert('driver-offline', trip), trip.driverId);
    sent += 1;
  }

  if (candidates.length === MAX_ALERTS_PER_TICK) {
    // eslint-disable-next-line no-console
    console.warn(
      `watchdog: hit the ${MAX_ALERTS_PER_TICK}-alert throttle this tick; the rest follow next tick`
    );
  }
  return sent;
}

// Drivers previously flagged offline that have started reporting again.
async function raiseBackOnlineAlerts() {
  const cutoff = new Date(Date.now() - env.DRIVER_OFFLINE_AFTER_SECONDS * 1000);
  const candidates = await Trip.find({
    status: 'active',
    offlineNotifiedAt: { $ne: null },
    'lastLocation.recordedAt': { $gte: cutoff },
  })
    .select('_id')
    .limit(MAX_ALERTS_PER_TICK);

  let sent = 0;
  for (const { _id } of candidates) {
    const trip = await Trip.findOneAndUpdate(
      { _id, offlineNotifiedAt: { $ne: null } },
      { $set: { offlineNotifiedAt: null } },
      { new: true }
    )
      .populate('driverId', 'name managerId country')
      .populate('vehicleId', 'plateNumber');

    if (!trip || !trip.driverId) continue;
    if (env.ALERT_ON_BACK_ONLINE) {
      await dispatch(buildAlert('driver-online', trip), trip.driverId);
      sent += 1;
    }
  }
  return sent;
}

/** One full sweep. Exported so tests can drive it without waiting on the timer. */
async function tick() {
  const offline = await raiseOfflineAlerts();
  const online = await raiseBackOnlineAlerts();
  // Trips that stayed silent past the dead-session window are closed here too, so the map
  // clears itself even on days when nobody opens the panel.
  const closed = await closeDeadTrips();
  return { offline, online, closed };
}

function startWatchdog() {
  if (timer || !env.ALERTS_ENABLED) return null;
  const everyMs = Math.max(5, env.WATCHDOG_INTERVAL_SECONDS) * 1000;

  timer = setInterval(async () => {
    if (running) return; // a slow sweep must not stack on itself
    running = true;
    try {
      const { offline, online, closed } = await tick();
      if (offline || online || closed) {
        // eslint-disable-next-line no-console
        console.log(`watchdog: ${offline} offline, ${online} back online, ${closed} trips closed`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('watchdog tick failed:', err.message);
    } finally {
      running = false;
    }
  }, everyMs);

  // eslint-disable-next-line no-console
  console.log(
    `   Watchdog every ${everyMs / 1000}s — driver offline after ${env.DRIVER_OFFLINE_AFTER_SECONDS}s` +
      (isConfigured() ? ' (web push on)' : ' (web push OFF — no VAPID keys)')
  );
  return timer;
}

function stopWatchdog() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startWatchdog, stopWatchdog, tick };
