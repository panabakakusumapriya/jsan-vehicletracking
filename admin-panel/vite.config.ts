import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Local development uses the local API. Production is available only through an explicit
// --mode prod or BACKEND_URL override, so startup timing cannot select an old deployed API.
const LOCAL = 'http://localhost:4000';
const RAILWAY = 'https://backend-jsan-vehicletracking-production.up.railway.app';

async function pickBackend(mode: string): Promise<{ url: string; why: string }> {
  if (process.env.BACKEND_URL) return { url: process.env.BACKEND_URL, why: 'BACKEND_URL env var' };
  if (mode === 'prod' || mode === 'railway') return { url: RAILWAY, why: '--mode prod' };
  if (mode === 'local') return { url: LOCAL, why: '--mode local' };

  return { url: LOCAL, why: 'local development backend' };
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
