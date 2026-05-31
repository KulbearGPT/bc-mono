import { describe, expect, test } from 'vitest';
import { getOrder, InMemoryOrderStore, type OrderMatchingProgress, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';

const now = new Date('2026-07-18T08:00:00.000Z');
const customerId = '00000000-0000-0000-0000-00000000a701';
const playerId = '00000000-0000-0000-0000-00000000a702';
const orderId = '00000000-0000-0000-0000-00000000b701';

describe('M2-US-07 customer matching progress projection', () => {
  test('getOrder exposes aggregate matching progress without candidate identities or ranking data', async () => {
    const matching: OrderMatchingProgress = {
      stage: 'WAITING_FOR_ACCEPTANCE',
      notifiedCandidateCount: 3,
      timeoutAt: '2026-07-18T08:05:00.000Z',
      nextStep: 'WAIT_FOR_PLAYER',
      playerSummary: null
    };
    const orderStore = new MatchingOrderStore([order()], matching);
    const result = await getOrder({
      accountStore: accounts(),
      orderStore,
      actor: actor(),
      orderId
    });

    expect(result.matching).toEqual(matching);
    expect(JSON.stringify(result.matching)).not.toContain(playerId);
    expect(result).toMatchObject({ publicId: 'P-M2-MATCH', game: 'VALORANT', service: 'ENTERTAINMENT' });
  });

  test('accepted order shows only the winning player summary and the customer next action', async () => {
    const matching: OrderMatchingProgress = {
      stage: 'ACCEPTED',
      notifiedCandidateCount: 3,
      timeoutAt: null,
      nextStep: 'CONFIRM_READINESS',
      playerSummary: { playerId, displayName: '陪玩小陈' }
    };
    const result = await getOrder({
      accountStore: accounts(),
      orderStore: new MatchingOrderStore([order({ status: 'ACCEPTED', playerId })], matching),
      actor: actor(),
      orderId
    });

    expect(result.matching).toEqual(matching);
  });
});

class MatchingOrderStore extends InMemoryOrderStore {
  constructor(orders: OrderRecord[], private readonly progress: OrderMatchingProgress) {
    super({ orders });
  }

  getMatchingProgress(): Promise<OrderMatchingProgress> {
    return Promise.resolve(this.progress);
  }
}

function accounts() {
  return new InMemoryAccountStore({ bindings: [binding()], reservations: [] });
}

function binding(): AccountBindingRecord {
  return {
    userId: customerId,
    displayName: 'Customer',
    userStatus: 'ACTIVE',
    userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-00000000d701',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    externalAccountId: '00000000-0000-0000-0000-00000000e701',
    provider: 'mock-provider',
    externalUserId: 'mock-user-ok',
    externalUserDisplay: 'mock-***-ok',
    externalAccountStatus: 'ACTIVE',
    boundAt: now.toISOString()
  };
}

function actor() {
  return {
    actorUserId: null,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT' as const,
    clientId: 'discord-bot',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    interactionId: '777777777777777777',
    permissionsVersion: null
  };
}

function order(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId,
    publicId: 'P-M2-MATCH',
    customerId,
    playerId: null,
    status: 'PENDING_DISPATCH',
    version: 3,
    serviceCatalogId: '00000000-0000-0000-0000-00000000c701',
    catalogVersion: 1,
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    unitCount: 2,
    customerUnitPriceMinor: 6000,
    playerUnitPayoutMinor: 4200,
    amountMinor: 12000,
    playerEarningMinor: 8400,
    currency: 'CAT',
    notes: null,
    channelSpec: { channelId: '120000000000000001', panelMessageId: '120000000000000002', voiceChannelId: null },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}
