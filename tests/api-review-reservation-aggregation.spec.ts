import { describe, expect, test } from 'vitest';
import { InMemoryOrderStore, type FundReservationEventRecord, type FundReservationRecord, type OrderRecord } from '@blackcat/api/orders';
import { activeReservationRemainder, sumActiveReservationRemainders } from '@blackcat/api/reservation-balance';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';

const now=new Date('2026-08-13T07:00:00.000Z');
const customerId='00000000-0000-0000-0000-000000021001';
const oldOrderId='00000000-0000-0000-0000-000000021002';
const nextOrderId='00000000-0000-0000-0000-000000021003';
const oldReservationId='00000000-0000-0000-0000-000000021004';
const nextReservationId='00000000-0000-0000-0000-000000021005';

describe('API review FundReservation remaining balance aggregation',()=>{
  test('subtracts only settlement events and clamps corrupted over-settlement at zero',()=>{
    expect(activeReservationRemainder(10_000,[
      {eventType:'CREATED',amountMinor:10_000},
      {eventType:'CAPTURED',amountMinor:3_000},
      {eventType:'DISPUTE_OPENED',amountMinor:0}
    ])).toBe(7_000);
    expect(activeReservationRemainder(10_000,[{eventType:'CAPTURED',amountMinor:12_000}])).toBe(0);
    expect(sumActiveReservationRemainders([
      {id:'a',userId:customerId,currency:'CAT',status:'PARTIALLY_SETTLED',amountMinor:10_000},
      {id:'b',userId:customerId,currency:'CAT',status:'ACTIVE',amountMinor:2_000},
      {id:'c',userId:customerId,currency:'CAT',status:'CAPTURED',amountMinor:5_000}
    ],[
      {fundReservationId:'a',eventType:'CAPTURED',amountMinor:3_000},
      {fundReservationId:'c',eventType:'CAPTURED',amountMinor:5_000}
    ],{userId:customerId,currency:'CAT'})).toBe(9_000);
  });

  test('allows a new order when ledger minus remaining holds exactly covers its reservation',async()=>{
    const oldReservation=reservation({id:oldReservationId,orderId:oldOrderId,amountMinor:10_000,status:'PARTIALLY_SETTLED',version:2});
    const store=new InMemoryOrderStore({
      orders:[order({id:oldOrderId,status:'COMPLETED',version:3,amountMinor:10_000}),order({id:nextOrderId,status:'DRAFT',version:1,amountMinor:6_000})],
      reservations:[oldReservation],
      reservationEvents:[reservationEvent({id:'00000000-0000-0000-0000-000000021006',fundReservationId:oldReservationId,eventType:'CAPTURED',fromStatus:'ACTIVE',toStatus:'PARTIALLY_SETTLED',amountMinor:3_000,reservationVersion:2,sequence:2})]
    });
    const submitted=order({id:nextOrderId,status:'PENDING_DISPATCH',version:2,amountMinor:6_000});
    const nextReservation=reservation({id:nextReservationId,orderId:nextOrderId,amountMinor:6_000,status:'ACTIVE',version:1});
    await store.commitSubmit({order:submitted,expectedVersion:1,ledgerBalanceMinor:13_000,orderEvent:orderEvent(),reservation:nextReservation,
      reservationEvent:reservationEvent({id:'00000000-0000-0000-0000-000000021007',fundReservationId:nextReservationId,eventType:'CREATED',fromStatus:null,toStatus:'ACTIVE',amountMinor:6_000,reservationVersion:1,sequence:1}),
      externalTransactions:[],auditRecord:audit(),auditSink:new InMemoryAuditSink()});
    expect(store.reservations).toHaveLength(2);
    expect(store.orders.find((item)=>item.id===nextOrderId)).toMatchObject({status:'PENDING_DISPATCH',version:2});
  });
});

function order(overrides:Partial<OrderRecord>&Pick<OrderRecord,'id'|'status'|'version'|'amountMinor'>):OrderRecord{return{
  id:overrides.id,publicId:`P-${overrides.id.slice(-6)}`,customerId,playerId:null,status:overrides.status,version:overrides.version,
  serviceCatalogId:'00000000-0000-0000-0000-000000021020',catalogVersion:1,game:'VALORANT',service:'ENTERTAINMENT',region:'NA',billingUnitMinutes:60,unitCount:1,
  customerUnitPriceMinor:overrides.amountMinor,playerUnitPayoutMinor:0,amountMinor:overrides.amountMinor,playerEarningMinor:0,currency:'CAT',notes:null,
  channelSpec:{channelId:'900000000000021001',panelMessageId:'900000000000021002',voiceChannelId:null},createdAt:now.toISOString(),updatedAt:now.toISOString(),...overrides};}

function reservation(overrides:Partial<FundReservationRecord>&Pick<FundReservationRecord,'id'|'orderId'|'amountMinor'|'status'|'version'>):FundReservationRecord{return{
  id:overrides.id,userId:customerId,sourceType:'ORDER',orderId:overrides.orderId,mode:'LOCAL_RESERVATION',provider:null,providerHoldRef:null,amountMinor:overrides.amountMinor,
  currency:'CAT',status:overrides.status,version:overrides.version,idempotencyKey:`reservation:${overrides.id}`,expiresAt:new Date(now.getTime()+30*60_000).toISOString(),
  activatedAt:now.toISOString(),settledAt:null,createdAt:now.toISOString(),updatedAt:now.toISOString(),...overrides};}

function reservationEvent(overrides:Partial<FundReservationEventRecord>&Pick<FundReservationEventRecord,'id'|'fundReservationId'|'eventType'|'fromStatus'|'toStatus'|'amountMinor'|'reservationVersion'|'sequence'>):FundReservationEventRecord{return{
  id:overrides.id,fundReservationId:overrides.fundReservationId,sequence:overrides.sequence,eventType:overrides.eventType,fromStatus:overrides.fromStatus,toStatus:overrides.toStatus,
  amountMinor:overrides.amountMinor,reservationVersion:overrides.reservationVersion,idempotencyKey:`event:${overrides.id}`,actorUserId:customerId,actorStaffId:null,actorSource:'DISCORD_BOT',reasonCode:null,createdAt:now.toISOString(),...overrides};}

function orderEvent(){return{id:'00000000-0000-0000-0000-000000021008',orderId:nextOrderId,sequence:2,eventType:'SUBMITTED' as const,fromStatus:'DRAFT' as const,toStatus:'PENDING_DISPATCH' as const,
  actorUserId:customerId,actorStaffId:null,actorSource:'DISCORD_BOT' as const,interactionId:'900000000000021003',payload:{},createdAt:now.toISOString()};}

function audit():AuditRecord{return{id:'00000000-0000-0000-0000-000000021009',actorId:customerId,actorStaffId:null,actorLevel:null,actorSource:'DISCORD_BOT',clientId:'DISCORD_BOT',interactionId:'900000000000021003',
  permissionCode:'order.submit',action:'SUBMIT_ORDER',targetType:'order',targetId:nextOrderId,outcome:'SUCCEEDED',reason:null,requestId:'req_reservation_aggregation',idempotencyKey:'reservation:aggregation:submit',approvalRequestId:null,occurredAt:now.toISOString()};}
