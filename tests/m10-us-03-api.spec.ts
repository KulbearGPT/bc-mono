import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryOrderParticipantStore } from '@blackcat/api/order-participants';
import type { StaffDirectory } from '@blackcat/api/security';
import { buildAddOrderParticipantRequest, buildUpdateOrderParticipantRequest } from '../apps/dashboard/src/admin-business.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminBusinessPage } from '../apps/dashboard/src/AdminBusinessPage.js';
import { buildAdminBusinessPage } from '../apps/dashboard/src/admin-business.js';

const env = { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'token' };
const guildId = '999999999999999999';
const l1DiscordId = '111111111111111111';
const unclaimedL1DiscordId = '111111111111111112';
const l2DiscordId = '222222222222222222';
const staffDirectory: StaffDirectory = { resolveByDiscord({ discordUserId }) {
  const level = discordUserId === l1DiscordId || discordUserId === unclaimedL1DiscordId ? 'L1_SUPPORT' : discordUserId === l2DiscordId ? 'L2_SUPERVISOR' : null;
  return level ? { staffId: `00000000-0000-0000-0000-${discordUserId.slice(-12)}`, userId: `10000000-0000-0000-0000-${discordUserId.slice(-12)}`, level, permissionsVersion: 1, status: 'ACTIVE' } : null;
} };

const orderId = '00000000-0000-0000-0000-000000001001';
const playerA = '00000000-0000-0000-0000-000000002001';
const playerB = '00000000-0000-0000-0000-000000002002';
const playerC = '00000000-0000-0000-0000-000000002003';
const valorantTech = '00000000-0000-0000-0000-000000003001';
const lolFun = '00000000-0000-0000-0000-000000003002';

function headers(discordUserId: string, idempotencyKey = 'm10:participant:test:0001') {
  return { authorization: 'Bearer token', 'x-client-source': 'DASHBOARD', 'x-actor-discord-user-id': discordUserId,
    'x-actor-guild-id': guildId, 'idempotency-key': idempotencyKey };
}

function fixture() {
  const store = new InMemoryOrderParticipantStore({
    orders: [{ id: orderId, guildId, version: 1, status: 'DRAFT', captured: false, amountMinor: 0 }],
    claimedOrderIdsByStaffId: { '00000000-0000-0000-0000-111111111111': [orderId] },
    players: [
      { userId: playerA, displayName: '奶糖', eligible: true },
      { userId: playerB, displayName: '布丁', eligible: true },
      { userId: playerC, displayName: '芝麻', eligible: true, discordUserId: '333333333333333333', discordTag: '芝麻#8192' }
    ],
    catalogs: [
      { id: valorantTech, serviceOfferingId: 'offering-tech', status: 'ACTIVE', game: 'VALORANT', gameDisplayName: '瓦洛兰特', service: 'TECH', serviceDisplayName: '技术陪玩', region: 'NA', regionDisplayName: '北美', billingUnitMinutes: 60, customerUnitPriceMinor: 100, defaultPlayerPayoutBps: 6000 },
      { id: lolFun, serviceOfferingId: 'offering-fun', status: 'ACTIVE', game: 'LOLNA', gameDisplayName: '英雄联盟美服', service: 'FUN', serviceDisplayName: '娱乐陪玩', region: null, regionDisplayName: null, billingUnitMinutes: 60, customerUnitPriceMinor: 80, defaultPlayerPayoutBps: 5000 }
    ],
    compensationRules: [{ playerUserId: playerB, serviceOfferingId: 'offering-fun', type: 'FIXED_MINOR', value: 55 },
      { playerUserId: playerC, serviceOfferingId: 'offering-tech', type: 'FIXED_MINOR', value: 50 }]
  });
  const server = buildApiServer({ env, security: { staffDirectory }, orderParticipants: { store } });
  return { server, store };
}

