import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAccountStore, registerAccountRoutes, type AccountBindingRecord, type BeneficiaryCommissionRecord, type ConsumptionRecord } from '@blackcat/api/accounts';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { TestWalletFunding } from './support/wallet-fixture';

const now = new Date('2026-07-18T17:00:00.000Z');
const userId = '00000000-0000-0000-0000-000000004010';

function binding(): AccountBindingRecord {
  return { userId, displayName: 'Owner', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-000000004011', guildId: '900000000000000001',
    discordUserId: '900000000000000051', externalAccountId: '00000000-0000-0000-0000-000000004012',
    provider: 'mock-provider', externalUserId: 'mock-user-ok', externalUserDisplay: 'mock-***-ok',
    externalAccountStatus: 'ACTIVE', boundAt: now.toISOString() };
}

function consumption(id: string, occurredAt: string, type: ConsumptionRecord['type']): ConsumptionRecord & { userId: string } {
  return { id, userId, type, sourceId: id, amountMinor: type === 'REVERSAL' ? -2000 : 12000, currency: 'CAT',
    status: type === 'REVERSAL' ? 'REVERSED' : 'SUCCEEDED', targetDisplay: type === 'GIFT' ? 'Gift 星光礼盒' : 'Order P-4010',
    occurredAt, reversalOf: type === 'REVERSAL' ? '00000000-0000-0000-0000-000000004021' : null };
}

function commission(id: string, beneficiaryUserId: string): BeneficiaryCommissionRecord & { beneficiaryUserId: string } {
  return { id, beneficiaryUserId, programType: 'PLAYER_LIFETIME', sourceCustomerMasked: { display: 'Customer ***' },
    amountMinor: 240, currency: 'CAT', status: 'PENDING', adjustments: [{ type: 'REVERSAL_DEBIT', amountMinor: 40,
      currency: 'CAT', createdAt: now.toISOString() }], netAmountMinor: 200, version: 2, createdAt: now.toISOString() };
}

function fixture() {
  const store = new InMemoryAccountStore({ bindings: [binding()], consumptions: [
    consumption('00000000-0000-0000-0000-000000004021', '2026-07-18T17:00:00.000Z', 'ORDER'),
    consumption('00000000-0000-0000-0000-000000004022', '2026-07-18T16:00:00.000Z', 'GIFT'),
    consumption('00000000-0000-0000-0000-000000004023', '2026-07-18T15:00:00.000Z', 'REVERSAL')
  ], commissions: [commission('00000000-0000-0000-0000-000000004031', userId),
    commission('00000000-0000-0000-0000-000000004032', '00000000-0000-0000-0000-000000004099')] });
  const server = buildApiServer({ env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() } });
  registerAccountRoutes(server, { store, walletFunding: new TestWalletFunding(), now: () => now });
  return server;
}

const headers = { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
  'x-actor-discord-user-id': '900000000000000051', 'x-actor-guild-id': '900000000000000001' };

describe('M3-US-05 private financial history', () => {
  test('paginates order, gift and reversal consumption without duplicates', async () => {
    const server = fixture();
    const first = await server.inject({ method: 'GET', url: '/api/v1/me/consumptions?limit=2', headers });
    expect(first.json()).toMatchObject({ data: { items: [{ type: 'ORDER' }, { type: 'GIFT' }], nextCursor: expect.any(String) } });
    const second = await server.inject({ method: 'GET', url: `/api/v1/me/consumptions?limit=2&cursor=${first.json().data.nextCursor}`, headers });
    expect(second.json()).toMatchObject({ data: { items: [{ type: 'REVERSAL', amountMinor: -2000 }], nextCursor: null } });
  });

  test('returns only commissions owned by the actor with no relationship identifiers or rate', async () => {
    const response = await fixture().inject({ method: 'GET', url: '/api/v1/me/commissions', headers });
    expect(response.json()).toMatchObject({ data: { summary: { pendingMinor: 200 }, items: [{
      id: '00000000-0000-0000-0000-000000004031', sourceCustomerMasked: { display: 'Customer ***' },
      amountMinor: 240, netAmountMinor: 200, adjustments: [{ amountMinor: 40 }] }] } });
    expect(response.body).not.toMatch(/beneficiaryUserId|sourceCustomerId|referralAttributionId|rateBps|00000000-0000-0000-0000-000000004032/);
  });
});
