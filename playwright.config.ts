import { defineConfig, devices } from '@playwright/test';

const apiPort = Number(process.env.DASHBOARD_E2E_API_PORT ?? 3000);
const dashboardPort = Number(process.env.DASHBOARD_E2E_PORT ?? 5173);
const apiUrl = `http://127.0.0.1:${apiPort}`;
const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;

export default defineConfig({
  testDir: './tests/e2e/dashboard',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'evidence/P0/dashboard-e2e/junit.xml' }], ['html', { outputFolder: 'evidence/P0/dashboard-e2e/html', open: 'never' }]] : [['list'], ['html', { outputFolder: 'evidence/P0/dashboard-e2e/html', open: 'never' }]],
  use: {
    baseURL: dashboardUrl,
    launchOptions: {
      slowMo: Number(process.env.E2E_SLOW_MO ?? 0)
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: [
    {
      command: `DASHBOARD_E2E_API_PORT=${apiPort} DASHBOARD_E2E_PORT=${dashboardPort} tsx tests/e2e/dashboard/fixture-server.ts`,
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 30_000
    },
    {
      command: `DASHBOARD_E2E_API_URL=${apiUrl} npm run dev -w @blackcat/dashboard -- --host 127.0.0.1 --port ${dashboardPort}`,
      url: dashboardUrl,
      reuseExistingServer: false,
      timeout: 30_000
    }
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], serviceWorkers: 'block' } }
  ]
});
