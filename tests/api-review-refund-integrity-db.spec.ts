import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import { PostgresAdminOrderActionStore, refundOrder } from '@blackcat/api/admin-order-actions';
import { PostgresDomainApprovalStore } from '@blackcat/api/approvals';
import { PostgresGiftStore } from '@blackcat/api/gifts';
import type { AuditRecord, ActorContext } from '@blackcat/api/security';
import { startIsolatedPostgres, type IsolatedPostgres } from './support/isolated-postgres';

const customerId = '00000000-0000-0000-0000-000000020001';
const playerId = '00000000-0000-0000-0000-000000020002';
const staffUserId = '00000000-0000-0000-0000-000000020003';
const staffId = '00000000-0000-0000-0000-000000020004';
const orderId = '00000000-0000-0000-0000-000000020005';
const chargeId = '00000000-0000-0000-0000-000000020006';
const walletId = '00000000-0000-0000-0000-000000020007';
const approvalId = '00000000-0000-0000-0000-000000020020';
const now = new Date('2026-08-12T15:00:00.000Z');
let isolated: IsolatedPostgres;
let pool: Pool;

const actor: ActorContext = {
  actorUserId: staffUserId,
  actorStaffId: staffId,
  actorLevel: 'L4_ADMIN_OWNER',
  actorSource: 'DASHBOARD',
  clientId: 'DASHBOARD',
  interactionId: null,
  guildId: '900000000000020001',
  discordUserId: null,
  permissionsVersion: 1
};

