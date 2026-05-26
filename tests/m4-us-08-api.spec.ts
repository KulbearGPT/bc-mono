import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAdminDirectoryStore } from '@blackcat/api/admin-directory';
import { InMemoryTransactionTimelineStore, type TransactionTimelineItem } from '@blackcat/api/transaction-timeline';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffLevel } from '@blackcat/api/security';
import type { OrderRecord } from '@blackcat/api/orders';

const orderId = '00000000-0000-0000-0000-000000008001';
const guildId = '900000000000008000';
const levels: StaffLevel[] = ['L1_SUPPORT', 'L2_SUPERVISOR', 'L3_OPERATIONS', 'L4_ADMIN_OWNER'];
const accounts = levels.map((level, index) => ({ staffId: `00000000-0000-0000-0000-00000000810${index}`, userId: `00000000-0000-0000-0000-00000000820${index}`, discordUserId: `90000000000000810${index}`, level, permissionsVersion: 1, status: 'ACTIVE' as const }));

function order(): OrderRecord {
  return { id: orderId, publicId: 'P-8001', customerId: '00000000-0000-0000-0000-000000008301', playerId: '00000000-0000-0000-0000-000000008302', status: 'COMPLETED', version: 8,
    serviceCatalogId: '00000000-0000-0000-0000-000000008303', catalogVersion: 1, game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA', billingUnitMinutes: 60, unitCount: 2,
    customerUnitPriceMinor: 6000, playerUnitPayoutMinor: 4000, amountMinor: 12000, playerEarningMinor: 8000, currency: 'USD', notes: null,
    channelSpec: { channelId: '900000000000008401', panelMessageId: '900000000000008402', voiceChannelId: null }, createdAt: '2026-07-18T20:00:00.000Z', updatedAt: '2026-07-18T20:10:00.000Z', completedAt: '2026-07-18T20:10:00.000Z' };
}

function item(id: string, type: TransactionTimelineItem['type'], occurredAt: string, amountMinor: number | null, direction: TransactionTimelineItem['direction'] = 'INFO'): TransactionTimelineItem {
  return { id, type, status: type.endsWith('ADJUSTMENT') ? 'REVERSAL' : 'SUCCEEDED', direction, amountMinor, currency: amountMinor === null ? null : 'USD', sourceType: type, sourceId: id,
    requestId: `req_${id.slice(-3)}`, actor: { source: 'DASHBOARD', userId: 'private-user', staffId: 'private-staff' }, occurredAt };
}

function fixture() {
  const audit = new InMemoryAuditSink();
  const orderRecord = order();
  const timeline: TransactionTimelineItem[] = [
    item('00000000-0000-0000-0000-000000008501', 'ORDER_EVENT', '2026-07-18T20:01:00.000Z', null),
    item('00000000-0000-0000-0000-000000008502', 'FUND_RESERVATION_EVENT', '2026-07-18T20:02:00.000Z', 12000, 'HOLD'),
    item('00000000-0000-0000-0000-000000008503', 'CONSUMPTION', '2026-07-18T20:03:00.000Z', 12000, 'DEBIT'),
    item('00000000-0000-0000-0000-000000008504', 'PLAYER_EARNING', '2026-07-18T20:04:00.000Z', 8000, 'CREDIT'),
    item('00000000-0000-0000-0000-000000008505', 'COMMISSION', '2026-07-18T20:05:00.000Z', 240, 'CREDIT'),
    item('00000000-0000-0000-0000-000000008506', 'REFUND', '2026-07-18T20:06:00.000Z', 6000, 'CREDIT'),
    item('00000000-0000-0000-0000-000000008507', 'PLAYER_EARNING_ADJUSTMENT', '2026-07-18T20:07:00.000Z', 4000, 'DEBIT'),
    item('00000000-0000-0000-0000-000000008508', 'COMMISSION_ADJUSTMENT', '2026-07-18T20:08:00.000Z', 120, 'DEBIT')
  ];
  const timelineStore = new InMemoryTransactionTimelineStore({ orders: [orderRecord], timelineByOrderId: { [orderId]: timeline }, visibleOrderIdsByStaffId: { [accounts[0]!.staffId]: [orderId] } });
  const directory = new InMemoryAdminDirectoryStore({ orders: [orderRecord], users: [], players: [], consumptions: [], gifts: [], giftRequests: [] });
  const server = buildApiServer({ env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' }, security: {
    auditSink: audit, idempotencyStore: new InMemoryIdempotencyStore(),
    staffDirectory: { resolveByDiscord: ({ discordUserId }) => accounts.find((candidate) => candidate.discordUserId === discordUserId) ?? null }
  }, adminDirectory: { store: directory, timelineStore } });
  return { server };
}

function headers(level: StaffLevel) { const actor=accounts.find((candidate)=>candidate.level===level)!;return { authorization:'Bearer valid-bot-token','x-client-source':'DISCORD_BOT','x-actor-discord-user-id':actor.discordUserId,'x-actor-guild-id':guildId,'x-discord-interaction-id':`9000000000000089${levels.indexOf(level)}` }; }

