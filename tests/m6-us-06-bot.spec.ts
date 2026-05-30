import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { ButtonStyle } from 'discord.js';
import { buildServiceLifecyclePanelMessage, HttpBotApiClient, parseServiceCenterCustomId, type BotActorContext } from '@blackcat/bot/service-center';
import { buildGiftAffordabilityMessage, buildGiftPanel, createGiftContinuationToken,
  readGiftContinuationToken, buildGiftCatalogMessage } from '@blackcat/bot/gifts';
import { toDiscordReply } from '../apps/bot/src/discord-renderer';

const actor: BotActorContext = { guildId: '900000000000006600', discordUserId: '900000000000006601',
  interactionId: '900000000000006609', clientSource: 'DISCORD_BOT' };
const result = { giftCatalogVersionId: '00000000-0000-0000-0000-000000006610', catalogVersion: 4,
  priceMinor: 8_800, providerBalanceMinor: 5_000, reservedMinor: 1_200, availableMinor: 3_800,
  shortfallMinor: 5_000, currency: 'CNY', fetchedAt: '2026-07-19T21:00:00.000Z', stale: false,
  canAfford: false, rechargeUrl: 'https://payments.example.test/recharge/guild-6600' };

describe('M6-US-06 Sapphire recharge continuation', () => {
  test('keeps every enabled catalog option selectable regardless of affordability', () => {
    const panel = buildGiftPanel({ orderId: 'order-1', orderPublicId: 'P-1', receiver: { userId: 'player-1', displayName: '阿岚' },
      balance: { providerBalanceMinor: 5_000, reservedMinor: 3_000, availableMinor: 2_000, currency: 'CNY', fetchedAt: result.fetchedAt },
      items: [{ id: 'gift-18', code: 'SMALL', name: '小心意', version: 1, priceMinor: 1_800, currency: 'CNY', affordable: true },
        { id: result.giftCatalogVersionId, code: 'BOX', name: '礼盒', version: 4, priceMinor: 8_800, currency: 'CNY', affordable: false }] });
    expect(panel.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'gift-18', disabled: false }),
      expect.objectContaining({ value: result.giftCatalogVersionId, disabled: false })
    ]));
    expect(panel).not.toHaveProperty('receiverInput');
  });

  test('renders an ephemeral deficit-only panel with Link, refresh, and back controls', () => {
    const message = buildGiftAffordabilityMessage(result, 'ctx_abc123');
    expect(message.visibility).toBe('EPHEMERAL');
    expect(message.body).toContain('¥50.00');
    expect(message.body).not.toMatch(/总余额|可用余额|预留/u);
    const rendered = toDiscordReply(message);
    const buttons = rendered.components!.flatMap((row: any) => row.components);
    expect(buttons.find((button: any) => button.data.style === ButtonStyle.Link)?.data.url).toBe(result.rechargeUrl);
    expect(JSON.stringify(message)).toContain('bc:gift:refresh:ctx_abc123');
    expect(JSON.stringify(message)).toContain('bc:gift:back:ctx_abc123');
    expect(JSON.stringify(message)).not.toContain('bc:gift:confirm:ctx_abc123');
    for (const button of buttons) if (button.data.custom_id) expect(button.data.custom_id.length).toBeLessThanOrEqual(100);
  });

  test('blocks stale confirmation and shows confirm only for the current affordable snapshot', () => {
    expect(JSON.stringify(buildGiftAffordabilityMessage({ ...result, stale: true, canAfford: false }, 'ctx_stale'))).not.toContain('gift:confirm');
    const affordable = buildGiftAffordabilityMessage({ ...result, providerBalanceMinor: 10_000, availableMinor: 8_800,
      shortfallMinor: 0, canAfford: true }, 'ctx_ready');
    expect(JSON.stringify(affordable)).toContain('bc:gift:confirm:ctx_ready');
    expect(affordable.body).toMatch(/¥88\.00.*确认/u);
  });

  test('uses an expiring HMAC short token with no receiver input or server-side registry', () => {
    const secret = 'm6-us-06-test-signing-secret-at-least-32-bytes';
    const context = { orderId: '00000000-0000-0000-0000-000000006601', orderVersion: 7,
      giftCatalogVersionId: result.giftCatalogVersionId, catalogVersion: 4, priceMinor: 8_800 };
    const token = createGiftContinuationToken(context, actor, secret, new Date('2026-07-19T21:00:00.000Z'));
    expect(token.length).toBeLessThanOrEqual(84);
    expect(readGiftContinuationToken(token, actor, secret, new Date('2026-07-19T21:29:59.000Z'))).toEqual(context);
    expect(() => readGiftContinuationToken(`${token.slice(0, -1)}A`, actor, secret, now())).toThrow(/context/i);
    expect(() => readGiftContinuationToken(token, { ...actor, discordUserId: '900000000000006699' }, secret, now())).toThrow(/context/i);
    expect(() => readGiftContinuationToken(token, actor, secret, new Date('2026-07-19T21:30:01.000Z'))).toThrow(/expired/i);
  });

  test('uses the shared affordability API and sends no receiver or balance calculation input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: result }) });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBotApiClient({ apiBaseUrl: 'https://api.example.test', botServiceToken: 'bot-token' });
    expect(await client.checkGiftAffordability('order-1', result.giftCatalogVersionId, actor)).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/v1/orders/order-1/gift-affordability');
    expect(JSON.parse(init.body)).toEqual({ giftCatalogVersionId: result.giftCatalogVersionId });
    expect(init.headers).toMatchObject({ 'x-actor-discord-user-id': actor.discordUserId, 'x-actor-guild-id': actor.guildId });
  });

  test('renders native enabled gift buttons and wires refresh/reconfirm through the shared API handler', async () => {
    const secret = 'm6-us-06-test-signing-secret-at-least-32-bytes';
    const message = buildGiftCatalogMessage({ orderId: '00000000-0000-0000-0000-000000006601', orderPublicId: 'P-6601',
      receiver: { userId: 'player-derived', displayName: '阿岚' }, balance: { providerBalanceMinor: 5_000,
        reservedMinor: 10_200, availableMinor: -5_200, currency: 'CNY', fetchedAt: result.fetchedAt },
      items: [{ id: result.giftCatalogVersionId, code: 'BOX', name: '礼盒', version: 4,
        priceMinor: 8_800, currency: 'CNY', affordable: false }] }, 7, actor, secret,
    new Date('2026-07-19T21:00:00.000Z'));
    const button = message.components[0]!.components[0]!;
    expect(button).toMatchObject({ type: 'BUTTON', disabled: false });
    if (button.type !== 'BUTTON') throw new Error('Expected gift button.');
    expect(button.customId.length).toBeLessThanOrEqual(100);
    expect(parseServiceCenterCustomId(button.customId)).toMatchObject({ area: 'gift', action: 'select' });
    const source = await readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8');
    expect(source).toContain('checkGiftAffordability');
    expect(source).toContain('createOrderGiftRequest');
    expect(source).toContain('readGiftContinuationToken');
    const orderPanel = buildServiceLifecyclePanelMessage({ orderId: '00000000-0000-0000-0000-000000006601',
      publicId: 'P-6601', status: 'IN_SERVICE', version: 7, actorRole: 'CUSTOMER',
      enabledFeatures: ['CORE_ORDER', 'GIFTS'], readiness: {
        customer: 'READY', player: 'READY', bothReady: true, readyDeadlineAt: null,
        startedAt: result.fetchedAt, staffTaskId: null } });
    const openId = (orderPanel.components[0]!.components.find((item) => item.type === 'BUTTON' && item.label === '赠送礼物') as any).customId;
    expect(parseServiceCenterCustomId(openId)).toEqual({ area: 'gift', action: 'open',
      orderId: '00000000-0000-0000-0000-000000006601', expectedVersion: 7 });
  });
});

function now() { return new Date('2026-07-19T21:01:00.000Z'); }
