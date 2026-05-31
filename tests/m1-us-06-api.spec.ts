import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { TestWalletFunding } from './support/wallet-fixture';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { createPilotFeaturePolicy, type PilotPhase } from '@blackcat/api/pilot-features';
import {
  InMemoryAccountStore,
  registerAccountRoutes,
  type AccountBindingRecord
} from '@blackcat/api/accounts';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const now = new Date('2026-07-17T22:00:00.000Z');

function boundAccount(overrides: Partial<AccountBindingRecord> = {}): AccountBindingRecord {
  return {
    userId: '00000000-0000-0000-0000-00000000a001',
    displayName: 'mock-***-ok',
    userStatus: 'ACTIVE',
    userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-00000000d001',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    externalAccountId: '00000000-0000-0000-0000-00000000e001',
    provider: 'mock-provider',
    externalUserId: 'mock-user-ok',
    externalUserDisplay: 'mock-***-ok',
    externalAccountStatus: 'ACTIVE',
    boundAt: now.toISOString(),
    ...overrides
  };
}

function botHeaders(discordUserId: string) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': '999999999999999999',
    'x-discord-interaction-id': '777777777777777777'
  };
}

function buildAccountServer(pilotPhase: PilotPhase = 'OFF') {
  const store = new InMemoryAccountStore({ bindings: [boundAccount()], reservations: [] });
  const server = buildApiServer({
    env,
    security: {
      auditSink: new InMemoryAuditSink(),
      idempotencyStore: new InMemoryIdempotencyStore(),
      pilotFeaturePolicy: createPilotFeaturePolicy(pilotPhase)
    }
  });
  registerAccountRoutes(server, {
    store,
    walletFunding: new TestWalletFunding(),
    now: () => now
  });
  return { server, store };
}

describe('M1-US-06 private current-user service center API contract', () => {
  test('listCurrentUserConsumptions returns a stable empty private page before consumption modules exist', async () => {
    const { server } = buildAccountServer();

    const owned = await server.inject({
      method: 'GET',
      url: '/api/v1/me/consumptions',
      headers: botHeaders('111111111111111111')
    });
    const unbound = await server.inject({
      method: 'GET',
      url: '/api/v1/me/consumptions',
      headers: botHeaders('222222222222222222')
    });

    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toEqual({
      requestId: expect.any(String),
      data: {
        items: [],
        nextCursor: null
      }
    });
    expect(owned.body).not.toMatch(/externalUserId|mock-user-ok|sourceCustomer|beneficiary/i);
    expect(unbound.statusCode).toBe(403);
  });

  test('listCurrentUserCommissions returns only beneficiary-safe empty records and never outgoing referral details', async () => {
    const { server } = buildAccountServer();

    const owned = await server.inject({
      method: 'GET',
      url: '/api/v1/me/commissions',
      headers: botHeaders('111111111111111111')
    });
    const unbound = await server.inject({
      method: 'GET',
      url: '/api/v1/me/commissions',
      headers: botHeaders('222222222222222222')
    });

    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toEqual({
      requestId: expect.any(String),
      data: {
        summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'USD' },
        items: [],
        nextCursor: null
      }
    });
    expect(owned.body).not.toMatch(/sourceCustomerId|beneficiaryId|referredCustomerId|rateBps|referralAttributionId/i);
    expect(unbound.statusCode).toBe(403);
  });

  test('CORE_ORDER keeps consumption history but rejects the referral commission surface', async () => {
    const { server } = buildAccountServer('CORE_ORDER');

    const currentUser = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: botHeaders('111111111111111111')
    });
    const consumptions = await server.inject({
      method: 'GET',
      url: '/api/v1/me/consumptions',
      headers: botHeaders('111111111111111111')
    });
    const commissions = await server.inject({
      method: 'GET',
      url: '/api/v1/me/commissions',
      headers: botHeaders('111111111111111111')
    });

    expect(currentUser.json().data.enabledFeatures).toEqual(['CORE_ORDER']);
    expect(consumptions.statusCode).toBe(200);
    expect(commissions.statusCode).toBe(409);
    expect(commissions.json()).toMatchObject({
      error: { code: 'FEATURE_DISABLED', details: [{ field: 'feature', reason: 'REFERRALS' }] }
    });
  });

  test('documents current-user service center operationIds on the expected OpenAPI paths', async () => {
    const openapi = await import('node:fs/promises').then((fs) =>
      fs.readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8')
    );

    expect(readOperationId(openapi, '/api/v1/me/consumptions', 'get')).toBe('listCurrentUserConsumptions');
    expect(readOperationId(openapi, '/api/v1/me/commissions', 'get')).toBe('listCurrentUserCommissions');
    expect(countOperationId(openapi, 'listCurrentUserConsumptions')).toBe(1);
    expect(countOperationId(openapi, 'listCurrentUserCommissions')).toBe(1);
  });
});

function readOperationId(openapi: string, path: string, method: string): string | null {
  const pathIndex = openapi.indexOf(`  ${path}:`);
  if (pathIndex === -1) {
    return null;
  }
  const nextPathIndex = openapi.indexOf('\n  /', pathIndex + 1);
  const pathBlock = openapi.slice(pathIndex, nextPathIndex === -1 ? undefined : nextPathIndex);
  const methodIndex = pathBlock.indexOf(`\n    ${method}:`);
  if (methodIndex === -1) {
    return null;
  }
  const nextMethodMatch = pathBlock.slice(methodIndex + 1).match(/\n    [a-z]+:/);
  const methodBlock = pathBlock.slice(methodIndex, nextMethodMatch ? methodIndex + 1 + nextMethodMatch.index! : undefined);
  const match = methodBlock.match(/operationId:\s*([A-Za-z0-9_]+)/);
  return match?.[1] ?? null;
}

function countOperationId(openapi: string, operationId: string): number {
  return (openapi.match(new RegExp(`operationId:\\s*${operationId}\\b`, 'g')) ?? []).length;
}
