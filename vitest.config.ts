import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 10_000
  },
  resolve: {
    alias: {
      '@blackcat/platform': new URL('./modules/platform/src', import.meta.url).pathname,
      '@blackcat/api': new URL('./apps/api/src', import.meta.url).pathname,
      '@blackcat/bot': new URL('./apps/bot/src', import.meta.url).pathname,
      '@blackcat/dashboard': new URL('./apps/dashboard/src', import.meta.url).pathname,
      '@blackcat/database': new URL('./database/src', import.meta.url).pathname
    }
  }
});
