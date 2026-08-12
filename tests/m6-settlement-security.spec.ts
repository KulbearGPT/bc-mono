import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import {
  InMemorySettlementStore,
  createSettlementBatch,
  type SettlementCandidateEarning,
  type SettlementCreateInput
} from '@blackcat/api/settlements';
import type { StaffAccount } from '@blackcat/api/security';
import { startIsolatedPostgres, type IsolatedPostgres } from './support/isolated-postgres';


const env = {
  NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000',
  BOT_SERVICE_TOKEN: 'valid-bot-token'
};
const guildA = '900000000000006801';
const guildB = '900000000000006802';
const staffId = '00000000-0000-0000-0000-000000006890';
const playerA = '00000000-0000-0000-0000-000000006891';
const playerB = '00000000-0000-0000-0000-000000006892';

function account(): StaffAccount {
  return { staffId, userId: staffId, level: 'L4_ADMIN_OWNER', permissionsVersion: 1, status: 'ACTIVE' };
}

function headers(guildId: string, key?: string) {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DASHBOARD',
    'x-actor-discord-user-id': 'settlement-owner',
    'x-actor-guild-id': guildId,
    ...(key ? { 'idempotency-key': key } : {})
  };
}

function earning(id: string, playerUserId: string, guildId: string): SettlementCandidateEarning {
  return {
    id, orderId: id, playerUserId, guildId, amountMinor: 10_000, currency: 'CAT', status: 'CONFIRMED',
    playerDisplayName: playerUserId, playerDiscordUserId: null, externalAccountDisplay: null,
    confirmedAt: '2026-07-19T12:00:00.000Z', paidAt: null,
    createdAt: '2026-07-19T11:00:00.000Z', adjustments: []
  };
}

function createInput(guildId: string, playerUserIds: string[] | null): SettlementCreateInput {
  return {
    guildId, source: 'MANUAL', scheduleKey: null,
    periodStart: '2026-07-13T16:00:00.000Z', periodEnd: '2026-07-19T16:00:00.000Z',
    cutoffAt: '2026-07-19T16:00:00.000Z', timeZone: 'Asia/Shanghai', currency: 'CAT',
    playerUserIds, createdByStaffId: staffId
  };
}

function serverFor(store: InMemorySettlementStore) {
  return buildApiServer({
    env,
    security: {
      staffDirectory: { resolveByDiscord: () => account() },
      stepUpVerifier: { verify: () => true }
    },
    settlements: {
      store,
      now: () => new Date('2026-07-19T18:00:00.000Z'),
      manualDualReviewFromMinor: 400_000,
      l4ReviewFromMinor: 500_000
    }
  });
}

