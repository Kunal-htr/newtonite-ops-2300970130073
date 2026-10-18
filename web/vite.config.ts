import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the browser only talks to Vite; these paths are proxied to the Express
// API on :3000, so the app is same-origin and CORS is never involved.
// Note: /me (not /auth/me) is a separate top-level route on the API.
// Production: the API serves the built files in web/dist (see src/server.ts).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:3000',
      '/me': 'http://localhost:3000',
      '/items': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
