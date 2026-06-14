import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { IMMUTABLE_RECORD_TABLES } from '@blackcat/database/immutable-records';

const execFile = promisify(execFileCallback);
let root = '';
let data = '';
let port = 0;
let pool: Pool;

describe('M10-US-02 multi-player persistence', () => {
  beforeAll(async () => {
    port = 62_200 + (process.pid % 200);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m10-participants-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m10_participants']);
    const migrations = (await readdir('database/prisma/migrations')).filter((name) => name < '000019').sort();
    for (const migration of migrations) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m10_participants', '-v', 'ON_ERROR_STOP=1', '-f', `database/prisma/migrations/${migration}/migration.sql`]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m10_participants' });
    await seedLegacyOrder();
    await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m10_participants', '-v', 'ON_ERROR_STOP=1', '-f', 'database/prisma/migrations/000019_multi_player_order_participants/migration.sql']);
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('creates participant projections and append-only events with independent project snapshots', async () => {
    const migration = await readFile('database/prisma/migrations/000019_multi_player_order_participants/migration.sql', 'utf8');

    expect(migration).toContain('CREATE TABLE "order_participants"');
    expect(migration).toContain('CREATE TABLE "order_participant_events"');
    expect(migration).toContain('service_catalog_version_id');
    expect(migration).toContain('service_display_name_snapshot');
    expect(migration).toContain('customer_unit_price_minor_snapshot');
    expect(migration).toContain('INSERT INTO order_participants');
    expect(migration).toContain('trg_order_participant_events_append_only');
    expect(migration).toContain('order_participants_one_active_player_idx');
  });

  test('protects participant history and links new earnings to one participant', async () => {
    const [migration, schema] = await Promise.all([
      readFile('database/prisma/migrations/000019_multi_player_order_participants/migration.sql', 'utf8'),
      readFile('database/prisma/schema.prisma', 'utf8')
    ]);

    expect(IMMUTABLE_RECORD_TABLES).toContain('order_participant_events');
    expect(migration).toContain('ADD COLUMN order_participant_id UUID');
    expect(migration).toContain('player_earnings_order_participant_id_key');
    expect(schema).toMatch(/model PlayerEarning[\s\S]*?orderParticipantId/u);
  });

  test('backfills a legacy accepted player with immutable project and earning linkage', async () => {
    const result = await pool.query(`SELECT participant.player_id,participant.service_code_snapshot,participant.service_display_name_snapshot,
      participant.compensation_source::text,participant.line_price_minor::text,event.event_type::text,earning.order_participant_id
      FROM order_participants participant
      JOIN order_participant_events event ON event.order_participant_id=participant.id
      JOIN player_earnings earning ON earning.order_participant_id=participant.id`);
    expect(result.rows[0]).toMatchObject({
      player_id: '00000000-0000-0000-0000-000000001002', service_code_snapshot: 'TECH',
      service_display_name_snapshot: '技术陪玩', compensation_source: 'LEGACY_ORDER_SNAPSHOT',
      line_price_minor: '900', event_type: 'ADDED', order_participant_id: expect.any(String)
    });
    await expect(pool.query('DELETE FROM order_participant_events')).rejects.toThrow(/append-only|immutable/i);
  });
});

async function seedLegacyOrder(): Promise<void> {
  await pool.query(`
    INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000001001','老板','ACTIVE',1,now(),now()),
      ('00000000-0000-0000-0000-000000001002','技术猫','ACTIVE',1,now(),now()),
      ('00000000-0000-0000-0000-000000001003','店主','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES('00000000-0000-0000-0000-000000001003','00000000-0000-0000-0000-000000001003','L4_ADMIN_OWNER','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at)
      VALUES('00000000-0000-0000-0000-000000001010','VAL-TECH-NA','VALORANT','瓦洛兰特','TECH','技术陪玩','NA',now(),now());
    INSERT INTO service_catalog_versions(id,service_offering_id,version,status,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at)
      VALUES('00000000-0000-0000-0000-000000001011','00000000-0000-0000-0000-000000001010',1,'ACTIVE',60,1,300,180,6000,'CAT','00000000-0000-0000-0000-000000001003',now());
    INSERT INTO orders(id,public_id,customer_id,player_id,status,row_version,service_catalog_version_id,catalog_version,
      game_code_snapshot,game_name_snapshot,service_code_snapshot,service_name_snapshot,region_code_snapshot,region_name_snapshot,
      billing_unit_minutes,unit_count,customer_unit_price_minor,player_unit_payout_minor,amount_minor,expected_player_earning_minor,
      currency,guild_id,channel_id,panel_message_id,created_at,updated_at)
      VALUES('00000000-0000-0000-0000-000000001020','P-M10-LEGACY','00000000-0000-0000-0000-000000001001','00000000-0000-0000-0000-000000001002','COMPLETED',3,
      '00000000-0000-0000-0000-000000001011',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,3,300,180,900,540,'CAT','999999999999999999','111111111111111111','222222222222222222',now(),now());
    INSERT INTO player_earnings(id,order_id,player_user_id,base_units,unit_payout_minor,amount_minor,currency,status,row_version,created_at,updated_at)
      VALUES('00000000-0000-0000-0000-000000001030','00000000-0000-0000-0000-000000001020','00000000-0000-0000-0000-000000001002',3,180,540,'CAT','PENDING',1,now(),now());
  `);
}
