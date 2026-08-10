import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { HttpBotApiClient, type BotApiClient } from '@blackcat/bot/service-center-api';
import {
  buildStaffGiftAssistCatalogMessage,
  buildStaffGiftAssistConfirmationMessage,
  buildStaffGiftAssistFinalModal,
  createStaffGiftAssistToken,
  executeStaffGiftAssistContextMenu,
  executeStaffGiftAssistModal,
  parseStaffGiftAssistButton,
  parseStaffGiftAssistModal,
  readStaffGiftAssistToken,
  type StaffGiftAssistContinuation
} from '@blackcat/bot/staff-assisted-gifts';

const guildId = '900000000000022400';
const staffDiscordUserId = '900000000000022401';
const customerDiscordUserId = '900000000000022402';
const challengeId = '00000000-0000-4000-8000-000000022403';
const playerProfileId = '00000000-0000-4000-8000-000000022404';
const giftCatalogVersionId = '00000000-0000-4000-8000-000000022405';
const secret = 'm22-staff-gift-assist-signing-secret-32-bytes';
const now = new Date('2026-08-13T18:00:00.000Z');
const actor = {
  guildId,
  discordUserId: staffDiscordUserId,
  interactionId: '900000000000022406',
  clientSource: 'DISCORD_BOT' as const
};
const continuation: StaffGiftAssistContinuation = {
  challengeId,
  playerProfileId,
  giftCatalogVersionId,
  catalogVersion: 3,
  priceMinor: 5_200
};

function center() {
  return {
    id: challengeId,
    customer: { displayName: '老板甲' },
    failedAttempts: 0,
    expiresAt: '2026-08-13T18:10:00.000Z',
    recipients: [{ playerProfileId, displayName: '阿青', discordUserId: '900000000000022407' }],
    items: [{ id: giftCatalogVersionId, code: 'MOON', name: '月亮蛋糕', version: 3,
      priceMinor: 5_200, currency: 'CAT' as const, affordable: true }],
    balance: { ledgerBalanceMinor: 10_000, reservedMinor: 0, availableMinor: 10_000,
      currency: 'CAT' as const, calculatedAt: '2026-08-13T18:00:00.000Z' }
  };
}

function affordability() {
  return { playerProfileId, giftCatalogVersionId, catalogVersion: 3, priceMinor: 5_200,
    recipientCount: 1, totalPriceMinor: 5_200, ledgerBalanceMinor: 10_000, reservedMinor: 0,
    availableMinor: 10_000, shortfallMinor: 0, currency: 'CAT' as const,
    calculatedAt: '2026-08-13T18:00:00.000Z', stale: false, canAfford: true,
    topUpInstructions: '联系客服充值' };
}

function created() {
  return {
    initiatorMode: 'STAFF_ASSISTED' as const,
    assistedByStaffId: '00000000-0000-4000-8000-000000022408',
    giftAssistChallengeId: challengeId,
    origin: 'STANDALONE' as const,
    senderVisibility: 'ANONYMOUS' as const,
    orderId: null,
    playerProfileId,
    receiverId: '00000000-0000-4000-8000-000000022409',
    id: '00000000-0000-4000-8000-000000022410',
    publicId: 'G-22410',
    status: 'PENDING_REVIEW' as const,
    expiresAt: '2026-08-13T18:30:00.000Z',
    gift: { code: 'MOON', name: '月亮蛋糕', priceMinor: 5_200, currency: 'CAT' as const },
    reservation: { id: '00000000-0000-4000-8000-000000022411', status: 'ACTIVE' as const,
      amountMinor: 5_200, currency: 'CAT' as const, expiresAt: '2026-08-13T18:30:00.000Z' },
    staffTask: { id: '00000000-0000-4000-8000-000000022412', publicId: 'T-22412',
      type: 'GIFT_REVIEW' as const, status: 'OPEN' as const },
    balance: { ledgerBalanceMinor: 10_000, reservedMinor: 5_200, availableMinor: 4_800,
      currency: 'CAT' as const, calculatedAt: '2026-08-13T18:00:00.000Z' }
  };
}

