import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrderStore } from '@blackcat/api/orders';
import {
  PostgresDispatchPlayerPool,
  PostgresDispatchStore,
  acceptOrder,
  declineOrderOffer,
  dispatchOrder
} from '@blackcat/api/dispatch';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T03:00:00.000Z');
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-00000000b301';
const playerAUserId = '00000000-0000-0000-0000-00000000a401';
const playerBUserId = '00000000-0000-0000-0000-00000000a402';

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M2-US-03 Postgres accept-order concurrency', () => {
  beforeAll(async () => {
    port = 59_500 + (process.pid % 400);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-accept-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_accept']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m2_accept',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m2_accept',
      application_name: 'blackcat_m2_accept_test',
      max: 8
    });
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`
TRUNCATE TABLE
  outbox_events,
  dispatch_candidates,
  dispatch_attempts,
  player_skills,
  skill_tags,
  player_profiles,
  discord_accounts,
  orders,
  users
RESTART IDENTITY CASCADE
    `);
    await seedAcceptFixture();
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

  test('only one candidate can accept the active attempt and the loser is marked lost', async () => {
    const { dispatchAttemptId } = await createDispatchAttempt();

    const results = await Promise.allSettled([
      acceptOrder({
        orderStore: new PostgresOrderStore({ pool }),
        dispatchStore: new PostgresDispatchStore({ pool }),
        playerPool: new PostgresDispatchPlayerPool({ pool }),
        orderId,
        expectedVersion: 3,
        dispatchAttemptId,
        actor: { guildId, discordUserId: '222222222222222222' },
        idempotencyKey: 'discord:dispatch:accept:player-a',
        now
      }),
      acceptOrder({
        orderStore: new PostgresOrderStore({ pool }),
        dispatchStore: new PostgresDispatchStore({ pool }),
        playerPool: new PostgresDispatchPlayerPool({ pool }),
        orderId,
        expectedVersion: 3,
        dispatchAttemptId,
        actor: { guildId, discordUserId: '222222222222222223' },
        idempotencyKey: 'discord:dispatch:accept:player-b',
        now
      })
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const order = await pool.query('SELECT status, player_id, active_player_slot_id, row_version FROM orders WHERE id = $1', [orderId]);
    const attempt = await pool.query('SELECT status, accepted_player_id, accepted_at, finished_at FROM dispatch_attempts WHERE id = $1', [dispatchAttemptId]);
    const candidates = await pool.query(
      'SELECT player_user_id, status, responded_at FROM dispatch_candidates WHERE dispatch_attempt_id = $1 ORDER BY player_user_id',
      [dispatchAttemptId]
    );
    const outbox = await pool.query(
      `SELECT event_type, aggregate_type, aggregate_id, order_id, dispatch_attempt_id, payload
       FROM outbox_events
       WHERE event_type = 'PANEL_SYNC'
       ORDER BY created_at`
    );

    const acceptedPlayerId = order.rows[0]!.player_id;
    expect(order.rows[0]).toMatchObject({
      status: 'ACCEPTED',
      active_player_slot_id: acceptedPlayerId,
      row_version: 4
    });
    expect(attempt.rows[0]).toMatchObject({
      status: 'ACCEPTED',
      accepted_player_id: acceptedPlayerId
    });
    expect(attempt.rows[0]!.accepted_at).toBeTruthy();
    expect(attempt.rows[0]!.finished_at).toBeTruthy();
    expect(candidates.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ player_user_id: acceptedPlayerId, status: 'ACCEPTED' }),
        expect.objectContaining({ status: 'LOST_RACE' })
      ])
    );
    expect(outbox.rows).toEqual([
      expect.objectContaining({
        event_type: 'PANEL_SYNC',
        aggregate_type: 'order',
        aggregate_id: orderId,
        order_id: orderId,
        dispatch_attempt_id: dispatchAttemptId,
        payload: expect.objectContaining({
          kind: 'ORDER_ACCEPTED_CHANNEL_SYNC',
          acceptedPlayerUserId: acceptedPlayerId,
          channelId: '444444444444444444'
        })
      })
    ]);
  });

  test('player who became busy after notification cannot accept the order', async () => {
    const { dispatchAttemptId } = await createDispatchAttempt();
    await insertActiveOrderForPlayer(playerAUserId);

    await expect(
      acceptOrder({
        orderStore: new PostgresOrderStore({ pool }),
        dispatchStore: new PostgresDispatchStore({ pool }),
        playerPool: new PostgresDispatchPlayerPool({ pool }),
        orderId,
        expectedVersion: 3,
        dispatchAttemptId,
        actor: { guildId, discordUserId: '222222222222222222' },
        idempotencyKey: 'discord:dispatch:accept:busy-player',
        now
      })
    ).rejects.toThrowError(expect.objectContaining({ code: 'PLAYER_NOT_ELIGIBLE' }));

    const order = await pool.query('SELECT status, player_id, row_version FROM orders WHERE id = $1', [orderId]);
    expect(order.rows[0]).toMatchObject({ status: 'PENDING_DISPATCH', player_id: null, row_version: 3 });
  });

  test('decline only marks the current candidate and keeps the order pending dispatch', async () => {
    const { dispatchAttemptId } = await createDispatchAttempt();

    const result = await declineOrderOffer({
      orderStore: new PostgresOrderStore({ pool }),
      dispatchStore: new PostgresDispatchStore({ pool }),
      playerPool: new PostgresDispatchPlayerPool({ pool }),
      orderId,
      expectedVersion: 3,
      actor: { guildId, discordUserId: '222222222222222222' },
      now
    });
    const candidates = await pool.query(
      'SELECT player_user_id, status FROM dispatch_candidates WHERE dispatch_attempt_id = $1 ORDER BY player_user_id',
      [dispatchAttemptId]
    );

    expect(result).toMatchObject({ id: orderId, status: 'PENDING_DISPATCH', version: 3 });
    expect(candidates.rows).toEqual([
      expect.objectContaining({ player_user_id: playerAUserId, status: 'DECLINED' }),
      expect.objectContaining({ player_user_id: playerBUserId, status: 'NOTIFIED' })
    ]);
  });
});

