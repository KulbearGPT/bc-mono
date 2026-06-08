import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminBusinessPage } from '@blackcat/dashboard/admin-business';

const pageSources = [
  'AdminBusinessPage.tsx',
  'CustomerProfilePage.tsx',
  'OperationsPage.tsx',
  'SecurityPage.tsx',
  'SettlementPage.tsx',
  'SupportWorkbenchPage.tsx'
] as const;

describe('Dashboard release visual gate', () => {
  test('renders the service-version workflow with a structured, responsive form instead of flowing labels', () => {
    const model = buildAdminBusinessPage({
      page: 'serviceCatalog',
      permissions: ['catalog.read', 'catalog.manage'],
      status: 'READY',
      items: [{ id: 'service-1', version: 1 }]
    });
    const action = model.actions.find((item) => item.id === 'CREATE_SERVICE_VERSION');
    expect(action).toBeDefined();

    const html = renderToStaticMarkup(createElement(AdminBusinessPage, {
      model,
      activeAction: { action: action! },
      onSubmitAction: () => undefined
    }));

    expect(html).toContain('class="action-panel"');
    expect(html).toContain('class="form-grid"');
    expect(html).toContain('class="field"');
    expect(html).toContain('class="checkbox-field"');
    expect(html).not.toContain('style="');
  });

  test('uses one shared visual system across every released Dashboard page', () => {
    for (const file of pageSources) {
      const source = readFileSync(`apps/dashboard/src/${file}`, 'utf8');
      expect(source, file).toContain('dashboard-page');
      expect(source, file).not.toMatch(/style=\{\{/u);
      expect(source, file).not.toMatch(/style=\{[a-zA-Z]/u);
    }
  });

  test('defines bounded panels, stable form tracks, table containment and all required responsive widths', () => {
    const styles = readFileSync('apps/dashboard/src/styles.css', 'utf8');
    for (const selector of [
      '.content-panel',
      '.action-panel',
      '.form-grid',
      '.field',
      '.checkbox-field',
      '.table-scroll',
      '.metric-grid',
      '.state-card'
    ]) expect(styles).toContain(selector);
    expect(styles).toMatch(/\.form-grid\s*\{[\s\S]*repeat\(auto-fit,\s*minmax\(min\(100%,\s*260px\),\s*1fr\)\)/u);
    expect(styles).toMatch(/\.table-scroll\s*\{[\s\S]*overflow-x:\s*auto/u);
    for (const width of [375, 768, 1024, 1440]) expect(styles).toContain(`--qa-viewport-${width}`);
  });

  test('adds a restrained gaming-tech layer without replacing the readable operations theme', () => {
    const styles = readFileSync('apps/dashboard/src/styles.css', 'utf8');
    expect(styles).toContain('--accent-electric');
    expect(styles).toContain('--accent-neon-cyan');
    expect(styles).toMatch(/\.dashboard-workspace::before\s*\{/u);
    expect(styles).toMatch(/\.page-heading::after\s*\{/u);
    expect(styles).toMatch(/\.content-panel::before[\s\S]*linear-gradient/u);
    expect(styles).toMatch(/\.action-panel::after[\s\S]*border-top/u);
    expect(styles).toMatch(/\.brand-mark[\s\S]*animation:\s*brand-pulse/u);
    expect(styles).toContain('@keyframes brand-pulse');
    expect(styles).toContain('prefers-reduced-motion: reduce');
  });

  test('extends the tactical operations language through daily workflow surfaces', () => {
    const styles = readFileSync('apps/dashboard/src/styles.css', 'utf8');
    expect(styles).toMatch(/\.dashboard-workspace\s*\{[\s\S]*#050812/u);
    expect(styles).toMatch(/\.content-panel\s*\{[\s\S]*clip-path/u);
    expect(styles).toMatch(/\.filter-bar::before\s*\{[\s\S]*QUERY FILTERS/u);
    expect(styles).toMatch(/\.state-card::before\s*\{[\s\S]*QUERY RESULT/u);
    expect(styles).toMatch(/\.dashboard-content table\s*\{[\s\S]*var\(--font-mono\)/u);
    expect(styles).toMatch(/\.dashboard-content tbody tr:hover\s*\{[\s\S]*box-shadow:\s*inset 3px 0/u);
  });
});
