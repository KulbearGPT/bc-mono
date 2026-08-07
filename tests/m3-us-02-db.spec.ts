import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresGiftStore, captureApprovedGift, terminateGiftRequest } from '@blackcat/api/gifts';
import { PostgresDomainApprovalStore } from '@blackcat/api/approvals';
import { PostgresAdminOrderActionStore } from '@blackcat/api/admin-order-actions';
import { InMemoryAuditSink, insertPostgresAuditRecord, type AuditRecord } from '@blackcat/api/security';
import { applyCurrentMigrations } from './support/postgres-migrations';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T13:00:00.000Z');
const customerId = '00000000-0000-0000-0000-000000003501';
const playerId = '00000000-0000-0000-0000-000000003502';
const staffId = '00000000-0000-0000-0000-000000003503';
const orderId = '00000000-0000-0000-0000-000000003504';
const giftId = '00000000-0000-0000-0000-000000003505';
const reservationId = '00000000-0000-0000-0000-000000003506';
const taskId = '00000000-0000-0000-0000-000000003507';
const releaseGiftId = '00000000-0000-0000-0000-000000003515';
const releaseReservationId = '00000000-0000-0000-0000-000000003516';
const rollbackGiftId = '00000000-0000-0000-0000-000000003525';
const rollbackReservationId = '00000000-0000-0000-0000-000000003526';
const rollbackTaskId = '00000000-0000-0000-0000-000000003527';
const rejectGiftId = '00000000-0000-0000-0000-000000003535';
const rejectReservationId = '00000000-0000-0000-0000-000000003536';
const rejectTaskId = '00000000-0000-0000-0000-000000003537';
let root = '';
let data = '';
let port = 0;
let pool: Pool;

