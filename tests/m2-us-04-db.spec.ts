import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresServiceLifecycleStore,
  confirmOrder,
  expireOrderCompletionConfirmation,
  requestOrderCompletion,
  setOrderReadiness
} from '@blackcat/api/service-lifecycle';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T04:30:00.000Z');
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000000b451';
const customerId = '00000000-0000-0000-0000-00000000a551';
const playerId = '00000000-0000-0000-0000-00000000a552';

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M2-US-04 Postgres service lifecycle', () => {
  beforeAll(async () => {
    port = 59_900 + (process.pid % 80);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-service-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_service']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m2_service',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m2_service',
      application_name: 'blackcat_m2_service_test',
      max: 4
    });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`
TRUNCATE TABLE
  staff_tasks,
  commissions,
  referral_attributions,
  referral_program_versions,
  staff_accounts,
  player_earnings,
  consumption_entries,
  external_transactions,
  fund_reservation_events,
  fund_reservations,
  order_events,
  discord_accounts,
  orders,
  users
RESTART IDENTITY CASCADE
    `);
    await seedAcceptedOrder();
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

  test('records both readiness sides and transitions ACCEPTED to IN_SERVICE once', async () => {
    const store = new PostgresServiceLifecycleStore({ pool });

    const customerReady = await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 4,
      readiness: 'READY',
      actor: { guildId, discordUserId: '111111111111111111' },
      now
    });
    const playerReady = await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 5,
      readiness: 'READY',
      actor: { guildId, discordUserId: '222222222222222222' },
      now: new Date(now.getTime() + 60_000)
    });

    const row = await pool.query(
      'SELECT status, row_version, customer_ready_at, player_ready_at, service_started_at FROM orders WHERE id = $1',
      [orderId]
    );

    expect(customerReady).toMatchObject({
      status: 'ACCEPTED',
      version: 5,
      actorRole: 'CUSTOMER',
      readiness: { customer: 'READY', player: 'NOT_READY', bothReady: false, startedAt: null }
    });
    expect(playerReady).toMatchObject({
      status: 'IN_SERVICE',
      version: 6,
      actorRole: 'PLAYER',
      readiness: { customer: 'READY', player: 'READY', bothReady: true }
    });
    expect(new Date(row.rows[0]!.customer_ready_at).toISOString()).toBe(now.toISOString());
    expect(new Date(row.rows[0]!.player_ready_at).toISOString()).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(new Date(row.rows[0]!.service_started_at).toISOString()).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(row.rows[0]).toMatchObject({ status: 'IN_SERVICE', row_version: 6 });
  });

  test('assigned player request completion moves service into pending confirmation', async () => {
    const store = new PostgresServiceLifecycleStore({ pool });
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 4,
      readiness: 'READY',
      actor: { guildId, discordUserId: '111111111111111111' },
      now
    });
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 5,
      readiness: 'READY',
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });

    const result = await requestOrderCompletion({
      store,
      orderId,
      expectedVersion: 6,
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });
    const row = await pool.query('SELECT status, row_version, completion_requested_at, confirmation_due_at FROM orders WHERE id = $1', [orderId]);

    expect(result).toMatchObject({
      status: 'PENDING_CONFIRMATION',
      version: 7,
      actorRole: 'PLAYER',
      confirmationDueAt: new Date(now.getTime() + 30 * 60_000).toISOString()
    });
    expect(row.rows[0]).toMatchObject({ status: 'PENDING_CONFIRMATION', row_version: 7 });
    expect(new Date(row.rows[0]!.completion_requested_at).toISOString()).toBe(now.toISOString());
    expect(new Date(row.rows[0]!.confirmation_due_at).toISOString()).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  test('customer confirmation completes order and creates capture, consumption and player earning facts atomically', async () => {
    const store = new PostgresServiceLifecycleStore({ pool });
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 4,
      readiness: 'READY',
      actor: { guildId, discordUserId: '111111111111111111' },
      now
    });
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 5,
      readiness: 'READY',
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });
    await requestOrderCompletion({
      store,
      orderId,
      expectedVersion: 6,
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });

    const result = await confirmOrder({
      store,
      orderId,
      expectedVersion: 7,
      confirmation: 'CONFIRM_COMPLETED',
      actor: { guildId, discordUserId: '111111111111111111' },
      idempotencyKey: 'discord:order:confirm:db',
      now
    });
    const snapshot = await pool.query(`
SELECT
  (SELECT status FROM orders WHERE id = '${orderId}') AS order_status,
  (SELECT row_version::text FROM orders WHERE id = '${orderId}') AS order_version,
  (SELECT active_customer_slot_id FROM orders WHERE id = '${orderId}') AS active_customer_slot_id,
  (SELECT active_player_slot_id FROM orders WHERE id = '${orderId}') AS active_player_slot_id,
  (SELECT status FROM fund_reservations WHERE order_id = '${orderId}') AS reservation_status,
  (SELECT count(*)::text FROM external_transactions WHERE order_id = '${orderId}' AND status = 'SUCCEEDED') AS external_transactions,
  (SELECT count(*)::text FROM consumption_entries WHERE order_id = '${orderId}' AND entry_type = 'ORDER_CHARGE' AND direction = 'DEBIT') AS consumptions,
  (SELECT count(*)::text FROM player_earnings WHERE order_id = '${orderId}' AND status = 'PENDING') AS player_earnings,
  (SELECT amount_minor::text FROM player_earnings WHERE order_id = '${orderId}') AS earning_amount
    `);

    expect(result).toMatchObject({
      orderId,
      status: 'COMPLETED',
      version: 8,
      capturedMinor: 12000,
      playerEarningMinor: 8400
    });
    expect(snapshot.rows[0]).toMatchObject({
      order_status: 'COMPLETED',
      order_version: '8',
      active_customer_slot_id: null,
      active_player_slot_id: null,
      reservation_status: 'CAPTURED',
      external_transactions: '1',
      consumptions: '1',
      player_earnings: '1',
      earning_amount: '8400'
    });
  });

  test('customer confirmation creates a pending referral commission when an eligible attribution exists', async () => {
    const store = new PostgresServiceLifecycleStore({ pool });
    await seedPlayerLifetimeReferral();
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 4,
      readiness: 'READY',
      actor: { guildId, discordUserId: '111111111111111111' },
      now
    });
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 5,
      readiness: 'READY',
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });
    await requestOrderCompletion({
      store,
      orderId,
      expectedVersion: 6,
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });

    await confirmOrder({
      store,
      orderId,
      expectedVersion: 7,
      confirmation: 'CONFIRM_COMPLETED',
      actor: { guildId, discordUserId: '111111111111111111' },
      idempotencyKey: 'discord:order:confirm:db-referral',
      now
    });
    const snapshot = await pool.query(`
SELECT
  count(*)::text AS commissions,
  max(program_type_snapshot::text) AS program_type,
  max(award_mode_snapshot::text) AS award_mode,
  max(base_amount_minor)::text AS base_amount,
  max(rate_bps)::text AS rate_bps,
  max(amount_minor)::text AS amount,
  max(status::text) AS status,
  max(beneficiary_user_id::text) AS beneficiary_user_id
FROM commissions
WHERE source_consumption_entry_id = (
  SELECT id FROM consumption_entries WHERE order_id = '${orderId}' AND entry_type = 'ORDER_CHARGE'
)
    `);

    expect(snapshot.rows[0]).toMatchObject({
      commissions: '1',
      program_type: 'PLAYER_LIFETIME',
      award_mode: 'NET_SPEND_BPS',
      base_amount: '12000',
      rate_bps: '200',
      amount: '240',
      status: 'PENDING',
      beneficiary_user_id: '00000000-0000-0000-0000-00000000a553'
    });
  });

  test('completion timeout creates one completion review task and leaves settlement untouched', async () => {
    const store = new PostgresServiceLifecycleStore({ pool });
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 4,
      readiness: 'READY',
      actor: { guildId, discordUserId: '111111111111111111' },
      now
    });
    await setOrderReadiness({
      store,
      orderId,
      expectedVersion: 5,
      readiness: 'READY',
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });
    await requestOrderCompletion({
      store,
      orderId,
      expectedVersion: 6,
      actor: { guildId, discordUserId: '222222222222222222' },
      now: new Date(now.getTime() - 31 * 60_000)
    });

    const first = await expireOrderCompletionConfirmation({ store, orderId, now });
    const replay = await expireOrderCompletionConfirmation({ store, orderId, now: new Date(now.getTime() + 1_000) });
    const snapshot = await pool.query(`
SELECT
  (SELECT status FROM orders WHERE id = '${orderId}') AS order_status,
  (SELECT count(*)::text FROM staff_tasks WHERE order_id = '${orderId}' AND type = 'COMPLETION_REVIEW') AS staff_tasks,
  (SELECT reason_code FROM staff_tasks WHERE order_id = '${orderId}' AND type = 'COMPLETION_REVIEW') AS reason_code,
  (SELECT count(*)::text FROM consumption_entries WHERE order_id = '${orderId}') AS consumptions,
  (SELECT count(*)::text FROM player_earnings WHERE order_id = '${orderId}') AS player_earnings,
  (SELECT status FROM fund_reservations WHERE order_id = '${orderId}') AS reservation_status
    `);

    expect(first).toMatchObject({
      orderId,
      status: 'PENDING_CONFIRMATION',
      version: 7,
      staffTask: {
        type: 'COMPLETION_REVIEW',
        reasonCode: 'COMPLETION_CONFIRMATION_TIMEOUT',
        status: 'OPEN'
      }
    });
    expect(replay.staffTask.id).toBe(first.staffTask.id);
    expect(snapshot.rows[0]).toMatchObject({
      order_status: 'PENDING_CONFIRMATION',
      staff_tasks: '1',
      reason_code: 'COMPLETION_CONFIRMATION_TIMEOUT',
      consumptions: '0',
      player_earnings: '0',
      reservation_status: 'ACTIVE'
    });
  });
});

