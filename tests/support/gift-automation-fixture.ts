import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool, type QueryResult } from 'pg';
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
  audits: number;
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
    (SELECT count(*)::int FROM outbox_events WHERE gift_request_id IS NOT NULL) AS announcement_jobs,
    (SELECT count(*)::int FROM audit_logs WHERE target_type LIKE 'GIFT%') AS audits`);
  const row = result.rows[0] as Record<string, number | string>;
  return {
    giftRequests: Number(row.gift_requests),
    reservations: Number(row.reservations),
    reservationEvents: Number(row.reservation_events),
    staffTasks: Number(row.staff_tasks),
    consumptions: Number(row.consumptions),
    announcementJobs: Number(row.announcement_jobs),
    audits: Number(row.audits)
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
