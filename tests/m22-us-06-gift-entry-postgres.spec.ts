import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryIdempotencyStore, PostgresAuditSink } from '@blackcat/api/security';
import { InMemoryAccountStore } from '@blackcat/api/accounts';
import { InMemoryOrderStore } from '@blackcat/api/orders';
import { PostgresGiftStore, registerGiftRoutes } from '@blackcat/api/gifts';
import { TestWalletFunding } from './support/wallet-fixture';
import {
  seedGiftAutomationScenario,
  snapshotGiftFacts,
  startIsolatedGiftDatabase,
  type GiftAutomationSeed,
  type GiftFactSnapshot,
  type IsolatedGiftDatabase
} from './support/gift-automation-fixture';

const now = new Date('2026-08-14T05:00:00.000Z');
let database: IsolatedGiftDatabase;

describe('M22-US-06 PostgreSQL gift entry matrix', () => {
  beforeAll(async () => { database = await startIsolatedGiftDatabase('entry-postgres'); }, 30_000);
  afterAll(async () => database.stop());

  test('GTA-S-001/002/008/009 lists a trusted recipient and persists one idempotent public request', async () => {
    const seed = await seedGiftAutomationScenario(database.pool, { sequence: 61, now });
    const server = buildServer(seed);
    const center = await server.inject({ method: 'GET', url: '/api/v1/gift-center', headers: headers(seed) });
    expect(center.statusCode, center.body).toBe(200);
    expect(center.json().data).toMatchObject({
      recipients: [{ playerProfileId: seed.playerProfileId, displayName: '陪玩测试账号' }],
      items: [{ id: seed.catalogVersionId, priceMinor: seed.priceMinor, affordable: true }],
      balance: { ledgerBalanceMinor: seed.balanceMinor, availableMinor: seed.balanceMinor, currency: 'CAT' }
    });

    const payload = { playerProfileId: seed.playerProfileId, giftCatalogVersionId: seed.catalogVersionId,
      expectedCatalogVersion: 1, expectedPriceMinor: seed.priceMinor, anonymous: false };
    const first = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers(seed, 'm22:06:standalone:public'), payload });
    const replay = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers(seed, 'm22:06:standalone:public'), payload });
    expect(first.statusCode, first.body).toBe(201);
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(first.json().data.id).toMatch(/^[0-9a-f-]{36}$/u);

    const persisted = await database.pool.query(`SELECT gr.origin::text,gr.sender_visibility::text,gr.sender_id,
      gr.receiver_id,fr.status::text reservation_status,fr.amount_minor::text,st.type::text task_type
      FROM gift_requests gr JOIN fund_reservations fr ON fr.gift_request_id=gr.id
      JOIN staff_tasks st ON st.gift_request_id=gr.id WHERE gr.sender_id=$1`, [seed.customerId]);
    expect(persisted.rows).toEqual([{
      origin: 'STANDALONE', sender_visibility: 'PUBLIC', sender_id: seed.customerId,
      receiver_id: seed.playerId, reservation_status: 'ACTIVE', amount_minor: String(seed.priceMinor), task_type: 'GIFT_REVIEW'
    }]);
    expect(await factsForSender(seed)).toMatchObject({ requests: 1, reservations: 1, tasks: 1, expiries: 1, consumptions: 0, announcements: 0 });

    const before = businessFacts(await snapshotGiftFacts(database.pool));
    const forged = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers(seed, 'm22:06:standalone:forged'), payload: { ...payload, receiverId: seed.playerId } });
    expect(forged.statusCode).toBe(400);
    expect(businessFacts(await snapshotGiftFacts(database.pool))).toEqual(before);
    await server.close();
  });

  test('GTA-S-004/006 keeps insufficient and stale-catalog submissions at zero business writes', async () => {
    const seed = await seedGiftAutomationScenario(database.pool, { sequence: 62, now, balanceMinor: 4_000, priceMinor: 5_200 });
    const server = buildServer(seed);
    const before = businessFacts(await snapshotGiftFacts(database.pool));
    const affordability = await server.inject({ method: 'POST', url: '/api/v1/gift-center/affordability',
      headers: headers(seed), payload: { playerProfileId: seed.playerProfileId, giftCatalogVersionId: seed.catalogVersionId } });
    expect(affordability.statusCode, affordability.body).toBe(200);
    expect(affordability.json().data).toMatchObject({ canAfford: false, shortfallMinor: 1_200 });
    expect(businessFacts(await snapshotGiftFacts(database.pool))).toEqual(before);

    const insufficient = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers(seed, 'm22:06:standalone:poor'), payload: { playerProfileId: seed.playerProfileId,
        giftCatalogVersionId: seed.catalogVersionId, expectedCatalogVersion: 1, expectedPriceMinor: 5_200, anonymous: false } });
    expect(insufficient.statusCode, insufficient.body).toBe(422);
    expect(businessFacts(await snapshotGiftFacts(database.pool))).toEqual(before);

    const staleSeed = await seedGiftAutomationScenario(database.pool, { sequence: 64, now, balanceMinor: 20_000, priceMinor: 5_200 });
    const fundedServer = buildServer(staleSeed);
    const staleBefore = businessFacts(await snapshotGiftFacts(database.pool));
    await database.pool.query(`UPDATE gift_catalog_versions SET version=2,price_minor=6200 WHERE id=$1`, [staleSeed.catalogVersionId]);
    const stale = await fundedServer.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers(staleSeed, 'm22:06:standalone:stale'), payload: { playerProfileId: staleSeed.playerProfileId,
        giftCatalogVersionId: staleSeed.catalogVersionId, expectedCatalogVersion: 1, expectedPriceMinor: 5_200, anonymous: false } });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(businessFacts(await snapshotGiftFacts(database.pool))).toEqual(staleBefore);
    await Promise.all([server.close(), fundedServer.close()]);
  });

  test('GTA-S-007 serializes two independent confirmations against one exact balance', async () => {
    const seed = await seedGiftAutomationScenario(database.pool, { sequence: 63, now, balanceMinor: 5_200, priceMinor: 5_200 });
    const server = buildServer(seed);
    const payload = { playerProfileId: seed.playerProfileId, giftCatalogVersionId: seed.catalogVersionId,
      expectedCatalogVersion: 1, expectedPriceMinor: 5_200, anonymous: true };
    const responses = await Promise.all([
      server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests', headers: headers(seed, 'gift:m22:06:race:a'), payload }),
      server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests', headers: headers(seed, 'gift:m22:06:race:b'), payload })
    ]);
    expect(responses.map((response) => response.statusCode).sort(), responses.map((response) => response.body).join('\n')).toEqual([201, 422]);
    expect(await factsForSender(seed)).toMatchObject({ requests: 1, reservations: 1, tasks: 1, expiries: 1 });
    await server.close();
  });

  test('GTA-S-009 treats a different idempotency key as a new gift intent', async () => {
    const seed = await seedGiftAutomationScenario(database.pool, { sequence: 65, now, balanceMinor: 10_400, priceMinor: 5_200 });
    const server = buildServer(seed);
    const payload = { playerProfileId: seed.playerProfileId, giftCatalogVersionId: seed.catalogVersionId,
      expectedCatalogVersion: 1, expectedPriceMinor: 5_200, anonymous: false };
    const first = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers(seed, 'gift:m22:06:new-intent:a'), payload });
    const second = await server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests',
      headers: headers(seed, 'gift:m22:06:new-intent:b'), payload });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(second.json().data.id).not.toBe(first.json().data.id);
    expect(await factsForSender(seed)).toMatchObject({ requests: 2, reservations: 2, tasks: 2, expiries: 2 });
    await server.close();
  });
});

