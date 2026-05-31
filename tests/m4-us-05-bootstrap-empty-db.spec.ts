import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresAccessStore } from '@blackcat/api/access';

const execFile = promisify(execFileCallback);
const now = new Date('2026-08-02T10:00:00.000Z');
const guildId = '900000000000006000';
const discordUserId = '900000000000006001';

let root = '';
let data = '';
let pool: Pool;

describe('M4-US-05 empty database owner bootstrap', () => {
  beforeAll(async () => {
    const port = 62_000 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m4-bootstrap-empty-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m4_bootstrap_empty']);
    await execFile('psql', [
      '-h', root, '-p', String(port), '-d', 'blackcat_m4_bootstrap_empty',
      '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);
    pool = new Pool({ host: root, port, database: 'blackcat_m4_bootstrap_empty' });
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('creates the initial Discord identity and active L4 owner atomically', async () => {
    const store = new PostgresAccessStore(pool);

    const owner = await store.bootstrapOwner({ guildId, discordUserId, now });

    expect(owner).toMatchObject({
      discordUserId,
      guildId,
      level: 'L4_ADMIN_OWNER',
      status: 'ACTIVE',
      permissionsVersion: 1
    });
    const rows = await pool.query<{
      display_name: string;
      guild_id: string;
      discord_user_id: string;
      level: string;
      staff_status: string;
      role_source: string;
    }>(`
      SELECT u.display_name, da.guild_id, da.discord_user_id,
             staff.level::text, staff.status::text AS staff_status, staff.role_source::text
        FROM users u
        JOIN discord_accounts da ON da.user_id = u.id
        JOIN staff_accounts staff ON staff.user_id = u.id
       WHERE da.guild_id = $1 AND da.discord_user_id = $2
    `, [guildId, discordUserId]);
    expect(rows.rows).toEqual([{
      display_name: 'Bootstrap Owner',
      guild_id: guildId,
      discord_user_id: discordUserId,
      level: 'L4_ADMIN_OWNER',
      staff_status: 'ACTIVE',
      role_source: 'BOOTSTRAP'
    }]);
    const auditRows = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs WHERE action = 'BOOTSTRAP_L4_OWNER'`
    );
    expect(auditRows.rows[0]?.count).toBe('1');
  });
});
