/**
 * Signing out after a while with nothing done, and saying why on the login page.
 *
 * The panel's token lasts 7 days (backend PANEL_JWT_EXPIRES_IN), so on its own a browser left open
 * stays signed in all week. This adds the idle rule on top: no click, key, scroll or touch in ANY
 * tab of the panel for IDLE_LIMIT_MS signs every tab out. The last activity is kept in
 * localStorage, which all tabs share, so working in one tab keeps the others signed in too.
 * Background requests (polling, the live map) do not count — only a person does.
 *
 * Why the person landed on the login page travels in sessionStorage (this tab only), so the
 * message shows once and a later visit to /login is plain.
 */

export const IDLE_LIMIT_MS = 8 * 60 * 60 * 1000; // 8 hours, the user's choice (2026-10-29)

const ACTIVITY_KEY = 'jsan_last_activity';
const REASON_KEY = 'jsan_signed_out_reason';
const WRITE_EVERY_MS = 30 * 1000; // activity is written at most this often

let lastWrite = 0;

/** Note that the person did something. Cheap to call on every event: writes every 30 s at most. */
export function markActive(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < WRITE_EVERY_MS) return;
  lastWrite = now;
  try {
    localStorage.setItem(ACTIVITY_KEY, String(now));
  } catch {
    /* storage unavailable: the token's own expiry still applies */
  }
}

/** True when nobody has used any tab of the panel for longer than the limit. */
export function idleTooLong(): boolean {
  let at: number;
  try {
    at = Number(localStorage.getItem(ACTIVITY_KEY));
  } catch {
    return false;
  }
  // No record (a browser signed in before this existed): start counting from now rather than
  // signing out everyone at once on the day it is deployed.
  if (!at) {
    markActive(true);
    return false;
  }
  return Date.now() - at > IDLE_LIMIT_MS;
}

export const TIMED_OUT_MESSAGE = 'Your session timed out. Please sign in again.';
export const EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

/** Remember why this tab is being sent to the login page. */
export function noteSignedOut(message: string) {
  try {
    sessionStorage.setItem(REASON_KEY, message);
  } catch {
    /* no message then — the login page still shows */
  }
}

/** The reason this tab was signed out, once; null when the person came to /login themselves. */
export function takeSignedOutReason(): string | null {
  try {
    const m = sessionStorage.getItem(REASON_KEY);
    if (m) sessionStorage.removeItem(REASON_KEY);
    return m;
  } catch {
    return null;
  }
}
