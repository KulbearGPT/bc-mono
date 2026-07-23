import { describe, expect, test, vi } from 'vitest';
import { BotApiError, type BotActorContext, type BotApiClient } from '@blackcat/bot/service-center-api';
import { buildServiceCenterMessage } from '@blackcat/bot/service-center-profile';
import { parseServiceCenterCustomId } from '@blackcat/bot/service-center-routes';
import { serviceCenterInteractionKind } from '@blackcat/bot/service-center-route-registry';
import { executeProfileButton } from '@blackcat/bot/service-center-profile-interactions';

const orderId = '11111111-1111-4111-8111-111111111111';
const actor: BotActorContext = {
  guildId: '999999999999999999',
  discordUserId: '888888888888888888',
  interactionId: '777777777777777777',
  clientSource: 'DISCORD_BOT'
};

describe('M17-US-08 handler behavior and route reachability', () => {
  test('acknowledges a profile button before the API call and edits the deferred response', async () => {
    const events: string[] = [];
    const interaction = {
      deferUpdate: vi.fn(async () => {
        events.push('ack');
      }),
      editReply: vi.fn(async () => {
        events.push('edit');
      }),
      followUp: vi.fn(async () => {
        events.push('follow-up');
      })
    };
    const api = {
      getCurrentUserProfileSummary: vi.fn(async () => {
        events.push('api');
        return {
          user: { displayName: '测试用户' },
          balance: {
            ledgerBalanceMinor: 100,
            reservedMinor: 0,
            availableMinor: 100,
            currency: 'CAT',
            calculatedAt: '2026-08-06T00:00:00Z'
          },
          statistics: { activeOrderCount: 0, orderSpendMinor: 0, giftSpendMinor: 0, currency: 'CAT' }
        };
      })
    } as unknown as BotApiClient;

    await executeProfileButton({
      interaction,
      route: { area: 'profile', action: 'open' },
      actor,
      api
    });

    expect(events).toEqual(['ack', 'api', 'edit']);
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  test('uses an ephemeral follow-up with the API request ID after acknowledgement', async () => {
    const events: string[] = [];
    const interaction = {
      deferUpdate: vi.fn(async () => {
        events.push('ack');
      }),
      editReply: vi.fn(async () => {
        events.push('edit');
      }),
      followUp: vi.fn(async () => {
        events.push('follow-up');
      })
    };
    const api = {
      getCurrentUserProfileSummary: vi.fn(async () => {
        events.push('api');
        throw new BotApiError({ code: 'STALE', message: 'stale', requestId: 'req-profile-stale', statusCode: 409 });
      })
    } as unknown as BotApiClient;

    await executeProfileButton({
      interaction,
      route: { area: 'profile', action: 'refresh' },
      actor,
      api
    });

    expect(events).toEqual(['ack', 'api', 'follow-up']);
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('request_id: req-profile-stale'),
        ephemeral: true
      })
    );
  });

  test('gives every enabled service-center component exactly one interaction kind', () => {
    const message = buildServiceCenterMessage({
      currentUser: {
        user: {
          id: 'user-1',
          displayName: '测试用户',
          status: 'ACTIVE',
          externalAccountDisplay: null,
          activeOrderId: orderId,
          riskFlags: [],
          version: 1
        },
        activeOrderId: orderId,
        consumptionSummary: { totalMinor: 0, currency: 'CAT' },
        commissionSummary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' }
      },
      balance: {
        ledgerBalanceMinor: 100,
        reservedMinor: 0,
        availableMinor: 100,
        currency: 'CAT',
        calculatedAt: '2026-08-06T00:00:00Z'
      },
      activeOrder: { id: orderId, publicId: 'P-1', status: 'PENDING_DISPATCH', version: 2 } as never,
      consumptions: { items: [], nextCursor: null },
      commissions: {
        summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' },
        items: [],
        nextCursor: null
      }
    });
    const customIds = message.components.flatMap((row) =>
      row.type === 'ACTION_ROW'
        ? row.components.filter((item) => item.type !== 'LINK_BUTTON' && !item.disabled).map((item) => item.customId)
        : []
    );
    expect(customIds).not.toHaveLength(0);
    for (const customId of customIds) {
      const route = parseServiceCenterCustomId(customId);
      expect(route.area, customId).not.toBe('unknown');
      expect(serviceCenterInteractionKind(route), customId).toBe('button');
    }
    expect(parseServiceCenterCustomId(`bc:order:${orderId}:refresh`)).toMatchObject({
      area: 'order-refresh',
      orderId
    });
    for (const customId of ['bc:service-center:recharge', `bc:order:${orderId}:refresh`]) {
      expect(serviceCenterInteractionKind(parseServiceCenterCustomId(customId)), customId).toBe('button');
    }
  });

  test('keeps the Sapphire button adapter thin and delegates feature execution', async () => {
    const source = await import('node:fs/promises').then(({ readFile }) =>
      readFile('apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts', 'utf8')
    );
    expect(source).toContain('executeProfileButton');
    expect(source).toContain('serviceCenterInteractionKind');
    expect(source.split('\n').length).toBeLessThan(720);
  });
});