describe('M10-US-03 order participant API', () => {
  test('builds Dashboard participant writes without accepting a client-derived order total', () => {
    expect(buildAddOrderParticipantRequest(orderId,{playerId:playerA,serviceCatalogVersionId:valorantTech,unitCount:'2',linePriceMinor:'240',expectedOrderVersion:1,reasonCode:'ADD_PLAYER'})).toEqual({method:'POST',path:`/api/v1/admin/orders/${orderId}/participants`,body:{playerId:playerA,serviceCatalogVersionId:valorantTech,unitCount:2,linePriceMinor:240,expectedOrderVersion:1,reasonCode:'ADD_PLAYER'}});
    expect(buildUpdateOrderParticipantRequest(orderId,'participant-1',{action:'CHANGE_PROJECT',serviceCatalogVersionId:lolFun,unitCount:'3',linePriceMinor:'300',expectedOrderVersion:2,expectedParticipantVersion:1,reasonCode:'CHANGE_PROJECT'}).body).not.toHaveProperty('amountMinor');
    expect(buildUpdateOrderParticipantRequest(orderId,'participant-1',{action:'REASSIGN',playerId:playerC,expectedOrderVersion:3,expectedParticipantVersion:1,reasonCode:'PLAYER_UNAVAILABLE'})).toEqual({
      method:'PATCH',path:`/api/v1/admin/orders/${orderId}/participants/participant-1`,body:{expectedOrderVersion:3,expectedParticipantVersion:1,action:'REASSIGN',playerId:playerC,serviceCatalogVersionId:null,unitCount:null,linePriceMinor:null,reasonCode:'PLAYER_UNAVAILABLE'}
    });
  });

  test('renders every participant project, price and compensation inside the order overlay',()=>{
    const model=buildAdminBusinessPage({page:'orders',permissions:['order.read','order.participants.manage'],status:'READY',items:[{id:orderId}]});
    const html=renderToStaticMarkup(createElement(AdminBusinessPage,{model,detail:{kind:'READY',page:'orders',requestId:'req-m10',data:{order:{id:orderId,publicId:'P-M10',version:3,status:'DRAFT',customerId:'customer-1',customerDiscordUserId:'123456789012345678',customerDiscordTag:'老板猫#1024',sourcePackageVersionId:'package-v2',sourcePackageCode:'DELTA_ESCORT',sourcePackageDisplayName:'三角洲护航',sourcePackageVersion:2,compositionMode:'CUSTOMIZED',amountMinor:540,currency:'CAT'},timeline:{items:[],nextCursor:null},requirements:{catalogSubtotalMinor:560,packageAdjustmentMinor:-20,derivedTotalMinor:540,items:[{id:'requirement-a',sourcePackageSlotId:'slot-a',serviceCatalogVersionId:valorantTech,customerNote:'负责技术护航',gameDisplayName:'瓦洛兰特',serviceDisplayName:'技术陪玩',regionDisplayName:'北美',billingUnitMinutes:60,unitCount:2,requestedPlayerCount:1,filledPlayerCount:1,estimatedLinePriceMinor:240,status:'ACTIVE'},{id:'requirement-b',sourcePackageSlotId:'slot-b',serviceCatalogVersionId:lolFun,customerNote:'技术要求不高，会聊天就行',gameDisplayName:'英雄联盟美服',serviceDisplayName:'娱乐陪玩',billingUnitMinutes:60,unitCount:3,requestedPlayerCount:2,filledPlayerCount:1,estimatedLinePriceMinor:300,status:'ACTIVE'}]},participants:{derivedTotalMinor:540,items:[{id:'participant-a',orderRequirementId:'requirement-a',playerId:playerA,discordUserId:'223456789012345678',discordTag:'奶糖#2048',displayName:'奶糖',serviceCatalogVersionId:valorantTech,gameDisplayName:'瓦洛兰特',serviceDisplayName:'技术陪玩',regionDisplayName:'北美',billingUnitMinutes:60,unitCount:2,linePriceMinor:240,compensationType:'PERCENT_BPS',compensationValue:6000,compensationSource:'CATALOG_DEFAULT',expectedEarningMinor:144,status:'ACTIVE',readiness:'NOT_READY',version:1},{id:'participant-b',orderRequirementId:'requirement-b',playerId:playerB,discordUserId:'323456789012345678',discordTag:'布丁#4096',displayName:'布丁',serviceCatalogVersionId:lolFun,gameDisplayName:'英雄联盟美服',serviceDisplayName:'娱乐陪玩',billingUnitMinutes:60,unitCount:3,linePriceMinor:300,compensationType:'FIXED_MINOR',compensationValue:55,compensationSource:'PLAYER_OVERRIDE',expectedEarningMinor:165,status:'ACTIVE',readiness:'READY',version:1}]}}},serviceCatalogOptions:[],participantPlayerOptions:[],onAddOrderParticipant:()=>undefined,onUpdateOrderParticipant:()=>undefined}));
    expect(html).toContain('项目需求');expect(html).toContain('还差 1 位');expect(html).toContain('老板猫#1024');expect(html).toContain('三角洲护航');expect(html).toContain('DELTA_ESCORT');expect(html).toContain('技术要求不高，会聊天就行');expect(html).toContain('套餐调整 -2.0 猫条');expect(html).toContain('奶糖#2048');expect(html).toContain('陪玩与项目');expect(html).toContain('瓦洛兰特 · 技术陪玩');expect(html).toContain('英雄联盟美服 · 娱乐陪玩');expect(html).toContain('60.00% · 项目默认');expect(html).toContain('5.5 猫条/单位 · 个人规则');expect(html).toContain('编辑明细');expect(html).toContain('改派陪玩');
  });
  test('lets claimed L1 staff add independently priced projects and derives totals and earnings', async () => {
    const { server } = fixture();
    const candidates=await server.inject({method:'GET',url:`/api/v1/admin/orders/${orderId}/participant-candidates?query=奶糖`,headers:headers(l1DiscordId)});
    expect(candidates.statusCode).toBe(200);expect(candidates.json().data.items).toEqual([expect.objectContaining({playerId:playerA,projects:[expect.objectContaining({id:valorantTech,gameDisplayName:'瓦洛兰特'}),expect.objectContaining({id:lolFun,serviceDisplayName:'娱乐陪玩'})]})]);
    const first = await server.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/participants`, headers: headers(l1DiscordId), payload: {
      playerId: playerA, serviceCatalogVersionId: valorantTech, unitCount: 2, linePriceMinor: 240, expectedOrderVersion: 1, reasonCode: 'ADD_TECH_PLAYER'
    } });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({ orderVersion: 2, derivedTotalMinor: 240, participant: {
      playerId: playerA, gameDisplayName: '瓦洛兰特', serviceDisplayName: '技术陪玩', linePriceMinor: 240,
      compensationType: 'PERCENT_BPS', compensationValue: 6000, compensationSource: 'CATALOG_DEFAULT', expectedEarningMinor: 144
    } });
    const second = await server.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/participants`, headers: headers(l1DiscordId, 'm10:participant:test:0002'), payload: {
      playerId: playerB, serviceCatalogVersionId: lolFun, unitCount: 3, linePriceMinor: 300, expectedOrderVersion: 2, reasonCode: 'ADD_FUN_PLAYER'
    } });
    expect(second.statusCode).toBe(201);
    expect(second.json().data).toMatchObject({ orderVersion: 3, derivedTotalMinor: 540, participant: {
      playerId: playerB, gameDisplayName: '英雄联盟美服', serviceDisplayName: '娱乐陪玩', compensationType: 'FIXED_MINOR',
      compensationValue: 55, compensationSource: 'PLAYER_OVERRIDE', expectedEarningMinor: 165
    } });
    const list = await server.inject({ method: 'GET', url: `/api/v1/admin/orders/${orderId}/participants`, headers: headers(l1DiscordId) });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toMatchObject({ orderVersion: 3, derivedTotalMinor: 540, items: [
      expect.objectContaining({ playerId: playerA, serviceCatalogVersionId: valorantTech }),
      expect.objectContaining({ playerId: playerB, serviceCatalogVersionId: lolFun })
    ] });
  });

  test('supports project/price changes and logical removal with optimistic concurrency', async () => {
    const { server } = fixture();
    const added = await server.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/participants`, headers: headers(l1DiscordId), payload: {
      playerId: playerA, serviceCatalogVersionId: valorantTech, unitCount: 2, linePriceMinor: 240, expectedOrderVersion: 1, reasonCode: 'ADD_PLAYER'
    } });
    const participantId = added.json().data.participant.id as string;
    const changed = await server.inject({ method: 'PATCH', url: `/api/v1/admin/orders/${orderId}/participants/${participantId}`, headers: headers(l1DiscordId, 'm10:participant:test:0003'), payload: {
      expectedOrderVersion: 2, expectedParticipantVersion: 1, action: 'CHANGE_PROJECT', serviceCatalogVersionId: lolFun, unitCount: 4, linePriceMinor: 360, reasonCode: 'CHANGE_PROJECT'
    } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().data).toMatchObject({ orderVersion: 3, derivedTotalMinor: 360, participant: { version: 2, gameDisplayName: '英雄联盟美服', unitCount: 4 } });
    const stale = await server.inject({ method: 'PATCH', url: `/api/v1/admin/orders/${orderId}/participants/${participantId}`, headers: headers(l1DiscordId, 'm10:participant:test:0004'), payload: {
      expectedOrderVersion: 2, expectedParticipantVersion: 1, action: 'REMOVE', reasonCode: 'REMOVE_PLAYER'
    } });
    expect(stale.statusCode).toBe(409);
    const removed = await server.inject({ method: 'PATCH', url: `/api/v1/admin/orders/${orderId}/participants/${participantId}`, headers: headers(l1DiscordId, 'm10:participant:test:0005'), payload: {
      expectedOrderVersion: 3, expectedParticipantVersion: 2, action: 'REMOVE', reasonCode: 'REMOVE_PLAYER'
    } });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().data).toMatchObject({ orderVersion: 4, derivedTotalMinor: 0, participant: { status: 'REMOVED', version: 3 } });
  });

  test('reassigns only one participant while preserving its project, price, order total and other player', async () => {
    const {server,store}=fixture();
    const first=await server.inject({method:'POST',url:`/api/v1/admin/orders/${orderId}/participants`,headers:headers(l1DiscordId),payload:{playerId:playerA,serviceCatalogVersionId:valorantTech,unitCount:2,linePriceMinor:240,expectedOrderVersion:1,reasonCode:'ADD_TECH_PLAYER'}});
    const firstId=first.json().data.participant.id as string;
    const second=await server.inject({method:'POST',url:`/api/v1/admin/orders/${orderId}/participants`,headers:headers(l1DiscordId,'m10:participant:reassign:add2'),payload:{playerId:playerB,serviceCatalogVersionId:lolFun,unitCount:3,linePriceMinor:300,expectedOrderVersion:2,reasonCode:'ADD_FUN_PLAYER'}});
    const secondBefore=structuredClone(second.json().data.participant);
    const firstRecord=store.participants.find((participant)=>participant.id===firstId)!;firstRecord.readiness='READY';firstRecord.orderRequirementId='requirement-tech';
    const reassigned=await server.inject({method:'PATCH',url:`/api/v1/admin/orders/${orderId}/participants/${firstId}`,headers:headers(l1DiscordId,'m10:participant:reassign:0001'),payload:{expectedOrderVersion:3,expectedParticipantVersion:1,action:'REASSIGN',playerId:playerC,serviceCatalogVersionId:null,unitCount:null,linePriceMinor:null,reasonCode:'PLAYER_UNAVAILABLE'}});
    expect(reassigned.statusCode,reassigned.body).toBe(200);
    expect(reassigned.json().data).toMatchObject({orderVersion:4,derivedTotalMinor:540,participant:{id:firstId,orderRequirementId:'requirement-tech',playerId:playerC,displayName:'芝麻',serviceCatalogVersionId:valorantTech,unitCount:2,linePriceMinor:240,readiness:'NOT_READY',compensationType:'FIXED_MINOR',compensationValue:50,expectedEarningMinor:100,version:2}});
    expect(store.participants.find((participant)=>participant.playerId===playerB)).toEqual(secondBefore);
    expect(store.orders[0]).toMatchObject({amountMinor:540,version:4});
    const duplicate=await server.inject({method:'PATCH',url:`/api/v1/admin/orders/${orderId}/participants/${firstId}`,headers:headers(l1DiscordId,'m10:participant:reassign:0002'),payload:{expectedOrderVersion:4,expectedParticipantVersion:2,action:'REASSIGN',playerId:playerB,reasonCode:'DUPLICATE_PLAYER'}});
    expect(duplicate.statusCode).toBe(409);
    const priceInjection=await server.inject({method:'PATCH',url:`/api/v1/admin/orders/${orderId}/participants/${firstId}`,headers:headers(l1DiscordId,'m10:participant:reassign:0003'),payload:{expectedOrderVersion:4,expectedParticipantVersion:2,action:'REASSIGN',playerId:playerA,linePriceMinor:1,reasonCode:'PRICE_INJECTION'}});
    expect(priceInjection.statusCode).toBe(400);
    expect(store.participants).toHaveLength(2);
  });

  test('enforces claimed-task and guild scope and rejects client totals, duplicate players, ineligible players and captured orders', async () => {
    const { server, store } = fixture();
    const unclaimed = await server.inject({ method: 'GET', url: `/api/v1/admin/orders/${orderId}/participants`, headers: headers(unclaimedL1DiscordId) });
    expect(unclaimed.statusCode).toBe(403);
    const clientTotal = await server.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/participants`, headers: headers(l1DiscordId), payload: {
      playerId: playerA, serviceCatalogVersionId: valorantTech, unitCount: 2, linePriceMinor: 240, amountMinor: 1, expectedOrderVersion: 1, reasonCode: 'ADD_PLAYER'
    } });
    expect(clientTotal.statusCode).toBe(400);
    store.orders[0]!.captured = true;
    const captured = await server.inject({ method: 'POST', url: `/api/v1/admin/orders/${orderId}/participants`, headers: headers(l2DiscordId, 'm10:participant:test:0006'), payload: {
      playerId: playerA, serviceCatalogVersionId: valorantTech, unitCount: 2, linePriceMinor: 240, expectedOrderVersion: 1, reasonCode: 'ADD_PLAYER'
    } });
    expect(captured.statusCode).toBe(422);
  });
});
