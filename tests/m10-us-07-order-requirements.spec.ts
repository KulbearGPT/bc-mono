import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import {
  InMemoryOrderRequirementStore,
  type RequirementCatalog
} from '@blackcat/api/order-requirements';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import {
  buildMultiProjectOrderPanelMessage,
  handleOpenOrderConfirmation,
  handleOrderRequirementAction,
  handleOrderRequirementSelectSubmit,
  type BotActorContext,
  type BotApiClient,
  type OrderRequirementPageSummary,
  type OrderSummary,
  type PublicServiceSummary
} from '@blackcat/bot/service-center';
import { vi } from 'vitest';

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
    expect(openapi).toContain('required: [expectedVersion]\n      properties:\n        expectedVersion: {$ref: \'#/components/schemas/Version\'}\n    CancellationPreviewRequest:');
    expect(openapi).not.toContain('required: [expectedVersion, acceptedAmount]');
    expect(prisma).toContain('model OrderRequirement');
    expect(prisma).toContain('orderRequirementId');
    expect(interaction).toContain('多项目订单需求编排器');
    expect(acceptance).toContain('AT-MULTI-006');
    expect(acceptance).toContain('AT-MULTI-007');
  });

  test('provides a complete append-only migration for demand and participant linkage', async () => {
    const [migration, dispatchMigration] = await Promise.all([
      readFile('database/prisma/migrations/000022_order_requirements/migration.sql', 'utf8'),
      readFile('database/prisma/migrations/000023_requirement_slot_dispatch/migration.sql', 'utf8')
    ]);

    expect(migration).toContain('CREATE TABLE order_requirements');
    expect(migration).toContain('CREATE TABLE order_requirement_events');
    expect(migration).toContain('order_requirement_id');
    expect(migration).toContain('requested_player_count > 0');
    expect(migration).toContain('estimated_line_price_minor > 0');
    expect(migration).toContain('deny_append_only_mutation');
    expect(dispatchMigration).toContain('dispatch_attempts_order_requirement_id_fkey');
    expect(dispatchMigration).toContain('order_participants_one_player_requirement_idx');
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
    const removed=store.update({orderId:store.orders[0]!.id,requirementId:staged.data.requirement.id,actorGuildId:'guild',actorDiscordUserId:'customer',expectedOrderVersion:2,expectedRequirementVersion:1,action:'REMOVE',serviceCatalogVersionId:null,unitCount:null,requestedPlayerCount:null,idempotencyKey:'requirement:remove:1',now:new Date('2026-08-04T10:01:00.000Z')});
    await removed.commit({} as never);
    expect(store.list({orderId:store.orders[0]!.id,actorGuildId:'guild',actorDiscordUserId:'customer',cursor:null,limit:25}).items).toEqual([]);
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

  test('renders a restart-safe multi-project basket with independent quantity and player controls', () => {
    const order = botOrder();
    const page = requirementPage(order.id, order.version);
    const message = buildMultiProjectOrderPanelMessage(order, page, botServices(), page.items[0]!.id);

    expect(message.body).toContain('瓦洛兰特 · 技术陪玩 · 美服');
    expect(message.body).toContain('2 小时 × 1 位');
    expect(message.body).toContain('英雄联盟 · 娱乐陪玩 · 美服');
    expect(message.body).toContain('3 小时 × 2 位');
    expect(message.body).toContain('合计：100.0 CAT');
    expect(message.components).toHaveLength(5);
    expect(JSON.stringify(message.components)).toContain(`bc:req:${order.id}:${page.items[0]!.id}:units:v7`);
    expect(JSON.stringify(message.components)).toContain(`bc:req:${order.id}:${page.items[0]!.id}:players:v7`);
    expect(JSON.stringify(message.components)).not.toMatch(/playerPayout|expectedEarning|分成/iu);
    for (const component of message.components.flatMap((row) => row.components)) {
      expect(component.customId.length).toBeLessThanOrEqual(100);
    }
  });

  test('adds and edits requirement lines through the API without calculating money in the Bot', async () => {
    const order = botOrder();
    const firstPage = requirementPage(order.id, order.version);
    const addedPage = requirementPage(order.id, 8);
    const api = {
      getOrder: vi.fn().mockResolvedValueOnce(order).mockResolvedValue(botOrder({ version: 8 })),
      listServices: vi.fn().mockResolvedValue({ items: botServices() }),
      listOrderRequirements: vi.fn().mockResolvedValueOnce(firstPage).mockResolvedValue(addedPage),
      addOrderRequirement: vi.fn().mockResolvedValue({ orderId: order.id, orderVersion: 8, derivedTotalMinor: 900, currency: 'CAT', requirement: addedPage.items[0] }),
      updateOrderRequirement: vi.fn()
    } as unknown as BotApiClient;

    const result = await handleOrderRequirementSelectSubmit({
      api,
      actor: botActor(),
      orderId: order.id,
      expectedVersion: 7,
      action: 'add',
      value: botServices()[0]!.id,
      idempotencyKey: 'discord:requirement:add:1'
    });

    expect(api.addOrderRequirement).toHaveBeenCalledWith(order.id, {
      expectedOrderVersion: 7,
      serviceCatalogVersionId: botServices()[0]!.id,
      unitCount: 1,
      requestedPlayerCount: 1
    }, botActor(), 'discord:requirement:add:1');
    expect(JSON.stringify((result as { message: unknown }).message)).not.toContain('customerUnitPriceMinor:');
  });

  test('removes one requirement through an append-only API action and returns to the refreshed basket', async () => {
    const order=botOrder();const page=requirementPage(order.id,order.version);const remaining={...page,orderVersion:8,derivedTotalMinor:600,items:[page.items[1]! ]};
    const api={getOrder:vi.fn().mockResolvedValue(botOrder({version:8})),listServices:vi.fn().mockResolvedValue({items:botServices()}),listOrderRequirements:vi.fn().mockResolvedValue(remaining),updateOrderRequirement:vi.fn().mockResolvedValue({orderId:order.id,orderVersion:8,derivedTotalMinor:600,currency:'CAT',requirement:{...page.items[0]!,status:'REMOVED',version:2}}),addOrderRequirement:vi.fn()} as unknown as BotApiClient;
    const result=await handleOrderRequirementAction({api,actor:botActor(),orderId:order.id,expectedVersion:7,action:'remove',requirementId:page.items[0]!.id,expectedRequirementVersion:1,idempotencyKey:'discord:requirement:remove:1'});
    expect(api.updateOrderRequirement).toHaveBeenCalledWith(order.id,page.items[0]!.id,{expectedOrderVersion:7,expectedRequirementVersion:1,action:'REMOVE'},botActor(),'discord:requirement:remove:1');
    expect((result as {message:{body:string}}).message.body).not.toContain('技术陪玩');
    expect((result as {message:{body:string}}).message.body).toContain('娱乐陪玩');
  });

  test('opens confirmation from server-derived requirement totals without calling the legacy single-project estimate',async()=>{
    const order=botOrder();const page=requirementPage(order.id,order.version);const api={getOrder:vi.fn().mockResolvedValue(order),listOrderRequirements:vi.fn().mockResolvedValue(page),getCurrentBalance:vi.fn().mockResolvedValue({ledgerBalanceMinor:2000,reservedMinor:0,availableMinor:2000,currency:'CAT',calculatedAt:'2026-08-04T10:00:00Z',version:1}),estimateOrder:vi.fn()} as unknown as BotApiClient;
    const result=await handleOpenOrderConfirmation({api,actor:botActor(),orderId:order.id,expectedVersion:7,idempotencyKey:'discord:confirm:1'});
    expect(api.estimateOrder).not.toHaveBeenCalled();
    expect((result as {message:{body:string}}).message.body).toContain('瓦洛兰特 · 技术陪玩');
    expect((result as {message:{body:string}}).message.body).toContain('订单合计：100.0 CAT');
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

function botActor(): BotActorContext {
  return { guildId: '999999999999999999', discordUserId: '111111111111111111', interactionId: '777777777777777777', clientSource: 'DISCORD_BOT' };
}

function botOrder(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return { id:'00000000-0000-0000-0000-000000107003',publicId:'P-MULTI',status:'DRAFT',version:7,serviceCatalogId:null,game:null,service:null,region:null,billingUnitMinutes:null,unitCount:null,amountMinor:800,currency:'CAT',notes:null,preferredPlayerDiscordUserIds:[],channelSpec:{channelId:'120000000000000001',panelMessageId:'120000000000000002',voiceChannelId:null},matching:null,...overrides };
}

function botServices(): PublicServiceSummary[] {
  return [
    {id:'00000000-0000-0000-0000-000000107101',game:'VALORANT',gameDisplayName:'瓦洛兰特',service:'RANKED',serviceDisplayName:'技术陪玩',region:'NA',regionDisplayName:'美服',billingUnitMinutes:60,minimumUnits:1,customerUnitPriceMinor:200,currency:'CAT',version:1},
    {id:'00000000-0000-0000-0000-000000107102',game:'LOLNA',gameDisplayName:'英雄联盟',service:'FUN',serviceDisplayName:'娱乐陪玩',region:'NA',regionDisplayName:'美服',billingUnitMinutes:60,minimumUnits:1,customerUnitPriceMinor:100,currency:'CAT',version:1}
  ];
}

function requirementPage(orderId: string, orderVersion: number): OrderRequirementPageSummary {
  return {orderId,orderVersion,derivedTotalMinor:1000,currency:'CAT',nextCursor:null,items:[
    {id:'00000000-0000-0000-0000-000000107201',orderId,serviceCatalogVersionId:botServices()[0]!.id,game:'VALORANT',gameDisplayName:'瓦洛兰特',service:'RANKED',serviceDisplayName:'技术陪玩',region:'NA',regionDisplayName:'美服',billingUnitMinutes:60,unitCount:2,requestedPlayerCount:1,customerUnitPriceMinor:200,estimatedLinePriceMinor:400,filledPlayerCount:0,status:'ACTIVE',version:1,createdAt:'2026-08-04T10:00:00.000Z',updatedAt:'2026-08-04T10:00:00.000Z'},
    {id:'00000000-0000-0000-0000-000000107202',orderId,serviceCatalogVersionId:botServices()[1]!.id,game:'LOLNA',gameDisplayName:'英雄联盟',service:'FUN',serviceDisplayName:'娱乐陪玩',region:'NA',regionDisplayName:'美服',billingUnitMinutes:60,unitCount:3,requestedPlayerCount:2,customerUnitPriceMinor:100,estimatedLinePriceMinor:600,filledPlayerCount:0,status:'ACTIVE',version:1,createdAt:'2026-08-04T10:01:00.000Z',updatedAt:'2026-08-04T10:01:00.000Z'}
  ]};
}
