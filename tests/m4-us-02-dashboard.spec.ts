import { describe, expect, test } from 'vitest';
import { buildSupportWorkbench } from '@blackcat/dashboard/support-workbench';

describe('M4-US-02 support workbench UI model', () => {
  test('groups personal and unclaimed work with operational status and Discord links', () => {
    const view = buildSupportWorkbench({
      guildId: '999999999999999999',
      currentStaffId: 'staff-1',
      permissions: ['staff_task.read', 'staff_task.claim', 'staff_task.verify'],
      tasks: [
        { id: 't1', publicId: 'T-1', type: 'ORDER_ASSIST', status: 'OPEN', version: 1, claimedBy: null, orderId: 'o1', channelId: 'c1', voiceChannelId: null, createdAt: '2026-07-18T01:00:00Z' },
        { id: 't2', publicId: 'T-2', type: 'CANCELLATION_ASSIST', status: 'CLAIMED', version: 2, claimedBy: 'staff-1', orderId: 'o2', channelId: 'c2', voiceChannelId: 'v2', createdAt: '2026-07-18T02:00:00Z' }
      ]
    });
    expect(view.filters.map((filter) => filter.id)).toEqual(['ALL', 'MINE', 'UNCLAIMED']);
    expect(view.sections.mine).toHaveLength(1);
    expect(view.sections.unclaimed).toHaveLength(1);
    expect(view.sections.mine[0]).toMatchObject({ statusLabel: '处理中', links: { orderChannel: expect.stringContaining('/c2'), voiceChannel: expect.stringContaining('/v2') } });
    expect(view.sections.unclaimed[0]?.actions).toContainEqual(expect.objectContaining({ id: 'CLAIM', enabled: true }));
  });
});
