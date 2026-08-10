import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryIdempotencyStore, PostgresAuditSink } from '@blackcat/api/security';
import { InMemoryAccountStore } from '@blackcat/api/accounts';
import { InMemoryOrderStore } from '@blackcat/api/orders';
import { PostgresGiftStore, createGiftExpiryHandler, registerGiftRoutes } from '@blackcat/api/gifts';
import type { OutboxJob } from '@blackcat/api/outbox';
import { TestWalletFunding } from './support/wallet-fixture';
import {
  seedGiftAutomationScenario,
  startIsolatedGiftDatabase,
  type GiftAutomationSeed,
  type IsolatedGiftDatabase
} from './support/gift-automation-fixture';

const now = new Date('2026-08-14T07:00:00.000Z');
let database: IsolatedGiftDatabase;

describe('M22-US-06 PostgreSQL gift lifecycle matrix', () => {
  beforeAll(async () => { database = await startIsolatedGiftDatabase('lifecycle-postgres'); }, 30_000);
  afterAll(async () => database.stop());

  test('GTA-L-001/L-004/L-009 verifies and approves by capturing the original reservation exactly once', async () => {
    const fixture = await createdGift(71);
    await claimAndVerify(fixture);
    const payload = { expectedVersion: 2, reason: '已核对客户授权、陪玩和礼物金额。' };
    const first = await fixture.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${fixture.giftRequestId}/approve`,
      headers: staffHeaders(fixture.seed, 'gift:m22:06:approve:once'), payload });
    const replay = await fixture.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${fixture.giftRequestId}/approve`,
      headers: staffHeaders(fixture.seed, 'gift:m22:06:approve:once'), payload });
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(await lifecycleFacts(fixture.giftRequestId)).toMatchObject({
      gift_status: 'CAPTURED', reservation_status: 'CAPTURED', reservation_count: 1,
      capture_events: 1, consumption_count: 1, announcement_count: 1
    });
    await fixture.server.close();
  });

  test('GTA-L-006 rejects a verified gift by releasing its reservation without charge or announcement', async () => {
    const fixture = await createdGift(72);
    await claimAndVerify(fixture);
    const rejected = await fixture.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${fixture.giftRequestId}/reject`,
      headers: staffHeaders(fixture.seed, 'gift:m22:06:reject:once'),
      payload: { expectedVersion: 2, reason: '接收资格核对未通过。' } });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(await lifecycleFacts(fixture.giftRequestId)).toMatchObject({
      gift_status: 'REJECTED', reservation_status: 'RELEASED', reservation_count: 1,
      release_events: 1, consumption_count: 0, announcement_count: 0
    });
    await fixture.server.close();
  });

  test('GTA-L-008 expires through the real Worker handler and releases idempotently', async () => {
    const fixture = await createdGift(73);
    const jobRow = (await database.pool.query(`SELECT id,event_type,payload,aggregate_type,aggregate_id,dedupe_key,
      status,attempt_count,max_attempts,available_at,locked_at,locked_by,last_error,row_version,created_at,updated_at
      FROM outbox_events WHERE gift_request_id=$1 AND event_type='GIFT_EXPIRY'`, [fixture.giftRequestId])).rows[0];
    const job: OutboxJob = {
      id: jobRow.id, type: jobRow.event_type, payload: jobRow.payload, aggregateType: jobRow.aggregate_type,
      aggregateId: jobRow.aggregate_id, dedupeKey: jobRow.dedupe_key, status: jobRow.status,
      attempts: jobRow.attempt_count, maxAttempts: jobRow.max_attempts, runAfter: jobRow.available_at.toISOString(),
      lockedAt: jobRow.locked_at?.toISOString() ?? null, lockedBy: jobRow.locked_by, lastError: jobRow.last_error,
      version: jobRow.row_version, createdAt: jobRow.created_at.toISOString(), updatedAt: jobRow.updated_at.toISOString()
    };
    const store = new PostgresGiftStore(database.pool);
    const handler = createGiftExpiryHandler({ store, now: () => new Date(now.getTime() + 31 * 60_000) });
    await handler(job);
    await handler(job);
    expect(await lifecycleFacts(fixture.giftRequestId)).toMatchObject({
      gift_status: 'EXPIRED', reservation_status: 'EXPIRED', reservation_count: 1,
      expire_events: 1, consumption_count: 0, announcement_count: 0
    });
    await fixture.server.close();
  });

  test('GTA-L-010 serializes concurrent approve and reject into one coherent terminal outcome', async () => {
    const fixture = await createdGift(74);
    await claimAndVerify(fixture);
    const [approve, reject] = await Promise.all([
      fixture.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${fixture.giftRequestId}/approve`,
        headers: staffHeaders(fixture.seed, 'gift:m22:06:decision:approve'),
        payload: { expectedVersion: 2, reason: '并发批准测试。' } }),
      fixture.server.inject({ method: 'POST', url: `/api/v1/admin/gift-requests/${fixture.giftRequestId}/reject`,
        headers: staffHeaders(fixture.seed, 'gift:m22:06:decision:reject'),
        payload: { expectedVersion: 2, reason: '并发拒绝测试。' } })
    ]);
    expect([approve.statusCode, reject.statusCode].sort(), `${approve.body}\n${reject.body}`).toEqual([200, 409]);
    const facts = await lifecycleFacts(fixture.giftRequestId);
    expect(['CAPTURED', 'REJECTED']).toContain(facts.gift_status);
    if (facts.gift_status === 'CAPTURED') {
      expect(facts).toMatchObject({ reservation_status: 'CAPTURED', capture_events: 1, release_events: 0,
        consumption_count: 1, announcement_count: 1 });
    } else {
      expect(facts).toMatchObject({ reservation_status: 'RELEASED', capture_events: 0, release_events: 1,
        consumption_count: 0, announcement_count: 0 });
    }
    await fixture.server.close();
  });
});

