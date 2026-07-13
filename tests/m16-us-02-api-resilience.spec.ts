import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type IdempotencyStore,
  type StaffDirectory
} from '@blackcat/api/security';
import { InMemoryWalletStore, WalletService, type WalletEntry } from '@blackcat/api/wallet';

const env = {
  NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0',
  API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const guildId = '999999999999999999';
const discordUserId = '111111111111111111';
const staffDirectory: StaffDirectory = {
  resolveByDiscord: () => ({
    staffId: '00000000-0000-0000-0000-000000016201',
    userId: '00000000-0000-0000-0000-000000016202',
    level: 'L1_SUPPORT', permissionsVersion: 1, status: 'ACTIVE'
  })
};

describe('M16-US-02 secure-route and wallet API resilience', () => {
  test('maps targetId validation through the standard error envelope and rejected audit', async () => {
    const audit = new InMemoryAuditSink();
    const server = buildApiServer({ env, security: {
      auditSink: audit, idempotencyStore: new InMemoryIdempotencyStore(), staffDirectory
    } });
    const route = {
      permission: 'staff_task.read', targetType: 'staff_task',
      targetId: () => { throw new RouteInputError('targetId is invalid.'); },
      acceptedSources: ['DISCORD_BOT'] as const,
      mapError: (error: unknown) => error instanceof RouteInputError
        ? { statusCode: 400, code: 'VALIDATION_ERROR', message: error.message } : null
    };
    registerSecureReadRoute(server, server.securityOptions!, {
      ...route, method: 'GET', url: '/__m16/invalid-target-read',
      action: 'M16_INVALID_TARGET_READ', handler: () => ({ unreachable: true })
    });
    registerSecureWriteRoute(server, server.securityOptions!, {
      ...route, method: 'POST', url: '/__m16/invalid-target-write',
      action: 'M16_INVALID_TARGET_WRITE', handler: () => ({ unreachable: true })
    });

    const read = await server.inject({
      method: 'GET', url: '/__m16/invalid-target-read', headers: botHeaders()
    });
    const write = await server.inject({
      method: 'POST', url: '/__m16/invalid-target-write', headers: botHeaders(), payload: {}
    });

    for (const response of [read, write]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        requestId: expect.any(String),
        error: { code: 'VALIDATION_ERROR', message: 'targetId is invalid.' }
      });
    }
    expect(audit.records).toHaveLength(2);
    expect(audit.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'M16_INVALID_TARGET_READ', outcome: 'REJECTED', reason: 'VALIDATION_ERROR' }),
      expect.objectContaining({ action: 'M16_INVALID_TARGET_WRITE', outcome: 'REJECTED', reason: 'VALIDATION_ERROR' })
    ]));
  });

  test('terminalizes the committed response when normal idempotency completion fails', async () => {
    const delegate = new InMemoryIdempotencyStore();
    const idempotency: IdempotencyStore = {
      reserve: (...args) => delegate.reserve(...args),
      complete: async () => { throw new Error('IDEMPOTENCY_COMPLETE_UNAVAILABLE'); },
      fail: (...args) => delegate.fail(...args),
      retryFailed: (...args) => delegate.retryFailed(...args)
    };
    const server = buildApiServer({ env, security: {
      auditSink: new InMemoryAuditSink(), idempotencyStore: idempotency, staffDirectory
    } });
    let handlerRuns = 0;
    let businessCommits = 0;
    registerSecureWriteRoute(server, server.securityOptions!, {
      method: 'POST', url: '/__m16/idempotency-finalization', permission: 'staff_task.claim',
      action: 'M16_IDEMPOTENCY_FINALIZATION', targetType: 'staff_task', acceptedSources: ['DISCORD_BOT'],
      successStatusCode: 201,
      handler: () => {
        handlerRuns += 1;
        return { data: { committed: true }, commit: async () => { businessCommits += 1; } };
      }
    });
    const headers = botHeaders({ 'idempotency-key': 'm16:committed-response:0001' });

    const first = await server.inject({ method: 'POST', url: '/__m16/idempotency-finalization', headers, payload: {} });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ data: { committed: true } });

    const replay = await server.inject({ method: 'POST', url: '/__m16/idempotency-finalization', headers, payload: {} });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['x-idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect({ handlerRuns, businessCommits }).toEqual({ handlerRuns: 1, businessCommits: 1 });
  });

  test('returns stable wallet entry pages instead of a bare array', async () => {
    const userId = '00000000-0000-0000-0000-000000016210';
    const store = new InMemoryWalletStore();
    const wallet = store.getOrCreate(userId);
    wallet.entries.push(...[
      entry(wallet.id, '00000000-0000-0000-0000-000000016211', '2026-08-06T12:03:00.000Z'),
      entry(wallet.id, '00000000-0000-0000-0000-000000016212', '2026-08-06T12:02:00.000Z'),
      entry(wallet.id, '00000000-0000-0000-0000-000000016213', '2026-08-06T12:01:00.000Z')
    ]);
    const service = new WalletService(store);

    const first = await service.listEntries({ userId, cursor: null, limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([
      '00000000-0000-0000-0000-000000016211', '00000000-0000-0000-0000-000000016212'
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await service.listEntries({ userId, cursor: first.nextCursor, limit: 2 });
    expect(second).toEqual({ items: [expect.objectContaining({ id: '00000000-0000-0000-0000-000000016213' })], nextCursor: null });
    await expect(service.listEntries({ userId, cursor: `${first.nextCursor}x`, limit: 2 }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.listEntries({
      userId: '00000000-0000-0000-0000-000000016219', cursor: first.nextCursor, limit: 2
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

class RouteInputError extends Error {}

function botHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId, 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': '777777777777777777',
    'idempotency-key': 'm16:target-validation:0001', ...extra
  };
}

function entry(walletAccountId: string, id: string, occurredAt: string): WalletEntry {
  return {
    id, walletAccountId, entryType: 'TOP_UP_CREDIT', direction: 'CREDIT', amountMinor: 100,
    currency: 'CAT', sourceType: 'TOP_UP', sourceId: id, reversalOfEntryId: null, occurredAt
  };
}