describe('API review standalone refund integrity', () => {
  beforeAll(async () => {
    isolated = await startIsolatedPostgres('a4_refund_integrity');
    pool = isolated.pool;
  }, 45_000);

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE users CASCADE');
    await pool.query(
      `INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ($1,'Customer','ACTIVE',1,$4,$4),($2,'Player','ACTIVE',1,$4,$4),($3,'Staff','ACTIVE',1,$4,$4)`,
      [customerId, playerId, staffUserId, now]
    );
    await pool.query(
      `INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES ($1,$2,'L4_ADMIN_OWNER','ACTIVE','MANUAL',1,$3,$3)`,
      [staffId, staffUserId, now]
    );
    await pool.query(
      `INSERT INTO orders
      (id,public_id,customer_id,player_id,status,row_version,billing_unit_minutes,unit_count,customer_unit_price_minor,
       player_unit_payout_minor,amount_minor,expected_player_earning_minor,currency,guild_id,completed_at,created_at,updated_at)
      VALUES ($1,'P-REFUND-INTEGRITY',$2,$3,'COMPLETED',9,60,1,200000,0,200000,0,'CAT',$4,$5,$5,$5)`,
      [orderId, customerId, playerId, actor.guildId, now]
    );
    await pool.query(
      `INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
      VALUES ($1,$2,'CAT','ACTIVE',1,$3,$3)`,
      [walletId, customerId, now]
    );
    await pool.query(
      `INSERT INTO external_transactions
      (id,provider,type,user_id,order_id,external_ref,idempotency_key,amount_minor,currency,status,initiated_at,settled_at,created_at,updated_at)
      VALUES ($1,'INTERNAL_WALLET','ORDER_CHARGE',$2,$3,'charge-refund-integrity','charge:refund-integrity',200000,'CAT','SUCCEEDED',$4,$4,$4,$4)`,
      [chargeId, customerId, orderId, now]
    );
    await pool.query(
      `INSERT INTO consumption_entries
      (id,user_id,entry_type,direction,order_id,external_transaction_id,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES ('00000000-0000-0000-0000-000000020008',$1,'ORDER_CHARGE','DEBIT',$2,$3,200000,'CAT','ORDER',$2,'consumption:refund-integrity',$4,$4)`,
      [customerId, orderId, chargeId, now]
    );
  });

  afterAll(async () => isolated.stop());

  test('serializes different idempotency keys and never credits more than the captured charge', async () => {
    const store = new PostgresAdminOrderActionStore({ pool });
    const first = await stage(store, 120_000, 'refund:integrity:first');
    const second = await stage(store, 100_000, 'refund:integrity:second');
    const results = await Promise.allSettled([
      first.commit(audit('00000000-0000-0000-0000-000000020011', 'refund:integrity:first')),
      second.commit(audit('00000000-0000-0000-0000-000000020012', 'refund:integrity:second'))
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const facts = await pool.query(`SELECT
      COALESCE((SELECT SUM(amount_minor) FROM refunds WHERE status='SUCCEEDED'),0)::int refunded,
      COALESCE((SELECT SUM(amount_minor) FROM wallet_entries WHERE entry_type='ORDER_REFUND_CREDIT'),0)::int credited,
      (SELECT count(*) FROM refunds)::int refund_count,
      (SELECT count(*) FROM audit_logs)::int audit_count`);
    expect(facts.rows[0].refunded).toBeLessThanOrEqual(200_000);
    expect(facts.rows[0]).toMatchObject({ credited: facts.rows[0].refunded, refund_count: 1, audit_count: 1 });
  });

  test('approves the immutable refund snapshot and commits decision, refund, wallet credit, and audit atomically', async () => {
    await insertRefundApproval(approvalId);
    const store = new PostgresDomainApprovalStore(pool, {
      orderStore: new PostgresAdminOrderActionStore({ pool }),
      giftStore: new PostgresGiftStore(pool),
      giftBroadcastChannelId: '900000000000020099'
    });
    const visible = await store.list({
      guildId: actor.guildId!,
      actorLevel: 'L4_ADMIN_OWNER',
      status: 'PENDING',
      cursor: null,
      limit: 10
    });
    expect(visible.items).toContainEqual(expect.objectContaining({ id: approvalId, amountMinor: 50_100 }));
    expect(visible.items.find((item) => item.id === approvalId)).not.toHaveProperty('payloadSnapshot');
    expect(
      await store.get({ approvalRequestId: approvalId, guildId: actor.guildId!, actorLevel: 'L4_ADMIN_OWNER' })
    ).not.toHaveProperty('guildId');
    const staged = await store.stageApprove({
      approvalRequestId: approvalId,
      expectedVersion: 1,
      reason: 'IMPACT_REVIEWED: source charge and wallet beneficiary verified.',
      actor,
      now
    });

    expect(staged.data).toMatchObject({ approvalRequestId: approvalId, status: 'APPROVED', resultType: 'REFUND' });
    await staged.commit(audit('00000000-0000-0000-0000-000000020021', `approval:${approvalId}:refund`));

    const facts = await pool.query(
      `SELECT
      (SELECT status::text FROM approval_requests WHERE id=$1) approval_status,
      (SELECT row_version FROM approval_requests WHERE id=$1) approval_version,
      (SELECT count(*)::int FROM approval_decisions WHERE approval_request_id=$1) decision_count,
      (SELECT approval_request_id::text FROM refunds WHERE order_id=$2) refund_approval_id,
      (SELECT amount_minor::int FROM refunds WHERE order_id=$2) refunded,
      (SELECT COALESCE(SUM(amount_minor),0)::int FROM wallet_entries WHERE entry_type='ORDER_REFUND_CREDIT') credited,
      (SELECT approval_request_id::text FROM audit_logs WHERE id=$3) audit_approval_id`,
      [approvalId, orderId, '00000000-0000-0000-0000-000000020021']
    );
    expect(facts.rows[0]).toMatchObject({
      approval_status: 'APPROVED',
      approval_version: 2,
      decision_count: 1,
      refund_approval_id: approvalId,
      refunded: 50_100,
      credited: 50_100,
      audit_approval_id: approvalId
    });
  });

  test('rolls back the approval decision and all refund facts when the success audit cannot be appended', async () => {
    await insertRefundApproval(approvalId);
    const duplicateAuditId = '00000000-0000-0000-0000-000000020022';
    await pool.query(
      `INSERT INTO audit_logs
      (id,actor_user_id,actor_staff_id,actor_level,actor_source,client_id,permission_code,action,target_type,target_id,outcome,reason,request_id,created_at)
      VALUES ($1,$2,$3,'L4_ADMIN_OWNER','DASHBOARD','DASHBOARD','test.seed','SEED_AUDIT','order',$4,'SUCCEEDED','seed','seed:audit',$5)`,
      [duplicateAuditId, staffUserId, staffId, orderId, now]
    );
    const store = new PostgresDomainApprovalStore(pool, {
      orderStore: new PostgresAdminOrderActionStore({ pool }),
      giftStore: new PostgresGiftStore(pool),
      giftBroadcastChannelId: '900000000000020099'
    });
    const staged = await store.stageApprove({
      approvalRequestId: approvalId,
      expectedVersion: 1,
      reason: 'IMPACT_REVIEWED',
      actor,
      now
    });

    await expect(staged.commit(audit(duplicateAuditId, `approval:${approvalId}:refund`))).rejects.toBeTruthy();
    const facts = await pool.query(
      `SELECT
      (SELECT status::text FROM approval_requests WHERE id=$1) approval_status,
      (SELECT row_version FROM approval_requests WHERE id=$1) approval_version,
      (SELECT count(*)::int FROM approval_decisions WHERE approval_request_id=$1) decision_count,
      (SELECT count(*)::int FROM refunds WHERE order_id=$2) refund_count,
      (SELECT count(*)::int FROM wallet_entries WHERE entry_type='ORDER_REFUND_CREDIT') credit_count`,
      [approvalId, orderId]
    );
    expect(facts.rows[0]).toMatchObject({
      approval_status: 'PENDING',
      approval_version: 1,
      decision_count: 0,
      refund_count: 0,
      credit_count: 0
    });
  });

  test('cancels a superseded pending snapshot when a higher-level actor uses the compatible direct refund route', async () => {
    await insertRefundApproval(approvalId);
    const staged = await stage(new PostgresAdminOrderActionStore({ pool }), 40_000, 'refund:direct:supersedes-pending');
    await staged.commit(audit('00000000-0000-0000-0000-000000020023', 'refund:direct:supersedes-pending'));

    const facts = await pool.query(
      `SELECT
      (SELECT status::text FROM approval_requests WHERE id=$1) approval_status,
      (SELECT row_version FROM approval_requests WHERE id=$1) approval_version,
      (SELECT count(*)::int FROM approval_decisions WHERE approval_request_id=$1) decision_count,
      (SELECT approval_request_id FROM refunds WHERE order_id=$2) refund_approval_id`,
      [approvalId, orderId]
    );
    expect(facts.rows[0]).toMatchObject({
      approval_status: 'CANCELLED',
      approval_version: 2,
      decision_count: 0,
      refund_approval_id: null
    });
  });

  test('generically approves an immutable order resolution and links every resulting fact', async () => {
    await pool.query(
      `UPDATE orders SET status='EXCEPTION',active_customer_slot_id=customer_id,active_player_slot_id=player_id WHERE id=$1`,
      [orderId]
    );
    await insertResolutionApproval(approvalId);
    const approvals = new PostgresDomainApprovalStore(pool, {
      orderStore: new PostgresAdminOrderActionStore({ pool }),
      giftStore: new PostgresGiftStore(pool),
      giftBroadcastChannelId: '900000000000020099'
    });
    const staged = await approvals.stageApprove({
      approvalRequestId: approvalId,
      expectedVersion: 1,
      reason: 'IMPACT_REVIEWED',
      actor,
      now
    });
    expect(staged.data).toMatchObject({ approvalRequestId: approvalId, resultType: 'ORDER_RESOLUTION' });
    await staged.commit(audit('00000000-0000-0000-0000-000000020024', `approval:${approvalId}:resolution`));

    const facts = await pool.query(
      `SELECT
      (SELECT status::text FROM approval_requests WHERE id=$1) approval_status,
      (SELECT count(*)::int FROM approval_decisions WHERE approval_request_id=$1) decision_count,
      (SELECT status::text FROM orders WHERE id=$2) order_status,
      (SELECT row_version FROM orders WHERE id=$2) order_version,
      (SELECT approval_request_id::text FROM order_resolutions WHERE order_id=$2) resolution_approval_id,
      (SELECT approval_request_id::text FROM refunds WHERE order_id=$2) refund_approval_id,
      (SELECT COALESCE(SUM(amount_minor),0)::int FROM wallet_entries WHERE entry_type='ORDER_REFUND_CREDIT') credited,
      (SELECT approval_request_id::text FROM audit_logs WHERE id=$3) audit_approval_id`,
      [approvalId, orderId, '00000000-0000-0000-0000-000000020024']
    );
    expect(facts.rows[0]).toMatchObject({
      approval_status: 'APPROVED',
      decision_count: 1,
      order_status: 'CANCELLED',
      order_version: 10,
      resolution_approval_id: approvalId,
      refund_approval_id: approvalId,
      credited: 50_100,
      audit_approval_id: approvalId
    });
  });

  test('rejects an order approval after verifying its immutable payload without creating domain facts', async () => {
    await insertRefundApproval(approvalId);
    const approvals = new PostgresDomainApprovalStore(pool, {
      orderStore: new PostgresAdminOrderActionStore({ pool }),
      giftStore: new PostgresGiftStore(pool),
      giftBroadcastChannelId: '900000000000020099'
    });
    const staged = await approvals.stageReject({
      approvalRequestId: approvalId,
      expectedVersion: 1,
      reason: 'REQUEST_REJECTED',
      actor,
      now
    });
    await staged.commit(audit('00000000-0000-0000-0000-000000020025', 'approval:refund:reject'));
    const facts = await pool.query(
      `SELECT
      (SELECT status::text FROM approval_requests WHERE id=$1) approval_status,
      (SELECT count(*)::int FROM approval_decisions WHERE approval_request_id=$1 AND decision='REJECT') decision_count,
      (SELECT count(*)::int FROM refunds WHERE order_id=$2) refund_count,
      (SELECT approval_request_id::text FROM audit_logs WHERE id=$3) audit_approval_id`,
      [approvalId, orderId, '00000000-0000-0000-0000-000000020025']
    );
    expect(facts.rows[0]).toMatchObject({
      approval_status: 'REJECTED',
      decision_count: 1,
      refund_count: 0,
      audit_approval_id: approvalId
    });
  });
});