async function createdGift(sequence: number) {
  const seed = await seedGiftAutomationScenario(database.pool, { sequence, now, balanceMinor: 300_000, priceMinor: 200_000,
    staffLevel: 'L2_SUPERVISOR' });
  const server = buildServer(seed);
  const response = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
    headers: customerHeaders(seed, `gift:m22:06:create:${sequence}`), payload: {
      playerProfileId: seed.playerProfileId, giftCatalogVersionId: seed.catalogVersionId,
      expectedCatalogVersion: 1, expectedPriceMinor: seed.priceMinor, anonymous: sequence % 2 === 0
    } });
  expect(response.statusCode, response.body).toBe(201);
  return { seed, server, giftRequestId: response.json().data.id as string,
    taskId: response.json().data.staffTask.id as string };
}

async function claimAndVerify(fixture: Awaited<ReturnType<typeof createdGift>>) {
  await database.pool.query(`UPDATE staff_tasks SET status='CLAIMED',row_version=2,claimed_by_staff_id=$2,
    claimed_at=$3,updated_at=$3 WHERE id=$1 AND status='OPEN'`, [fixture.taskId, fixture.seed.staffId, now]);
  const verified = await fixture.server.inject({ method: 'POST', url: `/api/v1/admin/staff-tasks/${fixture.taskId}/verify`,
    headers: staffHeaders(fixture.seed, `gift:m22:06:verify:${fixture.taskId.slice(-4)}`),
    payload: { expectedVersion: 2, verificationMethod: 'DIRECT_MESSAGE', notes: '已核对客户明确授权。' } });
  expect(verified.statusCode, verified.body).toBe(200);
}

function buildServer(seed: GiftAutomationSeed) {
  const server = buildApiServer({
    env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: {
      auditSink: new PostgresAuditSink({ client: database.pool }), idempotencyStore: new InMemoryIdempotencyStore(),
      staffDirectory: { resolveByDiscord: ({ discordUserId }) => discordUserId === seed.staffDiscordId
        ? { staffId: seed.staffId, userId: seed.staffUserId, level: 'L2_SUPERVISOR', permissionsVersion: 1, status: 'ACTIVE' } : null }
    }
  });
  registerGiftRoutes(server, {
    store: new PostgresGiftStore(database.pool), orderStore: new InMemoryOrderStore(),
    accountStore: new InMemoryAccountStore({ bindings: [seed.customerBinding] }),
    walletFunding: new TestWalletFunding(seed.balanceMinor), broadcastChannelId: '900000000000007999', now: () => now
  });
  return server;
}

function customerHeaders(seed: GiftAutomationSeed, key: string) {
  return actorHeaders(seed.customerDiscordId, seed.guildId, key);
}

function staffHeaders(seed: GiftAutomationSeed, key: string) {
  return actorHeaders(seed.staffDiscordId, seed.guildId, key);
}

function actorHeaders(discordUserId: string, guildId: string, key: string) {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId, 'x-actor-guild-id': guildId,
    'x-discord-interaction-id': `8${key.replace(/\D/gu, '').padEnd(18, '0').slice(0, 18)}`,
    'idempotency-key': key };
}

async function lifecycleFacts(giftRequestId: string) {
  const result = await database.pool.query(`SELECT gr.status::text gift_status,fr.status::text reservation_status,
    (SELECT count(*)::int FROM fund_reservations WHERE gift_request_id=gr.id) reservation_count,
    (SELECT count(*)::int FROM fund_reservation_events WHERE fund_reservation_id=fr.id AND event_type='CAPTURED') capture_events,
    (SELECT count(*)::int FROM fund_reservation_events WHERE fund_reservation_id=fr.id AND event_type='RELEASED') release_events,
    (SELECT count(*)::int FROM fund_reservation_events WHERE fund_reservation_id=fr.id AND event_type='EXPIRED') expire_events,
    (SELECT count(*)::int FROM consumption_entries WHERE gift_request_id=gr.id) consumption_count,
    (SELECT count(*)::int FROM outbox_events WHERE gift_request_id=gr.id AND event_type='GIFT_ANNOUNCEMENT') announcement_count
    FROM gift_requests gr JOIN fund_reservations fr ON fr.gift_request_id=gr.id WHERE gr.id=$1`, [giftRequestId]);
  return result.rows[0];
}
