import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolveBotConfigBoolean, type BotConfigStore } from '@blackcat/api/bot-config';
import { buildAdminActionRequest, buildAdminBusinessPage } from '@blackcat/dashboard/admin-business';

describe('M9-US-15 automatic/manual dispatch mode', () => {
  test('resolves the guild auto-dispatch switch with a safe fallback', async () => {
    const store = { get: vi.fn().mockResolvedValue({ guildId: 'guild', version: 1, values: { auto_dispatch_enabled: false } }) } as unknown as BotConfigStore;
    await expect(resolveBotConfigBoolean(store, 'guild', 'auto_dispatch_enabled', true)).resolves.toBe(false);
    await expect(resolveBotConfigBoolean(undefined, 'guild', 'auto_dispatch_enabled', true)).resolves.toBe(true);
  });

  test('worker gates initial and timeout retry while dashboard exposes manual dispatch', async () => {
    const [worker, adminBusiness, route] = await Promise.all([
      readFile('apps/api/src/worker.ts', 'utf8'),
      readFile('apps/dashboard/src/admin-business.ts', 'utf8'),
      readFile('apps/api/src/dispatch.ts', 'utf8')
    ]);
    expect(worker.match(/auto_dispatch_enabled/gu)).toHaveLength(2);
    expect(adminBusiness).toContain('MANUAL_DISPATCH');
    expect(route).toContain("acceptedSources: ['SYSTEM_JOB', 'DASHBOARD']");
    expect(route).toContain("body.trigger === 'MANUAL_RETRY'");
  });

  test('maps the L4 order action to a single 90-second manual round', () => {
    const page = buildAdminBusinessPage({
      page: 'orders',
      permissions: ['order.read', 'dispatch.execute'],
      status: 'READY',
      items: [{ id: 'order-1', version: 7, status: 'PENDING_DISPATCH' }]
    });
    expect(page.actions).toContainEqual(expect.objectContaining({ id: 'MANUAL_DISPATCH' }));
    expect(buildAdminActionRequest({
      actionId: 'MANUAL_DISPATCH',
      item: { id: 'order-1', version: 7, status: 'PENDING_DISPATCH' },
      fields: {}
    })).toEqual({
      method: 'POST',
      path: '/api/v1/orders/order-1/dispatch',
      body: { expectedVersion: 7, trigger: 'MANUAL_RETRY' }
    });
  });
});
