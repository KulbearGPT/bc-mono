import { describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildServiceLifecyclePanelMessage, HttpBotApiClient, parseServiceCenterCustomId, type BotActorContext } from '@blackcat/bot/service-center';
import { buildGiftAffordabilityMessage, buildGiftPanel, createGiftContinuationToken,
  readGiftContinuationToken, buildGiftCatalogMessage, decodeGiftRecipientSelection } from '@blackcat/bot/gifts';
import { toDiscordReply } from '../apps/bot/src/discord-renderer';

const actor: BotActorContext = { guildId: '900000000000006600', discordUserId: '900000000000006601',
  interactionId: '900000000000006609', clientSource: 'DISCORD_BOT' };
const result = { giftCatalogVersionId: '00000000-0000-0000-0000-000000006610', catalogVersion: 4,
  priceMinor: 8_800, recipientCount: 1, totalPriceMinor: 8_800, ledgerBalanceMinor: 5_000, reservedMinor: 1_200, availableMinor: 3_800,
  shortfallMinor: 5_000, currency: 'CAT', calculatedAt: '2026-07-19T21:00:00.000Z', stale: false,
  canAfford: false, topUpInstructions: '联系客服并提交付款 receipt。' };

describe('M6-US-06 Sapphire recharge continuation', () => {
  test('keeps every enabled catalog option selectable regardless of affordability', () => {
    const panel = buildGiftPanel({ orderId: 'order-1', orderPublicId: 'P-1', receiver: { userId: 'player-1', displayName: '阿岚' },
      recipients: [{ participantId: 'participant-1', playerId: 'player-1', displayName: '阿岚' }],
      balance: { ledgerBalanceMinor: 5_000, reservedMinor: 3_000, availableMinor: 2_000, currency: 'CAT', calculatedAt: result.calculatedAt },
      items: [{ id: 'gift-18', code: 'SMALL', name: '小心意', version: 1, priceMinor: 1_800, currency: 'CAT', affordable: true },
        { id: result.giftCatalogVersionId, code: 'BOX', name: '礼盒', version: 4, priceMinor: 8_800, currency: 'CAT', affordable: false }] });
    expect(panel.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'gift-18', disabled: false }),
      expect.objectContaining({ value: result.giftCatalogVersionId, disabled: false })
    ]));
    expect(panel).not.toHaveProperty('receiverInput');
  });

  test('renders an ephemeral deficit-only panel with support, refresh, and back controls', () => {
    const message = buildGiftAffordabilityMessage(result, 'ctx_abc123');
    expect(message.visibility).toBe('EPHEMERAL');
    expect(message.body).toContain('500.0 CAT');
    expect(message.body).not.toMatch(/总余额|可用余额|预留/u);
    const rendered = toDiscordReply(message);
    const buttons = rendered.components!.flatMap((row: any) => row.components);
    expect(JSON.stringify(buttons)).not.toMatch(/https?:\/\/|LINK/u);
    expect(JSON.stringify(message)).toContain('bc:gift:refresh:ctx_abc123');
    expect(JSON.stringify(message)).toContain('bc:gift:back:ctx_abc123');
    expect(JSON.stringify(message)).not.toContain('bc:gift:confirm:ctx_abc123');
    for (const button of buttons) if (button.data.custom_id) expect(button.data.custom_id.length).toBeLessThanOrEqual(100);
  });

  test('blocks stale confirmation and shows confirm only for the current affordable snapshot', () => {
    expect(JSON.stringify(buildGiftAffordabilityMessage({ ...result, stale: true, canAfford: false }, 'ctx_stale'))).not.toContain('gift:confirm');
    const affordable = buildGiftAffordabilityMessage({ ...result, ledgerBalanceMinor: 10_000, availableMinor: 8_800,
      shortfallMinor: 0, canAfford: true }, 'ctx_ready');
    expect(JSON.stringify(affordable)).toContain('bc:gift:confirm:ctx_ready');
    expect(affordable.body).toMatch(/880\.0 CAT[\s\S]*确认/u);
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
    expect(await client.checkGiftAffordability('order-1', result.giftCatalogVersionId, ['participant-1'], actor)).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/api/v1/orders/order-1/gift-affordability');
    expect(JSON.parse(init.body)).toEqual({ giftCatalogVersionId: result.giftCatalogVersionId, participantIds: ['participant-1'] });
    expect(init.headers).toMatchObject({ 'x-actor-discord-user-id': actor.discordUserId, 'x-actor-guild-id': actor.guildId });
  });

  test('renders a native gift select and wires refresh/reconfirm through the shared API handler', async () => {
    const secret = 'm6-us-06-test-signing-secret-at-least-32-bytes';
    const message = buildGiftCatalogMessage({ orderId: '00000000-0000-0000-0000-000000006601', orderPublicId: 'P-6601',
      receiver: { userId: 'player-derived', displayName: '阿岚' }, balance: { ledgerBalanceMinor: 5_000,
        reservedMinor: 10_200, availableMinor: -5_200, currency: 'CAT', calculatedAt: result.calculatedAt },
      recipients: [{ participantId: '00000000-0000-0000-0000-000000006606', playerId: 'player-derived', displayName: '阿岚' }],
      items: [{ id: result.giftCatalogVersionId, code: 'BOX', name: '礼盒', version: 4,
        priceMinor: 8_800, currency: 'CAT', affordable: false }] }, 7, actor, secret,
    new Date('2026-07-19T21:00:00.000Z'), ['00000000-0000-0000-0000-000000006606']);
    const giftSelect = message.components[1]!.components[0]!;
    expect(giftSelect).toMatchObject({ type: 'STRING_SELECT', customId: 'bc:gc:AQ', maxValues: 1 });
    if (giftSelect.type !== 'STRING_SELECT') throw new Error('Expected gift select.');
    expect(parseServiceCenterCustomId(giftSelect.customId)).toEqual({ area: 'gift-catalog-select', selection: 'AQ' });
    expect(giftSelect.options[0]!.value.length).toBeLessThanOrEqual(84);
    const source = await readFile('apps/bot/src/service-center-gift-interactions.ts', 'utf8');
    expect(source).toContain('checkGiftAffordability');
    expect(source).toContain('createOrderGiftRequest');
    expect(source).toContain('readGiftContinuationToken');
    const orderPanel = buildServiceLifecyclePanelMessage({ orderId: '00000000-0000-0000-0000-000000006601',
      publicId: 'P-6601', status: 'IN_SERVICE', version: 7, actorRole: 'CUSTOMER',
      enabledFeatures: ['CORE_ORDER', 'GIFTS'], readiness: {
        customer: 'READY', player: 'READY', bothReady: true, readyDeadlineAt: null,
        startedAt: result.calculatedAt, staffTaskId: null } });
    const openId = (orderPanel.components[0]!.components.find((item) => item.type === 'BUTTON' && item.label === '赠送礼物') as any).customId;
    expect(parseServiceCenterCustomId(openId)).toEqual({ area: 'gift', action: 'open',
      orderId: '00000000-0000-0000-0000-000000006601', expectedVersion: 7 });
  });

  test('paginates recipient selection without imposing an API recipient limit', () => {
    const secret = 'm6-us-06-test-signing-secret-at-least-32-bytes';
    const recipients = Array.from({ length: 30 }, (_, index) => ({
      participantId: `00000000-0000-0000-0000-${String(7000 + index).padStart(12, '0')}`,
      playerId: `00000000-0000-0000-0000-${String(8000 + index).padStart(12, '0')}`,
      displayName: `陪玩猫${index + 1}`
    }));
    const data = { orderId: '00000000-0000-0000-0000-000000006601', orderPublicId: 'P-6601',
      receiver: { userId: recipients[0]!.playerId, displayName: '30 位订单陪玩' }, recipients,
      balance: { ledgerBalanceMinor: 100_000, reservedMinor: 0, availableMinor: 100_000, currency: 'CAT', calculatedAt: result.calculatedAt },
      items: [{ id: result.giftCatalogVersionId, code: 'BOX', name: '礼盒', version: 4, priceMinor: 8_800, currency: 'CAT', affordable: true }] };
    const first = buildGiftCatalogMessage(data, 7, actor, secret);
    const recipientSelect = first.components[0]!.components[0]!;
    expect(recipientSelect).toMatchObject({ type: 'STRING_SELECT', maxValues: 25 });
    if (recipientSelect.type !== 'STRING_SELECT') throw new Error('Expected recipient select.');
    expect(recipientSelect.options).toHaveLength(25);
    const next = first.components.at(-1)!.components[1]!;
    expect(next.type).toBe('BUTTON');
    if (next.type !== 'BUTTON') throw new Error('Expected next-page button.');
    expect(parseServiceCenterCustomId(next.customId)).toMatchObject({ area: 'gift-recipient-page', page: 1 });
    const nextRoute = parseServiceCenterCustomId(next.customId);
    if (nextRoute.area !== 'gift-recipient-page') throw new Error('Expected recipient page route.');
    const chosen = [recipients[1]!.participantId, recipients[28]!.participantId];
    const second = buildGiftCatalogMessage(data, 7, actor, secret, now(), chosen, 1);
    const secondSelect = second.components[0]!.components[0]!;
    if (secondSelect.type !== 'STRING_SELECT') throw new Error('Expected recipient select.');
    const secondRoute = parseServiceCenterCustomId(secondSelect.customId);
    if (secondRoute.area !== 'gift-recipient-select') throw new Error('Expected recipient select route.');
    expect(decodeGiftRecipientSelection(recipients, secondRoute.selection)).toEqual(chosen);
    expect(secondRoute.page).toBe(1);
    expect(secondSelect.options.find((option) => option.value === recipients[28]!.participantId)?.default).toBe(true);
    expect(secondSelect.customId.length).toBeLessThanOrEqual(100);
  });
});

function now() { return new Date('2026-07-19T21:01:00.000Z'); }