function buildServer(seed: GiftAutomationSeed) {
  const server = buildApiServer({
    env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'valid-bot-token' },
    security: { auditSink: new PostgresAuditSink({ client: database.pool }), idempotencyStore: new InMemoryIdempotencyStore() }
  });
  registerGiftRoutes(server, {
    store: new PostgresGiftStore(database.pool),
    orderStore: new InMemoryOrderStore(),
    accountStore: new InMemoryAccountStore({ bindings: [seed.customerBinding] }),
    walletFunding: new TestWalletFunding(seed.balanceMinor),
    broadcastChannelId: '900000000000006999',
    now: () => now
  });
  return server;
}

function headers(seed: GiftAutomationSeed, idempotencyKey?: string) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': seed.customerDiscordId, 'x-actor-guild-id': seed.guildId,
    'x-discord-interaction-id': `9${String(seed.customerDiscordId).slice(1, 17)}99`,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  };
}

async function factsForSender(seed: GiftAutomationSeed) {
  const result = await database.pool.query(`SELECT
    (SELECT count(*)::int FROM gift_requests WHERE sender_id=$1) requests,
    (SELECT count(*)::int FROM fund_reservations WHERE user_id=$1 AND source_type='GIFT') reservations,
    (SELECT count(*)::int FROM staff_tasks task JOIN gift_requests gift ON gift.id=task.gift_request_id WHERE gift.sender_id=$1) tasks,
    (SELECT count(*)::int FROM outbox_events event JOIN gift_requests gift ON gift.id=event.gift_request_id WHERE gift.sender_id=$1 AND event.event_type='GIFT_EXPIRY') expiries,
    (SELECT count(*)::int FROM consumption_entries WHERE user_id=$1 AND entry_type='GIFT_CHARGE') consumptions,
    (SELECT count(*)::int FROM outbox_events event JOIN gift_requests gift ON gift.id=event.gift_request_id WHERE gift.sender_id=$1 AND event.event_type='GIFT_ANNOUNCEMENT') announcements`,
  [seed.customerId]);
  return result.rows[0];
}

function businessFacts(snapshot: GiftFactSnapshot) {
  const { audits: _audits, ...facts } = snapshot;
  return facts;
}
