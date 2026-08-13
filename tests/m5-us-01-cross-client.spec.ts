import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M5-US-01 cross-client candidate gate', () => {
  test('AT-AUD-004 and AT-MET-001 retain executable Bot/Dashboard parity regressions', async () => {
    const [operations, metrics] = await Promise.all([
      readFile('tests/m4-us-06-api.spec.ts', 'utf8'),
      readFile('tests/m4-us-09-api.spec.ts', 'utf8')
    ]);

    expect(operations).toContain('produces the same retry state and audit facts through Bot and Dashboard clients');
    expect(metrics).toContain('serves the same scoped summary to Dashboard and Sapphire Bot clients');
    expect(metrics).toContain("'x-client-source':'DASHBOARD'");
    expect(metrics).toContain("'x-client-source':'DISCORD_BOT'");
  });

  test('AT-RBAC-001 keeps final authorization in the API instead of either client', async () => {
    const [botPackage, dashboardPackage, policyTest] = await Promise.all([
      readFile('apps/bot/package.json', 'utf8'),
      readFile('apps/dashboard/package.json', 'utf8'),
      readFile('tests/m4-us-07-policy.spec.ts', 'utf8')
    ]);

    expect(botPackage).not.toMatch(/"(?:pg|@prisma\/client)"/u);
    expect(dashboardPackage).not.toMatch(/"(?:pg|@prisma\/client)"/u);
    expect(policyTest).toContain('uses identical API authorization for Bot and Dashboard actors and audits both denials');
  });

  test('runs every reproducible candidate command in the dedicated P0 CI workflow', async () => {
    const [workflow, layeredGate] = await Promise.all([
      readFile('.github/workflows/p0-ci.yml', 'utf8'),
      readFile('scripts/non-ui/gate-definition.mjs', 'utf8')
    ]);
    for (const command of [
      'node scripts/build-p0-acceptance-matrix.mjs', 'npm run test:non-ui:full', 'npm run typecheck', 'npm run build',
      'npx vite build apps/dashboard', 'npm run db:validate', 'npm run db:verify:migration',
      'npm run pieces -w @blackcat/bot', 'git diff --check'
    ]) expect(workflow).toContain(command);
    expect(layeredGate).toContain("step('repository-regression', 'npm', ['test'])");
  });
});
