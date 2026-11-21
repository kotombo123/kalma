import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const api = process.env.API_PROXY ?? 'http://localhost:3000';
const ingest = process.env.INGEST_PROXY ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, rewrite: (p) => p.replace(/^\/api/, '') },
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
      // "Send a test event" from the connect screen
      '/ingest': { target: ingest },
    },
  },
});
