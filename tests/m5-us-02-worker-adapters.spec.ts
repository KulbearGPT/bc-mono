import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import {
  DiscordRestWorkerAdapter,
  PostgresOrderPanelProjectionStore,
  WorkerAdapterError
} from '../apps/api/src/worker-adapters.js';
import type { OrderPanelProjection } from '../apps/api/src/worker-runtime.js';

const projection: OrderPanelProjection = {
  orderId: '00000000-0000-0000-0000-000000005301',
  publicId: 'P-5301',
  status: 'IN_SERVICE',
  version: 8,
  channelId: '530000000000000001',
  panelMessageId: '530000000000000002',
  customerDiscordUserId: '530000000000000003',
  playerDiscordUserId: '530000000000000004',
  amountMinor: 12_000,
  currency: 'CAT'
};
const notBefore = '2026-07-18T23:00:00.000Z';

describe('M5-US-02 Worker production adapters', () => {
  test('loads an order panel projection through users and Guild-scoped Discord accounts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      order_id: projection.orderId,
      public_id: projection.publicId,
      status: projection.status,
      row_version: projection.version,
      channel_id: projection.channelId,
      panel_message_id: projection.panelMessageId,
      customer_discord_user_id: projection.customerDiscordUserId,
      player_discord_user_id: projection.playerDiscordUserId,
      amount_minor: '12000',
      currency: projection.currency
    }] });
    const store = new PostgresOrderPanelProjectionStore({ query });

    await expect(store.getOrderPanelProjection(projection.orderId)).resolves.toEqual(projection);

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM orders AS orders/i);
    expect(sql).toMatch(/JOIN users AS customer/i);
    expect(sql).toMatch(/LEFT JOIN users AS player/i);
    expect(sql).toMatch(/JOIN discord_accounts AS customer_discord/i);
    expect(sql).toMatch(/LEFT JOIN discord_accounts AS player_discord/i);
    expect(sql).toMatch(/customer_discord\.guild_id = orders\.guild_id/i);
    expect(sql).toMatch(/player_discord\.guild_id = orders\.guild_id/i);
    expect(values).toEqual([projection.orderId]);
  });

  test('returns null when the order projection does not exist', async () => {
    const store = new PostgresOrderPanelProjectionStore({ query: vi.fn().mockResolvedValue({ rows: [] }) });
    await expect(store.getOrderPanelProjection(projection.orderId)).resolves.toBeNull();
  });

  test('replaces panel message id with an optimistic expected-id condition', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: projection.orderId }] });
    const store = new PostgresOrderPanelProjectionStore({ query });

    await store.replacePanelMessageId({
      orderId: projection.orderId,
      expectedPanelMessageId: projection.panelMessageId,
      panelMessageId: '530000000000000005'
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE orders/i);
    expect(sql).toMatch(/panel_message_id = \$3/i);
    expect(sql).toMatch(/id = \$1 AND panel_message_id = \$2/i);
    expect(values).toEqual([projection.orderId, projection.panelMessageId, '530000000000000005']);
  });

  test('distinguishes a missing order from an optimistic panel-id conflict', async () => {
    const missingQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const missing = new PostgresOrderPanelProjectionStore({ query: missingQuery });
    await expect(missing.replacePanelMessageId({
      orderId: projection.orderId,
      expectedPanelMessageId: projection.panelMessageId,
      panelMessageId: '530000000000000005'
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const conflictQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ panel_message_id: 'newer-message' }] });
    const conflict = new PostgresOrderPanelProjectionStore({ query: conflictQuery });
    await expect(conflict.replacePanelMessageId({
      orderId: projection.orderId,
      expectedPanelMessageId: projection.panelMessageId,
      panelMessageId: '530000000000000005'
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('grants the assigned player access and patches the existing panel message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, { id: projection.panelMessageId }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel(projection, notBefore)).resolves.toEqual({
      messageId: projection.panelMessageId,
      recreated: false
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1,
      `https://discord.com/api/v10/channels/${projection.channelId}/permissions/${projection.playerDiscordUserId}`,
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ authorization: 'Bot discord-token', 'content-type': 'application/json' }),
        body: JSON.stringify({ allow: '3072', deny: '0', type: 1 })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      `https://discord.com/api/v10/channels/${projection.channelId}/messages/${projection.panelMessageId}`,
      expect.objectContaining({ method: 'PATCH' })
    );
    const panelBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(panelBody.content).toContain('P-5301');
    expect(panelBody.content).toContain('IN_SERVICE');
    expect(panelBody.content).toContain('CAT 1200.0');
    expect(panelBody.allowed_mentions).toEqual({ parse: [] });
    expect(panelBody.components[0].components).toEqual(expect.arrayContaining([
      expect.objectContaining({ custom_id: `bc:service:request-completion:${projection.orderId}:v8` }),
      expect.objectContaining({ custom_id: `bc:service:support:${projection.orderId}:v8` })
    ]));
  });

  test('posts a replacement only when the existing panel PATCH returns 404', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, { message: 'Unknown Message' }))
      .mockResolvedValueOnce(response(200, []))
      .mockResolvedValueOnce(response(200, { id: '530000000000000005' }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null }, notBefore)).resolves.toEqual({
      messageId: '530000000000000005',
      recreated: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/messages/${projection.panelMessageId}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://discord.com/api/v10/channels/${projection.channelId}/messages?limit=100`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`https://discord.com/api/v10/channels/${projection.channelId}/messages`);
    const replacementBody = JSON.parse(fetchMock.mock.calls[2]?.[1]?.body as string);
    expect(replacementBody).toMatchObject({ enforce_nonce: true });
    expect(replacementBody.nonce).toMatch(/^[a-f0-9]{24}$/u);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/permissions/'))).toBe(false);
  });

  test('recovers a remotely-created replacement panel by nonce before posting again', async () => {
    const nonce = createHash('sha256').update(`order-panel:${projection.orderId}`).digest('hex').slice(0, 24);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(404, { message: 'Unknown Message' }))
      .mockResolvedValueOnce(response(200, [{ id: '530000000000000005', nonce }]));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null }, notBefore)).resolves.toEqual({
      messageId: '530000000000000005', recreated: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('exposes Discord retry_after when panel delivery is rate limited', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ retry_after: 0.5 }), {
      status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0.5' }
    }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null }, notBefore))
      .rejects.toMatchObject({ retryAfterMs: 500 });
  });

  test('does not create a duplicate panel after a non-404 Discord failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(403, { message: 'Missing Permissions' }));
    const adapter = new DiscordRestWorkerAdapter({ token: 'discord-token', fetch: fetchMock });

    await expect(adapter.upsertOrderPanel({ ...projection, playerDiscordUserId: null }, notBefore))
      .rejects.toBeInstanceOf(WorkerAdapterError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' }
  });
}
