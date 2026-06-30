import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

describe('M12-US-02 dashboard contract', () => {
  test('support page exposes only minimal clock and 30-day summary actions', () => {
    const source = readFileSync('apps/dashboard/src/SupportWorkbenchPage.tsx', 'utf8');
    expect(source).toContain('/api/v1/admin/support-shifts/me');
    expect(source).toContain('/api/v1/admin/support-shifts/clock-in');
    expect(source).toContain('/api/v1/admin/support-shifts/clock-out');
    expect(source).toContain('/api/v1/admin/support/summary');
    expect(source).toContain('最近 30 天客服记录');
    expect(source).not.toMatch(/排班管理|薪资计算|导出 CSV/);
  });
});
