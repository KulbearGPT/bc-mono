import { readFile, readdir, stat } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const retiredRuntimeFiles = [
  'apps/api/src/funding-adapter-runtime.ts',
  'apps/api/src/http-payment-adapter.ts',
  'apps/api/src/payment-adapter.ts',
  'apps/api/src/webhooks.ts'
];

const currentRuntimeFiles = [
  'apps/api/src/server.ts',
  'apps/api/src/index.ts',
  'apps/api/src/worker.ts',
  'apps/api/src/accounts.ts',
  'apps/api/src/orders.ts',
  'apps/api/src/gifts.ts',
  'apps/api/src/admin-order-actions.ts',
  'apps/api/src/customer-profiles.ts',
  'apps/api/src/admin-directory.ts',
  'apps/bot/src/service-center.ts',
  'apps/bot/src/gifts.ts',
  'apps/dashboard/src/CustomerProfilePage.tsx',
  '.env.example',
  'docker-compose.yml',
  'docker-compose.production.yml',
  'scripts/verify-production-env.mjs'
];

describe('M7-US-07 Provider funding retirement', () => {
  test('deletes Provider funding adapters and payment Webhook runtime', async () => {
    for (const file of retiredRuntimeFiles) {
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('contains no current Provider funding, binding, recharge URL, or CNY runtime contract', async () => {
    const runtime = (await Promise.all(currentRuntimeFiles.map((file) => readFile(file, 'utf8')))).join('\n');
    expect(runtime).not.toMatch(/getProviderBalance|createHold|captureHold|releaseHold|createReservationDebit|createRefund/u);
    expect(runtime).not.toMatch(/providerBalanceMinor|PROVIDER_(?:TIMEOUT|UNAVAILABLE)|PAYMENT_PROVIDER_|RECHARGE_URL/u);
    expect(runtime).not.toMatch(/binding-modal|modal:binding|\/api\/v1\/bindings|\/api\/v1\/webhooks\/payment/u);
    expect(runtime).not.toMatch(/provider_balance_snapshots|JOIN external_accounts|FROM external_accounts/u);
    expect(runtime).not.toMatch(/currency:\s*['"]CNY['"]|defaultValue=['"]CNY['"]/u);
  });

  test('inventories every mutation route and production worker handler under the universal audit contract', async () => {
    const acceptance = await readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8');
    const acceptanceIds = ['AT-AUD-005', 'AT-AUD-006', 'AT-AUD-007', 'AT-AUD-008'];
    for (const id of acceptanceIds) expect(acceptance).toContain(id);

    const routeInventory: Array<Record<string, string>> = [];
    for (const file of (await readdir('apps/api/src')).filter((name) => name.endsWith('.ts') && name !== 'security.ts').sort()) {
      const source = await readFile(`apps/api/src/${file}`, 'utf8');
      for (const match of source.matchAll(/registerSecureWriteRoute\s*\(/gu)) {
        const registration = source.slice(match.index, match.index + 1_800);
        routeInventory.push({
          id: `${file}:${requiredMatch(registration, /method\s*:\s*['"](POST|PUT|PATCH|DELETE)['"]/u)}`
            + `:${requiredMatch(registration, /url\s*:\s*['"]([^'"]+)['"]/u)}`,
          actorSources: registration.match(/acceptedSources\s*:\s*\[([^\]]+)\]/u)?.[1]?.replaceAll(/\s+/gu, '') ?? 'ALL_TRUSTED',
          primaryTarget: requiredMatch(registration, /targetType\s*:\s*['"]([^'"]+)['"]/u),
          action: requiredMatch(registration, /action\s*:\s*['"]([^'"]+)['"]/u),
          successChangeBuilder: 'registerSecureWriteRoute:primary-or-explicit-audit-changes',
          failureRejectionAuditPath: 'registerSecureWriteRoute:FAILED-or-REJECTED',
          acceptanceIds: acceptanceIds.join(';')
        });
      }
    }

    const workerRuntime = await readFile('apps/api/src/worker-runtime.ts', 'utf8');
    const handlerMap = workerRuntime.slice(workerRuntime.indexOf('const handlers:'), workerRuntime.indexOf('return handlers;'));
    const workerInventory = [...handlerMap.matchAll(/(?:handlers\.)?([A-Z][A-Z_]+)\s*[:=]\s*input\./gu)].map((match) => ({
      id: `worker:${match[1]}`,
      actorSources: 'SYSTEM_JOB',
      primaryTarget: 'outbox_event+aggregate',
      action: `PROCESS_${match[1]}`,
      successChangeBuilder: 'OutboxWorker:job-and-aggregate-changes',
      failureRejectionAuditPath: 'OutboxWorker:FAILED',
      acceptanceIds: acceptanceIds.join(';')
    }));

    expect(routeInventory).toHaveLength(79);
    expect(workerInventory).toHaveLength(10);
    const inventory = [...routeInventory, ...workerInventory];
    expect(new Set(inventory.map(({ id }) => id)).size).toBe(inventory.length);
    for (const entry of inventory) {
      expect(Object.values(entry).every((value) => value.length > 0), entry.id).toBe(true);
      expect(entry.acceptanceIds).toBe(acceptanceIds.join(';'));
    }
  });
});

function requiredMatch(source: string, pattern: RegExp): string {
  const value = source.match(pattern)?.[1];
  if (!value) throw new Error(`Mutation audit inventory could not resolve ${pattern}.`);
  return value;
}
