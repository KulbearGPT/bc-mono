import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresOrderStore,
  type OrderEventRecord,
  type OrderRecord
} from '@blackcat/api/orders';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';
import { startIsolatedPostgres, type IsolatedPostgres } from './support/isolated-postgres';

const now = new Date('2026-07-17T20:00:00.000Z');

let isolated: IsolatedPostgres;
let pool: Pool;

describe('M1-US-03 Postgres order draft integration', () => {
  beforeAll(async () => {
    isolated = await startIsolatedPostgres('a3_order_store');
    pool = isolated.pool;
    await seedCustomerAndCatalog();
  }, 40_000);

  afterAll(async () => isolated.stop());

  test('commits a draft order, CREATED event and audit record atomically', async () => {
    const store = new PostgresOrderStore({ pool });
    await store.commitCreate({
      order: draftOrder(),
      event: orderEvent({ eventType: 'CREATED', fromStatus: null, toStatus: 'DRAFT', sequence: 1 }),
      auditRecord: auditRecord('CREATE_ORDER', 'order.create'),
      auditSink: new InMemoryAuditSink()
    });

    await expect(store.findActiveByCustomer('00000000-0000-0000-0000-00000000a001')).resolves.toMatchObject({
      id: '00000000-0000-0000-0000-00000000b001',
      status: 'DRAFT',
      amountMinor: 0,
      channelSpec: {
        channelId: '120000000000000001',
        panelMessageId: '120000000000000002',
        voiceChannelId: null
      }
    });
    const sideEffects = await pool.query<{ events: string; audits: string }>(`
SELECT
  (SELECT count(*) FROM order_events WHERE order_id = '00000000-0000-0000-0000-00000000b001') AS events,
  (SELECT count(*) FROM audit_logs WHERE action = 'CREATE_ORDER') AS audits
    `);
    expect(sideEffects.rows[0]).toEqual({ events: '1', audits: '1' });
  });

  test('updates draft catalog snapshots and amounts only through the controlled store transaction', async () => {
    const store = new PostgresOrderStore({ pool });
    const updated = draftOrder({
      version: 2,
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      catalogVersion: 3,
      game: 'VALORANT',
      service: 'ENTERTAINMENT',
      region: 'NA',
      billingUnitMinutes: 60,
      unitCount: 2,
      customerUnitPriceMinor: 6000,
      playerUnitPayoutMinor: 4200,
      amountMinor: 12000,
      playerEarningMinor: 8400,
      notes: '轻松交流，不急着上分',
      channelSpec: {
        channelId: '120000000000000001',
        panelMessageId: '120000000000000002',
        voiceChannelId: '120000000000000003'
      },
      updatedAt: new Date(now.getTime() + 60_000).toISOString()
    });

    await store.commitUpdate({
      order: updated,
      event: orderEvent({ eventType: 'DETAILS_UPDATED', fromStatus: 'DRAFT', toStatus: 'DRAFT', sequence: 2 }),
      expectedVersion: 1,
      auditRecord: auditRecord('UPDATE_ORDER', 'order.update'),
      auditSink: new InMemoryAuditSink()
    });

    await expect(store.findById('00000000-0000-0000-0000-00000000b001')).resolves.toMatchObject({
      version: 2,
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      catalogVersion: 3,
      amountMinor: 12000,
      playerEarningMinor: 8400,
      notes: '轻松交流，不急着上分',
      channelSpec: {
        voiceChannelId: '120000000000000003'
      }
    });
    const directUpdate = pool.query(
      "UPDATE orders SET amount_minor = 999 WHERE id = '00000000-0000-0000-0000-00000000b001'"
    );
    await expect(directUpdate).rejects.toThrow(/protected amount/i);
  });

  test('rolls back order updates and audit when expectedVersion is stale', async () => {
    const store = new PostgresOrderStore({ pool });

    await expect(
      store.commitUpdate({
        order: draftOrder({ version: 3, amountMinor: 5000 }),
        event: orderEvent({ eventType: 'DETAILS_UPDATED', fromStatus: 'DRAFT', toStatus: 'DRAFT', sequence: 3 }),
        expectedVersion: 1,
        auditRecord: auditRecord('UPDATE_ORDER', 'stale-order.update'),
        auditSink: new InMemoryAuditSink()
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const current = await store.findById('00000000-0000-0000-0000-00000000b001');
    const leakedAudit = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_logs WHERE permission_code = 'stale-order.update'"
    );

    expect(current).toMatchObject({ version: 2, amountMinor: 12000 });
    expect(leakedAudit.rows[0]?.count).toBe('0');
  });

  test('commits a recovered CHANNEL_LINKED event and persists the replacement mapping', async () => {
    const store = new PostgresOrderStore({ pool });
    const current = await store.findById('00000000-0000-0000-0000-00000000b001');
    expect(current).not.toBeNull();
    const updated = draftOrder({ version: current!.version + 1, channelSpec: { channelId: '120000000000000009', panelMessageId: '120000000000000010', voiceChannelId: null }, updatedAt: now.toISOString() });
    await store.commitUpdate({order:updated,event:orderEvent({eventType:'CHANNEL_LINKED',fromStatus:'DRAFT',toStatus:'DRAFT',sequence:updated.version,payload:{recovered:true}}),expectedVersion:current!.version,auditRecord:auditRecord('RECOVER_ORDER_CHANNEL','order.update'),auditSink:new InMemoryAuditSink()});
    await expect(store.findById(updated.id)).resolves.toMatchObject({version:updated.version,channelSpec:updated.channelSpec});
  });

  test('uses the remaining amount of a partially settled hold when submitting another order',async()=>{
    const userId='00000000-0000-0000-0000-00000000a002';const oldOrderId='00000000-0000-0000-0000-00000000b010';const nextOrderId='00000000-0000-0000-0000-00000000b011';
    const oldReservationId='00000000-0000-0000-0000-00000000b012';const nextReservationId='00000000-0000-0000-0000-00000000b013';
    await pool.query(`INSERT INTO users(id,display_name,updated_at)VALUES('${userId}','Partial Hold Customer','${now.toISOString()}');
      INSERT INTO wallet_accounts(id,user_id,currency,status,row_version,created_at,updated_at)VALUES('00000000-0000-0000-0000-00000000b014','${userId}','CAT','ACTIVE',1,'${now.toISOString()}','${now.toISOString()}');
      INSERT INTO wallet_entries(id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES('00000000-0000-0000-0000-00000000b015','00000000-0000-0000-0000-00000000b014','TOP_UP_CREDIT','CREDIT',13000,'CAT','TOP_UP','00000000-0000-0000-0000-00000000b016','partial:topup','${now.toISOString()}','${now.toISOString()}');
      INSERT INTO orders(id,public_id,customer_id,status,row_version,currency,amount_minor,guild_id,completed_at,created_at,updated_at)
      VALUES('${oldOrderId}','P-OLD-PARTIAL','${userId}','COMPLETED',3,'CAT',10000,'900000000000001002','${now.toISOString()}','${now.toISOString()}','${now.toISOString()}');
      INSERT INTO fund_reservations(id,user_id,source_type,order_id,mode,amount_minor,currency,status,row_version,idempotency_key,created_at,updated_at)
      VALUES('${oldReservationId}','${userId}','ORDER','${oldOrderId}','LOCAL_RESERVATION',10000,'CAT','PARTIALLY_SETTLED',2,'partial:old','${now.toISOString()}','${now.toISOString()}');
      INSERT INTO fund_reservation_events(id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_source,created_at)VALUES
      ('00000000-0000-0000-0000-00000000b017','${oldReservationId}',1,'CREATED',NULL,'ACTIVE',10000,1,'partial:old:created','SYSTEM_JOB','${now.toISOString()}'),
      ('00000000-0000-0000-0000-00000000b018','${oldReservationId}',2,'CAPTURED','ACTIVE','PARTIALLY_SETTLED',3000,2,'partial:old:captured','SYSTEM_JOB','${now.toISOString()}');
      INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,service_catalog_version_id,catalog_version,game_code_snapshot,service_code_snapshot,region_code_snapshot,billing_unit_minutes,unit_count,
        customer_unit_price_minor,player_unit_payout_minor,amount_minor,expected_player_earning_minor,currency,guild_id,channel_id,panel_message_id,created_at,updated_at)
      VALUES('${nextOrderId}','P-NEXT-PARTIAL','${userId}','${userId}','DRAFT',1,'00000000-0000-0000-0000-00000000c001',3,'VALORANT','ENTERTAINMENT','NA',60,1,6000,4200,6000,4200,'CAT','900000000000001002','120000000000000011','120000000000000012','${now.toISOString()}','${now.toISOString()}')`);
    const store=new PostgresOrderStore({pool});const submitted=draftOrder({id:nextOrderId,publicId:'P-NEXT-PARTIAL',customerId:userId,status:'PENDING_DISPATCH',version:2,
      serviceCatalogId:'00000000-0000-0000-0000-00000000c001',catalogVersion:3,game:'VALORANT',service:'ENTERTAINMENT',region:'NA',billingUnitMinutes:60,unitCount:1,
      customerUnitPriceMinor:6000,playerUnitPayoutMinor:4200,amountMinor:6000,playerEarningMinor:4200,channelSpec:{channelId:'120000000000000011',panelMessageId:'120000000000000012',voiceChannelId:null}});
    const reservation={id:nextReservationId,userId,sourceType:'ORDER' as const,orderId:nextOrderId,mode:'LOCAL_RESERVATION' as const,provider:null,providerHoldRef:null,
      amountMinor:6000,currency:'CAT' as const,status:'ACTIVE' as const,version:1,idempotencyKey:'partial:next',expiresAt:new Date(now.getTime()+30*60_000).toISOString(),activatedAt:now.toISOString(),settledAt:null,createdAt:now.toISOString(),updatedAt:now.toISOString()};
    await store.commitSubmit({order:submitted,expectedVersion:1,ledgerBalanceMinor:13_000,reservation,
      reservationEvent:{id:'00000000-0000-0000-0000-00000000b019',fundReservationId:nextReservationId,sequence:1,eventType:'CREATED',fromStatus:null,toStatus:'ACTIVE',amountMinor:6000,
        reservationVersion:1,idempotencyKey:'partial:next:created',actorUserId:userId,actorStaffId:null,actorSource:'DISCORD_BOT',reasonCode:null,createdAt:now.toISOString()},
      orderEvent:{id:'00000000-0000-0000-0000-00000000b020',orderId:nextOrderId,sequence:1,eventType:'SUBMITTED',fromStatus:'DRAFT',toStatus:'PENDING_DISPATCH',actorUserId:userId,
        actorStaffId:null,actorSource:'DISCORD_BOT',interactionId:'120000000000000013',payload:{},createdAt:now.toISOString()},externalTransactions:[],
      auditRecord:{...auditRecord('SUBMIT_PARTIAL_ORDER','order.submit'),id:'00000000-0000-0000-0000-00000000b021',targetId:nextOrderId},auditSink:new InMemoryAuditSink()});
    await expect(store.findById(nextOrderId)).resolves.toMatchObject({status:'PENDING_DISPATCH',version:2});
    const reserved=await pool.query(`SELECT sum(GREATEST(fr.amount_minor-COALESCE(events.settled,0),0))::int total FROM fund_reservations fr
      LEFT JOIN LATERAL(SELECT sum(amount_minor) settled FROM fund_reservation_events WHERE fund_reservation_id=fr.id AND event_type IN ('CAPTURED','RELEASED','EXPIRED'))events ON true WHERE fr.user_id=$1 AND fr.status IN('ACTIVE','PARTIALLY_SETTLED')`,[userId]);
    expect(reserved.rows[0]?.total).toBe(13_000);
  });
});

async function seedCustomerAndCatalog(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a001', 'mock-***-ok', now()),
  ('00000000-0000-0000-0000-000000000033', 'Ops Staff', now());

INSERT INTO staff_accounts (id, user_id, level, role_source, mfa_enrolled, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000333',
  '00000000-0000-0000-0000-000000000033',
  'L3_OPERATIONS',
  'BOOTSTRAP',
  true,
  now()
);

INSERT INTO service_offerings (id, code, game_code, game_name, service_code, service_name, region_code, updated_at)
VALUES (
  '00000000-0000-0000-0000-00000000c100',
  'VALORANT|ENTERTAINMENT|NA',
  'VALORANT',
  'VALORANT',
  'ENTERTAINMENT',
  'ENTERTAINMENT',
  'NA',
  now()
);

INSERT INTO service_catalog_versions (
  id, service_offering_id, version, status, active_offering_key,
  billing_unit_minutes, minimum_units, customer_unit_price_minor, player_unit_payout_minor,
  currency, created_by_staff_id, activated_at, created_at
)
VALUES (
  '00000000-0000-0000-0000-00000000c001',
  '00000000-0000-0000-0000-00000000c100',
  3,
  'ACTIVE',
  '00000000-0000-0000-0000-00000000c100',
  60,
  1,
  6000,
  4200,
  'CAT',
  '00000000-0000-0000-0000-000000000333',
  now(),
  now()
);
  `);
}

function draftOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: '00000000-0000-0000-0000-00000000b001',
    publicId: 'P-M1-ORD-1',
    customerId: '00000000-0000-0000-0000-00000000a001',
    playerId: null,
    status: 'DRAFT',
    version: 1,
    serviceCatalogId: null,
    catalogVersion: null,
    game: null,
    service: null,
    region: null,
    billingUnitMinutes: null,
    unitCount: null,
    customerUnitPriceMinor: null,
    playerUnitPayoutMinor: null,
    amountMinor: 0,
    playerEarningMinor: 0,
    currency: 'CAT',
    notes: null,
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: null
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function orderEvent(overrides: Partial<OrderEventRecord>): OrderEventRecord {
  return {
    id: crypto.randomUUID(),
    orderId: '00000000-0000-0000-0000-00000000b001',
    sequence: 1,
    eventType: 'CREATED',
    fromStatus: null,
    toStatus: 'DRAFT',
    actorUserId: null,
    actorStaffId: null,
    actorSource: 'DISCORD_BOT',
    interactionId: '777777777777777777',
    payload: {},
    createdAt: now.toISOString(),
    ...overrides
  };
}

function auditRecord(action: string, permissionCode: string): AuditRecord {
  return {
    id: crypto.randomUUID(),
    actorId: null,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT',
    interactionId: '777777777777777777',
    permissionCode,
    action,
    targetType: 'order',
    targetId: '00000000-0000-0000-0000-00000000b001',
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: `req_${permissionCode}`,
    approvalRequestId: null,
    occurredAt: now.toISOString()
  };
}
