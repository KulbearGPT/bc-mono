import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { MockFundingAdapter } from '@blackcat/api/payment-adapter';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore
} from '@blackcat/api/security';
import {
  InMemoryAccountStore,
  AccountError,
  registerAccountRoutes,
  type AccountBindingRecord,
  type FundReservationBalanceRecord
} from '@blackcat/api/accounts';

const env = {
  NODE_ENV: 'development',
  DATABASE_URL: '',
  API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};

const now = new Date('2026-07-17T18:00:00.000Z');

function buildAccountServer(input: {
  bindings?: AccountBindingRecord[];
  reservations?: FundReservationBalanceRecord[];
} = {}) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const store = new InMemoryAccountStore({
    bindings: input.bindings ?? [],
    reservations: input.reservations ?? []
  });
  const server = buildApiServer({
    env,
    security: {
      auditSink,
      idempotencyStore
    }
  });

  registerAccountRoutes(server, {
    store,
    fundingAdapter: new MockFundingAdapter({ now }),
    providerKey: 'mock-provider',
    now: () => now
  });

  return { server, store, auditSink, idempotencyStore };
}

function botHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': '999999999999999999',
    'x-discord-interaction-id': '777777777777777777',
    ...extra
  };
}

function dashboardHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    ...botHeaders(discordUserId, extra),
    'x-client-source': 'DASHBOARD'
  };
}

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