describe('M22-US-04 Discord staff-assisted gift mode B', () => {
  test('uses an actor-bound, expiring and Discord-safe continuation token', () => {
    const token = createStaffGiftAssistToken(continuation, actor, secret, now);
    expect(token).toHaveLength(88);
    expect(readStaffGiftAssistToken(token, actor, secret, new Date('2026-08-13T18:10:00.000Z'))).toEqual(continuation);
    expect(() => readStaffGiftAssistToken(token, { ...actor, discordUserId: customerDiscordUserId }, secret, now)).toThrow();
    const tampered = `${token.slice(0, -2)}${token.at(-2) === 'x' ? 'y' : 'x'}${token.at(-1)}`;
    expect(() => readStaffGiftAssistToken(tampered, actor, secret, now)).toThrow();
    expect(() => readStaffGiftAssistToken(token, actor, secret, new Date('2026-08-13T18:10:01.000Z'))).toThrow();

    const catalog = buildStaffGiftAssistCatalogMessage(center(), playerProfileId, actor, secret, now);
    const confirmation = buildStaffGiftAssistConfirmationMessage({ center: center(), affordability: affordability(), token });
    const modal = buildStaffGiftAssistFinalModal(token, true);
    const customIds = JSON.stringify([catalog, confirmation, modal]).match(/bc:ga:[^"\\]+/gu) ?? [];
    expect(customIds.every((value) => value.length <= 100)).toBe(true);
    expect(parseStaffGiftAssistButton(`bc:ga:a:${token}`)).toEqual({ action: 'anonymous', token });
    expect(parseStaffGiftAssistModal(modal.customId)).toEqual({ anonymous: true, token });
    expect(modal.components.map((item) => item.customId)).toEqual(['authorizationReason', 'totpCode']);
  });

  test('derives the payer from the target message author and never reads message content', async () => {
    const createChallenge = vi.fn(async () => center());
    const interaction = {
      guildId,
      id: '900000000000022420',
      user: { id: staffDiscordUserId },
      targetMessage: {
        id: '900000000000022421',
        channelId: '900000000000022422',
        author: { id: customerDiscordUserId, bot: false },
        content: 'this must not be sent to the API'
      },
      inGuild: () => true,
      deferReply: vi.fn(),
      editReply: vi.fn(),
      reply: vi.fn()
    };
    await executeStaffGiftAssistContextMenu({
      interaction: interaction as never,
      api: { createStaffGiftAssistChallenge: createChallenge } as unknown as BotApiClient
    });
    expect(createChallenge).toHaveBeenCalledWith({
      customerDiscordUserId,
      authorizationChannelId: '900000000000022422',
      authorizationMessageId: '900000000000022421'
    }, { ...actor, interactionId: '900000000000022420' }, expect.stringContaining('gift:assist:challenge'));
    expect(JSON.stringify(createChallenge.mock.calls)).not.toContain('this must not be sent to the API');
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  test('submits anonymous mode, reason and TOTP without client-selected sender or receiver IDs', async () => {
    const token = createStaffGiftAssistToken(continuation, actor, secret, now);
    const createGift = vi.fn(async () => created());
    const interaction = {
      guildId,
      id: actor.interactionId,
      user: { id: staffDiscordUserId },
      fields: { getTextInputValue: vi.fn((key: string) => key === 'totpCode' ? '123456' : '客户在原消息明确授权') },
      deferReply: vi.fn(),
      editReply: vi.fn()
    };
    await executeStaffGiftAssistModal({
      interaction: interaction as never,
      route: { anonymous: true, token },
      api: { createStaffAssistedGiftRequest: createGift } as unknown as BotApiClient,
      secret
    });
    const request = createGift.mock.calls[0]?.[1];
    expect(request).toEqual({ playerProfileId, giftCatalogVersionId, expectedCatalogVersion: 3,
      expectedPriceMinor: 5_200, anonymous: true, authorizationReason: '客户在原消息明确授权', totpCode: '123456' });
    expect(request).not.toHaveProperty('senderId');
    expect(request).not.toHaveProperty('receiverId');
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });

  test('registers a Guild-only message command and three dedicated Sapphire handlers', async () => {
    const [command, buttons, selects, modals] = await Promise.all([
      readFile('apps/bot/src/pieces/commands/staff-gift-assist.ts', 'utf8'),
      readFile('apps/bot/src/pieces/interaction-handlers/staff-gift-assist-buttons.ts', 'utf8'),
      readFile('apps/bot/src/pieces/interaction-handlers/staff-gift-assist-selects.ts', 'utf8'),
      readFile('apps/bot/src/pieces/interaction-handlers/staff-gift-assist-modals.ts', 'utf8')
    ]);
    expect(command).toContain(".setName('协助此老板送礼')");
    expect(command).toContain('.setType(ApplicationCommandType.Message)');
    expect(command).toContain('.setDMPermission(false)');
    expect(buttons).toContain('parseStaffGiftAssistButton');
    expect(selects).toContain('parseStaffGiftAssistSelect');
    expect(modals).toContain('parseStaffGiftAssistModal');
  });

  test('keeps real desktop/mobile, negative and replay UAT external', async () => {
    const runbook = await readFile('evidence/P0/M22-US-04/human-uat-runbook.md', 'utf8');
    expect(runbook).toContain('状态：`PENDING_EXTERNAL`');
    expect(runbook).toContain('桌面端');
    expect(runbook).toContain('手机端');
    expect(runbook).toContain('第五次错误');
    expect(runbook).toContain('单次消费与并发重放');
    expect(runbook).toContain('不得由 Codex、Bot、自动探针或测试替身代签');
  });

  test('sends all four unified API calls and only the frozen mode-B request fields', async () => {
    const responses = [center(), center(), affordability(), created()];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ requestId: 'req-assist', data: responses.shift() }), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    const api = new HttpBotApiClient({ apiBaseUrl: 'https://api.example.test', botServiceToken: 'token', fetch: fetchMock });
    await api.createStaffGiftAssistChallenge({ customerDiscordUserId, authorizationChannelId: 'c1', authorizationMessageId: 'm1' }, actor, 'k1');
    await api.getStaffGiftAssistChallenge(challengeId, actor);
    await api.checkStaffGiftAssistAffordability(challengeId, playerProfileId, giftCatalogVersionId, actor);
    await api.createStaffAssistedGiftRequest(challengeId, { playerProfileId, giftCatalogVersionId,
      expectedCatalogVersion: 3, expectedPriceMinor: 5_200, anonymous: true,
      authorizationReason: '客户授权', totpCode: '123456' }, actor, 'k2');
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.example.test/api/v1/admin/gift-assist/challenges',
      `https://api.example.test/api/v1/admin/gift-assist/challenges/${challengeId}`,
      `https://api.example.test/api/v1/admin/gift-assist/challenges/${challengeId}/affordability`,
      `https://api.example.test/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`
    ]);
    const finalBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body));
    expect(finalBody).toEqual({ playerProfileId, giftCatalogVersionId, expectedCatalogVersion: 3,
      expectedPriceMinor: 5_200, anonymous: true, authorizationReason: '客户授权', totpCode: '123456' });
    expect(finalBody).not.toHaveProperty('senderId');
    expect(finalBody).not.toHaveProperty('receiverId');
  });
});
