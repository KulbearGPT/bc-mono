import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { dashboardFieldLabel } from '../apps/dashboard/src/table-labels.js';

describe('Dashboard Chinese table headers', () => {
  test('translates operational and business API fields to Chinese', () => {
    expect(dashboardFieldLabel('id')).toBe('编号');
    expect(dashboardFieldLabel('actorId')).toBe('操作者编号');
    expect(dashboardFieldLabel('permissionCode')).toBe('权限代码');
    expect(dashboardFieldLabel('amountMinor')).toBe('金额');
    expect(dashboardFieldLabel('runAfter')).toBe('计划执行时间');
    expect(dashboardFieldLabel('displayName')).toBe('展示名称');
    expect(dashboardFieldLabel('unknownVendorField')).toBe('数据字段');
    expect(dashboardFieldLabel('状态')).toBe('状态');
  });

  test('uses Chinese labels while preserving the API field in a tooltip', () => {
    for (const file of ['AdminBusinessPage.tsx', 'OperationsPage.tsx']) {
      const source = readFileSync(`apps/dashboard/src/${file}`, 'utf8');
      expect(source, file).toContain('dashboardFieldLabel(column)');
      expect(source, file).toContain('title={column}');
      expect(source, file).not.toContain('scope="col">{column}</th>');
    }
  });
});
