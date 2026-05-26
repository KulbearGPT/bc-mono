import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresStaffTaskStore,
  claimStaffTask,
  createOrderStaffTask
} from '@blackcat/api/staff-tasks';
import {
  PostgresRiskEventStore,
  createUserRiskFlag
} from '@blackcat/api/risk-events';
import type { OrderRecord } from '@blackcat/api/orders';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T05:30:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000b551';

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M2-US-05 Postgres staff task support', () => {
  beforeAll(async () => {
    port = 59_980 + (process.pid % 80);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-staff-task-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_staff_task']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m2_staff_task',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m2_staff_task',
      application_name: 'blackcat_m2_staff_task_test',
      max: 6
    });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`
TRUNCATE TABLE
  staff_tasks,
  risk_events,
  staff_accounts,
  orders,
  users
RESTART IDENTITY CASCADE
    `);
    await seedOrderAndStaff();
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

  test('createOrderStaffTask returns the same active task for repeated order/type/reason', async () => {
    const store = new PostgresStaffTaskStore({ pool });

    const first = await createOrderStaffTask({
      store,
      order: acceptedOrder(),
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      actor: { actorUserId: '00000000-0000-0000-0000-00000000a551', actorStaffId: null, actorSource: 'DISCORD_BOT' },
      note: '用户取消',
      now
    });
    const replay = await createOrderStaffTask({
      store,
      order: acceptedOrder(),
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      actor: { actorUserId: '00000000-0000-0000-0000-00000000a551', actorStaffId: null, actorSource: 'DISCORD_BOT' },
      note: '重复点击',
      now: new Date(now.getTime() + 1_000)
    });
    const row = await pool.query('SELECT count(*)::text AS count FROM staff_tasks WHERE order_id = $1 AND type = $2', [
      orderId,
      'CANCELLATION_ASSIST'
    ]);

    expect(first).toMatchObject({ type: 'CANCELLATION_ASSIST', status: 'OPEN', version: 1 });
    expect(replay.id).toBe(first.id);
    expect(row.rows[0]).toEqual({ count: '1' });
  });

  test('claimStaffTask is atomic: concurrent L1 claims leave exactly one claimant', async () => {
    const store = new PostgresStaffTaskStore({ pool });
    const task = await createOrderStaffTask({
      store,
      order: acceptedOrder(),
      type: 'CANCELLATION_ASSIST',
      reasonCode: 'CUSTOMER_CANCEL_AFTER_ACCEPT',
      actor: { actorUserId: '00000000-0000-0000-0000-00000000a551', actorStaffId: null, actorSource: 'DISCORD_BOT' },
      now
    });

    const results = await Promise.allSettled([
      claimStaffTask({
        store,
        staffTaskId: task.id,
        expectedVersion: 1,
        actorStaffId: '00000000-0000-0000-0000-000000000551',
        now
      }),
      claimStaffTask({
        store,
        staffTaskId: task.id,
        expectedVersion: 1,
        actorStaffId: '00000000-0000-0000-0000-000000000552',
        now
      })
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof claimStaffTask>>> => {
      return result.status === 'fulfilled';
    });
    const rejected = results.filter((result) => result.status === 'rejected');
    const row = await pool.query(
      'SELECT status, row_version, claimed_by_staff_id::text FROM staff_tasks WHERE id = $1',
      [task.id]
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      status: 'CLAIMED',
      row_version: 2,
      claimed_by_staff_id: fulfilled[0]!.value.claimedBy
    });
  });

  test('createUserRiskFlag appends a Postgres risk event without changing user status', async () => {
    const store = new PostgresRiskEventStore({ pool });

    const result = await createUserRiskFlag({
      store,
      userId: '00000000-0000-0000-0000-00000000a551',
      actor: {
        actorUserId: '00000000-0000-0000-0000-000000000552',
        actorStaffId: '00000000-0000-0000-0000-000000000552',
        actorLevel: 'L2_SUPERVISOR',
        actorSource: 'DASHBOARD',
        permissionsVersion: 1,
        guildId: '999999999999999999',
        discordUserId: '222222222222222222',
        interactionId: '888888888888888888'
      },
      body: {
        type: 'PLAYER_NO_SHOW',
        severity: 'MEDIUM',
        source: 'CUSTOMER_REPORT',
        notes: '用户报告陪玩未出现，等待客服复核。',
        orderId
      },
      now
    });
    const rows = await pool.query(`
SELECT risk_events.type, risk_events.severity, risk_events.source, risk_events.notes, users.status AS user_status
FROM risk_events
JOIN users ON users.id = risk_events.user_id
WHERE risk_events.id = $1
    `, [result.riskEvent.id]);

    expect(result.userStatusChanged).toBe(false);
    expect(rows.rows[0]).toMatchObject({
      type: 'PLAYER_NO_SHOW',
      severity: 'MEDIUM',
      source: 'CUSTOMER_REPORT',
      notes: '用户报告陪玩未出现，等待客服复核。',
      user_status: 'ACTIVE'
    });
  });
});

async function seedOrderAndStaff(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, status, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a551', 'Customer', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a552', 'Player', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-000000000551', 'Staff A', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-000000000552', 'Staff B', 'ACTIVE', now());

INSERT INTO staff_accounts (id, user_id, level, role_source, mfa_enrolled, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000551', '00000000-0000-0000-0000-000000000551', 'L1_SUPPORT', 'BOOTSTRAP', true, now()),
  ('00000000-0000-0000-0000-000000000552', '00000000-0000-0000-0000-000000000552', 'L1_SUPPORT', 'BOOTSTRAP', true, now());

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
  '00000000-0000-0000-0000-00000000b551',
  'P-M2-STAFF',
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
  'USD',
  '{"language":"zh"}',
  '中文交流',
  '999999999999999999',
  '120000000000000001',
  '120000000000000002',
  '120000000000000003',
  now(),
  now(),
  now() + interval '10 minutes',
  now(),
  now()
);
  `);
}

function acceptedOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: orderId,
    publicId: 'P-M2-STAFF',
    customerId: '00000000-0000-0000-0000-00000000a551',
    playerId: '00000000-0000-0000-0000-00000000a552',
    status: 'ACCEPTED',
    version: 4,
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
    currency: 'USD',
    notes: '中文交流',
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: '120000000000000003'
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}
