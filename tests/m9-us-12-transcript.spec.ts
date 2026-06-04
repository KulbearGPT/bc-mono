import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { InMemoryOrderChannelEventStore, recordOrderChannelEvent } from '../apps/api/src/order-channel-events.js';

const event = {
  guildId: '1533309755873955880',
  channelId: '1533615769303257283',
  messageId: '1533615770179866746',
  eventId: '1533615770179866746:create',
  eventType: 'CREATED' as const,
  authorDiscordId: '1533309755873955881',
  authorDisplayName: '测试玩家',
  authorIsBot: false,
  content: '你好',
  embeds: [],
  attachments: [],
  replyToMessageId: null,
  discordCreatedAt: '2026-08-02T23:00:00.000Z',
  discordEditedAt: null
};

describe('M9-US-12 append-only order channel transcript events', () => {
  test('derives order and ticket from the trusted guild/channel mapping and deduplicates gateway retries', async () => {
    const store = new InMemoryOrderChannelEventStore([{ orderId: '00000000-0000-0000-0000-000000009012', orderPublicId: 'P-9012', ...event }]);
    const first = await recordOrderChannelEvent({ store, event, observedAt: new Date('2026-08-02T23:01:00Z') });
    const replay = await recordOrderChannelEvent({ store, event, observedAt: new Date('2026-08-02T23:02:00Z') });
    expect(first).toMatchObject({ orderId: '00000000-0000-0000-0000-000000009012', orderPublicId: 'P-9012', created: true });
    expect(replay).toMatchObject({ orderPublicId: 'P-9012', created: false });
    expect(store.events).toHaveLength(1);
  });

  test('keeps create, update and delete as separate immutable events', async () => {
    const store = new InMemoryOrderChannelEventStore([{ orderId: '00000000-0000-0000-0000-000000009012', orderPublicId: 'P-9012', ...event }]);
    for (const [eventType, suffix, content] of [['CREATED','create','初稿'],['UPDATED','edit-1','修改稿'],['DELETED','delete','修改稿']] as const) {
      await recordOrderChannelEvent({ store, event: { ...event, eventType, eventId: `${event.messageId}:${suffix}`, content }, observedAt: new Date() });
    }
    expect(store.events.map((item) => [item.eventType, item.content])).toEqual([['CREATED','初稿'],['UPDATED','修改稿'],['DELETED','修改稿']]);
  });

  test('bot enables message intents and ships all three persistent listeners through the unified API', async () => {
    const index = await readFile('apps/bot/src/index.ts', 'utf8');
    expect(index).toContain('GatewayIntentBits.GuildMessages');
    expect(index).toContain('GatewayIntentBits.MessageContent');
    for (const name of ['message-create', 'message-update', 'message-delete']) {
      const source = await readFile(`apps/bot/src/pieces/listeners/${name}.ts`, 'utf8');
      expect(source).toContain('orderChannelTranscriptApi.record');
    }
    const client = await readFile('apps/bot/src/order-channel-transcript.ts', 'utf8');
    expect(client).toContain('private_order_category_id');
  });

  test('migration enforces append-only storage and ticket lookup index', async () => {
    const sql = await readFile('database/prisma/migrations/000015_order_channel_transcript/migration.sql', 'utf8');
    expect(sql).toContain('order_channel_message_events');
    expect(sql).toContain('order_public_id');
    expect(sql).toContain('CREATE INDEX');
    expect(sql).toContain('prevent_order_channel_message_event_mutation');
  });
});