async function insertRefundApproval(id: string) {
  const payload = {
    expectedVersion: 9,
    amount: { amountMinor: 50_100, currency: 'CAT' },
    reasonCode: 'USER_REQUEST',
    evidenceNote: 'Verified generic approval refund.'
  };
  await pool.query(
    `INSERT INTO approval_requests
    (id,public_id,action,target_type,target_id,target_version,payload_snapshot,payload_hash,amount_minor,currency,
     requested_by_staff_id,required_level,status,row_version,reason,expires_at,created_at,updated_at)
    VALUES ($1,$2,'REFUND_EXECUTE','ORDER',$3,9,$4::jsonb,$5,50100,'CAT',$6,'L3_OPERATIONS','PENDING',1,
      'Refund exceeds the L2 direct execution threshold.',$7,$8,$8)`,
    [
      id,
      `APR-${id.slice(-6)}`,
      orderId,
      JSON.stringify(payload),
      stablePayloadHash(payload),
      staffId,
      new Date(now.getTime() + 60 * 60_000),
      now
    ]
  );
}

async function insertResolutionApproval(id: string) {
  const payload = {
    expectedVersion: 9,
    targetStatus: 'CANCELLED',
    refund: { amountMinor: 50_100, currency: 'CAT' },
    playerEarning: { amountMinor: 0, currency: 'CAT' },
    reasonCode: 'USER_REQUEST',
    evidenceNote: 'Verified generic order resolution.'
  };
  await pool.query(
    `INSERT INTO approval_requests
    (id,public_id,action,target_type,target_id,target_version,payload_snapshot,payload_hash,amount_minor,currency,
     requested_by_staff_id,required_level,status,row_version,reason,expires_at,created_at,updated_at)
    VALUES ($1,$2,'ORDER_RESOLVE','ORDER',$3,9,$4::jsonb,$5,50100,'CAT',$6,'L3_OPERATIONS','PENDING',1,
      'Resolution refund exceeds the L2 threshold.',$7,$8,$8)`,
    [
      id,
      `APR-R-${id.slice(-6)}`,
      orderId,
      JSON.stringify(payload),
      stablePayloadHash(payload),
      staffId,
      new Date(now.getTime() + 60 * 60_000),
      now
    ]
  );
}

function stablePayloadHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortPayload(value)))
    .digest('hex');
}

function sortPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPayload);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortPayload(item)])
    );
  return value;
}

async function stage(store: PostgresAdminOrderActionStore, amountMinor: number, idempotencyKey: string) {
  return refundOrder({
    orderStore: store,
    orderId,
    expectedVersion: 9,
    amount: { amountMinor, currency: 'CAT' },
    reasonCode: 'USER_REQUEST',
    evidenceNote: 'Verified standalone partial refund.',
    actor,
    staffLevel: 'L4_ADMIN_OWNER',
    idempotencyKey,
    now
  });
}

function audit(id: string, idempotencyKey: string): AuditRecord {
  return {
    id,
    actorId: staffUserId,
    actorStaffId: staffId,
    actorLevel: 'L4_ADMIN_OWNER',
    actorSource: 'DASHBOARD',
    clientId: 'DASHBOARD',
    interactionId: null,
    permissionCode: 'refund.execute',
    action: 'REFUND_ORDER',
    targetType: 'order',
    targetId: orderId,
    outcome: 'SUCCEEDED',
    reason: 'USER_REQUEST',
    requestId: `req:${idempotencyKey}`,
    idempotencyKey,
    approvalRequestId: null,
    occurredAt: now.toISOString(),
    changes: [
      {
        targetType: 'order',
        targetId: orderId,
        changeType: 'APPEND',
        beforeSnapshot: null,
        afterSnapshot: { amountMinor: idempotencyKey },
        changedFields: ['refund']
      }
    ]
  };
}