describe('M3-US-02 PostgreSQL gift review authorization', () => {
  beforeAll(async () => {
    port = 60_700 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m3-gift-review-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m3_gift_review']);
    await applyCurrentMigrations({ host: root, port, database: 'blackcat_m3_gift_review' });
    pool = new Pool({ host: root, port, database: 'blackcat_m3_gift_review' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('persists verification credential then creates immutable L3 escalation at 200100', async () => {
    const store = new PostgresGiftStore(pool);
    const verified = await store.verifyTask({ taskId, expectedVersion: 2, actorStaffId: staffId,
      verificationMethod: 'DIRECT_MESSAGE', notes: 'Confirmed gift, target, amount and intent.', now });
    expect(verified.executionCredential.payloadHash).toMatch(/^[a-f0-9]{64}$/);

    const result = await store.authorizeGift({ giftRequestId: giftId, expectedVersion: 2, actorStaffId: staffId,
      actorLevel: 'L2_SUPERVISOR', reason: 'Verified high-value gift.', now });
    expect(result).toMatchObject({ code: 'APPROVAL_PENDING', requiredLevel: 'L3_OPERATIONS', actionExecuted: false });
    const persisted = await pool.query(`SELECT gr.status, gr.row_version, gr.verification_payload_hash,
      st.status AS task_status, ar.action, ar.required_level, ar.payload_hash
      FROM gift_requests gr JOIN staff_tasks st ON st.gift_request_id = gr.id
      JOIN approval_requests ar ON ar.target_id = gr.id WHERE gr.id = $1`, [giftId]);
    expect(persisted.rows[0]).toMatchObject({ status: 'PENDING_APPROVAL', row_version: 3, task_status: 'PENDING_APPROVAL',
      action: 'GIFT_APPROVE', required_level: 'L3_OPERATIONS', verification_payload_hash: expect.any(String), payload_hash: expect.any(String) });
    await expect(store.authorizeGift({ giftRequestId: giftId, expectedVersion: 2, actorStaffId: staffId,
      actorLevel: 'L3_OPERATIONS', reason: 'Stale retry.', now })).rejects.toThrowError(expect.objectContaining({ code: 'EXECUTION_CREDENTIAL_STALE' }));

    const approvalRow=await pool.query<{id:string}>(`SELECT id FROM approval_requests WHERE target_id=$1 AND status='PENDING'`,[giftId]);
    const approvals=new PostgresDomainApprovalStore(pool,{orderStore:new PostgresAdminOrderActionStore({pool}),giftStore:store,giftBroadcastChannelId:'900000000000000020'});
    const staged=await approvals.stageApprove({approvalRequestId:approvalRow.rows[0]!.id,expectedVersion:1,reason:'IMPACT_REVIEWED',now,
      actor:{actorUserId:staffId,actorStaffId:staffId,actorLevel:'L3_OPERATIONS',actorSource:'DASHBOARD',clientId:'TEST',guildId:'900000000000000001',discordUserId:null,interactionId:null,permissionsVersion:1}});
    const approvalAudit:AuditRecord={id:'00000000-0000-0000-0000-000000003598',actorId:staffId,actorStaffId:staffId,actorLevel:'L3_OPERATIONS',actorSource:'DASHBOARD',clientId:'TEST',interactionId:null,permissionCode:'approval.approve',action:'APPROVE_APPROVAL_REQUEST',targetType:'approval_request',targetId:approvalRow.rows[0]!.id,outcome:'SUCCEEDED',reason:'IMPACT_REVIEWED',requestId:'req_gift_generic_approval',idempotencyKey:'gift:generic:approval',approvalRequestId:null,occurredAt:now.toISOString()};
    await staged.commit(approvalAudit);
    expect(staged.data).toMatchObject({status:'APPROVED',actionExecuted:true,resultType:'GIFT_REQUEST',resultId:giftId});
    const captured = await store.findCapture(giftId);
    expect(captured).not.toBeNull();
    const replay = await captureApprovedGift({ store,
      broadcastChannelId: '900000000000000020', giftRequestId: giftId, actorStaffId: staffId, now });
    expect(replay).toEqual(captured);
    const facts = await pool.query(`SELECT gr.status AS gift_status, fr.status AS reservation_status,
      count(DISTINCT tx.id)::int AS transaction_count, count(DISTINCT ce.id)::int AS consumption_count,
      count(DISTINCT oe.id)::int AS outbox_count
      FROM gift_requests gr JOIN fund_reservations fr ON fr.gift_request_id = gr.id
      LEFT JOIN external_transactions tx ON tx.gift_request_id = gr.id
      LEFT JOIN consumption_entries ce ON ce.gift_request_id = gr.id
      LEFT JOIN outbox_events oe ON oe.gift_request_id = gr.id
      WHERE gr.id = $1 GROUP BY gr.status, fr.status`, [giftId]);
    expect(facts.rows[0]).toEqual({ gift_status: 'CAPTURED', reservation_status: 'CAPTURED',
      transaction_count: 1, consumption_count: 1, outbox_count: 1 });
  });

  test('atomically releases a pending gift without creating financial side effects', async () => {
    const store=new PostgresGiftStore(pool);const released=await terminateGiftRequest({store,giftRequestId:releaseGiftId,
      expectedVersion:1,terminalStatus:'WITHDRAWN',reason:'CUSTOMER_WITHDREW_REQUEST',actorUserId:customerId,now});
    const replay=await terminateGiftRequest({store,giftRequestId:releaseGiftId,expectedVersion:1,terminalStatus:'WITHDRAWN',
      reason:'CUSTOMER_WITHDREW_REQUEST',actorUserId:customerId,now});expect(replay).toEqual(released);
    const facts=await pool.query(`SELECT gr.status AS gift_status,fr.status AS reservation_status,fr.row_version,
      (SELECT count(*)::int FROM fund_reservation_events WHERE fund_reservation_id=fr.id) AS event_count,
      (SELECT count(*)::int FROM external_transactions WHERE gift_request_id=gr.id) AS charge_count,
      (SELECT count(*)::int FROM consumption_entries WHERE gift_request_id=gr.id) AS consumption_count,
      (SELECT count(*)::int FROM outbox_events WHERE gift_request_id=gr.id) AS outbox_count
      FROM gift_requests gr JOIN fund_reservations fr ON fr.gift_request_id=gr.id WHERE gr.id=$1`,[releaseGiftId]);
    expect(facts.rows[0]).toEqual({gift_status:'WITHDRAWN',reservation_status:'RELEASED',row_version:3,event_count:3,charge_count:0,consumption_count:0,outbox_count:0});
  });

  test('generic rejection atomically rejects the approval and gift while releasing the reservation', async () => {
    const store=new PostgresGiftStore(pool);
    await store.verifyTask({taskId:rejectTaskId,expectedVersion:2,actorStaffId:staffId,verificationMethod:'DIRECT_MESSAGE',notes:'Confirmed rejection fixture.',now});
    await store.authorizeGift({giftRequestId:rejectGiftId,expectedVersion:2,actorStaffId:staffId,actorLevel:'L2_SUPERVISOR',reason:'Escalate before rejection.',now});
    const approval=await pool.query<{id:string}>(`SELECT id FROM approval_requests WHERE target_id=$1 AND status='PENDING'`,[rejectGiftId]);
    const approvals=new PostgresDomainApprovalStore(pool,{orderStore:new PostgresAdminOrderActionStore({pool}),giftStore:store,giftBroadcastChannelId:'900000000000000020'});
    const staged=await approvals.stageReject({approvalRequestId:approval.rows[0]!.id,expectedVersion:1,reason:'REQUEST_REJECTED: recipient eligibility failed.',now,
      actor:{actorUserId:staffId,actorStaffId:staffId,actorLevel:'L3_OPERATIONS',actorSource:'DASHBOARD',clientId:'TEST',guildId:'900000000000000001',discordUserId:null,interactionId:null,permissionsVersion:1}});
    await staged.commit({id:'00000000-0000-0000-0000-000000003597',actorId:staffId,actorStaffId:staffId,actorLevel:'L3_OPERATIONS',actorSource:'DASHBOARD',clientId:'TEST',interactionId:null,permissionCode:'approval.reject',action:'REJECT_APPROVAL_REQUEST',targetType:'approval_request',targetId:approval.rows[0]!.id,outcome:'SUCCEEDED',reason:'REQUEST_REJECTED',requestId:'req_gift_generic_rejection',idempotencyKey:'gift:generic:rejection',approvalRequestId:null,occurredAt:now.toISOString()});
    const facts=await pool.query(`SELECT gr.status AS gift_status,fr.status AS reservation_status,
      ar.status AS approval_status,ar.row_version AS approval_version,
      (SELECT count(*)::int FROM approval_decisions WHERE approval_request_id=ar.id) AS decision_count,
      (SELECT count(*)::int FROM external_transactions WHERE gift_request_id=gr.id) AS charge_count,
      (SELECT count(*)::int FROM consumption_entries WHERE gift_request_id=gr.id) AS consumption_count
      FROM gift_requests gr JOIN fund_reservations fr ON fr.gift_request_id=gr.id
      JOIN approval_requests ar ON ar.target_id=gr.id WHERE gr.id=$1`,[rejectGiftId]);
    expect(facts.rows[0]).toEqual({gift_status:'REJECTED',reservation_status:'RELEASED',approval_status:'REJECTED',approval_version:2,decision_count:1,charge_count:0,consumption_count:0});
  });

  test('rolls back authorization, capture, wallet facts, and outbox when the audit insert fails', async () => {
    const store=new PostgresGiftStore(pool);
    await store.verifyTask({taskId:rollbackTaskId,expectedVersion:2,actorStaffId:staffId,
      verificationMethod:'DIRECT_MESSAGE',notes:'Confirmed rollback fixture.',now});
    const audit:AuditRecord={id:'00000000-0000-0000-0000-000000003599',actorId:staffId,actorStaffId:staffId,
      actorLevel:'L2_SUPERVISOR',actorSource:'DASHBOARD',clientId:'TEST',interactionId:null,
      permissionCode:'gift.approve',action:'AUTHORIZE_GIFT_REQUEST',targetType:'gift_request',targetId:rollbackGiftId,
      outcome:'SUCCEEDED',reason:null,requestId:'req_gift_atomic_rollback',idempotencyKey:'gift:atomic:rollback',
      approvalRequestId:null,occurredAt:now.toISOString()};
    await insertPostgresAuditRecord(pool,audit);
    await expect(store.commitApprovalDecision({giftRequestId:rollbackGiftId,expectedVersion:2,actorStaffId:staffId,
      actorLevel:'L2_SUPERVISOR',reason:'Verified request.',broadcastChannelId:'900000000000000020',now,
      auditRecord:audit,auditSink:new InMemoryAuditSink()})).rejects.toMatchObject({code:'23505'});
    const facts=await pool.query(`SELECT gr.status AS gift_status,gr.row_version,fr.status AS reservation_status,fr.row_version AS reservation_version,
      (SELECT count(*)::int FROM wallet_entries WHERE source_id=fr.id) AS wallet_entry_count,
      (SELECT count(*)::int FROM external_transactions WHERE gift_request_id=gr.id) AS charge_count,
      (SELECT count(*)::int FROM consumption_entries WHERE gift_request_id=gr.id) AS consumption_count,
      (SELECT count(*)::int FROM outbox_events WHERE gift_request_id=gr.id) AS outbox_count
      FROM gift_requests gr JOIN fund_reservations fr ON fr.gift_request_id=gr.id WHERE gr.id=$1`,[rollbackGiftId]);
    expect(facts.rows[0]).toEqual({gift_status:'PENDING_REVIEW',row_version:2,reservation_status:'ACTIVE',reservation_version:2,
      wallet_entry_count:0,charge_count:0,consumption_count:0,outbox_count:0});
  });
});

async function seed() {
  const itemId = '00000000-0000-0000-0000-000000003508';
  const versionId = '00000000-0000-0000-0000-000000003509';
  await pool.query(`
INSERT INTO users (id, display_name, status, row_version, created_at, updated_at) VALUES
('${customerId}', 'Customer', 'ACTIVE', 1, now(), now()), ('${playerId}', 'Player', 'ACTIVE', 1, now(), now()),
('${staffId}', 'Supervisor', 'ACTIVE', 1, now(), now());
INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-000000003520','${customerId}','CAT','ACTIVE',1,now(),now());
INSERT INTO wallet_entries (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
VALUES ('00000000-0000-0000-0000-000000003521','00000000-0000-0000-0000-000000003520','TOP_UP_CREDIT','CREDIT',500000,'CAT','TOP_UP','00000000-0000-0000-0000-000000003522','seed:wallet:3501',now(),now());
INSERT INTO external_accounts (id,user_id,provider,external_user_id,status,active_user_provider_key,verified_at,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-000000003512','${customerId}','mock-provider','mock-user-ok','ACTIVE','${customerId}:mock-provider',now(),now(),now());
INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
VALUES ('${staffId}','${staffId}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
INSERT INTO orders (id,public_id,customer_id,player_id,active_customer_slot_id,active_player_slot_id,status,row_version,
currency,amount_minor,guild_id,channel_id,panel_message_id,voice_channel_id,created_at,updated_at)
VALUES ('${orderId}','P-3504','${customerId}','${playerId}','${customerId}','${playerId}','IN_SERVICE',7,
'CAT',12000,'900000000000000001','900000000000000003','900000000000000004','900000000000000005',now(),now());
INSERT INTO gift_catalog_items (id,code,created_at,updated_at) VALUES ('${itemId}','STAR',now(),now());
INSERT INTO gift_catalog_versions (id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at)
VALUES ('${versionId}','${itemId}',1,'ACTIVE','${itemId}','星光礼盒',200100,'CAT','{sender_name}','${staffId}',now(),now());
INSERT INTO gift_requests (id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,expires_at,created_at,updated_at)
VALUES ('${giftId}','G-3505','${orderId}','${versionId}','${customerId}','${playerId}','PENDING_REVIEW',1,'STAR','星光礼盒',200100,'CAT','{sender_name}',now()+interval '30 minutes',now(),now()),
('${releaseGiftId}','G-3515','${orderId}','${versionId}','${customerId}','${playerId}','PENDING_REVIEW',1,'STAR','星光礼盒',200100,'CAT','{sender_name}',now()+interval '30 minutes',now(),now());
UPDATE gift_catalog_versions SET price_minor=200000 WHERE id='${versionId}';
INSERT INTO gift_requests (id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,expires_at,created_at,updated_at)
VALUES ('${rollbackGiftId}','G-3525','${orderId}','${versionId}','${customerId}','${playerId}','PENDING_REVIEW',1,'STAR','星光礼盒',200000,'CAT','{sender_name}',now()+interval '30 minutes',now(),now());
INSERT INTO gift_requests (id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,expires_at,created_at,updated_at)
VALUES ('${rejectGiftId}','G-3535','${orderId}','${versionId}','${customerId}','${playerId}','PENDING_REVIEW',1,'STAR','星光礼盒',200100,'CAT','{sender_name}',now()+interval '30 minutes',now(),now());
UPDATE gift_catalog_versions SET price_minor=200100 WHERE id='${versionId}';
INSERT INTO fund_reservations (id,user_id,source_type,gift_request_id,mode,provider,amount_minor,currency,status,row_version,idempotency_key,expires_at,created_at,updated_at)
VALUES ('${reservationId}','${customerId}','GIFT','${giftId}','LOCAL_RESERVATION','mock-provider',200100,'CAT','PENDING',1,'gift:3505',now()+interval '30 minutes',now(),now()),
('${releaseReservationId}','${customerId}','GIFT','${releaseGiftId}','LOCAL_RESERVATION','mock-provider',200100,'CAT','PENDING',1,'gift:3515',now()+interval '30 minutes',now(),now());
INSERT INTO fund_reservations (id,user_id,source_type,gift_request_id,mode,provider,amount_minor,currency,status,row_version,idempotency_key,expires_at,created_at,updated_at)
VALUES ('${rollbackReservationId}','${customerId}','GIFT','${rollbackGiftId}','LOCAL_RESERVATION','mock-provider',200000,'CAT','PENDING',1,'gift:3525',now()+interval '30 minutes',now(),now());
INSERT INTO fund_reservations (id,user_id,source_type,gift_request_id,mode,provider,amount_minor,currency,status,row_version,idempotency_key,expires_at,created_at,updated_at)
VALUES ('${rejectReservationId}','${customerId}','GIFT','${rejectGiftId}','LOCAL_RESERVATION','mock-provider',200100,'CAT','PENDING',1,'gift:3535',now()+interval '30 minutes',now(),now());
INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_source,created_at)
VALUES ('00000000-0000-0000-0000-000000003510','${reservationId}',1,'CREATED',NULL,'PENDING',200100,1,'gift:3505:created','${customerId}','DISCORD_BOT',now());
INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_source,created_at)
VALUES ('00000000-0000-0000-0000-000000003511','${reservationId}',2,'ACTIVATED','PENDING','ACTIVE',0,2,'gift:3505:activated','${customerId}','DISCORD_BOT',now());
INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_source,created_at) VALUES
('00000000-0000-0000-0000-000000003517','${releaseReservationId}',1,'CREATED',NULL,'PENDING',200100,1,'gift:3515:created','${customerId}','DISCORD_BOT',now()),
('00000000-0000-0000-0000-000000003518','${releaseReservationId}',2,'ACTIVATED','PENDING','ACTIVE',0,2,'gift:3515:activated','${customerId}','DISCORD_BOT',now());
INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_source,created_at) VALUES
('00000000-0000-0000-0000-000000003528','${rollbackReservationId}',1,'CREATED',NULL,'PENDING',200000,1,'gift:3525:created','${customerId}','DISCORD_BOT',now()),
('00000000-0000-0000-0000-000000003529','${rollbackReservationId}',2,'ACTIVATED','PENDING','ACTIVE',0,2,'gift:3525:activated','${customerId}','DISCORD_BOT',now());
INSERT INTO fund_reservation_events (id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_user_id,actor_source,created_at) VALUES
('00000000-0000-0000-0000-000000003538','${rejectReservationId}',1,'CREATED',NULL,'PENDING',200100,1,'gift:3535:created','${customerId}','DISCORD_BOT',now()),
('00000000-0000-0000-0000-000000003539','${rejectReservationId}',2,'ACTIVATED','PENDING','ACTIVE',0,2,'gift:3535:activated','${customerId}','DISCORD_BOT',now());
INSERT INTO staff_tasks (id,public_id,type,reason_code,status,row_version,order_id,gift_request_id,claimed_by_staff_id,voice_channel_id,context_snapshot,claimed_at,created_at,updated_at)
VALUES ('${taskId}','T-GIFT-3507','GIFT_REVIEW','GIFT_REQUESTED','CLAIMED',2,'${orderId}','${giftId}','${staffId}','900000000000000005',
'{"orderId":"${orderId}","reservationId":"${reservationId}"}'::jsonb,now(),now(),now());
INSERT INTO staff_tasks (id,public_id,type,reason_code,status,row_version,order_id,gift_request_id,voice_channel_id,context_snapshot,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-000000003519','T-GIFT-3519','GIFT_REVIEW','GIFT_REQUESTED','OPEN',1,'${orderId}','${releaseGiftId}','900000000000000005',
'{"orderId":"${orderId}","reservationId":"${releaseReservationId}"}'::jsonb,now(),now());
INSERT INTO staff_tasks (id,public_id,type,reason_code,status,row_version,order_id,gift_request_id,claimed_by_staff_id,voice_channel_id,context_snapshot,claimed_at,created_at,updated_at)
VALUES ('${rollbackTaskId}','T-GIFT-3527','GIFT_REVIEW','GIFT_REQUESTED','CLAIMED',2,'${orderId}','${rollbackGiftId}','${staffId}','900000000000000005',
'{"orderId":"${orderId}","reservationId":"${rollbackReservationId}"}'::jsonb,now(),now(),now());
INSERT INTO staff_tasks (id,public_id,type,reason_code,status,row_version,order_id,gift_request_id,claimed_by_staff_id,voice_channel_id,context_snapshot,claimed_at,created_at,updated_at)
VALUES ('${rejectTaskId}','T-GIFT-3537','GIFT_REVIEW','GIFT_REQUESTED','CLAIMED',2,'${orderId}','${rejectGiftId}','${staffId}','900000000000000005',
'{"orderId":"${orderId}","reservationId":"${rejectReservationId}"}'::jsonb,now(),now(),now());`);
}
