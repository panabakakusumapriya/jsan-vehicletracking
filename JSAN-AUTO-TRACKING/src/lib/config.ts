/**
 * Backend base URL.
 *  - Android emulator reaches your PC's localhost via 10.0.2.2
 *  - On a physical device, set EXPO_PUBLIC_API_URL to your PC's LAN IP,
 *    e.g. EXPO_PUBLIC_API_URL=http://192.168.1.20:4000  (in an .env file)
 */
export const API_BASE_URL =
  (process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:4000').replace(/\/$/, '');
