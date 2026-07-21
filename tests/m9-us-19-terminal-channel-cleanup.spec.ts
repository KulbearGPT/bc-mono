import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  createTerminalChannelArchiveHandler,
  type DiscordChannelMessageSnapshot,
  type TerminalChannelCleanupProjection,
  type TerminalChannelCleanupStore
} from '../apps/api/src/order-channel-cleanup.js';
import type { OutboxJob } from '../apps/api/src/outbox.js';
import { DiscordRestDeliveryAdapter } from '../apps/api/src/worker-delivery.js';

const projection: TerminalChannelCleanupProjection = {
  orderId: '00000000-0000-0000-0000-000000009019',
  publicId: 'P-9019',
  status: 'COMPLETED',
  guildId: '123456789012345678',
  textChannelId: '223456789012345678',
  selectionVoiceChannelId: '323456789012345678',
  serviceVoiceChannelId: '423456789012345678'
};

describe('M9-US-19 terminal order channel cleanup', () => {
  test('backfills every visible message before deleting voice channels and finally the text channel', async () => {
    const effects: string[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => message(String(1_000 - index)));
    const lastPage = [message('900')];
    const store: TerminalChannelCleanupStore = {
      getProjection: vi.fn().mockResolvedValue(projection),
      appendSnapshot: vi.fn(async ({ message: item }) => effects.push(`append:${item.id}`)),
      enqueueDueTerminalOrders: vi.fn()
    };
    const listChannelMessages = vi.fn(async (_channelId: string, before: string | null) =>
      before === null ? firstPage : lastPage
    );
    const handler = createTerminalChannelArchiveHandler({
      store,
      discord: {
        freezeChannelIfExists: vi.fn(async (channelId) => effects.push(`freeze:${channelId}`)),
        listChannelMessages,
        deleteChannelIfExists: vi.fn(async (channelId) => effects.push(`delete:${channelId}`))
      },
      now: () => new Date('2026-08-07T12:00:00.000Z')
    });

    await handler(job());

    expect(listChannelMessages).toHaveBeenNthCalledWith(1, projection.textChannelId, null);
    expect(listChannelMessages).toHaveBeenNthCalledWith(2, projection.textChannelId, '901');
    expect(effects).toHaveLength(105);
    expect(effects[0]).toBe(`freeze:${projection.textChannelId}`);
    expect(effects.slice(-3)).toEqual([
      `delete:${projection.selectionVoiceChannelId}`,
      `delete:${projection.serviceVoiceChannelId}`,
      `delete:${projection.textChannelId}`
    ]);
    expect(effects.slice(1, -3).every((entry) => entry.startsWith('append:'))).toBe(true);
  });

  test('does not delete any channel when transcript backfill fails', async () => {
    const deleteChannelIfExists = vi.fn();
    const handler = createTerminalChannelArchiveHandler({
      store: {
        getProjection: vi.fn().mockResolvedValue({ ...projection, status: 'CANCELLED' }),
        appendSnapshot: vi.fn().mockRejectedValue(new Error('transcript unavailable')),
        enqueueDueTerminalOrders: vi.fn()
      },
      discord: {
        freezeChannelIfExists: vi.fn(),
        listChannelMessages: vi.fn().mockResolvedValue([message('100')]),
        deleteChannelIfExists
      }
    });

    await expect(handler(job())).rejects.toThrow('transcript unavailable');
    expect(deleteChannelIfExists).not.toHaveBeenCalled();
  });

  test('refuses to clean a non-terminal order', async () => {
    const deleteChannelIfExists = vi.fn();
    const handler = createTerminalChannelArchiveHandler({
      store: {
        getProjection: vi.fn().mockResolvedValue({ ...projection, status: 'IN_SERVICE' }),
        appendSnapshot: vi.fn(),
        enqueueDueTerminalOrders: vi.fn()
      },
      discord: { freezeChannelIfExists: vi.fn(), listChannelMessages: vi.fn(), deleteChannelIfExists }
    });

    await expect(handler(job())).rejects.toThrow('not terminal');
    expect(deleteChannelIfExists).not.toHaveBeenCalled();
  });

  test('Discord cleanup adapter paginates history and treats an already deleted channel as success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([message('100')]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Unknown Channel' }), { status: 404 }));
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'test-token',
      apiBaseUrl: 'https://discord.test/api/v10',
      fetch: fetchMock
    });

    await expect(adapter.listChannelMessages(projection.textChannelId!, '200')).resolves.toHaveLength(1);
    await expect(adapter.deleteChannelIfExists(projection.textChannelId!)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `https://discord.test/api/v10/channels/${projection.textChannelId}/messages?limit=100&before=200`
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  test('contracts cover terminal enqueue, transcript gate, and zombie reconciliation', async () => {
    const [spec, backlog, acceptance, interactions, orders, lifecycle, admin, worker] = await Promise.all([
      readFile('outputs/Discord陪玩业务Bot最小原型设计开发文档.html', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8'),
      readFile('outputs/P0开发交付包/01-UIUX/交互映射.csv', 'utf8'),
      readFile('apps/api/src/orders.ts', 'utf8'),
      readFile('apps/api/src/service-lifecycle.ts', 'utf8'),
      readFile('apps/api/src/admin-order-actions.ts', 'utf8'),
      readFile('apps/api/src/worker.ts', 'utf8')
    ]);
    expect(spec).toContain('COMPLETED 或 CANCELLED');
    expect(spec).toContain('完整回填');
    expect(backlog).toContain('M9-US-19');
    expect(acceptance).toContain('AT-TRN-003');
    expect(acceptance).toContain('AT-TRN-004');
    expect(interactions).toContain('INT-W-M9-019');
    for (const source of [orders, lifecycle, admin]) expect(source).toContain('enqueueTerminalChannelArchive');
    expect(worker).toContain('enqueueDueTerminalOrders');
  });
});

function message(id: string): DiscordChannelMessageSnapshot {
  return {
    id,
    author: { id: `5${id}`, username: `user-${id}`, global_name: null, bot: false },
    member: { nick: null },
    content: `message-${id}`,
    embeds: [],
    attachments: [],
    message_reference: null,
    timestamp: '2026-08-07T11:00:00.000Z',
    edited_timestamp: null
  };
}

function job(): OutboxJob {
  return {
    id: '00000000-0000-0000-0000-000000009119',
    type: 'CHANNEL_ARCHIVE',
    status: 'PROCESSING',
    payload: { orderId: projection.orderId },
    aggregateType: 'order',
    aggregateId: projection.orderId,
    dedupeKey: `terminal-channel-cleanup:${projection.orderId}:v7`,
    attempts: 1,
    maxAttempts: 8,
    runAfter: '2026-08-07T12:00:00.000Z',
    lockedAt: '2026-08-07T12:00:00.000Z',
    lockedBy: 'worker-1',
    completedAt: null,
    lastError: null,
    version: 2,
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z'
  };
}
