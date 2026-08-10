import { describe, expect, test } from 'vitest';
import { toDiscordReply } from '../apps/bot/src/discord-renderer';
import {
  buildStandaloneGiftAffordabilityMessage,
  buildStandaloneGiftEntryMessage,
  buildStandaloneGiftRecipientMessage,
  createStandaloneGiftContinuationToken,
  readStandaloneGiftContinuationToken,
  type StandaloneGiftCenterData
} from '@blackcat/bot/standalone-gifts';
import {
  buildStaffGiftAssistFinalModal,
  createStaffGiftAssistToken,
  readStaffGiftAssistToken
} from '@blackcat/bot/staff-assisted-gifts';

const now = new Date('2026-08-14T08:00:00.000Z');
const actor = { guildId: '900000000000027001', discordUserId: '900000000000027002',
  interactionId: '900000000000027003', clientSource: 'DISCORD_BOT' as const };
const otherActor = { ...actor, discordUserId: '900000000000027099' };
const secret = 'm22-us-06-bot-adapter-secret-at-least-32-bytes';
const playerProfileId = '00000000-0000-4000-8000-000000027004';
const catalogId = '00000000-0000-4000-8000-000000027005';

describe('M22-US-06 Discord adapter non-UI matrix', () => {
  test('GTA-B-001/B-002 keeps the shared entry public and all personal gift facts ephemeral', () => {
    const entry = buildStandaloneGiftEntryMessage();
    const picker = buildStandaloneGiftRecipientMessage(center());
    const token = createStandaloneGiftContinuationToken({ playerProfileId, giftCatalogVersionId: catalogId,
      catalogVersion: 1, priceMinor: 5_200 }, actor, secret, now);
    const confirmation = buildStandaloneGiftAffordabilityMessage({
      playerProfileId, giftCatalogVersionId: catalogId, catalogVersion: 1, priceMinor: 5_200,
      recipientCount: 1, totalPriceMinor: 5_200, ledgerBalanceMinor: 10_000, reservedMinor: 1_000,
      availableMinor: 9_000, shortfallMinor: 0, currency: 'CAT', calculatedAt: now.toISOString(),
      stale: false, canAfford: true, topUpInstructions: '联系客服充值'
    }, token, '陪玩阿青', '星光礼盒');

    expect(entry.visibility).toBe('PUBLIC');
    expect(JSON.stringify(entry)).not.toContain('10000');
    expect(JSON.stringify(entry)).not.toContain('9000');
    expect(picker.visibility).toBe('EPHEMERAL');
    expect(confirmation.visibility).toBe('EPHEMERAL');
    expect(toDiscordReply(entry).allowedMentions).toEqual({ parse: [] });
    expect(toDiscordReply(picker)).toMatchObject({ ephemeral: true, allowedMentions: { parse: [] } });
    expect(toDiscordReply(confirmation)).toMatchObject({ ephemeral: true, allowedMentions: { parse: [] } });
  });

  test('GTA-B-003/B-004 rejects tampering, expiry and actor switching while surviving a fresh decoder instance', () => {
    const state = { playerProfileId, giftCatalogVersionId: catalogId, catalogVersion: 1, priceMinor: 5_200 };
    const token = createStandaloneGiftContinuationToken(state, actor, secret, now);
    expect(readStandaloneGiftContinuationToken(token, actor, `${secret}`, new Date(now.getTime() + 29 * 60_000))).toEqual(state);
    expect(() => readStandaloneGiftContinuationToken(token, otherActor, secret, now)).toThrow();
    const tampered = `${token.slice(0, -1)}${token.endsWith('x') ? 'y' : 'x'}`;
    expect(() => readStandaloneGiftContinuationToken(tampered, actor, secret, now)).toThrow();
    expect(() => readStandaloneGiftContinuationToken(token, actor, secret, new Date(now.getTime() + 31 * 60_000))).toThrow();
  });

  test('GTA-A-011/B-007 binds the staff modal without embedding payer, receiver, reason or TOTP', () => {
    const continuation = { challengeId: '00000000-0000-4000-8000-000000027006', playerProfileId,
      giftCatalogVersionId: catalogId, catalogVersion: 1, priceMinor: 5_200 };
    const token = createStaffGiftAssistToken(continuation, actor, secret, now);
    expect(readStaffGiftAssistToken(token, actor, secret, new Date(now.getTime() + 9 * 60_000))).toEqual(continuation);
    const modal = buildStaffGiftAssistFinalModal(token, true);
    const rendered = JSON.stringify(modal);
    expect(rendered).toContain('authorizationReason');
    expect(rendered).toContain('totpCode');
    expect(rendered).not.toContain('老板测试账号');
    expect(rendered).not.toContain('陪玩测试账号');
    expect(rendered).not.toContain('123456');
  });
});

function center(): StandaloneGiftCenterData {
  return {
    recipients: [{ playerProfileId, displayName: '陪玩阿青', discordUserId: '900000000000027004' }],
    items: [{ id: catalogId, code: 'STAR', name: '星光礼盒', version: 1, priceMinor: 5_200,
      currency: 'CAT', affordable: true }],
    balance: { ledgerBalanceMinor: 10_000, reservedMinor: 1_000, availableMinor: 9_000,
      currency: 'CAT', calculatedAt: now.toISOString() }
  };
}