describe('settlement security remediation', () => {
  test('derives immutable Guild ownership from Actor Context and hides other Guild batches', async () => {
    const store = new InMemorySettlementStore({ earnings: [
      earning('00000000-0000-0000-0000-000000006811', playerA, guildA),
      earning('00000000-0000-0000-0000-000000006812', playerB, guildB)
    ] });
    const server = serverFor(store);

    const created = await server.inject({
      method: 'POST', url: '/api/v1/admin/settlement-batches',
      headers: headers(guildA, 'm6:guild:create:0001'),
      payload: { ...createInput(guildB, [playerA]), guildId: guildB }
    });
    expect(created.statusCode, created.body).toBe(201);
    const batch = created.json().data;
    expect(batch.guildId).toBe(guildA);

    const listed = await server.inject({ method: 'GET', url: '/api/v1/admin/settlement-batches', headers: headers(guildB) });
    expect(listed.json()).toMatchObject({ data: { items: [] } });
    const fetched = await server.inject({
      method: 'GET', url: `/api/v1/admin/settlement-batches/${batch.id}`, headers: headers(guildB)
    });
    expect(fetched.statusCode).toBe(404);
    const exported = await server.inject({
      method: 'GET', url: `/api/v1/admin/settlement-batches/${batch.id}/exports/SUMMARY`, headers: headers(guildB)
    });
    expect(exported.statusCode).toBe(404);
    const submitted = await server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${batch.id}/submit`,
      headers: headers(guildB, 'm6:guild:submit:001'),
      payload: { expectedVersion: 1, reasonCode: 'CROSS_GUILD' }
    });
    expect(submitted.statusCode).toBe(404);
    const voided = await server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${batch.id}/void`,
      headers: headers(guildB, 'm6:guild:void:0001'),
      payload: { expectedVersion: 1, reasonCode: 'CROSS_GUILD' }
    });
    expect(voided.statusCode).toBe(404);
  });

  test('rejects self, cross-Guild, and cross-currency replacement attacks before atomically creating a valid replacement', async () => {
    const store = new InMemorySettlementStore({ earnings: [
      earning('00000000-0000-0000-0000-000000006821', playerA, guildA),
      earning('00000000-0000-0000-0000-000000006822', playerB, guildA)
    ] });
    const original = await createSettlementBatch({ store, input: createInput(guildA, [playerA]) });
    store.submit(guildA, original.id, {
      expectedVersion: 1, reason: 'review', actorStaffId: staffId,
      actorLevel: 'L4_ADMIN_OWNER', now: new Date('2026-07-19T17:00:00.000Z')
    });
    store.approve(guildA, original.id, {
      expectedVersion: 2, reason: 'approve', actorStaffId: staffId,
      actorLevel: 'L4_ADMIN_OWNER', now: new Date('2026-07-19T17:30:00.000Z')
    }, { manualDualReviewFromMinor: 400_000, l4ReviewFromMinor: 500_000 });
    const rejectedReplacement = (replacementBatchId: string, replacement: SettlementCreateInput) => () =>
      store.void(guildA, original.id, {
        expectedVersion: 3,
        reason: 'invalid replacement',
        actorStaffId: staffId,
        actorLevel: 'L4_ADMIN_OWNER',
        now: new Date('2026-07-19T17:45:00.000Z'),
        replacementBatchId,
        replacement
      });
    expect(rejectedReplacement(original.id, createInput(guildA, [playerA]))).toThrow(/cannot replace itself/i);
    expect(rejectedReplacement('00000000-0000-0000-0000-000000006827', createInput(guildB, [playerA]))).toThrow(
      /same Guild and currency/i
    );
    expect(rejectedReplacement('00000000-0000-0000-0000-000000006828', {
      ...createInput(guildA, [playerA]),
      currency: 'USD'
    })).toThrow(/same Guild and currency/i);
    expect(store.batches).toHaveLength(1);
    expect(store.batches[0]).toMatchObject({ status: 'APPROVED', replacementBatchId: null });
    const server = serverFor(store);

    const missing = await server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${original.id}/void`,
      headers: headers(guildA, 'm6:void:no-replacement:1'),
      payload: { expectedVersion: 3, reasonCode: 'CORRECTION_REQUIRED' }
    });
    expect(missing.statusCode).toBe(409);

    const replacementBatchId = '00000000-0000-0000-0000-000000006829';
    const replaced = await server.inject({
      method: 'POST', url: `/api/v1/admin/settlement-batches/${original.id}/void`,
      headers: headers(guildA, 'm6:void:replacement:01'),
      payload: {
        expectedVersion: 3,
        reasonCode: 'CORRECTION_REQUIRED',
        replacementBatchId,
        replacement: createInput(guildB, [playerA])
      }
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json()).toMatchObject({ data: { status: 'VOIDED', replacementBatchId } });
    expect(store.get(guildA, replacementBatchId)).toMatchObject({ guildId: guildA, currency: 'CAT', status: 'DRAFT' });
  });

  test('wires PostgreSQL settlement and durable idempotency stores in production', () => {
    const source = readFileSync('apps/api/src/index.ts', 'utf8');
    expect(source).toContain('new PostgresSettlementStore(databasePool)');
    expect(source).toContain('settlements:');
    expect(source).toContain('new PostgresIdempotencyStore');
    expect(source).not.toContain('idempotencyStore: new InMemoryIdempotencyStore()');
  });
});

describe('durable settlement idempotency', () => {
  let isolated: IsolatedPostgres;
  let pool: Pool;

  beforeAll(async () => {
    isolated = await startIsolatedPostgres('a6_idempotency');
    pool = isolated.pool;
  }, 30_000);

  afterAll(async () => isolated.stop());

  test('replays a completed response from a fresh PostgreSQL store instance', async () => {
    await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at)
      VALUES ($1,'Settlement Operator','ACTIVE',1,now(),now())`, [staffId]);
    await pool.query(`INSERT INTO staff_accounts
      (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES ($1,$1,'L4_ADMIN_OWNER','ACTIVE','MANUAL',1,now(),now())`, [staffId]);
    const security = await import('@blackcat/api/security') as typeof import('@blackcat/api/security') & {
      PostgresIdempotencyStore: new (options: { client: Pool }) => {
        reserve(scopeKey: string, fingerprint: string): Promise<{ reserved: boolean; record: { payload?: unknown } }>;
        complete(scopeKey: string, statusCode: number, payload: unknown): Promise<void>;
      };
    };
    expect(security.PostgresIdempotencyStore).toBeTypeOf('function');
    const scopeKey = JSON.stringify({
      clientId: 'DASHBOARD', operation: 'VOID_SETTLEMENT_BATCH',
      actorKey: `STAFF:${staffId}`, key: 'm6:durable:void:0001'
    });
    const first = new security.PostgresIdempotencyStore({ client: pool });
    expect((await first.reserve(scopeKey, 'fingerprint-a')).reserved).toBe(true);
    await first.complete(scopeKey, 200, { requestId: 'req-1', data: { status: 'VOIDED' } });

    const restarted = new security.PostgresIdempotencyStore({ client: pool });
    const replay = await restarted.reserve(scopeKey, 'fingerprint-a');
    expect(replay).toMatchObject({
      reserved: false,
      record: { status: 'COMPLETED', statusCode: 200, payload: { requestId: 'req-1', data: { status: 'VOIDED' } } }
    });
    const conflict = await restarted.reserve(scopeKey, 'fingerprint-b');
    expect(conflict).toMatchObject({ reserved: false, record: { fingerprint: 'fingerprint-a' } });
  });
});
