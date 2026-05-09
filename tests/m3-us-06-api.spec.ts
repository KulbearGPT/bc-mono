import { describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryOrderStore, type OrderRecord } from '@blackcat/api/orders';
import { InMemoryGiftStore, createGiftExpiryHandler, expireGiftRequest, registerGiftRoutes, type GiftRequestRecord, type GiftReservationRecord, type GiftStaffTaskRecord } from '@blackcat/api/gifts';
import { MockFundingAdapter } from '@blackcat/api/payment-adapter';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';

const now = new Date('2026-07-18T20:00:00.000Z');
const guildId = '900000000000000001'; const discordUserId = '900000000000000061';
const customerId = '00000000-0000-0000-0000-000000004310'; const playerId = '00000000-0000-0000-0000-000000004311';
const orderId = '00000000-0000-0000-0000-000000004312'; const giftRequestId = '00000000-0000-0000-0000-000000004313';

function order(): OrderRecord { return { id:orderId,publicId:'P-4312',customerId,playerId,status:'IN_SERVICE',version:7,serviceCatalogId:null,catalogVersion:null,
  game:'VALORANT',service:'ENTERTAINMENT',region:'NA',billingUnitMinutes:60,unitCount:2,customerUnitPriceMinor:6000,playerUnitPayoutMinor:4200,
  amountMinor:12000,playerEarningMinor:8400,currency:'CNY',notes:null,channelSpec:{channelId:'900000000000000003',panelMessageId:'900000000000000004',voiceChannelId:null},createdAt:now.toISOString(),updatedAt:now.toISOString() }; }
function request(status: GiftRequestRecord['status']='PENDING_REVIEW'): GiftRequestRecord { return { id:giftRequestId,publicId:'G-4313',orderId,giftCatalogVersionId:'00000000-0000-0000-0000-000000004314',senderId:customerId,receiverId:playerId,status,version:1,giftCodeSnapshot:'STAR',giftNameSnapshot:'星光礼盒',priceMinor:2000,currency:'CNY',broadcastTemplateSnapshot:'gift',expiresAt:new Date(now.getTime()+30*60_000).toISOString(),createdAt:now.toISOString(),updatedAt:now.toISOString() }; }
function reservation(status: GiftReservationRecord['status']='ACTIVE'): GiftReservationRecord { return { id:'00000000-0000-0000-0000-000000004315',userId:customerId,sourceType:'GIFT',orderId:null,giftRequestId,mode:'LOCAL_RESERVATION_FALLBACK',provider:'mock-provider',providerHoldRef:null,amountMinor:2000,currency:'CNY',status,version:2,idempotencyKey:'gift:4313',expiresAt:request().expiresAt,activatedAt:now.toISOString(),settledAt:null,createdAt:now.toISOString(),updatedAt:now.toISOString() }; }
function task(): GiftStaffTaskRecord { return {id:'00000000-0000-0000-0000-000000004316',publicId:'T-4316',type:'GIFT_REVIEW',reasonCode:'GIFT_REQUESTED',status:'OPEN',version:1,orderId,giftRequestId,voiceChannelId:null,contextSnapshot:{orderId,orderPublicId:'P-4312',channelId:'900000000000000003',voiceChannelId:null,senderId:customerId,receiverId:playerId,giftCode:'STAR',giftName:'星光礼盒',priceMinor:2000,currency:'CNY',reservationId:reservation().id},createdAt:now.toISOString(),updatedAt:now.toISOString()}; }
function binding(): AccountBindingRecord { return {userId:customerId,displayName:'Customer',userStatus:'ACTIVE',userVersion:1,discordAccountId:'00000000-0000-0000-0000-000000004317',guildId,discordUserId,externalAccountId:'00000000-0000-0000-0000-000000004318',provider:'mock-provider',externalUserId:'mock-user-ok',externalUserDisplay:'mock',externalAccountStatus:'ACTIVE',boundAt:now.toISOString()}; }
function fixture(status: GiftRequestRecord['status']='PENDING_REVIEW') { const store=new InMemoryGiftStore({requests:[request(status)],reservations:[reservation(status==='CAPTURED'?'CAPTURED':'ACTIVE')],staffTasks:[task()]});
  const server=buildApiServer({env:{NODE_ENV:'development',DATABASE_URL:'',API_PORT:'0',API_BASE_URL:'http://localhost:3000',BOT_SERVICE_TOKEN:'valid-bot-token'},security:{auditSink:new InMemoryAuditSink(),idempotencyStore:new InMemoryIdempotencyStore()}});
  registerGiftRoutes(server,{store,orderStore:new InMemoryOrderStore({orders:[order()]}),accountStore:new InMemoryAccountStore({bindings:[binding()],reservationSource:()=>store.reservations}),fundingAdapter:new MockFundingAdapter({now}),providerKey:'mock-provider',broadcastChannelId:'900000000000000020',now:()=>now});return{server,store}; }
function headers(key:string, actor=discordUserId){return{authorization:'Bearer valid-bot-token','x-client-source':'DISCORD_BOT','x-actor-discord-user-id':actor,'x-actor-guild-id':guildId,'x-discord-interaction-id':'900000000000000062','idempotency-key':key};}

describe('M3-US-06 gift reservation lifecycle',()=>{
  test('lets only the sender withdraw before capture and releases once',async()=>{const {server,store}=fixture();const input={method:'POST' as const,url:`/api/v1/gift-requests/${giftRequestId}/cancel`,headers:headers('gift:cancel:4313'),payload:{expectedVersion:1,reasonCode:'CUSTOMER_WITHDREW_REQUEST'}};
    const first=await server.inject(input);const replay=await server.inject(input);expect(first.json()).toMatchObject({data:{status:'WITHDRAWN',reservation:{status:'RELEASED'}}});expect(replay.statusCode).toBe(200);expect(store.reservations[0]).toMatchObject({status:'RELEASED',version:3});
    expect((await fixture().server.inject({...input,headers:headers('gift:cancel:other','900000000000000099')})).statusCode).toBe(403);});
  test('blocks cancellation after capture',async()=>{const {server}=fixture('CAPTURED');expect((await server.inject({method:'POST',url:`/api/v1/gift-requests/${giftRequestId}/cancel`,headers:headers('gift:cancel:captured'),payload:{expectedVersion:1,reasonCode:'CUSTOMER_WITHDREW_REQUEST'}})).statusCode).toBe(409);});
  test('expires and releases the same request idempotently',async()=>{const {store}=fixture();const at=new Date(Date.parse(request().expiresAt)+1);
    await createGiftExpiryHandler({store,now:()=>at})({id:'00000000-0000-0000-0000-000000004319',type:'GIFT_EXPIRY',status:'PROCESSING',payload:{giftRequestId},aggregateType:'GIFT_REQUEST',aggregateId:giftRequestId,dedupeKey:'gift-expiry:4313',attempts:1,maxAttempts:8,runAfter:request().expiresAt,lockedAt:at.toISOString(),lockedBy:'worker',lastError:null,version:2,createdAt:now.toISOString(),updatedAt:now.toISOString()});
    const replay=await expireGiftRequest({store,giftRequestId,now:at});expect(replay).toMatchObject({status:'EXPIRED',reservation:{status:'EXPIRED'}});expect(store.reservations[0]).toMatchObject({status:'EXPIRED',version:3});});
});
