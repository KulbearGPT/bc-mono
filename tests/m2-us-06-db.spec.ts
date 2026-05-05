import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import { PostgresAdminOrderActionStore } from '@blackcat/api/admin-order-actions';
import { MockFundingAdapter } from '@blackcat/api/payment-adapter';
import { InMemoryAuditSink, InMemoryIdempotencyStore, PostgresStaffDirectory } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T07:00:00.000Z');
const guildId = '999999999999999999';
const staffDiscordId = '222222222222222222';
const orderId = '00000000-0000-0000-0000-00000000b651';
const customerId = '00000000-0000-0000-0000-00000000a651';
const playerId = '00000000-0000-0000-0000-00000000a652';
const nextPlayerId = '00000000-0000-0000-0000-00000000a654';
const staffId = '00000000-0000-0000-0000-000000000652';
const sourceTransactionId = '00000000-0000-0000-0000-00000000e651';
const sourceConsumptionId = '00000000-0000-0000-0000-00000000d651';
const playerEarningId = '00000000-0000-0000-0000-00000000c651';
const commissionId = '00000000-0000-0000-0000-000000009651';
const reservationId = '00000000-0000-0000-0000-00000000f651';

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;
let provider: MockFundingAdapter;
let sourceProviderRef = '';

describe('M2-US-06 Postgres admin order actions', () => {
  beforeAll(async () => {
    port = 60_060 + (process.pid % 80);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-admin-order-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;
    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_admin_order']);
    await execFile('psql', [
      '-h', socketDir, '-p', String(port), '-d', 'blackcat_m2_admin_order',
      '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);
    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m2_admin_order',
      application_name: 'blackcat_m2_admin_order_test',
      max: 6
    });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`
TRUNCATE TABLE
  audit_logs, commission_adjustments, commissions, referral_attributions,
  referral_program_versions, player_earning_adjustments, player_earnings,
  consumption_entries, refunds, external_transactions, order_resolutions,
  order_events, risk_events, player_skills, skill_tags, discord_accounts, staff_accounts, orders, users
RESTART IDENTITY CASCADE
    `);
    provider = new MockFundingAdapter({ now });
    const source = provider.createReservationDebit({
      idempotencyKey: 'provider:order-charge:m2-us-06-db',
      fundReservationId: '00000000-0000-0000-0000-00000000f651',
      fundReservationVersion: 1,
      externalUserId: 'mock-user-ok',
      amount: { amountMinor: 12000, currency: 'CNY' },
      businessSource: 'ORDER',
      businessReference: orderId
    });
    sourceProviderRef = source.providerRef!;
    await seedCompletedFacts();
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dataDir) {
      await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']).catch(() => undefined);
    }
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('resolveOrder commits resolution, refund, corrections, adjustments, event and success audit together', async () => {
    const server = buildServer();
    const response = await server.inject(resolveRequest('dashboard:resolve:postgres-success'));

    expect(response.statusCode, response.body).toBe(200);
    const snapshot = await readSnapshot();
    expect(snapshot).toMatchObject({
      order_status: 'CANCELLED',
      order_version: '12',
      resolution_count: '1',
      refund_count: '1',
      refund_amount: '5000',
      refund_external_ref: expect.stringMatching(/^mock_txn_/),
      reversal_count: '1',
      reversal_amount: '5000',
      earning_amount: '8400',
      earning_status: 'PAID',
      earning_adjustment_count: '1',
      earning_adjustment_amount: '6400',
      commission_amount: '240',
      commission_adjustment_count: '1',
      commission_adjustment_amount: '100',
      resolved_event_count: '1',
      success_audit_count: '1'
    });
  });

  test('resolveOrder rolls back every local fact when an adjustment insert fails', async () => {
    await pool.query('ALTER TABLE commission_adjustments ADD CONSTRAINT m2_us_06_forced_failure CHECK (false)');
    const idempotencyKey = 'dashboard:resolve:postgres-rollback';
    const server = buildServer();
    try {
      const response = await server.inject(resolveRequest(idempotencyKey));

      expect(response.statusCode, response.body).toBe(500);
      const snapshot = await readSnapshot();
      expect(snapshot).toMatchObject({
        order_status: 'EXCEPTION',
        order_version: '11',
        resolution_count: '0',
        refund_count: '0',
        reversal_count: '0',
        earning_adjustment_count: '0',
        commission_adjustment_count: '0',
        resolved_event_count: '0',
        success_audit_count: '0'
      });
    } finally {
      await pool.query('ALTER TABLE commission_adjustments DROP CONSTRAINT m2_us_06_forced_failure');
    }

    const recovered = await server.inject(resolveRequest(idempotencyKey));
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.headers['x-idempotency-replayed']).toBeUndefined();
    await expect(readSnapshot()).resolves.toMatchObject({
      order_status: 'CANCELLED',
      resolution_count: '1',
      refund_count: '1',
      reversal_count: '1',
      earning_adjustment_count: '1',
      commission_adjustment_count: '1',
      resolved_event_count: '1',
      success_audit_count: '1'
    });
  });

  test('refundOrder appends refund corrections and adjustments without changing a completed order fact', async () => {
    await pool.query(
      "UPDATE orders SET status = 'COMPLETED', active_customer_slot_id = NULL, active_player_slot_id = NULL WHERE id = $1",
      [orderId]
    );
    const server = buildServer();
    const response = await server.inject({
      ...resolveRequest('dashboard:refund:postgres-success'),
      url: `/api/v1/admin/orders/${orderId}/refund`,
      payload: {
        expectedVersion: 11,
        amount: { amountMinor: 5000, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: '已完成订单售后部分退款。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode, response.body).toBe(200);
    const snapshot = await readSnapshot();
    expect(snapshot).toMatchObject({
      order_status: 'COMPLETED',
      order_version: '11',
      resolution_count: '0',
      refund_count: '1',
      reversal_count: '1',
      earning_amount: '8400',
      earning_status: 'PAID',
      earning_adjustment_count: '1',
      earning_adjustment_amount: '3500',
      commission_amount: '240',
      commission_adjustment_count: '1',
      commission_adjustment_amount: '100'
    });
    const audit = await pool.query(
      "SELECT count(*)::text AS count FROM audit_logs WHERE target_id = $1 AND action = 'REFUND_ORDER' AND outcome = 'SUCCEEDED'",
      [orderId]
    );
    expect(audit.rows[0]).toEqual({ count: '1' });
  });

  test('refundOrder persists an immutable approval request when the L2 amount limit is exceeded', async () => {
    await pool.query('ALTER TABLE orders DISABLE TRIGGER protect_orders_amount_update');
    try {
      await pool.query('UPDATE orders SET amount_minor = 120000 WHERE id = $1', [orderId]);
    } finally {
      await pool.query('ALTER TABLE orders ENABLE TRIGGER protect_orders_amount_update');
    }
    const server = buildServer();
    const response = await server.inject({
      ...resolveRequest('dashboard:refund:postgres-approval'),
      url: `/api/v1/admin/orders/${orderId}/refund`,
      payload: {
        expectedVersion: 11,
        amount: { amountMinor: 50001, currency: 'CNY' },
        reasonCode: 'USER_REQUEST',
        evidenceNote: '超过 L2 退款额度，提交 L3 审批。',
        confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
      }
    });

    expect(response.statusCode, response.body).toBe(202);
    const approval = await pool.query(`
SELECT action::text, target_type, target_id::text, target_version::text,
       amount_minor::text, currency, required_level::text, status::text,
       requested_by_staff_id::text
FROM approval_requests
WHERE id = $1
    `, [response.json().data.approvalRequestId]);
    expect(approval.rows).toEqual([{
      action: 'REFUND_EXECUTE',
      target_type: 'ORDER',
      target_id: orderId,
      target_version: '11',
      amount_minor: '50001',
      currency: 'CNY',
      required_level: 'L3_OPERATIONS',
      status: 'PENDING',
      requested_by_staff_id: staffId
    }]);
  });

  test('reassignOrder changes only assignment fields and appends an event and success audit', async () => {
    const server = buildServer();
    const response = await server.inject({
      ...resolveRequest('dashboard:reassign:postgres-success'),
      url: `/api/v1/admin/orders/${orderId}/reassign`,
      payload: {
        expectedVersion: 11,
        playerId: nextPlayerId,
        reasonCode: 'PLAYER_NO_SHOW',
        note: '原陪玩未到，客服转派。'
      }
    });

    expect(response.statusCode, response.body).toBe(200);
    const result = await pool.query(`
SELECT
  orders.player_id::text,
  orders.active_player_slot_id::text,
  orders.status::text,
  orders.row_version::text,
  (SELECT count(*)::text FROM order_events WHERE order_id = orders.id AND event_type = 'DETAILS_UPDATED') AS event_count,
  (SELECT count(*)::text FROM audit_logs WHERE target_id = orders.id::text AND action = 'REASSIGN_ORDER' AND outcome = 'SUCCEEDED') AS audit_count
FROM orders WHERE orders.id = $1
    `, [orderId]);
    expect(result.rows[0]).toEqual({
      player_id: nextPlayerId,
      active_player_slot_id: nextPlayerId,
      status: 'EXCEPTION',
      row_version: '12',
      event_count: '1',
      audit_count: '1'
    });
  });

  test('reassignOrder rejects a user who is not an active available player', async () => {
    const server = buildServer();
    const ineligibleUserId = '00000000-0000-0000-0000-00000000a653';
    const response = await server.inject({
      ...resolveRequest('dashboard:reassign:ineligible-player'),
      url: `/api/v1/admin/orders/${orderId}/reassign`,
      payload: {
        expectedVersion: 11,
        playerId: ineligibleUserId,
        reasonCode: 'PLAYER_NO_SHOW',
        note: '该用户没有有效陪玩资格。'
      }
    });

    expect(response.statusCode).toBe(422);
    const order = await pool.query('SELECT player_id::text, row_version::text FROM orders WHERE id = $1', [orderId]);
    expect(order.rows[0]).toEqual({ player_id: playerId, row_version: '11' });
  });

  test('resolveOrder appends a customer risk signal inside a no-show resolution transaction', async () => {
    const server = buildServer();
    const request = resolveRequest('dashboard:resolve:customer-no-show');
    request.payload = {
      ...request.payload,
      reasonCode: 'CUSTOMER_NO_SHOW',
      refund: { amountMinor: 0, currency: 'CNY' },
      playerEarning: { amountMinor: 0, currency: 'CNY' },
      evidenceNote: '客服核对：用户未到场，记录风险信号但不自动封禁。'
    };

    const response = await server.inject(request);

    expect(response.statusCode, response.body).toBe(200);
    const risk = await pool.query(`
SELECT user_id::text, order_id::text, type::text, severity::text, source, created_by_staff_id::text
FROM risk_events
WHERE order_id = $1
    `, [orderId]);
    expect(risk.rows).toEqual([{
      user_id: customerId,
      order_id: orderId,
      type: 'CUSTOMER_NO_SHOW',
      severity: 'MEDIUM',
      source: 'ORDER_RESOLUTION',
      created_by_staff_id: staffId
    }]);
  });

  test('resolveOrder atomically captures the retained amount and releases the remainder of an active reservation', async () => {
    const hold = provider.createHold({
      idempotencyKey: 'provider:hold:m2-us-06-partial',
      fundReservationId: reservationId,
      fundReservationVersion: 1,
      externalUserId: 'mock-user-ok',
      amount: { amountMinor: 12000, currency: 'CNY' },
      businessSource: 'ORDER',
      businessReference: orderId,
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString()
    });
    await pool.query(`
TRUNCATE TABLE commission_adjustments, commissions, player_earning_adjustments,
  player_earnings, consumption_entries, refunds, external_transactions CASCADE;
UPDATE orders
SET status = 'ACCEPTED', row_version = 11, completed_at = NULL, service_started_at = NULL
WHERE id = '${orderId}';
INSERT INTO external_accounts (
  id, user_id, provider, external_user_id, status, active_user_provider_key,
  verified_at, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-00000000e659', '${customerId}', 'mock-provider',
  'mock-user-ok', 'ACTIVE', '${customerId}:mock-provider', now(), now(), now()
);
INSERT INTO fund_reservations (
  id, user_id, source_type, order_id, mode, provider, provider_hold_ref,
  amount_minor, currency, status, row_version, idempotency_key,
  expires_at, activated_at, created_at, updated_at
) VALUES (
  '${reservationId}', '${customerId}', 'ORDER', '${orderId}', 'PROVIDER_NATIVE_HOLD',
  'mock-provider', '${hold.holdRef}', 12000, 'CNY', 'ACTIVE', 1,
  'reservation:m2-us-06-partial', now() + interval '30 minutes', now(), now(), now()
);
INSERT INTO fund_reservation_events (
  id, fund_reservation_id, sequence, event_type, from_status, to_status,
  amount_minor, reservation_version, idempotency_key, actor_source, created_at
) VALUES (
  '00000000-0000-0000-0000-00000000e658', '${reservationId}', 1, 'CREATED', NULL,
  'ACTIVE', 12000, 1, 'reservation:m2-us-06-partial:created', 'SYSTEM_JOB', now()
);
    `);

    const server = buildServer();
    const response = await server.inject(resolveRequest('dashboard:resolve:active-reservation'));

    expect(response.statusCode, response.body).toBe(200);
    const result = await pool.query(`
SELECT
  (SELECT status::text FROM orders WHERE id = $1) AS order_status,
  (SELECT status::text FROM fund_reservations WHERE id = $2) AS reservation_status,
  (SELECT count(*)::text FROM fund_reservation_events WHERE fund_reservation_id = $2 AND event_type = 'CAPTURED') AS capture_events,
  (SELECT count(*)::text FROM fund_reservation_events WHERE fund_reservation_id = $2 AND event_type = 'RELEASED') AS release_events,
  (SELECT COALESCE(sum(amount_minor), 0)::text FROM fund_reservation_events WHERE fund_reservation_id = $2 AND event_type = 'CAPTURED') AS captured_minor,
  (SELECT COALESCE(sum(amount_minor), 0)::text FROM fund_reservation_events WHERE fund_reservation_id = $2 AND event_type = 'RELEASED') AS released_minor,
  (SELECT amount_minor::text FROM external_transactions WHERE order_id = $1 AND type = 'ORDER_CHARGE') AS charge_minor,
  (SELECT amount_minor::text FROM consumption_entries WHERE order_id = $1 AND entry_type = 'ORDER_CHARGE') AS consumption_minor,
  (SELECT amount_minor::text FROM player_earnings WHERE order_id = $1) AS earning_minor,
  (SELECT count(*)::text FROM refunds WHERE order_id = $1) AS refund_count
    `, [orderId, reservationId]);
    expect(result.rows[0]).toEqual({
      order_status: 'CANCELLED',
      reservation_status: 'RELEASED',
      capture_events: '1',
      release_events: '1',
      captured_minor: '7000',
      released_minor: '5000',
      charge_minor: '7000',
      consumption_minor: '7000',
      earning_minor: '2000',
      refund_count: '0'
    });
    expect(provider.getHold({ lookupType: 'PROVIDER_HOLD_REF', lookupValue: hold.holdRef! })).toMatchObject({
      status: 'RELEASED',
      capturedAmount: { amountMinor: 7000, currency: 'CNY' },
      releasedAmount: { amountMinor: 5000, currency: 'CNY' },
      remainingAmount: { amountMinor: 0, currency: 'CNY' }
    });
  });
});

function buildServer() {
  return buildApiServer({
    env: {
      NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0',
      API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token'
    },
    security: {
      auditSink: new InMemoryAuditSink(),
      idempotencyStore: new InMemoryIdempotencyStore(),
      staffDirectory: new PostgresStaffDirectory({ client: pool })
    },
    adminOrders: {
      orderStore: new PostgresAdminOrderActionStore({ pool }),
      fundingAdapter: provider,
      providerKey: 'mock-provider',
      now: () => now
    }
  });
}

function resolveRequest(idempotencyKey: string) {
  return {
    method: 'POST' as const,
    url: `/api/v1/admin/orders/${orderId}/resolve`,
    headers: {
      authorization: 'Bearer valid-bot-token',
      'x-client-source': 'DASHBOARD',
      'x-actor-discord-user-id': staffDiscordId,
      'x-actor-guild-id': guildId,
      'x-discord-interaction-id': '777777777777777777',
      'idempotency-key': idempotencyKey
    },
    payload: {
      expectedVersion: 11,
      targetStatus: 'CANCELLED',
      reasonCode: 'SERVICE_INTERRUPTED',
      refund: { amountMinor: 5000, currency: 'CNY' },
      playerEarning: { amountMinor: 2000, currency: 'CNY' },
      evidenceNote: '客服核对：服务中断，部分退款并保留部分陪玩收益。',
      confirmation: 'EXECUTE_OR_REQUEST_APPROVAL'
    }
  };
}

async function readSnapshot() {
  const result = await pool.query(`
SELECT
  (SELECT status::text FROM orders WHERE id = $1) AS order_status,
  (SELECT row_version::text FROM orders WHERE id = $1) AS order_version,
  (SELECT count(*)::text FROM order_resolutions WHERE order_id = $1) AS resolution_count,
  (SELECT count(*)::text FROM refunds WHERE order_id = $1) AS refund_count,
  (SELECT max(amount_minor)::text FROM refunds WHERE order_id = $1) AS refund_amount,
  (SELECT max(external_refund_ref) FROM refunds WHERE order_id = $1) AS refund_external_ref,
  (SELECT count(*)::text FROM consumption_entries WHERE order_id = $1 AND entry_type = 'REFUND_REVERSAL') AS reversal_count,
  (SELECT max(amount_minor)::text FROM consumption_entries WHERE order_id = $1 AND entry_type = 'REFUND_REVERSAL') AS reversal_amount,
  (SELECT amount_minor::text FROM player_earnings WHERE id = $2) AS earning_amount,
  (SELECT status::text FROM player_earnings WHERE id = $2) AS earning_status,
  (SELECT count(*)::text FROM player_earning_adjustments WHERE player_earning_id = $2) AS earning_adjustment_count,
  (SELECT max(amount_minor)::text FROM player_earning_adjustments WHERE player_earning_id = $2) AS earning_adjustment_amount,
  (SELECT amount_minor::text FROM commissions WHERE id = $3) AS commission_amount,
  (SELECT count(*)::text FROM commission_adjustments WHERE commission_id = $3) AS commission_adjustment_count,
  (SELECT max(amount_minor)::text FROM commission_adjustments WHERE commission_id = $3) AS commission_adjustment_amount,
  (SELECT count(*)::text FROM order_events WHERE order_id = $1 AND event_type = 'RESOLVED') AS resolved_event_count,
  (SELECT count(*)::text FROM audit_logs WHERE target_id = $1::text AND action = 'RESOLVE_ORDER' AND outcome = 'SUCCEEDED') AS success_audit_count
  `, [orderId, playerEarningId, commissionId]);
  return result.rows[0];
}

async function seedCompletedFacts(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, status, updated_at) VALUES
  ('${customerId}', 'Customer', 'ACTIVE', now()),
  ('${playerId}', 'Player', 'ACTIVE', now()),
  ('${nextPlayerId}', 'Replacement player', 'ACTIVE', now()),
  ('${staffId}', 'Supervisor', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a653', 'Referral beneficiary', 'ACTIVE', now());

INSERT INTO staff_accounts (id, user_id, level, role_source, mfa_enrolled, updated_at)
VALUES ('${staffId}', '${staffId}', 'L2_SUPERVISOR', 'BOOTSTRAP', true, now());

INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-00000000d652', '${staffId}', '${guildId}', '${staffDiscordId}', now(), now());

INSERT INTO player_profiles (
  id, user_id, review_status, row_version, availability, discord_presence,
  presence_observed_at, approved_by_staff_id, approved_at, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-00000000c654', '${nextPlayerId}', 'ACTIVE', 1,
  'AVAILABLE', 'ONLINE', now(), '${staffId}', now(), now(), now()
);

INSERT INTO skill_tags (id, type, code, display_name, enabled, created_at, updated_at) VALUES
  ('00000000-0000-0000-0000-00000000c655', 'GAME', 'VALORANT', 'VALORANT', true, now(), now()),
  ('00000000-0000-0000-0000-00000000c656', 'SERVICE', 'ENTERTAINMENT', 'ENTERTAINMENT', true, now(), now());
INSERT INTO player_skills (player_profile_id, skill_tag_id, created_at) VALUES
  ('00000000-0000-0000-0000-00000000c654', '00000000-0000-0000-0000-00000000c655', now()),
  ('00000000-0000-0000-0000-00000000c654', '00000000-0000-0000-0000-00000000c656', now());

INSERT INTO orders (
  id, public_id, customer_id, player_id, active_customer_slot_id, active_player_slot_id,
  status, row_version, game_code_snapshot, game_name_snapshot, service_code_snapshot,
  service_name_snapshot, region_code_snapshot, billing_unit_minutes, unit_count,
  customer_unit_price_minor, player_unit_payout_minor, amount_minor,
  expected_player_earning_minor, currency, requirement_snapshot, customer_note,
  guild_id, channel_id, panel_message_id, voice_channel_id,
  submitted_at, accepted_at, service_started_at, completed_at, created_at, updated_at
) VALUES (
  '${orderId}', 'P-M2-ADMIN', '${customerId}', '${playerId}', '${customerId}', '${playerId}',
  'EXCEPTION', 11, 'VALORANT', 'VALORANT', 'ENTERTAINMENT', 'ENTERTAINMENT', 'NA',
  60, 2, 6000, 4200, 12000, 8400, 'CNY', '{"language":"zh"}', '中文交流',
  '${guildId}', '120000000000000001', '120000000000000002', '120000000000000003',
  now(), now(), now(), now(), now(), now()
);

INSERT INTO external_transactions (
  id, provider, type, user_id, order_id, external_ref, idempotency_key,
  amount_minor, currency, status, initiated_at, settled_at, created_at, updated_at
) VALUES (
  '${sourceTransactionId}', 'mock-provider', 'ORDER_CHARGE', '${customerId}', '${orderId}',
  '${sourceProviderRef}', 'provider:order-charge:m2-us-06-db', 12000, 'CNY', 'SUCCEEDED', now(), now(), now(), now()
);

INSERT INTO consumption_entries (
  id, user_id, entry_type, direction, order_id, external_transaction_id,
  amount_minor, currency, source_type, source_id, idempotency_key, occurred_at
) VALUES (
  '${sourceConsumptionId}', '${customerId}', 'ORDER_CHARGE', 'DEBIT', '${orderId}', '${sourceTransactionId}',
  12000, 'CNY', 'ORDER', '${orderId}', 'consume:m2-us-06-db', now()
);

INSERT INTO player_earnings (
  id, order_id, player_user_id, base_units, unit_payout_minor, amount_minor,
  currency, status, row_version, paid_at, created_at, updated_at
) VALUES (
  '${playerEarningId}', '${orderId}', '${playerId}', 2, 4200, 8400,
  'CNY', 'PAID', 3, now(), now(), now()
);

INSERT INTO referral_program_versions (
  id, program_type, version, status, active_program_key, award_mode, rate_bps,
  currency, eligible_order_spend, eligible_gift_spend, created_by_staff_id, activated_at
) VALUES (
  '00000000-0000-0000-0000-000000009661', 'PLAYER_LIFETIME', 1, 'ACTIVE',
  'PLAYER_LIFETIME', 'NET_SPEND_BPS', 200, 'CNY', true, false, '${staffId}', now()
);
INSERT INTO referral_attributions (
  id, program_version_id, beneficiary_user_id, referred_user_id, status, row_version,
  active_attribution_key, source_type, bound_by_staff_id, eligibility_checked_at, bound_at
) VALUES (
  '00000000-0000-0000-0000-000000009662', '00000000-0000-0000-0000-000000009661',
  '00000000-0000-0000-0000-00000000a653', '${customerId}', 'ACTIVE', 1,
  '${customerId}', 'ADMIN_MANUAL', '${staffId}', now(), now()
);
INSERT INTO commissions (
  id, referral_attribution_id, beneficiary_user_id, source_consumption_entry_id,
  program_type_snapshot, program_version_snapshot, award_mode_snapshot,
  base_amount_minor, rate_bps, amount_minor, currency, status, row_version, created_at, updated_at
) VALUES (
  '${commissionId}', '00000000-0000-0000-0000-000000009662',
  '00000000-0000-0000-0000-00000000a653', '${sourceConsumptionId}',
  'PLAYER_LIFETIME', 1, 'NET_SPEND_BPS', 12000, 200, 240, 'CNY', 'PENDING', 1, now(), now()
);
  `);
}
