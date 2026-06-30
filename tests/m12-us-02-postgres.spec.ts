import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresSupportOperationsStore } from '@blackcat/api/support-operations';

const execFile = promisify(execFileCallback);
const guildId = '999999999999999999';
const staffIds = ['00000000-0000-0000-0000-000000012001', '00000000-0000-0000-0000-000000012002', '00000000-0000-0000-0000-000000012003'];
let root = '';
let data = '';
let pool: Pool;

describe('M12-US-02 PostgreSQL shifts', () => {
  beforeAll(async () => {
    const port = 62_900 + (process.pid % 80);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m12-support-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m12_support']);
    for (const migration of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m12_support', '-v', 'ON_ERROR_STOP=1', '-f', `database/prisma/migrations/${migration}/migration.sql`]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m12_support', max: 4 });
    await pool.query(`INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
      ($1,'一线客服','ACTIVE',1,now(),now()),($2,'客服主管','ACTIVE',1,now(),now()),($3,'运营支援','ACTIVE',1,now(),now())`, staffIds);
    await pool.query(`INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ($1,$1,'L1_SUPPORT','ACTIVE','MANUAL',1,now(),now()),
      ($2,$2,'L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now()),
      ($3,$3,'L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now())`, staffIds);
    await pool.query(`INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      (gen_random_uuid(),$1,$4,'111111111111111111',now(),now(),now()),
      (gen_random_uuid(),$2,$4,'222222222222222222',now(),now(),now()),
      (gen_random_uuid(),$3,$4,'333333333333333333',now(),now(),now())`, [...staffIds, guildId]);
  }, 40_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('serializes concurrent clock-ins and includes an ACTIVE L3 support actor in a supervisor summary', async () => {
    const store = new PostgresSupportOperationsStore(pool);
    const now = new Date('2026-08-05T16:00:00.000Z');
    const [first, second] = await Promise.all([
      store.clockIn({ guildId, staffId: staffIds[0]!, now }),
      store.clockIn({ guildId, staffId: staffIds[0]!, now })
    ]);
    expect(second.id).toBe(first.id);
    expect((await pool.query('SELECT count(*)::int count FROM support_shifts WHERE clocked_out_at IS NULL')).rows[0].count).toBe(1);
    const summary = await store.summary({ guildId, staffId: staffIds[1]!, actorLevel: 'L2_SUPERVISOR', now });
    expect(summary.items.map((item) => item.staffId)).toEqual(staffIds);
    expect(summary.items[0]).toMatchObject({ clockedIn: true, shiftSeconds: 0 });
  });
});
