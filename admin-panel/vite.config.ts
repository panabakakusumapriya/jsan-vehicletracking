import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, proxy API + Socket.IO to the backend so the panel is single-origin
// (no CORS) and websockets upgrade cleanly. Defaults to the deployed Railway
// backend; override with BACKEND_URL=http://localhost:4000 for local dev.
const backend = process.env.BACKEND_URL || 'https://backend-jsan-vehicletracking-production.up.railway.app';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/socket.io': { target: backend, ws: true, changeOrigin: true },
      '/health': { target: backend, changeOrigin: true },
    },
  },
});