async function createDispatchAttempt(): Promise<{ dispatchAttemptId: string }> {
  const dispatch = await dispatchOrder({
    orderStore: new PostgresOrderStore({ pool }),
    dispatchStore: new PostgresDispatchStore({ pool }),
    playerPool: new PostgresDispatchPlayerPool({ pool }),
    orderId,
    expectedVersion: 3,
    trigger: 'ORDER_SUBMITTED',
    dispatchChannelId: '777777777777777777',
    idempotencyKey: 'system:dispatch:postgres:P-3301',
    now
  });

  expect(dispatch).toMatchObject({ orderId, status: 'OPEN', candidateCount: 2 });
  return { dispatchAttemptId: dispatch.dispatchAttemptId };
}

async function seedAcceptFixture(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, status, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a101', 'Customer One', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a102', 'Customer Two', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a401', 'Player A', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a402', 'Player B', 'ACTIVE', now());

INSERT INTO orders (
  id, public_id, customer_id, active_customer_slot_id, status, row_version,
  game_code_snapshot, game_name_snapshot, service_code_snapshot, service_name_snapshot,
  region_code_snapshot, billing_unit_minutes, unit_count, customer_unit_price_minor,
  player_unit_payout_minor, amount_minor, expected_player_earning_minor, currency,
  requirement_snapshot, customer_note, guild_id, channel_id, panel_message_id,
  voice_channel_id, submitted_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000b301',
  'P-3301',
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
  'USD',
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
  ('00000000-0000-0000-0000-00000000d401', '00000000-0000-0000-0000-00000000a401', '999999999999999999', '222222222222222222', 'player-a', now()),
  ('00000000-0000-0000-0000-00000000d402', '00000000-0000-0000-0000-00000000a402', '999999999999999999', '222222222222222223', 'player-b', now());

INSERT INTO player_profiles (
  id, user_id, review_status, row_version, availability, discord_presence,
  presence_observed_at, approved_at, created_at, updated_at
)
VALUES
  ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-00000000a401', 'ACTIVE', 2, 'AVAILABLE', 'ONLINE', now(), now(), now(), now()),
  ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000a402', 'ACTIVE', 2, 'AVAILABLE', 'ONLINE', now(), now(), now(), now());

INSERT INTO skill_tags (id, type, code, display_name, enabled, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000f401', 'GAME', 'VALORANT', 'VALORANT', true, now(), now()),
  ('00000000-0000-0000-0000-00000000f402', 'SERVICE', 'ENTERTAINMENT', 'ENTERTAINMENT', true, now(), now());

INSERT INTO player_skills (player_profile_id, skill_tag_id, created_at)
VALUES
  ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-00000000f401', now()),
  ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-00000000f402', now()),
  ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000f401', now()),
  ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000f402', now());
  `);
}

async function insertActiveOrderForPlayer(playerUserId: string): Promise<void> {
  await pool.query(
    `
INSERT INTO orders (
  id, public_id, customer_id, player_id, active_customer_slot_id, active_player_slot_id,
  status, row_version, game_code_snapshot, game_name_snapshot, service_code_snapshot,
  service_name_snapshot, region_code_snapshot, billing_unit_minutes, unit_count,
  customer_unit_price_minor, player_unit_payout_minor, amount_minor,
  expected_player_earning_minor, currency, requirement_snapshot, customer_note,
  guild_id, channel_id, panel_message_id, voice_channel_id,
  submitted_at, accepted_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000b399',
  'P-3399',
  '00000000-0000-0000-0000-00000000a102',
  $1,
  '00000000-0000-0000-0000-00000000a102',
  $1,
  'ACCEPTED',
  1,
  'VALORANT',
  'VALORANT',
  'ENTERTAINMENT',
  'ENTERTAINMENT',
  'NA',
  60,
  1,
  6000,
  4200,
  6000,
  4200,
  'USD',
  '{"language":"zh"}',
  'active order',
  '999999999999999999',
  '444444444444444499',
  '555555555555555599',
  '666666666666666699',
  now(),
  now(),
  now(),
  now()
)
    `,
    [playerUserId]
  );
}
