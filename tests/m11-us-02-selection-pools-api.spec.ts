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

  test('keeps the current-pool recovery read synchronized across API and interaction contracts', async () => {
    const [outputApi, docsApi, outputMap, docsMap, outputBacklog, docsBacklog] = await Promise.all([
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('docs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('outputs/P0开发交付包/01-UIUX/交互映射.csv', 'utf8'),
      readFile('docs/P0开发交付包/01-UIUX/交互映射.csv', 'utf8'),
      readFile('outputs/P0开发交付包/06-开发计划/backlog.csv', 'utf8'),
      readFile('docs/P0开发交付包/06-开发计划/backlog.csv', 'utf8')
    ]);

    expect(outputApi).toBe(docsApi);
    expect(outputMap).toBe(docsMap);
    expect(outputBacklog).toBe(docsBacklog);
    expect(outputApi).toContain('/api/v1/orders/{orderId}/selection-pools/current:');
    expect(outputApi).toContain('operationId: getCurrentOrderSelectionPool');
    expect(outputMap).toMatch(/INT-D-067[^\n]*getCurrentOrderSelectionPool;createOrderSelectionPool/u);
    expect(outputBacklog).toMatch(/M9-US-13[^\n]*submitOrder;getCurrentOrderSelectionPool;createOrderSelectionPool/u);
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
    const second = await commit(store.apply({ ...playerScope(orderId, created.pool.id, requirementId, created.pool.version, 'apply:second'), actorDiscordUserId: '333333333333333333' }));
    const closed = await commit(store.closePool({
      orderId, selectionPoolId: created.pool.id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId,
      expectedPoolVersion: created.pool.version, reason: 'CUSTOMER_EARLY_CLOSE', idempotencyKey: 'pool:close', now: instant(1)
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
    const second = await commit(store.apply({ ...playerScope(orderId, created.pool.id, requirementId, created.pool.version, 'apply:second'), actorDiscordUserId: '333333333333333333' }));
    const closed = await commit(store.closePool({ orderId, selectionPoolId: created.pool.id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId, expectedPoolVersion: created.pool.version, reason: 'CUSTOMER_EARLY_CLOSE', idempotencyKey: 'pool:close', now: instant(1) }));
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
    const empty = await server.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}/selection-pools/current`,
      headers: headers(customerDiscordId, 'current-empty')
    });
    expect(empty.statusCode).toBe(404);
    const create = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools`, headers: headers(customerDiscordId, 'create'), payload: { expectedOrderVersion: 1 } });
    expect(create.statusCode, create.body).toBe(201);
    const pool = create.json().data.pool;
    const current = await server.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}/selection-pools/current`,
      headers: headers(customerDiscordId, 'current-owner')
    });
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json().data.pool).toMatchObject({ id: pool.id, status: 'COLLECTING' });
    const forbidden = await server.inject({
      method: 'GET',
      url: `/api/v1/orders/${orderId}/selection-pools/current`,
      headers: headers(playerDiscordId, 'current-player')
    });
    expect(forbidden.statusCode).toBe(403);
    const invalid = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools/${pool.id}/applications`, headers: headers(playerDiscordId, 'invalid'), payload: { expectedPoolVersion: pool.version, orderRequirementId: requirementId, availability: 'AVAILABLE', amountMinor: 1 } });
    expect(invalid.statusCode).toBe(400);
    const applied = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools/${pool.id}/applications`, headers: headers(playerDiscordId, 'apply'), payload: { expectedPoolVersion: pool.version, orderRequirementId: requirementId } });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(applied.json().data.application).toMatchObject({ playerId, status: 'APPLIED' });
    const rejectedReason = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools/${pool.id}/close`, headers: headers(customerDiscordId, 'close-with-reason'), payload: { expectedPoolVersion: pool.version, reason: 'CUSTOMER_EARLY_CLOSE' } });
    expect(rejectedReason.statusCode).toBe(400);
    const closed = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools/${pool.id}/close`, headers: headers(customerDiscordId, 'close'), payload: { expectedPoolVersion: pool.version } });
    expect(closed.statusCode, closed.body).toBe(200);
    const replacement = await server.inject({ method: 'POST', url: `/api/v1/orders/${orderId}/selection-pools`, headers: headers(customerDiscordId, 'replace'), payload: { expectedOrderVersion: 1, replacesSelectionPoolId: pool.id, expectedSelectionPoolVersion: closed.json().data.pool.version } });
    expect(replacement.statusCode, replacement.body).toBe(201);
    expect(replacement.json().data.pool).toMatchObject({ round: 2, status: 'COLLECTING', waitMinutes: null, closesAt: null });
    expect(store.applications[0]).toMatchObject({ status: 'NOT_SELECTED' });
    await server.close();
  });

  test('new pools ignore legacy timing fields internally and expose no deadline', () => {
    const store = fixtureStore();
    const preview = store.createPool(customerScope(orderId, 1, 30, 'manual:no-deadline'));
    expect(preview.data.pool).toMatchObject({ waitMinutes: null, closesAt: null });
  });

  test('keeps the collecting lifecycle version stable across applications and withdrawals', async () => {
    const store = fixtureStore({ requestedPlayerCount: 2, includeSecondPlayer: true });
    const created = await commit(store.createPool(customerScope(orderId, 1, 3, 'stable:create')));
    const first = await commit(store.apply(
      playerScope(orderId, created.pool.id, requirementId, created.pool.version, 'stable:apply:first')
    ));
    const second = await commit(store.apply({
      ...playerScope(orderId, created.pool.id, requirementId, created.pool.version, 'stable:apply:second'),
      actorDiscordUserId: '333333333333333333'
    }));
    const withdrawn = await commit(store.withdraw({
      orderId,
      selectionPoolId: created.pool.id,
      applicationId: first.application.id,
      actorGuildId: guildId,
      actorDiscordUserId: playerDiscordId,
      expectedPoolVersion: first.pool.version,
      expectedApplicationVersion: first.application.version,
      idempotencyKey: 'stable:withdraw:first',
      now: instant(1)
    }));
    const closed = await commit(store.closePool({
      orderId,
      selectionPoolId: created.pool.id,
      actorGuildId: guildId,
      actorDiscordUserId: customerDiscordId,
      expectedPoolVersion: created.pool.version,
      reason: 'CUSTOMER_EARLY_CLOSE',
      idempotencyKey: 'stable:close',
      now: instant(1)
    }));

    expect(first.pool).toMatchObject({ version: 1, applicationCount: 1 });
    expect(second.pool).toMatchObject({ version: 1, applicationCount: 2 });
    expect(withdrawn.pool).toMatchObject({ version: 1, applicationCount: 1 });
    expect(closed.pool).toMatchObject({ version: 2, status: 'SELECTION' });
  });

  test('accepts an application long after recruitment started until the customer stops it', async () => {
    const store = fixtureStore();
    const created = await commit(store.createPool(customerScope(orderId, 1, 3, 'deadline:create')));
    const applied = await commit(store.apply({
      ...playerScope(orderId, created.pool.id, requirementId, created.pool.version, 'deadline:apply'),
      now: instant(3)
    }));
    expect(applied.application.status).toBe('APPLIED');
  });

  test('rejects application, close, and finalization once the order is cancelled', async () => {
    const collectingStore = fixtureStore();
    const collecting = await commit(collectingStore.createPool(customerScope(orderId, 1, 3, 'cancelled:collecting:create')));
    collectingStore.orders[0]!.status = 'CANCELLED';
    collectingStore.orders[0]!.version = 2;

    expect(() => collectingStore.apply(
      playerScope(orderId, collecting.pool.id, requirementId, collecting.pool.version, 'cancelled:apply')
    )).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => collectingStore.closePool({
      orderId,
      selectionPoolId: collecting.pool.id,
      actorGuildId: guildId,
      actorDiscordUserId: customerDiscordId,
      expectedPoolVersion: collecting.pool.version,
      reason: 'CUSTOMER_EARLY_CLOSE',
      idempotencyKey: 'cancelled:close',
      now: instant(1)
    })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));

    const selectionStore = fixtureStore();
    const opened = await commit(selectionStore.createPool(customerScope(orderId, 1, 3, 'cancelled:selection:create')));
    const applied = await commit(selectionStore.apply(
      playerScope(orderId, opened.pool.id, requirementId, opened.pool.version, 'cancelled:selection:apply')
    ));
    const closed = await commit(selectionStore.closePool({
      orderId,
      selectionPoolId: opened.pool.id,
      actorGuildId: guildId,
      actorDiscordUserId: customerDiscordId,
      expectedPoolVersion: applied.pool.version,
      reason: 'CUSTOMER_EARLY_CLOSE',
      idempotencyKey: 'cancelled:selection:close',
      now: instant(1)
    }));
    selectionStore.orders[0]!.status = 'CANCELLED';
    selectionStore.orders[0]!.version = 2;
    expect(() => selectionStore.finalize({
      orderId,
      selectionPoolId: opened.pool.id,
      actorGuildId: guildId,
      actorDiscordUserId: customerDiscordId,
      expectedOrderVersion: 2,
      expectedPoolVersion: closed.pool.version,
      applicationIds: [applied.application.id],
      idempotencyKey: 'cancelled:selection:finalize',
      now: instant(2)
    })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });

  test('lets the owner explicitly start a new round after an empty selection without touching the reservation', async () => {
    const store=fixtureStore();const first=await commit(store.createPool(customerScope(orderId,1,3,'empty:create')));await commit(store.closePool({orderId,selectionPoolId:first.pool.id,actorGuildId:guildId,actorDiscordUserId:customerDiscordId,expectedPoolVersion:first.pool.version,reason:'CUSTOMER_EARLY_CLOSE',idempotencyKey:'empty:close',now:instant(1)}));
    const second=await commit(store.createPool({...customerScope(orderId,1,5,'empty:continue'),replacesSelectionPoolId:first.pool.id,expectedSelectionPoolVersion:first.pool.version+1}));
    expect(second.pool).toMatchObject({round:2,status:'COLLECTING',waitMinutes:null,closesAt:null});expect(store.pools[0]).toMatchObject({status:'FINALIZED'});expect(store.orders[0]).toMatchObject({status:'PENDING_DISPATCH',version:1,reservationId:'reservation-a'});expect(store.participants).toEqual([]);
  });

  test('lets the owner reject the current candidates and atomically start a new round', async () => {
    const store = fixtureStore();
    const first = await commit(store.createPool(customerScope(orderId, 1, 3, 'reject:create')));
    const applied = await commit(store.apply(playerScope(orderId, first.pool.id, requirementId, first.pool.version, 'reject:apply')));
    const closed = await commit(store.closePool({ orderId, selectionPoolId: first.pool.id, actorGuildId: guildId, actorDiscordUserId: customerDiscordId, expectedPoolVersion: applied.pool.version, reason: 'CUSTOMER_EARLY_CLOSE', idempotencyKey: 'reject:close', now: instant(1) }));

    expect(() => store.createPool({ ...customerScope(orderId, 1, 5, 'reject:stale'), replacesSelectionPoolId: first.pool.id, expectedSelectionPoolVersion: closed.pool.version - 1 })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(store.applications[0]).toMatchObject({ status: 'APPLIED' });
    const second = await commit(store.createPool({ ...customerScope(orderId, 1, 5, 'reject:continue'), replacesSelectionPoolId: first.pool.id, expectedSelectionPoolVersion: closed.pool.version }));

    expect(second.pool).toMatchObject({ round: 2, status: 'COLLECTING', waitMinutes: null, closesAt: null });
    expect(store.pools[0]).toMatchObject({ status: 'FINALIZED', version: closed.pool.version + 1 });
    expect(store.applications[0]).toMatchObject({ status: 'NOT_SELECTED', version: applied.application.version + 1 });
    expect(store.applications[0]!.decidedAt).not.toBeNull();
    expect(store.orders[0]).toMatchObject({ status: 'PENDING_DISPATCH', version: 1, reservationId: 'reservation-a' });
    expect(store.participants).toEqual([]);
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
