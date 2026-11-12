import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds only the frame-test page (bench.html). Output goes to BENCH_OUT; the stand-in server in
// bench/server.mjs serves it together with the saved map data.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: process.env.BENCH_OUT || 'dist-bench',
    emptyOutDir: true,
    rollupOptions: { input: 'bench.html' },
  },
});
