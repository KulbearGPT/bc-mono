import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { enqueuePeriodicRoleReconciliation } from '@blackcat/api/access';

describe('M4-US-05 Role sync reliability maintenance', () => {
  test('deduplicates a five-minute periodic full reconciliation in PostgreSQL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'job-1' }] });
    const queued = await enqueuePeriodicRoleReconciliation({
      client: { query },
      guildId: '900000000000000001',
      now: new Date('2026-08-10T12:07:00.000Z'),
      intervalMs: 5 * 60_000
    });
    expect(queued).toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("'ROLE_RECONCILIATION'"), expect.arrayContaining([
      '900000000000000001',
      'role-reconciliation:periodic:900000000000000001:5954545'
    ]));
  });

  test('shows sync evidence and a per-staff reconciliation control on the access page', async () => {
    const source = await readFile('apps/dashboard/src/AccessManagementPage.tsx', 'utf8');
    expect(source).toContain('最近同步');
    expect(source).toContain('当前观察 Role');
    expect(source).toContain('上次同步错误');
    expect(source).toContain('立即从 Discord 对账');
  });

  test('explains that a changed permission requires a fresh login', async () => {
    const source = await readFile('apps/dashboard/src/DashboardChrome.tsx', 'utf8');
    expect(source).toContain('权限已变化，请重新登录');
  });

  test('worker schedules periodic role reconciliation instead of startup-only repair', async () => {
    const source = await readFile('apps/api/src/worker.ts', 'utf8');
    expect(source).toContain('ROLE_RECONCILIATION_INTERVAL_MS');
    expect(source).toContain('enqueuePeriodicRoleReconciliation');
  });
});
