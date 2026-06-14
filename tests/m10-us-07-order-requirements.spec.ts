import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  InMemoryOrderRequirementStore,
  type RequirementCatalog
} from '@blackcat/api/order-requirements';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';

describe('M10-US-07 multi-project order requirement contract', () => {
  test('separates customer demand from assigned players and freezes slot dispatch operations', async () => {
    const [openapi, prisma, interaction, acceptance] = await Promise.all([
      readFile('outputs/P0开发交付包/02-API/openapi.yaml', 'utf8'),
      readFile('outputs/P0开发交付包/03-数据模型/schema.prisma', 'utf8'),
      readFile('outputs/P0开发交付包/01-UIUX/交互映射.csv', 'utf8'),
      readFile('outputs/P0开发交付包/07-验收测试/acceptance-cases.csv', 'utf8')
    ]);

    expect(openapi).toContain('operationId: addOrderRequirement');
    expect(openapi).toContain('operationId: updateOrderRequirement');
    expect(prisma).toContain('model OrderRequirement');
    expect(prisma).toContain('orderRequirementId');
    expect(interaction).toContain('多项目订单需求编排器');
    expect(acceptance).toContain('AT-MULTI-006');
    expect(acceptance).toContain('AT-MULTI-007');
  });

  test('provides a complete append-only migration for demand and participant linkage', async () => {
    const migration = await readFile(
      'database/prisma/migrations/000022_order_requirements/migration.sql',
      'utf8'
    );

    expect(migration).toContain('CREATE TABLE order_requirements');
    expect(migration).toContain('CREATE TABLE order_requirement_events');
    expect(migration).toContain('order_requirement_id');
    expect(migration).toContain('requested_player_count > 0');
    expect(migration).toContain('estimated_line_price_minor > 0');
    expect(migration).toContain('deny_append_only_mutation');
  });

  test('derives every line and order estimate without accepting client money', async () => {
    const store = new InMemoryOrderRequirementStore({
      orders: [{ id: '00000000-0000-0000-0000-000000107001', guildId: 'guild', customerDiscordUserId: 'customer', status: 'DRAFT', version: 1, amountMinor: 0 }],
      catalogs: [catalog('00000000-0000-0000-0000-000000107101', 'RANKED', 125)]
    });
    const staged = store.add({
      orderId: '00000000-0000-0000-0000-000000107001',
      actorGuildId: 'guild',
      actorDiscordUserId: 'customer',
      serviceCatalogVersionId: '00000000-0000-0000-0000-000000107101',
      unitCount: 2,
      requestedPlayerCount: 3,
      expectedOrderVersion: 1,
      idempotencyKey: 'requirement:add:1',
      now: new Date('2026-08-04T10:00:00.000Z')
    });
    expect(staged.data).toMatchObject({ orderVersion: 2, derivedTotalMinor: 750 });
    expect(staged.data.requirement).toMatchObject({ estimatedLinePriceMinor: 750, requestedPlayerCount: 3 });
    await staged.commit({} as never);
    expect(store.orders[0]).toMatchObject({ version: 2, amountMinor: 750 });
  });

  test('exposes owner-scoped Bot routes and rejects client supplied amount fields', async () => {
    const orderId = '00000000-0000-0000-0000-000000107002';
    const catalogId = '00000000-0000-0000-0000-000000107102';
    const store = new InMemoryOrderRequirementStore({
      orders: [{ id: orderId, guildId: '999999999999999999', customerDiscordUserId: '111111111111111111', status: 'DRAFT', version: 1, amountMinor: 0 }],
      catalogs: [catalog(catalogId, 'FUN', 100)]
    });
    const server = buildApiServer({
      env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      orderRequirements: { store, now: () => new Date('2026-08-04T10:00:00.000Z') }
    });

    const invalid = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/requirements`, headers: botHeaders('requirement:invalid'),
      payload: { expectedOrderVersion: 1, serviceCatalogVersionId: catalogId, unitCount: 1, requestedPlayerCount: 2, estimatedLinePriceMinor: 1 }
    });
    expect(invalid.statusCode).toBe(400);
    const added = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/requirements`, headers: botHeaders('requirement:add'),
      payload: { expectedOrderVersion: 1, serviceCatalogVersionId: catalogId, unitCount: 2, requestedPlayerCount: 2 }
    });
    expect(added.statusCode, added.body).toBe(201);
    expect(added.json()).toMatchObject({ data: { derivedTotalMinor: 400, requirement: { serviceDisplayName: '娱乐陪玩' } } });
    const denied = await server.inject({ method: 'GET', url: `/api/v1/orders/${orderId}/requirements`, headers: botHeaders('requirement:denied', '222222222222222222') });
    expect(denied.statusCode).toBe(403);
    await server.close();
  });
});

function botHeaders(key: string, discordUserId = '111111111111111111') {
  return {
    authorization: 'Bearer valid-bot-token',
    'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': '999999999999999999',
    'x-discord-interaction-id': '777777777777777777',
    'idempotency-key': `discord:m10:${key}:0001`
  };
}

function catalog(id: string, service: string, price: number): RequirementCatalog {
  return {
    id,
    status: 'ACTIVE',
    game: 'VALORANT',
    gameDisplayName: '瓦洛兰特',
    service,
    serviceDisplayName: service === 'RANKED' ? '技术陪玩' : '娱乐陪玩',
    region: 'NA',
    regionDisplayName: '美服',
    billingUnitMinutes: 60,
    customerUnitPriceMinor: price
  };
}