async function seedAcceptedOrder(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, status, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a551', 'Customer', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a552', 'Player', 'ACTIVE', now());

INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, username, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000d551', '00000000-0000-0000-0000-00000000a551', '999999999999999999', '111111111111111111', 'customer', now()),
  ('00000000-0000-0000-0000-00000000d552', '00000000-0000-0000-0000-00000000a552', '999999999999999999', '222222222222222222', 'player', now());

INSERT INTO orders (
  id, public_id, customer_id, player_id, active_customer_slot_id, active_player_slot_id,
  status, row_version, game_code_snapshot, game_name_snapshot, service_code_snapshot,
  service_name_snapshot, region_code_snapshot, billing_unit_minutes, unit_count,
  customer_unit_price_minor, player_unit_payout_minor, amount_minor,
  expected_player_earning_minor, currency, requirement_snapshot, customer_note,
  guild_id, channel_id, panel_message_id, voice_channel_id,
  submitted_at, accepted_at, readiness_due_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000b451',
  'P-4451',
  '00000000-0000-0000-0000-00000000a551',
  '00000000-0000-0000-0000-00000000a552',
  '00000000-0000-0000-0000-00000000a551',
  '00000000-0000-0000-0000-00000000a552',
  'ACCEPTED',
  4,
  'VALORANT',
  'VALORANT',
  'ENTERTAINMENT',
  'ENTERTAINMENT',
  'NA',
  60,
  2,
  6000,
  4200,
  12000,
  8400,
  'CNY',
  '{"language":"zh"}',
  '中文交流',
  '999999999999999999',
  '444444444444444444',
  '555555555555555555',
  '666666666666666666',
  now(),
  now(),
  now() + interval '10 minutes',
  now(),
  now()
);

