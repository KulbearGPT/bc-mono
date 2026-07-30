import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.DASHBOARD_E2E_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': apiTarget,
      // The local E2E OAuth adapter follows the same reverse-proxy boundary as
      // the production-facing API. It is only served by the test harness.
      '/__e2e': apiTarget
    }
  }
});
