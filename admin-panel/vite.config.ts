import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev proxy target for /api + /socket.io (keeps the panel single-origin: no CORS, clean
 * websocket upgrades).
 *
 * This USED to default to the Railway backend, which meant "npm run dev" silently pointed
 * local work at production — and when that deploy is stale you get a 404 on /api/auth/login
 * that looks like a bug in the panel. So the default is now decided by what is actually
 * running, and the choice is printed at startup instead of being invisible.
 *
 * Order of precedence:
 *   1. BACKEND_URL=...      explicit wins, always
 *   2. --mode local | prod  explicit intent
 *   3. auto                 local backend if it answers /health, else the deployed one
 */
const LOCAL = 'http://localhost:4000';
const RAILWAY = 'https://backend-jsan-vehicletracking-production.up.railway.app';

async function pickBackend(mode: string): Promise<{ url: string; why: string }> {
  if (process.env.BACKEND_URL) return { url: process.env.BACKEND_URL, why: 'BACKEND_URL env var' };
  if (mode === 'prod' || mode === 'railway') return { url: RAILWAY, why: '--mode prod' };
  if (mode === 'local') return { url: LOCAL, why: '--mode local' };

  try {
    const res = await fetch(`${LOCAL}/health`, { signal: AbortSignal.timeout(700) });
    if (res.ok) return { url: LOCAL, why: 'local backend is running on :4000' };
  } catch {
    /* nothing listening locally — fall through to the deployed backend */
  }
  return { url: RAILWAY, why: 'no local backend on :4000' };
}

export default defineConfig(async ({ mode }) => {
  const { url: backend, why } = await pickBackend(mode);

  // eslint-disable-next-line no-console
  console.log(`\n  ⇢ API proxy → ${backend}\n    (${why})\n`);
  if (backend === RAILWAY) {
    // eslint-disable-next-line no-console
    console.log(
      '  ⚠  This is PRODUCTION. Start the backend (cd backend && npm run dev) and restart\n' +
        '     Vite to work locally, or run `npm run dev:local`.\n'
    );
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/uploads': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, ws: true, changeOrigin: true },
        '/health': { target: backend, changeOrigin: true },
      },
    },
  };
});
