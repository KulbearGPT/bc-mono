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
    expect(dashboardFieldLabel('offeringKey')).toBe('服务组合代码');
    expect(dashboardFieldLabel('game')).toBe('游戏');
    expect(dashboardFieldLabel('service')).toBe('服务类型');
    expect(dashboardFieldLabel('billingUnitMinutes')).toBe('计费单位（分钟）');
    expect(dashboardFieldLabel('minimumUnits')).toBe('最低购买单位');
    expect(dashboardFieldLabel('customerUnitPriceMinor')).toBe('客户单价');
    expect(dashboardFieldLabel('playerUnitPayoutMinor')).toBe('陪玩单位收益');
    expect(dashboardFieldLabel('defaultPlayerPayoutBps')).toBe('默认陪玩分成（基点）');
    expect(dashboardFieldLabel('archivedAt')).toBe('归档时间');
    expect(dashboardFieldLabel('gameTags')).toBe('游戏标签');
    expect(dashboardFieldLabel('discordPresence')).toBe('Discord 在线状态');
    expect(dashboardFieldLabel('broadcastTemplate')).toBe('播报模板');
    expect(dashboardFieldLabel('unknownVendorField')).toBe('其他信息');
    expect(dashboardFieldLabel('状态')).toBe('状态');
  });

  test('uses Chinese labels while preserving the API field in a tooltip', () => {
    for (const file of ['AdminBusinessPage.tsx', 'OperationsPage.tsx']) {
      const source = readFileSync(`apps/dashboard/src/${file}`, 'utf8');
      expect(source, file).toContain(file==='AdminBusinessPage.tsx'?'dashboardFieldLabel(column.key)':'dashboardFieldLabel(column)');
      expect(source, file).toContain(file==='AdminBusinessPage.tsx'?'title={column.key}':'title={column}');
      expect(source, file).not.toContain('scope="col">{column}</th>');
    }
  });

  test('covers every service catalog column without a generic fallback', () => {
    const fields = [
      'id', 'offeringKey', 'serviceOfferingId', 'game', 'service', 'region',
      'billingUnitMinutes', 'minimumUnits', 'customerUnitPriceMinor',
      'playerUnitPayoutMinor', 'defaultPlayerPayoutBps', 'currency', 'status',
      'version', 'createdByStaffId', 'createdAt', 'activatedAt', 'retiredAt',
      'archivedAt', 'enabled'
    ];
    const labels = fields.map(dashboardFieldLabel);
    expect(labels).not.toContain('数据字段');
    expect(labels.every((label) => !label.startsWith('未映射字段：'))).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
