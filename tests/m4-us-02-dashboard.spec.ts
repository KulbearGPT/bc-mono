import { describe, expect, test } from 'vitest';
import { buildSupportWorkbench } from '@blackcat/dashboard/support-workbench';

describe('M4-US-02 support workbench UI model', () => {
  test('groups personal and unclaimed work with operational status and Discord links', () => {
    const view = buildSupportWorkbench({
      guildId: '999999999999999999',
      currentStaffId: 'staff-1',
      permissions: ['staff_task.read', 'staff_task.claim', 'staff_task.verify'],
      tasks: [
        { id: 't1', publicId: 'T-1', type: 'ORDER_ASSIST', status: 'OPEN', version: 1, claimedBy: null, orderId: 'o1', createdAt: '2026-07-18T01:00:00Z', links: { orderChannel: 'https://discord.com/channels/999999999999999999/111111111111111111', voiceChannel: null }, triage: triage('P-1') },
        { id: 't2', publicId: 'T-2', type: 'CANCELLATION_ASSIST', status: 'CLAIMED', version: 2, claimedBy: 'staff-1', orderId: 'o2', createdAt: '2026-07-18T02:00:00Z', links: { orderChannel: 'https://discord.com/channels/999999999999999999/222222222222222222', voiceChannel: 'https://discord.com/channels/999999999999999999/333333333333333333' }, triage: triage('P-2') }
      ]
    });
    expect(view.filters.map((filter) => filter.id)).toEqual(['ALL', 'MINE', 'UNCLAIMED']);
    expect(view.sections.mine).toHaveLength(1);
    expect(view.sections.unclaimed).toHaveLength(1);
    expect(view.sections.mine[0]).toMatchObject({ statusLabel: '处理中', links: { orderChannel: expect.stringContaining('/222222222222222222'), voiceChannel: expect.stringContaining('/333333333333333333') } });
    expect(view.sections.unclaimed[0]?.actions).toContainEqual(expect.objectContaining({ id: 'CLAIM', enabled: true }));
  });

  test('fails closed for malformed or non-Discord links instead of constructing a browser URL', () => {
    const view = buildSupportWorkbench({ guildId: '', currentStaffId: 'staff-1', permissions: ['staff_task.read'], tasks: [
      { id: 't3', publicId: 'T-3', type: 'ORDER_ASSIST', status: 'OPEN', version: 1, claimedBy: null, orderId: 'o3', createdAt: '2026-07-18T03:00:00Z',
        links: { orderChannel: 'https://discord.com/channels//333333333333333333', voiceChannel: 'https://example.com/channels/999999999999999999/333333333333333333' }, triage: triage('P-3') }
    ] });
    expect(view.sections.unclaimed[0]?.links).toEqual({ orderChannel: null, voiceChannel: null });
  });
});

function triage(orderPublicId: string) {
  return { orderPublicId, customerDisplayName: '客户', gameDisplayName: '游戏', serviceDisplayName: '服务', amountMinor: 1000, currency: 'CAT', reasonLabel: '需要协助', waitStartedAt: '2026-07-18T01:00:00Z', nextActionLabel: '认领并联系客户' };
}
