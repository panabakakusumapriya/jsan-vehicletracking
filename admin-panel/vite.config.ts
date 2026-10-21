import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

// The browser closing a live-socket connection mid-write (a reload, a tab closed, the client
// reconnecting with a new token) makes Vite print "ws proxy socket error: ECONNABORTED" and a
// stack trace. Nothing is wrong when that happens, so those three codes are dropped from the log;
// every other proxy error — ECONNREFUSED when the backend is down, above all — is still shown.
const HARMLESS_WS_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'EPIPE']);
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (msg, options) => {
  const code = (options?.error as NodeJS.ErrnoException | null | undefined)?.code;
  if (code && HARMLESS_WS_CODES.has(code) && msg.includes('ws proxy')) return;
  logError(msg, options);
};

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
    customLogger: logger,
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
