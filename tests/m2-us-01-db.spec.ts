import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresPlayerStore } from '@blackcat/api/players';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T00:00:00.000Z');

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M2-US-01 Postgres player profile integration', () => {
  beforeAll(async () => {
    port = 58_000 + (process.pid % 1_000);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-player-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_player']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m2_player',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m2_player',
      application_name: 'blackcat_m2_player_test',
      max: 4
    });
    await seedPlayerProfile();
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

  test('reads player profile with Discord mapping, tags and active-order state', async () => {
    const store = new PostgresPlayerStore({ pool });

    await expect(
      store.findByDiscord({
        guildId: '999999999999999999',
        discordUserId: '111111111111111111'
      })
    ).resolves.toMatchObject({
      playerId: '00000000-0000-0000-0000-00000000a001',
      reviewStatus: 'ACTIVE',
      availability: 'AVAILABLE',
      discordPresence: 'ONLINE',
      gameTags: ['VALORANT'],
      serviceTags: ['ENTERTAINMENT'],
      activeOrderId: null,
      version: 5
    });
  });

  test('updates availability and presence while keeping the two state dimensions independent', async () => {
    const store = new PostgresPlayerStore({ pool });

    await expect(
      store.updateAvailability({
        playerId: '00000000-0000-0000-0000-00000000a001',
        expectedVersion: 5,
        availability: 'BUSY',
        now
      })
    ).resolves.toMatchObject({ availability: 'BUSY', discordPresence: 'ONLINE', version: 6 });
    await expect(
      store.updatePresence({
        guildId: '999999999999999999',
        discordUserId: '111111111111111111',
        presence: 'OFFLINE',
        observedAt: now.toISOString(),
        now
      })
    ).resolves.toMatchObject({ availability: 'BUSY', discordPresence: 'OFFLINE', version: 7 });
  });

  test('atomically approves a pending companion while creating previously unseen skill tags', async () => {
    const store = new PostgresPlayerStore({ pool });

    await expect(store.approvePlayer({
      playerId: '00000000-0000-0000-0000-00000000a002',
      expectedVersion: 1,
      gameTags: ['VALORANT_NEW'],
      serviceTags: ['RANKED_NEW'],
      approvedByStaffId: '00000000-0000-0000-0000-00000000a201',
      now
    })).resolves.toMatchObject({
      reviewStatus: 'ACTIVE',
      gameTags: ['VALORANT_NEW'],
      serviceTags: ['RANKED_NEW'],
      version: 2
    });

    const facts = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM skill_tags WHERE code IN ('VALORANT_NEW', 'RANKED_NEW')) AS tags,
        (SELECT count(*)::int FROM player_skills WHERE player_profile_id = '00000000-0000-0000-0000-00000000a002') AS skills,
        (SELECT count(*)::int FROM companion_review_events WHERE player_profile_id = '00000000-0000-0000-0000-00000000a002') AS events,
        (SELECT count(*)::int FROM discord_product_role_tasks WHERE user_id = '00000000-0000-0000-0000-00000000a102') AS role_tasks
    `);
    expect(facts.rows[0]).toEqual({ tags: 2, skills: 2, events: 1, role_tasks: 2 });
  });

  test('rolls back the approval projection when a later role-task write fails', async () => {
    const store = new PostgresPlayerStore({ pool });
    await pool.query(`UPDATE guild_bot_configs SET config_json = jsonb_set(config_json, '{companion_role_id}', to_jsonb(repeat('9', 40))) WHERE guild_id = '999999999999999999'`);

    await expect(store.approvePlayer({
      playerId: '00000000-0000-0000-0000-00000000a003',
      expectedVersion: 1,
      gameTags: ['ROLLBACK_GAME'],
      serviceTags: ['ROLLBACK_SERVICE'],
      approvedByStaffId: '00000000-0000-0000-0000-00000000a201',
      now
    })).rejects.toBeDefined();

    const facts = await pool.query(`
      SELECT p.review_status, p.row_version,
        (SELECT count(*)::int FROM player_skills WHERE player_profile_id = p.id) AS skills,
        (SELECT count(*)::int FROM companion_review_events WHERE player_profile_id = p.id) AS events
      FROM player_profiles p WHERE p.id = '00000000-0000-0000-0000-00000000a003'
    `);
    expect(facts.rows[0]).toEqual({ review_status: 'PENDING_REVIEW', row_version: 1, skills: 0, events: 0 });
  });
});

async function seedPlayerProfile(): Promise<void> {
  await pool.query(`
CREATE TABLE IF NOT EXISTS companion_review_events (
  id UUID PRIMARY KEY,
  player_profile_id UUID NOT NULL REFERENCES player_profiles(id),
  from_status "PlayerReviewStatus",
  to_status "PlayerReviewStatus" NOT NULL,
  actor_staff_id UUID,
  reason_code VARCHAR(80),
  note VARCHAR(1000),
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS discord_product_role_tasks (
  id UUID PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  discord_user_id VARCHAR(32) NOT NULL,
  role_id VARCHAR(32) NOT NULL,
  action VARCHAR(10) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  dedupe_key VARCHAR(200) NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(100),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL
);

INSERT INTO users (id, display_name, status, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a101', 'Player One', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a102', 'Pending Player', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a103', 'Rollback Player', 'ACTIVE', now()),
  ('00000000-0000-0000-0000-00000000a202', 'Approver', 'ACTIVE', now());

INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, username, updated_at)
VALUES (
  '00000000-0000-0000-0000-00000000d101',
  '00000000-0000-0000-0000-00000000a101',
  '999999999999999999',
  '111111111111111111',
  'player-one',
  now()
), (
  '00000000-0000-0000-0000-00000000d102',
  '00000000-0000-0000-0000-00000000a102',
  '999999999999999999',
  '222222222222222222',
  'pending-player',
  now()
), (
  '00000000-0000-0000-0000-00000000d103',
  '00000000-0000-0000-0000-00000000a103',
  '999999999999999999',
  '555555555555555555',
  'rollback-player',
  now()
);

INSERT INTO staff_accounts (id, user_id, level, status, role_source, permissions_version, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-00000000a202', 'L4_ADMIN_OWNER', 'ACTIVE', 'BOOTSTRAP', 1, now(), now());

INSERT INTO guild_bot_configs (guild_id, version, config_json, updated_by_staff_id, updated_at)
VALUES ('999999999999999999', 1, '{"companion_applicant_role_id":"333333333333333333","companion_role_id":"444444444444444444"}'::jsonb, '00000000-0000-0000-0000-00000000a201', now());

INSERT INTO player_profiles (
  id, user_id, review_status, row_version, availability, discord_presence,
  presence_observed_at, approved_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000a001',
  '00000000-0000-0000-0000-00000000a101',
  'ACTIVE',
  5,
  'AVAILABLE',
  'ONLINE',
  now(),
  now(),
  now(),
  now()
), (
  '00000000-0000-0000-0000-00000000a002',
  '00000000-0000-0000-0000-00000000a102',
  'PENDING_REVIEW',
  1,
  'OFFLINE',
  'ONLINE',
  now(),
  NULL,
  now(),
  now()
), (
  '00000000-0000-0000-0000-00000000a003',
  '00000000-0000-0000-0000-00000000a103',
  'PENDING_REVIEW',
  1,
  'OFFLINE',
  'ONLINE',
  now(),
  NULL,
  now(),
  now()
);

INSERT INTO skill_tags (id, type, code, display_name, enabled, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000f001', 'GAME', 'VALORANT', 'VALORANT', true, now(), now()),
  ('00000000-0000-0000-0000-00000000f002', 'SERVICE', 'ENTERTAINMENT', 'ENTERTAINMENT', true, now(), now());

INSERT INTO player_skills (player_profile_id, skill_tag_id, created_at)
VALUES
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000f001', now()),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000f002', now());
  `);
}
