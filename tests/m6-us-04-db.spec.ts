import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresCustomerProfileStore } from '@blackcat/api/customer-profiles';
import { PostgresAdminDirectoryStore } from '@blackcat/api/admin-directory';

const execFile = promisify(execFileCallback);
const customerId = '00000000-0000-0000-0000-000000006610';
const playerId = '00000000-0000-0000-0000-000000006611';
const staffId = '00000000-0000-0000-0000-000000006612';
const otherStaffId = '00000000-0000-0000-0000-000000006613';
const guildId = '900000000000006600';
const now = new Date('2026-07-19T18:00:00.000Z');
let root = ''; let data = ''; let pool: Pool;

describe('M6-US-04 customer profile persistence contract', () => {
  test('defines customer profile notes without a current Provider balance model in both Prisma mirrors', () => {
    for (const path of ['database/prisma/schema.prisma', 'outputs/P0开发交付包/03-数据模型/schema.prisma']) {
      const schema = readFileSync(path, 'utf8');
      expect(schema).not.toContain('model ProviderBalanceSnapshot');
      expect(schema).toContain('model CustomerProfileNote');
      expect(schema).toMatch(/model CustomerProfileNote[\s\S]*guildId\s+String\?/u);
    }
  });

  test('ships an upgrade migration with immutable snapshot and note guards', () => {
    const path = 'database/prisma/migrations/000006_m6_customer_profiles/migration.sql';
    expect(existsSync(path)).toBe(true);
    const migration = existsSync(path) ? readFileSync(path, 'utf8') : '';
    expect(migration).toContain('provider_balance_snapshots');
    expect(migration).toContain('customer_profile_notes');
    expect(migration).toContain('trg_provider_balance_snapshots_append_only');
    expect(migration).toContain('trg_customer_profile_notes_append_only');
  });

  test('ships a fail-closed Guild provenance migration for profile notes', () => {
    const path = 'database/prisma/migrations/000008_m6_profile_note_guild/migration.sql';
    expect(existsSync(path)).toBe(true);
    const migration = existsSync(path) ? readFileSync(path, 'utf8') : '';
    expect(migration).toContain('ADD COLUMN guild_id');
    expect(migration).not.toMatch(/UPDATE customer_profile_notes SET guild_id/u);
  });

  beforeAll(async () => {
    const port = 62_000 + (process.pid % 200); root = await mkdtemp(join(tmpdir(), 'blackcat-m6-profile-')); data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m6_profile']);
    for (const migration of ['000001_p0_baseline','000002_m6_settlements','000003_m6_settlement_review','000004_m6_weekly_reports','000005_m6_weekly_report_review_fixes','000006_m6_customer_profiles','000008_m6_profile_note_guild']) {
      await execFile('psql', ['-h', root, '-p', String(port), '-d', 'blackcat_m6_profile', '-v', 'ON_ERROR_STOP=1', '-f', `database/prisma/migrations/${migration}/migration.sql`]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m6_profile', max: 6 });
  }, 30_000);
  beforeEach(async () => { await pool.query('TRUNCATE TABLE users RESTART IDENTITY CASCADE'); await seed(); });
  afterAll(async () => { await pool?.end().catch(() => undefined); if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined); if (root) await rm(root, { recursive: true, force: true }); });

  test('applies the same customer predicate to L1 assignments and L2 trusted Guild scope', async () => {
    const store = new PostgresCustomerProfileStore(pool);
    expect(await store.canReadCustomer({ userId: customerId, actorStaffId: staffId, actorLevel: 'L1_SUPPORT', guildId })).toBe(true);
    expect(await store.canReadCustomer({ userId: customerId, actorStaffId: otherStaffId, actorLevel: 'L1_SUPPORT', guildId })).toBe(false);
    expect(await store.canReadCustomer({ userId: customerId, actorStaffId: otherStaffId, actorLevel: 'L2_SUPERVISOR', guildId })).toBe(true);
    expect(await store.canReadCustomer({ userId: customerId, actorStaffId: otherStaffId, actorLevel: 'L2_SUPERVISOR', guildId: 'other-guild' })).toBe(false);
  });

  test('queries statistics and cursor pages without confidential joins', async () => {
    const store = new PostgresCustomerProfileStore(pool);
    const scope = { userId: customerId, actorStaffId: staffId, actorLevel: 'L1_SUPPORT' as const, guildId };
    const summary = await store.getSummaryData({ ...scope, window: 'DAYS_30', now });
    expect(summary?.statistics).toMatchObject({ orderCount: 2, completedOrderCount: 1, cancelledOrderCount: 1, refundCount: 1,
      orderSpendMinor: 10_001, giftSpendMinor: 2_500, refundMinor: 1_500, totalConsumptionMinor: 11_001, averageOrderAmountMinor: 10_001 });
    expect(summary?.internalNotes).toEqual([{ id: '00000000-0000-0000-0000-000000006651', text: 'DB note', createdAt: '2026-07-18T13:00:00.000Z' }]);
    const otherGuildSummary = await store.getSummaryData({ ...scope, guildId: '900000000000006699', actorLevel: 'L2_SUPERVISOR', window: 'DAYS_30', now });
    expect(otherGuildSummary?.internalNotes).toEqual([{ id: '00000000-0000-0000-0000-000000006652', text: 'Other Guild note', createdAt: '2026-07-18T14:00:00.000Z' }]);
    const first = await store.listOrders({ ...scope, cursor: null, limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toEqual(expect.any(String));
    const second = await store.listOrders({ ...scope, cursor: first.nextCursor, limit: 1 });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const admin = new PostgresAdminDirectoryStore(pool);
    const finance = await (admin.listUserConsumptions as (input: { cursor: null; limit: number; userId: string; guildId: string }) => Promise<{ items: Array<{ id: string }> }>)
      ({ cursor: null, limit: 20, userId: customerId, guildId });
    expect(finance.items.map((item) => item.id)).not.toContain('00000000-0000-0000-0000-000000006674');
  });

  test('does not expose legacy Provider snapshots and rejects note mutation', async () => {
    const store = new PostgresCustomerProfileStore(pool);
    expect('appendBalanceSnapshot' in store).toBe(false);
    expect('getLatestBalanceSnapshot' in store).toBe(false);
    await expect(pool.query('DELETE FROM customer_profile_notes WHERE id=$1', ['00000000-0000-0000-0000-000000006651'])).rejects.toThrow(/append-only/u);
  });

  test('atomically appends notes only inside the same customer scope', async () => {
    const store = new PostgresCustomerProfileStore(pool);
    const appended = await store.appendNote({userId: customerId, actorStaffId: staffId, actorLevel: 'L1_SUPPORT', guildId, body: '老板要求晚些回访', now});
    expect(appended).toMatchObject({text: '老板要求晚些回访', createdAt: now.toISOString()});
    await expect(store.appendNote({userId: customerId, actorStaffId: otherStaffId, actorLevel: 'L1_SUPPORT', guildId, body: '越权备注', now}))
      .rejects.toMatchObject({code: 'NOT_FOUND'});
    const rows = await pool.query('SELECT body,author_staff_id,guild_id FROM customer_profile_notes WHERE id=$1', [appended.id]);
    expect(rows.rows).toEqual([{body: '老板要求晚些回访', author_staff_id: staffId, guild_id: guildId}]);
    await expect(pool.query('UPDATE customer_profile_notes SET body=$2 WHERE id=$1', [appended.id, 'edited'])).rejects.toThrow(/append-only/u);
  });
});

async function seed() {
  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
    ($1,'Customer','ACTIVE',1,now(),now()),($2,'Player','ACTIVE',1,now(),now()),($3,'Support','ACTIVE',1,now(),now()),($4,'Other','ACTIVE',1,now(),now())`, [customerId, playerId, staffId, otherStaffId]);
  await pool.query(`INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
    ($1,$1,'L1_SUPPORT','ACTIVE','MANUAL',1,now(),now()),($2,$2,'L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now())`, [staffId, otherStaffId]);
  await pool.query(`INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
    ('00000000-0000-0000-0000-000000006621',$1,$2,'900000000000006610',now(),now(),now()),
    ('00000000-0000-0000-0000-000000006623',$1,'900000000000006699','900000000000006610',now(),now(),now())`, [customerId, guildId]);
  await pool.query(`INSERT INTO external_accounts (id,user_id,provider,external_user_id,status,active_user_provider_key,verified_at,created_at,updated_at) VALUES
    ('00000000-0000-0000-0000-000000006622',$1,'mock','provider-secret-1234','ACTIVE','profile:mock',now(),now(),now())`, [customerId]);
  await pool.query(`INSERT INTO orders (id,public_id,customer_id,player_id,status,row_version,game_code_snapshot,service_code_snapshot,amount_minor,currency,guild_id,completed_at,cancelled_at,created_at,updated_at) VALUES
    ('00000000-0000-0000-0000-000000006631','P-6631',$1,$2,'COMPLETED',1,'VALORANT','RANKED',10001,'CAT',$3,'2026-07-18T12:00:00Z',NULL,'2026-07-18T10:00:00Z','2026-07-18T12:00:00Z'),
    ('00000000-0000-0000-0000-000000006632','P-6632',$1,$2,'CANCELLED',1,'VALORANT','RANKED',20000,'CAT',$3,NULL,'2026-07-17T12:00:00Z','2026-07-17T10:00:00Z','2026-07-17T12:00:00Z'),
    ('00000000-0000-0000-0000-000000006633','P-XGUILD',$1,$2,'COMPLETED',1,'VALORANT','RANKED',90000,'CAT','900000000000006699','2026-07-18T14:00:00Z',NULL,'2026-07-18T13:00:00Z','2026-07-18T14:00:00Z')`, [customerId, playerId, guildId]);
  await pool.query(`INSERT INTO staff_tasks (id,public_id,type,reason_code,status,row_version,order_id,claimed_by_staff_id,context_snapshot,claimed_at,created_at,updated_at) VALUES
    ('00000000-0000-0000-0000-000000006641','T-6641','ORDER_ASSIST','CUSTOMER_ASSIST','CLAIMED',1,'00000000-0000-0000-0000-000000006631',$1,'{}',now(),now(),now())`, [staffId]);
  await pool.query(`INSERT INTO consumption_entries (id,user_id,entry_type,direction,order_id,source_type,source_id,idempotency_key,amount_minor,currency,occurred_at,created_at) VALUES
    ('00000000-0000-0000-0000-000000006671',$1,'ORDER_CHARGE','DEBIT','00000000-0000-0000-0000-000000006631','ORDER','00000000-0000-0000-0000-000000006631','profile:order',10001,'CAT','2026-07-18T12:05:00Z',now()),
    ('00000000-0000-0000-0000-000000006672',$1,'GIFT_CHARGE','DEBIT','00000000-0000-0000-0000-000000006631','GIFT','00000000-0000-0000-0000-000000006681','profile:gift',2500,'CAT','2026-07-18T12:06:00Z',now()),
    ('00000000-0000-0000-0000-000000006673',$1,'REFUND_REVERSAL','CREDIT','00000000-0000-0000-0000-000000006631','REFUND','00000000-0000-0000-0000-000000006682','profile:refund',1500,'CAT','2026-07-18T12:07:00Z',now()),
    ('00000000-0000-0000-0000-000000006674',$1,'ORDER_CHARGE','DEBIT','00000000-0000-0000-0000-000000006633','ORDER','00000000-0000-0000-0000-000000006633','profile:cross-guild',90000,'CAT','2026-07-18T14:05:00Z',now())`, [customerId]);
  await pool.query(`INSERT INTO customer_profile_notes (id,user_id,guild_id,author_staff_id,body,created_at) VALUES
    ('00000000-0000-0000-0000-000000006651',$1,$2,$3,'DB note','2026-07-18T13:00:00Z'),
    ('00000000-0000-0000-0000-000000006652',$1,'900000000000006699',$3,'Other Guild note','2026-07-18T14:00:00Z')`, [customerId, guildId, staffId]);
}
