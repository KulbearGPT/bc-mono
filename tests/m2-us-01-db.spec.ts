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
});

async function seedPlayerProfile(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, status, updated_at)
VALUES ('00000000-0000-0000-0000-00000000a101', 'Player One', 'ACTIVE', now());

INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, username, updated_at)
VALUES (
  '00000000-0000-0000-0000-00000000d101',
  '00000000-0000-0000-0000-00000000a101',
  '999999999999999999',
  '111111111111111111',
  'player-one',
  now()
);

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
