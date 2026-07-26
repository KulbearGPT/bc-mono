import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DiscordRestDeliveryAdapter, PostgresDispatchMessageStore } from '@blackcat/api/worker-delivery';

describe('M5-US-02 Worker delivery adapters', () => {
  test('recovers a remotely-created message by stable nonce before posting again', async () => {
    const nonce = createHash('sha256').update('gift:announcement:1').digest('hex').slice(0, 24);
    const requests: string[] = [];
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (_url, init) => {
        requests.push(init?.method ?? 'GET');
        return new Response(JSON.stringify([{ id: 'message-existing', nonce }]), { status: 200 });
      }
    });

    await expect(adapter.sendMessage({ channelId: 'channel-1', content: 'gift', dedupeKey: 'gift:announcement:1', notBefore: '2026-07-18T23:00:00.000Z' }))
      .resolves.toEqual({ messageId: 'message-existing' });
    expect(requests).toEqual(['GET']);
  });

  test('updates an existing nonce message without creating one when the original reminder is absent', async () => {
    const nonce = createHash('sha256').update('support-response-reminder:task-1').digest('hex').slice(0, 24);
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    let existing = true;
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (url, init) => {
        requests.push({
          method: init?.method ?? 'GET',
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null
        });
        if (!init?.method || init.method === 'GET')
          return new Response(JSON.stringify(existing ? [{ id: 'reminder-1', nonce }] : []), { status: 200 });
        return new Response(JSON.stringify({ id: 'reminder-1' }), { status: 200 });
      }
    });

    await expect(adapter.updateMessage({
      channelId: 'channel-1',
      content: '客服已响应',
      dedupeKey: 'support-response-reminder:task-1',
      notBefore: '2026-07-18T23:00:00.000Z'
    })).resolves.toEqual({ messageId: 'reminder-1', updated: true });
    existing = false;
    await expect(adapter.updateMessage({
      channelId: 'channel-1',
      content: '客服已响应',
      dedupeKey: 'support-response-reminder:task-1',
      notBefore: '2026-07-18T23:00:00.000Z'
    })).resolves.toEqual({ messageId: null, updated: false });

    expect(requests.map(({ method }) => method)).toEqual(['GET', 'PATCH', 'GET']);
    expect(requests[1]).toMatchObject({
      url: 'https://discord.com/api/v10/channels/channel-1/messages/reminder-1',
      body: { content: '客服已响应' }
    });
  });

  test('paginates nonce reconciliation beyond the latest 100 messages', async () => {
    const nonce = createHash('sha256').update('gift:announcement:paged').digest('hex').slice(0, 24);
    let page = 0;
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async () => {
        page += 1;
        if (page === 1) return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
          id: String(200 - index), nonce: `other-${index}`, timestamp: '2026-07-18T23:01:00.000Z'
        }))), { status: 200 });
        return new Response(JSON.stringify([{ id: 'message-existing', nonce, timestamp: '2026-07-18T23:00:30.000Z' }]), { status: 200 });
      }
    });

    await expect(adapter.sendMessage({
      channelId: 'channel-1', content: 'gift', dedupeKey: 'gift:announcement:paged', notBefore: '2026-07-18T23:00:00.000Z'
    })).resolves.toEqual({ messageId: 'message-existing' });
    expect(page).toBe(2);
  });

  test('exposes Discord retry_after for Outbox scheduling', async () => {
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (_url, init) => init?.method === 'GET'
        ? new Response(JSON.stringify([]), { status: 200 })
        : new Response(JSON.stringify({ retry_after: 0.25 }), { status: 429, headers: { 'retry-after': '0.25' } })
    });

    await expect(adapter.sendMessage({ channelId: 'channel-1', content: 'gift', dedupeKey: 'gift:announcement:2', notBefore: '2026-07-18T23:00:00.000Z' }))
      .rejects.toMatchObject({ retryAfterMs: 250 });
  });

  test('uses a stable nonce only when creating and edits the persisted dispatch message id', async () => {
    const requests: Array<{ url: string; method: string; body: any }> = [];
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        if (!init?.method || init.method === 'GET') return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ id: 'message-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    });
    const payload = { dispatchAttemptId: 'attempt-1', dispatchChannelId: 'channel-1', orderId: 'order-1', orderVersion: 3, orderPublicId: 'P-1001',
      game: '瓦洛兰特', service: '娱乐陪玩', region: '北美', durationLabel: '2 小时', playerEarningMinor: 8400,
      currency: 'CAT', notes: '中文交流，主要娱乐', voiceChannelId: 'voice-1', expiresAt: '2026-07-19T00:00:00.000Z', candidatePlayerUserIds: ['player-1'] };

    await adapter.upsertDispatchOffer(payload, null, '2026-07-18T23:00:00.000Z');
    await adapter.upsertDispatchOffer(payload, 'message-1', '2026-07-18T23:00:00.000Z');

    expect(requests.map(({ url, method }) => [method, url])).toEqual([
      ['GET', 'https://discord.com/api/v10/channels/channel-1/messages?limit=100'],
      ['POST', 'https://discord.com/api/v10/channels/channel-1/messages'],
      ['PATCH', 'https://discord.com/api/v10/channels/channel-1/messages/message-1']
    ]);
    expect(requests[1]!.body).toMatchObject({ enforce_nonce: true });
    expect(requests[1]!.body.nonce).toMatch(/^[a-f0-9]{24}$/u);
    expect(requests[1]!.body.content).toBeNull();
    expect(requests[1]!.body.embeds).toEqual([expect.objectContaining({
      title: '🎮 新订单 · P-1001',
      description: expect.stringContaining('请确认以下信息后再接单'),
      fields: expect.arrayContaining([
        { name: '游戏', value: '瓦洛兰特', inline: true },
        { name: '服务类型', value: '娱乐陪玩', inline: true },
        { name: '区服', value: '北美', inline: true },
        { name: '服务时长', value: '2 小时', inline: true },
        { name: '语音频道', value: '<#voice-1>', inline: true },
        { name: '客户备注', value: '中文交流，主要娱乐', inline: false },
        { name: '接单截止', value: '<t:1784419200:F>\n<t:1784419200:R>', inline: false }
      ])
    })]);
    expect(JSON.stringify(requests[1]!.body)).not.toContain('预计收益');
    expect(requests[1]!.body.components).toEqual([{
      type: 1,
      components: [{
        type: 2,
        style: 3,
        label: '接单',
        custom_id: 'bc:dispatch:attempt-1:accept:order-1:v3'
      }]
    }]);
    expect(JSON.stringify(requests[1]!.body)).not.toContain('无法接单');
    expect(requests[2]!.body).not.toHaveProperty('nonce');
    expect(requests[2]!.body).not.toHaveProperty('enforce_nonce');
    expect(requests[2]!.body.content).toBeNull();
    expect(requests[2]!.body.embeds).toHaveLength(1);
  });

  test('moves a reusable order message id to the latest dispatch attempt', async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const store = new PostgresDispatchMessageStore({
      query: async (sql: string, values: unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes('SELECT dispatch_message_id')) return { rows: [{ dispatch_message_id: null }] };
        return { rows: [{ id: 'attempt-1' }], rowCount: 1 };
      }
    });

    expect(await store.getReusableDispatchMessageId({ dispatchAttemptId: 'attempt-1', orderId: 'order-1' })).toBeNull();
    expect(queries[0]!.sql).toContain('ORDER BY (dispatch_message_id IS NOT NULL) DESC');
    await store.saveDispatchMessageId({ dispatchAttemptId: 'attempt-1', orderId: 'order-1', previousMessageId: null, messageId: 'message-1' });

    expect(queries[1]!.sql).toContain('CASE WHEN id = $1::uuid THEN $4 ELSE NULL END');
    expect(queries[1]!.values).toEqual(['attempt-1', 'order-1', null, 'message-1']);
  });

  test('edits an empty-candidate round into a waiting message without stale buttons', async () => {
    let body: any;
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (_url, init) => {
        body = init?.body ? JSON.parse(String(init.body)) : null;
        return new Response(JSON.stringify({ id: 'message-1' }), { status: 200 });
      }
    });

    await adapter.upsertDispatchOffer({
      dispatchAttemptId: 'attempt-2', dispatchChannelId: 'channel-1', orderId: 'order-1', orderVersion: 3,
      orderPublicId: 'P-1001', game: 'VALORANT', service: 'FUN', expiresAt: '2026-07-19T00:00:00.000Z', candidatePlayerUserIds: []
    }, 'message-1', '2026-07-18T23:00:00.000Z');

    expect(body.content).toBeNull();
    expect(body.embeds[0]).toMatchObject({
      title: '⏳ 订单 · P-1001',
      description: expect.stringContaining('正在等待合格陪玩')
    });
    expect(body.components).toEqual([]);
  });

  test('recreates a deleted dispatch offer with a stable nonce', async () => {
    const requests: Array<{ method: string; body: any }> = [];
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (_url, init) => {
        requests.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        if (init?.method === 'PATCH') return new Response(JSON.stringify({ message: 'Unknown Message' }), { status: 404 });
        if (!init?.method || init.method === 'GET') return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify({ id: 'message-2' }), { status: 200 });
      }
    });
    const payload = { dispatchAttemptId: 'attempt-1', dispatchChannelId: 'channel-1', orderId: 'order-1', orderVersion: 3,
      orderPublicId: 'P-1001', expiresAt: '2026-07-19T00:00:00.000Z' };

    await expect(adapter.upsertDispatchOffer(payload, 'deleted-message', '2026-07-18T23:00:00.000Z')).resolves.toEqual({ messageId: 'message-2', recreated: true });
    expect(requests.map((request) => request.method)).toEqual(['PATCH', 'GET', 'POST']);
    expect(requests[2]!.body).toMatchObject({ enforce_nonce: true });
    expect(requests[2]!.body.nonce).toMatch(/^[a-f0-9]{24}$/u);
  });

  test('makes a text channel read-only while preserving existing overwrites', async () => {
    const requests: Array<{ url: string; method: string; body: any }> = [];
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1', type: 0,
          permission_overwrites: [
            { id: 'guild-1', type: 0, allow: '1024', deny: '0' },
            { id: 'member-1', type: 1, allow: '3072', deny: '0' }
          ] }), { status: 200 });
        return new Response(JSON.stringify({ id: 'channel-1' }), { status: 200 });
      }
    });

    await adapter.archiveChannel('channel-1');

    expect(requests[1]).toMatchObject({ method: 'PATCH', body: { permission_overwrites: [
      { id: 'guild-1', type: 0, allow: '1024', deny: '2048' },
      { id: 'member-1', type: 1, allow: '1024', deny: '2048' }
    ] } });
  });

  test('adds an everyone deny when a channel has no permission overwrites', async () => {
    const requests: Array<{ method: string; body: any }> = [];
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value',
      fetch: async (_url, init) => {
        requests.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        if (!init?.method || init.method === 'GET') {
          return new Response(JSON.stringify({ id: 'channel-1', guild_id: 'guild-1', type: 0, permission_overwrites: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 'channel-1' }), { status: 200 });
      }
    });

    await adapter.archiveChannel('channel-1');

    expect(requests[1]).toMatchObject({
      method: 'PATCH',
      body: { permission_overwrites: [{ id: 'guild-1', type: 0, allow: '0', deny: '2048' }] }
    });
  });

  test('reconciles non-bot Guild members through the unified role-sync API', async () => {
    const requests: Array<{ url: string; method: string; body: any; authorization: string | null }> = [];
    const adapter = new DiscordRestDeliveryAdapter({
      botToken: 'discord-token-value', businessApiBaseUrl: 'https://api.example.test', botServiceToken: 'service-token-value',
      fetch: async (url, init) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null,
          authorization: new Headers(init?.headers).get('authorization') });
        if (String(url).includes('/guilds/')) return new Response(JSON.stringify([
          { user: { id: 'member-1', bot: false }, roles: ['role-1'] }, { user: { id: 'bot-1', bot: true }, roles: ['role-2'] }
        ]), { status: 200 });
        return new Response(JSON.stringify({ data: { status: 'APPLIED' } }), { status: 200 });
      }
    });

    await adapter.reconcileRoles('guild-1', 4, '2026-07-18T23:00:00.000Z');

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ method: 'POST', authorization: 'Bearer service-token-value', body: {
      guildId: 'guild-1', discordUserId: 'member-1', observedRoleIds: ['role-1'], mappingVersion: 4,
      source: 'STARTUP_RECONCILIATION', observedAt: '2026-07-18T23:00:00.000Z'
    } });
  });
});
