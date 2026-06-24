import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  InMemorySelectionPoolStore,
  SelectionPoolError,
  type SelectionRequirement,
  type SelectionPlayer
} from '@blackcat/api/selection-pools';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';

const guildId = '999999999999999999';
const customerDiscordId = '111111111111111111';
const orderId = '00000000-0000-0000-0000-000000110001';
const secondOrderId = '00000000-0000-0000-0000-000000110002';
const requirementId = '00000000-0000-0000-0000-000000110101';
const secondRequirementId = '00000000-0000-0000-0000-000000110102';
const playerId = '00000000-0000-0000-0000-000000110201';
const playerDiscordId = '222222222222222222';

describe('M11-US-02 selection pool API', () => {
  test('has an additive migration with append-only pool and application events', async () => {
    const [migration, schema, runtime] = await Promise.all([
      readFile('database/prisma/migrations/000029_selection_pool_dispatch/migration.sql', 'utf8'),
      readFile('database/prisma/schema.prisma', 'utf8'),
      readFile('apps/api/src/index.ts', 'utf8')
    ]);

    expect(migration).toContain('CREATE TABLE "selection_pools"');
    expect(migration).toContain('CREATE TABLE "selection_applications"');
    expect(migration).toContain('CREATE TABLE "selection_pool_events"');
    expect(migration).toContain('CREATE TABLE "selection_application_events"');
    expect(migration).toContain('selection_pools_one_active_per_order_idx');
    expect(migration).toContain('deny_append_only_mutation');
    expect(schema).toMatch(/model SelectionPool[\s\S]*?model SelectionApplication/u);
    expect(runtime).toContain('const selectionPoolStore = new PostgresSelectionPoolStore(databasePool);');
    expect(runtime).toContain('selectionPools: { store: selectionPoolStore }');
  });

  test('lets an offline or busy player apply to multiple orders without creating participants or taking an active slot', async () => {
    const store = fixtureStore();
    const firstPool = await commit(store.createPool(customerScope(orderId, 1, 3, 'pool:create:1')));
    const secondPool = await commit(store.createPool(customerScope(secondOrderId, 1, 5, 'pool:create:2')));

    const first = await commit(store.apply(playerScope(orderId, firstPool.pool.id, requirementId, firstPool.pool.version, 'apply:1')));
    const second = await commit(store.apply(playerScope(secondOrderId, secondPool.pool.id, secondRequirementId, secondPool.pool.version, 'apply:2')));

    expect(first.application.status).toBe('APPLIED');
    expect(second.application.status).toBe('APPLIED');
    expect(store.participants).toEqual([]);
    expect(store.players[0]).toMatchObject({ presence: 'OFFLINE', legacyAvailability: 'BUSY', activeOrderId: null });
    expect(store.orders.map((order) => order.reservationId)).toEqual(['reservation-a', 'reservation-b']);
  });

  test('closes early and atomically selects multiple applicants while retaining partial selections', async () => {
    const store = fixtureStore({ requestedPlayerCount: 3, includeSecondPlayer: true });
    const created = await commit(store.createPool(customerScope(orderId, 1, 3, 'pool:create')));
    const first = await commit(store.apply(playerScope(orderId, created.pool.id, requirementId, created.pool.version, 'apply:first')));
    const second = await commit(store.apply({ ...playerScope(orderId, created.pool.id, requirementId, created.pool.version + 1, 'apply:second'), actorDiscordUserId: '333333333333333333' }));
    const closed = await commit(store.closePool({
      orderId, selectionPoolId: created.pool.id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId,
      expectedPoolVersion: second.pool.version, reason: 'CUSTOMER_EARLY_CLOSE', idempotencyKey: 'pool:close', now: instant(1)
    }));
    const finalized = await commit(store.finalize({
      orderId, selectionPoolId: created.pool.id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId,
      expectedOrderVersion: 1, expectedPoolVersion: closed.pool.version,
      applicationIds: [first.application.id, second.application.id], idempotencyKey: 'pool:finalize', now: instant(2)
    }));

    expect(finalized).toMatchObject({ orderStatus: 'PENDING_DISPATCH', orderVersion: 2, remainingSlotCount: 1 });
    expect(finalized.selectedParticipantIds).toHaveLength(2);
    expect(store.participants).toHaveLength(2);
    expect(store.requirements[0]).toMatchObject({ filledPlayerCount: 2, requestedPlayerCount: 3 });
    const nextPool = await commit(store.createPool(customerScope(orderId, 2, 4, 'pool:create:remaining')));
    expect(nextPool.pool.round).toBe(2);
    expect(store.participants).toHaveLength(2);
  });

  test('rechecks active slots at finalization and rolls every selected applicant back on one conflict', async () => {
    const store = fixtureStore({ requestedPlayerCount: 2, includeSecondPlayer: true });
    const created = await commit(store.createPool(customerScope(orderId, 1, 3, 'pool:create')));
    const first = await commit(store.apply(playerScope(orderId, created.pool.id, requirementId, created.pool.version, 'apply:first')));
    const second = await commit(store.apply({ ...playerScope(orderId, created.pool.id, requirementId, created.pool.version + 1, 'apply:second'), actorDiscordUserId: '333333333333333333' }));
    const closed = await commit(store.closePool({ orderId, selectionPoolId: created.pool.id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId, expectedPoolVersion: second.pool.version, reason: 'CUSTOMER_EARLY_CLOSE', idempotencyKey: 'pool:close', now: instant(1) }));
    store.players[1]!.activeOrderId = '00000000-0000-0000-0000-000000119999';

    await expect(Promise.resolve().then(() => store.finalize({ orderId, selectionPoolId: created.pool.id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId, expectedOrderVersion: 1, expectedPoolVersion: closed.pool.version, applicationIds: [first.application.id, second.application.id], idempotencyKey: 'pool:finalize', now: instant(2) }))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.participants).toEqual([]);
    expect(store.requirements[0]!.filledPlayerCount).toBe(0);
    expect(store.orders[0]).toMatchObject({ status: 'PENDING_DISPATCH', version: 1 });
  });

  test('exposes strict owner/player routes and does not accept client money or availability fields', async () => {
    const store = fixtureStore();
    const server = buildApiServer({
      env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      selectionPools: { store, now: () => instant(0) }
    });
    const create = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools`, headers: headers(customerDiscordId, 'create'), payload: { expectedOrderVersion: 1, waitMinutes: 3 } });
    expect(create.statusCode, create.body).toBe(201);
    const pool = create.json().data.pool;
    const invalid = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools/${pool.id}/applications`, headers: headers(playerDiscordId, 'invalid'), payload: { expectedPoolVersion: pool.version, orderRequirementId: requirementId, availability: 'AVAILABLE', amountMinor: 1 } });
    expect(invalid.statusCode).toBe(400);
    const applied = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools/${pool.id}/applications`, headers: headers(playerDiscordId, 'apply'), payload: { expectedPoolVersion: pool.version, orderRequirementId: requirementId } });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(applied.json().data.application).toMatchObject({ playerId, status: 'APPLIED' });
    await server.close();
  });

  test('rejects waits outside 1-30 whole minutes', () => {
    const store = fixtureStore();
    for (const waitMinutes of [0, 31, 1.5]) {
      expect(() => store.createPool(customerScope(orderId, 1, waitMinutes, `wait:${waitMinutes}`))).toThrow(SelectionPoolError);
    }
  });

  test('lets the owner explicitly start a new round after an empty selection without touching the reservation', async () => {
    const store=fixtureStore();const first=await commit(store.createPool(customerScope(orderId,1,3,'empty:create')));await commit(store.closePool({orderId,selectionPoolId:first.pool.id,actorGuildId:guildId,actorDiscordUserId:customerDiscordId,expectedPoolVersion:first.pool.version,reason:'CUSTOMER_EARLY_CLOSE',idempotencyKey:'empty:close',now:instant(1)}));
    const second=await commit(store.createPool(customerScope(orderId,1,5,'empty:continue')));
    expect(second.pool).toMatchObject({round:2,status:'COLLECTING',waitMinutes:5});expect(store.pools[0]).toMatchObject({status:'FINALIZED'});expect(store.orders[0]).toMatchObject({status:'PENDING_DISPATCH',version:1,reservationId:'reservation-a'});expect(store.participants).toEqual([]);
  });
});

async function commit<T>(write: Promise<{ data: T; commit(audit: unknown): Promise<void> | void }> | { data: T; commit(audit: unknown): Promise<void> | void }): Promise<T> {
  const staged = await write;
  await staged.commit({});
  return staged.data;
}

function fixtureStore(options: { requestedPlayerCount?: number; includeSecondPlayer?: boolean } = {}): InMemorySelectionPoolStore {
  const requirements: SelectionRequirement[] = [requirement(orderId, requirementId, options.requestedPlayerCount ?? 1), requirement(secondOrderId, secondRequirementId, 1)];
  const players: SelectionPlayer[] = [{ id: playerId, guildId, discordUserId: playerDiscordId, displayName: '奶糖', reviewStatus: 'ACTIVE', matchingCatalogIds: ['catalog-a'], presence: 'OFFLINE', legacyAvailability: 'BUSY', activeOrderId: null, compensationType: 'PERCENT_BPS', compensationValue: 6000 }];
  if (options.includeSecondPlayer) players.push({ ...players[0]!, id: '00000000-0000-0000-0000-000000110202', discordUserId: '333333333333333333', displayName: '团子' });
  return new InMemorySelectionPoolStore({
    orders: [
      { id: orderId, guildId, customerDiscordUserId: customerDiscordId, status: 'PENDING_DISPATCH', version: 1, reservationId: 'reservation-a' },
      { id: secondOrderId, guildId, customerDiscordUserId: customerDiscordId, status: 'PENDING_DISPATCH', version: 1, reservationId: 'reservation-b' }
    ],
    requirements,
    players
  });
}

function requirement(id: string, requirement: string, requestedPlayerCount: number): SelectionRequirement {
  return { id: requirement, orderId: id, status: 'ACTIVE', serviceCatalogVersionId: 'catalog-a', requestedPlayerCount, filledPlayerCount: 0, game: 'VALORANT', gameDisplayName: '瓦洛兰特', service: 'TECH', serviceDisplayName: '技术陪玩', region: 'NA', regionDisplayName: '北美', billingUnitMinutes: 60, unitCount: 2, customerUnitPriceMinor: 100, linePriceMinor: 200 };
}

function customerScope(id: string, expectedOrderVersion: number, waitMinutes: number, idempotencyKey: string) {
  return { orderId: id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId, expectedOrderVersion, waitMinutes, idempotencyKey, now: instant(0) };
}

function playerScope(id: string, pool: string, requirement: string, expectedPoolVersion: number, idempotencyKey: string) {
  return { orderId: id, selectionPoolId: pool, orderRequirementId: requirement, actorGuildId: guildId, actorDiscordUserId: playerDiscordId, expectedPoolVersion, idempotencyKey, now: instant(0) };
}

function headers(discordUserId: string, key: string) {
  return { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT', 'x-actor-discord-user-id': discordUserId, 'x-actor-guild-id': guildId, 'x-discord-interaction-id': '777777777777777777', 'idempotency-key': `discord:m11:${key}:0001` };
}

function instant(minutes: number): Date {
  return new Date(Date.parse('2026-08-04T12:00:00.000Z') + minutes * 60_000);
}
