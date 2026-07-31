import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const RAILWAY = 'https://backend-jsan-vehicletracking-production.up.railway.app';
const LOCAL = 'http://localhost:4000';

/**
 * Which backend does `npm run dev` talk to?
 *
 * It used to always be Railway, which is a trap: you build a new endpoint, run the panel,
 * and it silently calls production — where that route does not exist yet — so the feature
 * 404s and looks broken locally.
 *
 * Now it picks automatically:
 *   BACKEND_URL=...      explicit, wins over everything
 *   --mode local|prod    explicit, for when you want to force one
 *   otherwise            use the local backend IF it is running, else Railway
 *
 * Either way the choice is printed at startup, so it is never a mystery.
 */
async function pickBackend(mode: string): Promise<{ url: string; why: string }> {
  if (process.env.BACKEND_URL) {
    return { url: process.env.BACKEND_URL, why: 'BACKEND_URL env var' };
  }
  if (mode === 'prod' || mode === 'railway') {
    return { url: RAILWAY, why: '--mode prod' };
  }
  if (mode === 'local') {
    return { url: LOCAL, why: '--mode local' };
  }
  // Auto: a running local backend is almost always the one you meant.
  try {
    const res = await fetch(`${LOCAL}/health`, { signal: AbortSignal.timeout(700) });
    if (res.ok) return { url: LOCAL, why: 'local backend is running' };
  } catch {
    /* not running — fall through */
  }
  return { url: RAILWAY, why: 'no local backend on :4000' };
}

export default defineConfig(async ({ mode }) => {
  const { url: backend, why } = await pickBackend(mode);
  const isLocal = /localhost|127\.0\.0\.1/.test(backend);

  return {
    plugins: [
      react(),
      {
        name: 'announce-proxy-target',
        configureServer() {
          // eslint-disable-next-line no-console
          console.log(`\n  API proxy → ${backend}`);
          // eslint-disable-next-line no-console
          console.log(`  reason    : ${why}`);
          if (!isLocal) {
            // eslint-disable-next-line no-console
            console.log(
              '  ⚠  This is PRODUCTION. Anything not deployed yet will 404.\n' +
                '     Start the backend (cd backend && npm run dev) and restart this,\n' +
                '     or force it with:  npm run dev:local\n'
            );
          } else {
            // eslint-disable-next-line no-console
            console.log('');
          }
        },
      },
    ],
    server: {
      port: 5173,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/socket.io': { target: backend, ws: true, changeOrigin: true },
        '/health': { target: backend, changeOrigin: true },
      },
    },
  };
});
