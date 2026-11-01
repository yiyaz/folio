import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', ws: true },
      '/healthz': 'http://localhost:3000',
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 4000,
  },
  test: { environment: 'jsdom' },
} as never);
