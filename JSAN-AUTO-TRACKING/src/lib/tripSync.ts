import * as VehicleTracker from '@/modules/vehicle-tracker';
import type { SyncStatus } from '@/modules/vehicle-tracker';

/**
 * Getting a driver's trip points off the phone before they sign out.
 *
 * Sign-out ENDS the open trip (VehicleTracker.endTripAndStop) — a trip left open used to be resumed
 * by the next sign-in, the next morning say, and that whole day's driving was filed under the day
 * before. What the phone still holds is then uploaded; only when nothing is left does sign-out
 * finish. If uploading takes more than a moment, the Sync screen (app/sync.tsx) shows the driver
 * what is left and roughly how long it will take.
 */

/** A sign-out is under way: tracking must stay stopped (TrackingBootstrap restarts it on foreground). */
let signingOut = false;
export const isSigningOut = () => signingOut;
export const setSigningOut = (v: boolean) => { signingOut = v; };

/** Nothing left on the phone, and the trip has been ended. */
export const allUploaded = (st: SyncStatus) => st.queued === 0 && !st.tripOpen;

/**
 * Upload until the phone is empty or `timeoutMs` passes; returns the last status. Nudges the
 * uploader whenever it is idle with points still waiting.
 */
export async function uploadWhatIsLeft(timeoutMs: number): Promise<SyncStatus> {
  const until = Date.now() + timeoutMs;
  let st = await VehicleTracker.getSyncStatus();
  let lastNudge = 0;
  while (!allUploaded(st) && Date.now() < until) {
    if (st.problem === 'auth') break; // the server refuses this login: retrying cannot help
    if (!st.uploading && st.queued > 0 && Date.now() - lastNudge > 2_500) {
      lastNudge = Date.now();
      await VehicleTracker.flushNow();
    }
    await new Promise((r) => setTimeout(r, 500));
    st = await VehicleTracker.getSyncStatus();
  }
  return st;
}

/**
 * Roughly how long the upload will take, in words a driver reads at a glance. Measured on this
 * phone when it can be: from how fast the count has actually been falling (`ratePerSec`), else
 * from how long one upload request has been taking. Null when there is nothing to go on yet.
 */
export function timeLeftText(st: SyncStatus, ratePerSec: number | null): string | null {
  if (st.queued === 0) return null;
  let seconds: number | null = null;
  if (ratePerSec && ratePerSec > 0) seconds = st.queued / ratePerSec;
  else if (st.avgBatchMs > 0) seconds = (Math.ceil(st.queued / Math.max(1, st.batchSize)) * st.avgBatchMs) / 1000;
  if (seconds === null) return null;
  if (seconds < 45) return 'Less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes <= 1) return 'About a minute left';
  if (minutes < 60) return `About ${minutes} minutes left`;
  const hours = Math.round(minutes / 60);
  return hours <= 1 ? 'About an hour left' : `About ${hours} hours left`;
}
