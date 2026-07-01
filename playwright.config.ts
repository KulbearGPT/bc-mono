import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/dashboard',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'evidence/P0/dashboard-e2e/junit.xml' }], ['html', { outputFolder: 'evidence/P0/dashboard-e2e/html', open: 'never' }]] : [['list'], ['html', { outputFolder: 'evidence/P0/dashboard-e2e/html', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    launchOptions: {
      slowMo: Number(process.env.E2E_SLOW_MO ?? 0)
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'tsx tests/e2e/dashboard/fixture-server.ts',
      url: 'http://127.0.0.1:3000/health',
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: 'npm run dev -w @blackcat/dashboard -- --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 30_000
    }
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
