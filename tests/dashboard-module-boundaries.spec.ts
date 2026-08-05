import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

const dashboardSourceDirectory = 'apps/dashboard/src';

describe('Dashboard module boundaries', () => {
  test('keeps every TypeScript source below the giant-file threshold', () => {
    const oversized = readdirSync(dashboardSourceDirectory)
      .filter((name) => ['.ts', '.tsx'].includes(extname(name)))
      .map((name) => ({ name, lines: readFileSync(join(dashboardSourceDirectory, name), 'utf8').split('\n').length }))
      .filter((file) => file.lines > 500);

    expect(oversized).toEqual([]);
  });

  test('assigns actions, details, support panels and application chrome to dedicated modules', () => {
    const adminPage = readFileSync(join(dashboardSourceDirectory, 'AdminBusinessPage.tsx'), 'utf8');
    const adminModel = readFileSync(join(dashboardSourceDirectory, 'admin-business.ts'), 'utf8');
    const supportPage = readFileSync(join(dashboardSourceDirectory, 'SupportWorkbenchPage.tsx'), 'utf8');
    const app = readFileSync(join(dashboardSourceDirectory, 'App.tsx'), 'utf8');

    expect(adminPage).toContain("from './AdminBusinessActionPanel.js'");
    expect(adminPage).toContain("from './AdminBusinessDetail.js'");
    expect(adminPage).not.toContain('function ActionFields');
    expect(adminPage).not.toContain('function AdminDetailRegion');

    expect(adminModel).toContain("from './admin-business-actions.js'");
    expect(adminModel).not.toContain('function buildAdminActionRequest');

    expect(supportPage).toContain("from './SupportWorkbenchPanels.js'");
    expect(supportPage).not.toContain('function SupportAutomationControl');

    expect(app).toContain("from './DashboardChrome.js'");
    expect(app).not.toContain('function DashboardChrome');
  });
});
