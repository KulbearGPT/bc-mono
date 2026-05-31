import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrderStore } from '@blackcat/api/orders';
import {
  PostgresDispatchPlayerPool,
  PostgresDispatchStore,
  dispatchOrder,
  expireDispatchAttempt
} from '@blackcat/api/dispatch';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T01:00:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000b201';

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M2-US-02 Postgres dispatch integration', () => {
  beforeAll(async () => {
    port = 59_000 + (process.pid % 1_000);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-dispatch-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_dispatch']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m2_dispatch',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m2_dispatch',
      application_name: 'blackcat_m2_dispatch_test',
      max: 4
    });
    await seedDispatchFixture();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dataDir) {
      await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']).catch(() => undefined);
    }
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('creates dispatch attempt, candidate snapshot and outbox rows transactionally', async () => {
    const result = await dispatchOrder({
      orderStore: new PostgresOrderStore({ pool }),
      dispatchStore: new PostgresDispatchStore({ pool }),
      playerPool: new PostgresDispatchPlayerPool({ pool }),
      orderId,
      expectedVersion: 3,
      trigger: 'ORDER_SUBMITTED',
      dispatchChannelId: '777777777777777777',
      idempotencyKey: 'system:dispatch:postgres:P-2201',
      now
    });

    expect(result).toMatchObject({ orderId, status: 'OPEN', candidateCount: 1 });
    const attempts = await pool.query('SELECT id, status, round FROM dispatch_attempts WHERE order_id = $1', [orderId]);
    const candidates = await pool.query('SELECT player_user_id, status FROM dispatch_candidates WHERE dispatch_attempt_id = $1', [result.dispatchAttemptId]);
    const outbox = await pool.query('SELECT event_type, aggregate_id, available_at FROM outbox_events WHERE dispatch_attempt_id = $1 ORDER BY event_type', [result.dispatchAttemptId]);

    expect(attempts.rows).toEqual([
      expect.objectContaining({ id: result.dispatchAttemptId, status: 'ACTIVE', round: 1 })
    ]);
    expect(candidates.rows).toEqual([
      expect.objectContaining({
        player_user_id: '00000000-0000-0000-0000-00000000a301',
        status: 'NOTIFIED'
      })
    ]);
    expect(outbox.rows.map((row) => row.event_type)).toEqual(['DISPATCH_MESSAGE', 'DISPATCH_TIMEOUT']);
  });

  test('timeout only ends current dispatch round and leaves order pending dispatch', async () => {
    const dispatchStore = new PostgresDispatchStore({ pool });
    const active = await pool.query<{ id: string }>('SELECT id FROM dispatch_attempts WHERE order_id = $1 LIMIT 1', [orderId]);

    const result = await expireDispatchAttempt({
      orderStore: new PostgresOrderStore({ pool }),
      dispatchStore,
      dispatchAttemptId: active.rows[0]!.id,
      now: new Date(now.getTime() + 5 * 60_000)
    });
    const order = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    const candidate = await pool.query('SELECT status FROM dispatch_candidates WHERE dispatch_attempt_id = $1', [active.rows[0]!.id]);

    expect(result).toMatchObject({ status: 'DISPATCH_TIMEOUT', orderStatus: 'PENDING_DISPATCH' });
    expect(order.rows[0]).toMatchObject({ status: 'PENDING_DISPATCH' });
    expect(candidate.rows[0]).toMatchObject({ status: 'EXPIRED' });
  });
});

async function seedDispatchFixture(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, status, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a101', 'Customer One', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a301', 'Player Eligible', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a302', 'Player Busy', 'ACTIVE', now());

INSERT INTO orders (
  id, public_id, customer_id, active_customer_slot_id, status, row_version,
  game_code_snapshot, game_name_snapshot, service_code_snapshot, service_name_snapshot,
  region_code_snapshot, billing_unit_minutes, unit_count, customer_unit_price_minor,
  player_unit_payout_minor, amount_minor, expected_player_earning_minor, currency,
  requirement_snapshot, customer_note, guild_id, channel_id, panel_message_id,
  voice_channel_id, submitted_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000b201',
  'P-2201',
  '00000000-0000-0000-0000-00000000a101',
  '00000000-0000-0000-0000-00000000a101',
  'PENDING_DISPATCH',
  3,
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
  'CAT',
  '{"language":"zh"}',
  '中文交流',
  '999999999999999999',
  '444444444444444444',
  '555555555555555555',
  '666666666666666666',
  now(),
  now(),
  now()
);

INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, username, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000a301', '999999999999999999', '222222222222222222', 'eligible', now()),
  ('00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-00000000a302', '999999999999999999', '222222222222222223', 'busy', now());

INSERT INTO player_profiles (
  id, user_id, review_status, row_version, availability, discord_presence,
  presence_observed_at, approved_at, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000a301', 'ACTIVE', 2, 'AVAILABLE', 'ONLINE', now(), now(), now(), now()),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000a302', 'ACTIVE', 2, 'BUSY', 'ONLINE', now(), now(), now(), now());

INSERT INTO skill_tags (id, type, code, display_name, enabled, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000f301', 'GAME', 'VALORANT', 'VALORANT', true, now(), now()),
  ('00000000-0000-0000-0000-00000000f302', 'SERVICE', 'ENTERTAINMENT', 'ENTERTAINMENT', true, now(), now());

INSERT INTO player_skills (player_profile_id, skill_tag_id, created_at)
VALUES
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000f301', now()),
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000f302', now()),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000f301', now()),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000f302', now());
  `);
}
