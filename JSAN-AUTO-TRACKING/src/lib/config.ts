/**
 * Backend base URL used by the app AND handed to the native tracking service.
 *  - Defaults to the deployed Railway backend.
 *  - Override per-build with EXPO_PUBLIC_API_URL in a .env file, e.g.
 *      EXPO_PUBLIC_API_URL=http://192.168.1.20:4000   (local dev on a LAN)
 *
 * The override is read here rather than only documented: this file previously described the env
 * var in a comment but hard-coded the production URL, so every local build silently talked to the
 * live Railway backend no matter what .env said — including its tracking writes.
 *
 * `process.env.EXPO_PUBLIC_*` is inlined at BUILD time by Expo, not read at runtime, so it must be
 * referenced as a full static property access for the transform to find it. Destructuring
 * process.env, or building the key dynamically, silently yields undefined.
 */
const DEFAULT_API_URL = 'https://backend-jsan-vehicletracking-production.up.railway.app';

const configured = process.env.EXPO_PUBLIC_API_URL;

export const API_BASE_URL = (configured && configured.trim().length > 0
  ? configured.trim()
  : DEFAULT_API_URL
).replace(/\/$/, '');

/** True when pointed somewhere other than production — surfaced in the UI so a dev build talking
 *  to a local backend is never mistaken for the real thing. */
export const IS_CUSTOM_API = API_BASE_URL !== DEFAULT_API_URL;