describe('M1-US-02 binding and current account API contract', () => {
  test('createBinding verifies a one-time credential through the provider and never returns or audits the raw code', async () => {
    const { server, auditSink, idempotencyStore } = buildAccountServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:binding:create:0001' }),
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-OK',
        expectedCurrency: 'CNY'
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      data: {
        externalUserDisplay: 'mock-***-ok',
        accountStatus: 'ACTIVE',
        boundAt: now.toISOString()
      }
    });
    expect(response.body).not.toContain('BIND-OK');
    expect(JSON.stringify(auditSink.records)).not.toContain('BIND-OK');
    const idempotencyRecords = Array.from(
      ((idempotencyStore as unknown as { records: Map<string, { fingerprint: string }> }).records).values()
    );
    expect(JSON.stringify(idempotencyRecords)).not.toContain('BIND-OK');
    expect(auditSink.records.at(-1)).toMatchObject({
      permissionCode: 'account.bind',
      outcome: 'SUCCEEDED'
    });
  });

  test('createBinding idempotency still conflicts on changed credentials without storing raw binding codes', async () => {
    const { server, idempotencyStore } = buildAccountServer();
    const headers = botHeaders('111111111111111111', { 'idempotency-key': 'discord:binding:fingerprint' });

    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers,
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-OK',
        expectedCurrency: 'CNY'
      }
    });
    const changedCredential = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers,
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-LOW',
        expectedCurrency: 'CNY'
      }
    });

    expect(first.statusCode).toBe(201);
    expect(changedCredential.statusCode).toBe(409);
    expect(changedCredential.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    const idempotencyRecords = Array.from(
      ((idempotencyStore as unknown as { records: Map<string, { fingerprint: string }> }).records).values()
    );
    expect(JSON.stringify(idempotencyRecords)).not.toContain('BIND-OK');
    expect(JSON.stringify(idempotencyRecords)).not.toContain('BIND-LOW');
  });

  test('createBinding rejects stable external user ids and requires a one-time binding code', async () => {
    const { server } = buildAccountServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:binding:externalid' }),
      payload: {
        credentialType: 'EXTERNAL_USER_ID',
        credentialValue: 'mock-user-ok',
        expectedCurrency: 'CNY'
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'credentialType must be ONE_TIME_CODE.'
      }
    });
  });

  test('createBinding is only accepted from the Discord bot client source', async () => {
    const { server } = buildAccountServer();

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers: dashboardHeaders('111111111111111111', { 'idempotency-key': 'dashboard:binding:blocked' }),
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-OK',
        expectedCurrency: 'CNY'
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: 'CLIENT_SOURCE_NOT_ACCEPTED' }
    });
  });

  test('createBinding rejects external account and Discord account conflicts', async () => {
    const { server } = buildAccountServer({ bindings: [boundAccount()] });

    const sameExternal = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers: botHeaders('222222222222222222', { 'idempotency-key': 'discord:binding:conflict:external' }),
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-OK',
        expectedCurrency: 'CNY'
      }
    });
    const sameDiscord = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:binding:conflict:discord' }),
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-LOW',
        expectedCurrency: 'CNY'
      }
    });

    expect(sameExternal.statusCode).toBe(409);
    expect(sameExternal.json()).toMatchObject({ error: { code: 'BINDING_CONFLICT' } });
    expect(sameDiscord.statusCode).toBe(409);
    expect(sameDiscord.json()).toMatchObject({ error: { code: 'BINDING_CONFLICT' } });
  });

  test('createBinding rolls back the binding if the success audit commit fails', async () => {
    const failingAuditSink = {
      append() {
        throw new Error('audit unavailable');
      }
    };
    const store = new InMemoryAccountStore({ bindings: [], reservations: [] });
    const server = buildApiServer({
      env,
      security: {
        auditSink: failingAuditSink,
        idempotencyStore: new InMemoryIdempotencyStore()
      }
    });
    registerAccountRoutes(server, {
      store,
      fundingAdapter: new MockFundingAdapter({ now }),
      providerKey: 'mock-provider',
      now: () => now,
      auditSink: failingAuditSink
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:binding:auditfail' }),
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-OK',
        expectedCurrency: 'CNY'
      }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'COMMIT_FAILED' } });
    await expect(
      store.findByDiscord({
        guildId: '999999999999999999',
        discordUserId: '111111111111111111'
      })
    ).resolves.toBeNull();
  });

  test('createBinding maps typed commit-time binding conflicts instead of returning a generic 500', async () => {
    const store = new InMemoryAccountStore({ bindings: [], reservations: [] });
    const originalCommitBinding = store.commitBinding.bind(store);
    let commitAttempts = 0;
    store.commitBinding = async (input) => {
      commitAttempts += 1;
      if (commitAttempts === 1) {
        throw new AccountError('BINDING_CONFLICT', 'External account is already bound.');
      }
      await originalCommitBinding(input);
    };
    const server = buildApiServer({
      env,
      security: {
        auditSink: new InMemoryAuditSink(),
        idempotencyStore: new InMemoryIdempotencyStore()
      }
    });
    registerAccountRoutes(server, {
      store,
      fundingAdapter: new MockFundingAdapter({ now }),
      providerKey: 'mock-provider',
      now: () => now
    });

    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/bindings',
      headers: botHeaders('111111111111111111', { 'idempotency-key': 'discord:binding:race' }),
      payload: {
        credentialType: 'ONE_TIME_CODE',
        credentialValue: 'BIND-OK',
        expectedCurrency: 'CNY'
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'BINDING_CONFLICT', message: 'External account is already bound.' }
    });
  });


  test('getCurrentUser returns only the current Discord actor service-center summary', async () => {
    const { server } = buildAccountServer({ bindings: [boundAccount()] });

    const owned = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: botHeaders('111111111111111111')
    });
    const unbound = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: botHeaders('222222222222222222')
    });

    expect(owned.statusCode).toBe(200);
    expect(owned.json()).toMatchObject({
      data: {
        user: {
          id: '00000000-0000-0000-0000-00000000a001',
          displayName: 'mock-***-ok',
          status: 'ACTIVE',
          externalAccountDisplay: 'mock-***-ok',
          activeOrderId: null,
          riskFlags: [],
          version: 1
        },
        activeOrderId: null,
        consumptionSummary: { totalMinor: 0, currency: 'CNY' },
        commissionSummary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CNY' }
      }
    });
    expect(owned.body).not.toContain('mock-user-ok');
    expect(unbound.statusCode).toBe(403);
  });

  test('getCurrentBalance derives availableMinor from fresh provider balance minus active reservations', async () => {
    const { server } = buildAccountServer({
      bindings: [boundAccount()],
      reservations: [
        {
          id: '00000000-0000-0000-0000-00000000f001',
          userId: '00000000-0000-0000-0000-00000000a001',
          amountMinor: 12000,
          currency: 'CNY',
          status: 'PENDING'
        },
        {
          id: '00000000-0000-0000-0000-00000000f002',
          userId: '00000000-0000-0000-0000-00000000a001',
          amountMinor: 8000,
          currency: 'CNY',
          status: 'ACTIVE'
        },
        {
          id: '00000000-0000-0000-0000-00000000f003',
          userId: '00000000-0000-0000-0000-00000000a001',
          amountMinor: 5000,
          currency: 'CNY',
          status: 'RELEASED'
        }
      ]
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/me/balance',
      headers: botHeaders('111111111111111111')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        providerBalanceMinor: 1_000_000,
        reservedMinor: 20_000,
        availableMinor: 980_000,
        currency: 'CNY',
        fetchedAt: now.toISOString()
      }
    });
    expect(response.body).not.toContain('externalUserId');
  });

  test('M7 supersedes Provider binding while preserving current-user and internal-balance operations', async () => {
    const openapi = await import('node:fs/promises').then((fs) =>
      fs.readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8')
    );

    expect(readOperationId(openapi, '/api/v1/bindings', 'post')).toBeNull();
    expect(readOperationId(openapi, '/api/v1/me', 'get')).toBe('getCurrentUser');
    expect(readOperationId(openapi, '/api/v1/me/balance', 'get')).toBe('getCurrentBalance');
    expect(countOperationId(openapi, 'createBinding')).toBe(0);
    expect(countOperationId(openapi, 'getCurrentUser')).toBe(1);
    expect(countOperationId(openapi, 'getCurrentBalance')).toBe(1);
    expect(openapi).not.toContain('CreateBindingRequest:');
    expect(readSchemaBlock(openapi, 'WalletBalance')).toContain('currency: {type: string, const: USD}');
  });

  test('buildApiServer can wire account routes for the running API process', async () => {
    const server = buildApiServer({
      env,
      security: {
        auditSink: new InMemoryAuditSink(),
        idempotencyStore: new InMemoryIdempotencyStore()
      },
      account: {
        store: new InMemoryAccountStore({ bindings: [boundAccount()], reservations: [] }),
        fundingAdapter: new MockFundingAdapter({ now }),
        providerKey: 'mock-provider',
        now: () => now
      }
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: botHeaders('111111111111111111')
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        user: expect.objectContaining({ id: '00000000-0000-0000-0000-00000000a001' })
      }
    });
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
  return methodBlock.match(/\n      operationId: ([A-Za-z0-9_]+)/)?.[1] ?? null;
}

function countOperationId(openapi: string, operationId: string): number {
  return openapi.match(new RegExp(`operationId: ${operationId}\\b`, 'g'))?.length ?? 0;
}

function readSchemaBlock(openapi: string, schemaName: string): string {
  const schemaIndex = openapi.indexOf(`    ${schemaName}:`);
  if (schemaIndex === -1) {
    return '';
  }
  const nextSchema = openapi.slice(schemaIndex + 1).match(/\n    [A-Za-z0-9_]+:/);
  return openapi.slice(schemaIndex, nextSchema ? schemaIndex + 1 + nextSchema.index! : undefined);
}
