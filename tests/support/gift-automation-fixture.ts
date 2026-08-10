import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool, type QueryResult } from 'pg';
import type { AccountBindingRecord } from '@blackcat/api/accounts';
import { applyCurrentMigrations } from './postgres-migrations';

const execFile = promisify(execFileCallback);

type Queryable = {
  query(sql: string, values?: readonly unknown[]): Promise<Pick<QueryResult, 'rows'>>;
};

export interface IsolatedGiftDatabase {
  database: string;
  host: string;
  port: number;
  root: string;
  pool: Pool;
  stop(): Promise<void>;
}

export interface GiftFactSnapshot {
  giftRequests: number;
  reservations: number;
  reservationEvents: number;
  staffTasks: number;
  consumptions: number;
  announcementJobs: number;
  expiryJobs: number;
  audits: number;
}

export interface GiftAutomationSeed {
  guildId: string;
  customerId: string;
  customerDiscordId: string;
  playerId: string;
  playerDiscordId: string;
  playerProfileId: string;
  staffId: string;
  staffUserId: string;
  staffDiscordId: string;
  catalogItemId: string;
  catalogVersionId: string;
  walletAccountId: string;
  priceMinor: number;
  balanceMinor: number;
  customerBinding: AccountBindingRecord;
}

export async function startIsolatedGiftDatabase(label: string): Promise<IsolatedGiftDatabase> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  if (!safeLabel) throw new Error('INVALID_GIFT_TEST_DATABASE_LABEL');

  const port = await reserveAvailablePort();
  // PostgreSQL Unix sockets have a short platform path limit. Keep the isolated
  // root below it instead of inheriting macOS's long per-user TMPDIR path.
  const root = await mkdtemp(join('/tmp', `blackcat-m22-gift-${safeLabel}-`));
  const data = join(root, 'data');
  const database = `blackcat_m22_gift_${safeLabel}_${process.pid}`;
  let pool: Pool | undefined;
  let started = false;
  let stopped = false;

  try {
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    started = true;
    await execFile('createdb', ['-h', root, '-p', String(port), database]);
    await applyCurrentMigrations({ host: root, port, database });
    pool = new Pool({ host: root, port, database, max: 8 });
    await assertGiftTestDatabase(pool);

    return {
      database,
      host: root,
      port,
      root,
      pool,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await pool?.end().catch(() => undefined);
        if (started) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    if (started) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function assertGiftTestDatabase(database: Queryable): Promise<void> {
  const result = await database.query(`SELECT current_database() AS database_name,
    current_setting('unix_socket_directories', true) AS socket_path`);
  const identity = result.rows[0] as { database_name?: unknown; socket_path?: unknown } | undefined;
  const databaseName = String(identity?.database_name ?? '');
  const socketPath = String(identity?.socket_path ?? '');
  if (!/^blackcat_m22_gift_[a-z0-9_]+_[0-9]+$/u.test(databaseName)
      || !socketPath.includes('blackcat-m22-gift-')) {
    throw new Error(`UNSAFE_GIFT_TEST_DATABASE:${databaseName}:${socketPath}`);
  }
}

export async function snapshotGiftFacts(database: Queryable): Promise<GiftFactSnapshot> {
  const result = await database.query(`SELECT
    (SELECT count(*)::int FROM gift_requests) AS gift_requests,
    (SELECT count(*)::int FROM fund_reservations WHERE source_type='GIFT') AS reservations,
    (SELECT count(*)::int FROM fund_reservation_events event
      JOIN fund_reservations reservation ON reservation.id=event.fund_reservation_id
      WHERE reservation.source_type='GIFT') AS reservation_events,
    (SELECT count(*)::int FROM staff_tasks WHERE type='GIFT_REVIEW') AS staff_tasks,
    (SELECT count(*)::int FROM consumption_entries WHERE entry_type='GIFT_CHARGE') AS consumptions,
    (SELECT count(*)::int FROM outbox_events WHERE event_type='GIFT_ANNOUNCEMENT') AS announcement_jobs,
    (SELECT count(*)::int FROM outbox_events WHERE event_type='GIFT_EXPIRY') AS expiry_jobs,
    (SELECT count(*)::int FROM audit_logs WHERE target_type ILIKE 'gift%') AS audits`);
  const row = result.rows[0] as Record<string, number | string>;
  return {
    giftRequests: Number(row.gift_requests),
    reservations: Number(row.reservations),
    reservationEvents: Number(row.reservation_events),
    staffTasks: Number(row.staff_tasks),
    consumptions: Number(row.consumptions),
    announcementJobs: Number(row.announcement_jobs),
    expiryJobs: Number(row.expiry_jobs),
    audits: Number(row.audits)
  };
}

export async function seedGiftAutomationScenario(pool: Pool, input: {
  sequence: number;
  now: Date;
  balanceMinor?: number;
  priceMinor?: number;
  playerReviewStatus?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED';
  staffLevel?: 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
}): Promise<GiftAutomationSeed> {
  if (!Number.isInteger(input.sequence) || input.sequence < 1 || input.sequence > 9_000) {
    throw new Error('INVALID_GIFT_TEST_SEQUENCE');
  }
  await assertGiftTestDatabase(pool);
  const id = (offset: number) => `00000000-0000-0000-0000-${String(input.sequence * 100 + offset).padStart(12, '0')}`;
  const snowflake = (offset: number) => `9${String(input.sequence * 100 + offset).padStart(17, '0')}`;
  const guildId = snowflake(1);
  const customerId = id(1);
  const playerId = id(2);
  const staffUserId = id(3);
  const staffId = id(4);
  const playerProfileId = id(5);
  const catalogItemId = id(6);
  const catalogVersionId = id(7);
  const walletAccountId = id(8);
  const customerDiscordId = snowflake(2);
  const playerDiscordId = snowflake(3);
  const staffDiscordId = snowflake(4);
  const priceMinor = input.priceMinor ?? 5_200;
  const balanceMinor = input.balanceMinor ?? 20_000;

  await pool.query(`INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ($1,'老板测试账号','ACTIVE',1,$4,$4),($2,'陪玩测试账号','ACTIVE',1,$4,$4),($3,'客服测试账号','ACTIVE',1,$4,$4)`,
  [customerId, playerId, staffUserId, input.now]);
  await pool.query(`INSERT INTO staff_accounts
      (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES ($1,$2,$3,'ACTIVE','MANUAL',1,$4,$4)`,
  [staffId, staffUserId, input.staffLevel ?? 'L3_OPERATIONS', input.now]);
  await pool.query(`INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      ($1,$2,$3,$4,$7,$7,$7),($5,$6,$3,$8,$7,$7,$7),($9,$10,$3,$11,$7,$7,$7)`,
  [id(9), customerId, guildId, customerDiscordId, id(10), playerId, input.now, playerDiscordId,
    id(11), staffUserId, staffDiscordId]);
  await pool.query(`INSERT INTO player_profiles
      (id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at)
      VALUES ($1,$2,$3,1,'AVAILABLE','ONLINE',$4,$4)`,
  [playerProfileId, playerId, input.playerReviewStatus ?? 'ACTIVE', input.now]);
  await pool.query(`INSERT INTO gift_catalog_items (id,code,created_at,updated_at) VALUES ($1,$2,$3,$3)`,
    [catalogItemId, `GIFT_${input.sequence}`, input.now]);
  await pool.query(`INSERT INTO gift_catalog_versions
      (id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at)
      VALUES ($1,$2,1,'ACTIVE',$2,$3,$4,'CAT','{sender_name} 向 {receiver_name} 送出 {gift_name}',$5,$6,$6)`,
  [catalogVersionId, catalogItemId, `测试礼物 ${input.sequence}`, priceMinor, staffId, input.now]);
  await pool.query(`INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
      VALUES ($1,$2,'CAT','ACTIVE',1,$3,$3)`, [walletAccountId, customerId, input.now]);
  await pool.query(`INSERT INTO wallet_entries
      (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES ($1,$2,'TOP_UP_CREDIT','CREDIT',$3,'CAT','TOP_UP',$4,$5,$6,$6)`,
  [id(12), walletAccountId, balanceMinor, id(13), `m22:gift:seed:${input.sequence}`, input.now]);

  return {
    guildId, customerId, customerDiscordId, playerId, playerDiscordId, playerProfileId,
    staffId, staffUserId, staffDiscordId, catalogItemId, catalogVersionId, walletAccountId,
    priceMinor, balanceMinor,
    customerBinding: {
      userId: customerId,
      displayName: '老板测试账号',
      userStatus: 'ACTIVE',
      userVersion: 1,
      discordAccountId: id(9),
      guildId,
      discordUserId: customerDiscordId,
      boundAt: input.now.toISOString()
    }
  };
}

async function reserveAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('GIFT_TEST_DATABASE_PORT_UNAVAILABLE');
  return port;
}
