/**
 * Backend base URL used by the app AND handed to the native tracking service.
 *  - Defaults to the deployed Railway backend.
 *  - Override per-build with EXPO_PUBLIC_API_URL in a .env file, e.g.
 *      EXPO_PUBLIC_API_URL=http://192.168.1.20:4000   (local dev on a LAN)
 */
const DEFAULT_API_URL = 'https://backend-jsan-vehicletracking-production.up.railway.app';

export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
