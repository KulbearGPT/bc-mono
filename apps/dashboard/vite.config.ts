import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      // The local E2E OAuth adapter follows the same reverse-proxy boundary as
      // the production-facing API. It is only served by the test harness.
      '/__e2e': 'http://localhost:3000'
    }
  }
});