describe('M4-US-08 unified transaction timeline API', () => {
  test('freezes the paginated, read-only timeline in both OpenAPI mirrors',()=>{
    const docs=readFileSync('docs/P0开发交付包/02-API/openapi.yaml','utf8');
    const output=readFileSync('outputs/P0开发交付包/02-API/openapi.yaml','utf8');
    expect(output).toBe(docs);
    expect(docs).toMatch(/operationId: getAdminOrder[\s\S]*?name: timelineCursor[\s\S]*?name: timelineLimit/);
    expect(docs).toMatch(/TransactionTimelineItem:[\s\S]*?additionalProperties: false[\s\S]*?COMMISSION_ADJUSTMENT/);
    expect(docs).toContain('timeline: {items: [], nextCursor: null}');
  });

  test('AT-TML-001 returns stable pages and keeps adjustments distinct from original facts', async () => {
    const { server } = fixture();
    const first = await server.inject({ method:'GET',url:`/api/v1/admin/orders/${orderId}?timelineLimit=3`,headers:headers('L3_OPERATIONS') });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.timeline.items.map((entry:{type:string})=>entry.type)).toEqual(['COMMISSION_ADJUSTMENT','PLAYER_EARNING_ADJUSTMENT','REFUND']);
    const cursor=encodeURIComponent(first.json().data.timeline.nextCursor);
    const second=await server.inject({method:'GET',url:`/api/v1/admin/orders/${orderId}?timelineLimit=3&timelineCursor=${cursor}`,headers:headers('L3_OPERATIONS')});
    expect(second.statusCode).toBe(200);
    expect(second.json().data.timeline.items.map((entry:{type:string})=>entry.type)).toEqual(['COMMISSION','PLAYER_EARNING','CONSUMPTION']);
    expect(second.json().data.timeline.items.find((entry:{type:string})=>entry.type==='COMMISSION')).not.toHaveProperty('beneficiaryId');
  });

  test('AT-TML-002 and AT-RFP-005 apply L1/L2/L3 redaction without leaking referral identities', async () => {
    const { server }=fixture();
    const [l1,l2,l3]=await Promise.all(['L1_SUPPORT','L2_SUPERVISOR','L3_OPERATIONS'].map((level)=>server.inject({method:'GET',url:`/api/v1/admin/orders/${orderId}?timelineLimit=100`,headers:headers(level as StaffLevel)})));
    expect(l1.statusCode).toBe(200);expect(l2.statusCode).toBe(200);expect(l3.statusCode).toBe(200);
    expect(l1.json().data.timeline.items.map((entry:{type:string})=>entry.type)).toEqual(['FUND_RESERVATION_EVENT','ORDER_EVENT']);
    expect(l1.json().data.timeline.items.every((entry:{amountMinor:number|null})=>entry.amountMinor===null)).toBe(true);
    expect(l2.body).not.toMatch(/COMMISSION|beneficiary|referred|rateBps/);
    expect(l3.body).toContain('COMMISSION');
    expect(l3.body).not.toMatch(/beneficiary|referred|rateBps/);
  });

  test('returns 404 for an L1 order outside claimed task scope', async () => {
    const { server }=fixture();
    const outsider={...accounts[0]!,staffId:'00000000-0000-0000-0000-000000008199',discordUserId:'900000000000008199'};
    accounts.push(outsider);
    const response=await server.inject({method:'GET',url:`/api/v1/admin/orders/${orderId}`,headers:{authorization:'Bearer valid-bot-token','x-client-source':'DISCORD_BOT','x-actor-discord-user-id':outsider.discordUserId,'x-actor-guild-id':guildId,'x-discord-interaction-id':'900000000000008998'}});
    expect(response.statusCode).toBe(404);
    accounts.pop();
  });

  test('rejects malformed timeline cursors without exposing an internal error', async () => {
    const { server }=fixture();
    const response=await server.inject({method:'GET',url:`/api/v1/admin/orders/${orderId}?timelineCursor=forged`,headers:headers('L3_OPERATIONS')});
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({error:{code:'VALIDATION_ERROR'}});
  });

  test('registers one getAdminOrder route when the support workbench is also enabled', async () => {
    const orderRecord=order();
    const timelineStore=new InMemoryTransactionTimelineStore({orders:[orderRecord],timelineByOrderId:{[orderId]:[]}});
    const directory=new InMemoryAdminDirectoryStore({orders:[orderRecord],users:[],players:[],consumptions:[],gifts:[],giftRequests:[]});
    const supportStore={listTasks:()=>[],getTask:()=>{throw new Error('unused');},addNote:()=>{throw new Error('unused');},escalate:()=>{throw new Error('unused');},getOrder:()=>{throw new Error('shadow route must not run');}};
    const server=buildApiServer({env:{NODE_ENV:'test',DATABASE_URL:'',API_PORT:'0',API_BASE_URL:'http://localhost:3000',BOT_SERVICE_TOKEN:'valid-bot-token'},security:{auditSink:new InMemoryAuditSink(),idempotencyStore:new InMemoryIdempotencyStore(),staffDirectory:{resolveByDiscord:({discordUserId})=>accounts.find((candidate)=>candidate.discordUserId===discordUserId)??null}},supportWorkbench:{store:supportStore},adminDirectory:{store:directory,timelineStore}});
    const response=await server.inject({method:'GET',url:`/api/v1/admin/orders/${orderId}`,headers:headers('L3_OPERATIONS')});
    expect(response.statusCode).toBe(200);
    expect(response.json().data.timeline).toEqual({items:[],nextCursor:null});
  });
});