INSERT INTO fund_reservations (
  id, user_id, source_type, order_id, gift_request_id, mode, provider, provider_hold_ref,
  amount_minor, currency, status, row_version, idempotency_key,
  expires_at, activated_at, settled_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000f451',
  '00000000-0000-0000-0000-00000000a551',
  'ORDER',
  '00000000-0000-0000-0000-00000000b451',
  NULL,
  'LOCAL_RESERVATION_FALLBACK',
  'mock-provider',
  NULL,
  12000,
  'CNY',
  'ACTIVE',
  1,
  'discord:order:submit:P-4451',
  now() + interval '30 minutes',
  now(),
  NULL,
  now(),
  now()
);

INSERT INTO fund_reservation_events (
  id, fund_reservation_id, sequence, event_type, from_status, to_status,
  amount_minor, reservation_version, idempotency_key,
  actor_user_id, actor_staff_id, actor_source, reason_code, created_at
)
VALUES (
  '00000000-0000-0000-0000-00000000e451',
  '00000000-0000-0000-0000-00000000f451',
  1,
  'CREATED',
  NULL,
  'ACTIVE',
  12000,
  1,
  'discord:order:submit:P-4451',
  '00000000-0000-0000-0000-00000000a551',
  NULL,
  'DISCORD_BOT',
  NULL,
  now()
);
  `);
}

async function seedPlayerLifetimeReferral(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, status, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a553', 'Referral Beneficiary', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a554', 'Referral Staff', 'ACTIVE', now());

INSERT INTO staff_accounts (id, user_id, level, role_source, mfa_enrolled, updated_at)
VALUES (
  '00000000-0000-0000-0000-00000000c554',
  '00000000-0000-0000-0000-00000000a554',
  'L4_ADMIN_OWNER',
  'BOOTSTRAP',
  true,
  now()
);

INSERT INTO referral_program_versions (
  id, program_type, version, status, active_program_key, award_mode,
  fixed_amount_minor, rate_bps, currency, eligible_order_spend,
  eligible_gift_spend, created_by_staff_id, activated_at, created_at
)
VALUES (
  '00000000-0000-0000-0000-000000009701',
  'PLAYER_LIFETIME',
  1,
  'ACTIVE',
  'PLAYER_LIFETIME',
  'NET_SPEND_BPS',
  NULL,
  200,
  'CNY',
  true,
  false,
  '00000000-0000-0000-0000-00000000c554',
  now(),
  now()
);

INSERT INTO referral_attributions (
  id, program_version_id, beneficiary_user_id, referred_user_id,
  status, row_version, active_attribution_key, source_type,
  source_reference_hash, bound_by_staff_id, replaces_attribution_id,
  eligibility_checked_at, bound_at, created_at
)
VALUES (
  '00000000-0000-0000-0000-000000009801',
  '00000000-0000-0000-0000-000000009701',
  '00000000-0000-0000-0000-00000000a553',
  '00000000-0000-0000-0000-00000000a551',
  'ACTIVE',
  1,
  '00000000-0000-0000-0000-00000000a551',
  'ADMIN_MANUAL',
  NULL,
  '00000000-0000-0000-0000-00000000c554',
  NULL,
  now(),
  now(),
  now()
);
  `);
}
