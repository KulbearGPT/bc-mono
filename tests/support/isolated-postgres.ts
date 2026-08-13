import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { applyCurrentMigrations } from './postgres-migrations';
import { emitNonUiFailureContext } from './non-ui-failure-context';

const execFile = promisify(execFileCallback);
const isolatedBase = process.platform === 'darwin' ? '/tmp' : tmpdir();
const databasePattern = /^blackcat_non_ui_[a-z0-9_]+_[0-9]+_[a-f0-9]{8}$/u;
const rootPrefix = resolve(isolatedBase, 'blackcat-non-ui-');

export interface IsolatedPostgres {
  database: string;
  dataDir: string;
  port: number;
  root: string;
  socketDir: string;
  pool: Pool;
  stop(options?: { failed?: boolean; keepFailed?: boolean }): Promise<void>;
}

export function assertIsolatedPostgresTarget(input: {
  database: string;
  host: string;
  root: string;
  nodeEnv?: string;
}): void {
  const normalizedRoot = resolve(input.root);
  const normalizedHost = resolve(input.host);
  if (input.nodeEnv !== 'test') throw new Error('Isolated PostgreSQL requires NODE_ENV=test.');
  if (!databasePattern.test(input.database)) throw new Error(`Unsafe isolated database name: ${input.database}`);
  if (!isAbsolute(input.host) || normalizedHost !== normalizedRoot) {
    throw new Error('Isolated PostgreSQL must use its owned Unix socket directory as host.');
  }
  if (!normalizedRoot.startsWith(rootPrefix)) {
    throw new Error(`Unsafe isolated PostgreSQL root: ${normalizedRoot}`);
  }
}

export function isExpectedIsolatedPostgresShutdownError(error: unknown, stopping: boolean): boolean {
  return (
    stopping &&
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '57P01'
  );
}

export async function verifyIsolatedPostgresEnvironment(): Promise<void> {
  await Promise.all(['initdb', 'pg_ctl', 'createdb', 'psql'].map((binary) => execFile(binary, ['--version'])));
}

export async function startIsolatedPostgres(
  label: string,
  options: { excludeMigrations?: string[] } = {}
): Promise<IsolatedPostgres> {
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 24);
  if (!safeLabel) throw new Error('Isolated PostgreSQL label must contain an ASCII letter or digit.');
  if (process.env.NODE_ENV !== 'test') throw new Error('Isolated PostgreSQL may only start under NODE_ENV=test.');
  await verifyIsolatedPostgresEnvironment();

  // macOS has a short Unix-socket path limit, so the owned socket directory
  // uses /tmp and a shortened display label while the database keeps the full label.
  const root = await mkdtemp(join(isolatedBase, `blackcat-non-ui-${safeLabel.slice(0, 12)}-`));
  const dataDir = join(root, 'data');
  const database = `blackcat_non_ui_${safeLabel}_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const port = 62_700 + (process.pid % 500);
  let started = false;
  let pool: Pool | undefined;
  let stopped = false;
  let stopping = false;
  const unexpectedPoolErrors: unknown[] = [];

  try {
    assertIsolatedPostgresTarget({ database, host: root, root, nodeEnv: process.env.NODE_ENV });
    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', [
      '-D',
      dataDir,
      '-o',
      `-p ${port} -k ${root} -c listen_addresses=''`,
      '-l',
      join(root, 'postgres.log'),
      'start'
    ]);
    started = true;
    await execFile('createdb', ['-h', root, '-p', String(port), database]);
    await applyCurrentMigrations({ host: root, port, database, exclude: options.excludeMigrations });
    pool = new Pool({ host: root, port, database, max: 8 });
    pool.on('error', (error) => {
      if (!isExpectedIsolatedPostgresShutdownError(error, stopping)) unexpectedPoolErrors.push(error);
    });
    await assertRunningIdentity(pool, { database, root });
    emitNonUiFailureContext({ database });

    const stop = async (options: { failed?: boolean; keepFailed?: boolean } = {}) => {
      if (stopped) return;
      stopped = true;
      stopping = true;
      const cleanupErrors: unknown[] = [];
      try {
        await pool?.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (started) {
        try {
          await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']);
          await assertPostgresStopped(dataDir);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      cleanupErrors.push(...unexpectedPoolErrors);
      const keep =
        options.failed === true && (options.keepFailed === true || process.env.NON_UI_KEEP_FAILED_DB === '1');
      if (!keep && cleanupErrors.length === 0) {
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          `Failed to stop isolated PostgreSQL ${database}; data retained at ${root}`
        );
      }
    };

    return { database, dataDir, port, root, socketDir: root, pool, stop };
  } catch (error) {
    stopping = true;
    const cleanupErrors: unknown[] = [];
    try {
      await pool?.end();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (started) {
      try {
        await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']);
        await assertPostgresStopped(dataDir);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    cleanupErrors.push(...unexpectedPoolErrors);
    if (cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Isolated PostgreSQL startup failed; data retained at ${root}`
      );
    }
    throw error;
  }
}

async function assertRunningIdentity(pool: Pool, input: { database: string; root: string }): Promise<void> {
  const result = await pool.query(`SELECT current_database() database,
    current_setting('listen_addresses') listen_addresses,
    current_setting('unix_socket_directories') socket_path`);
  const row = result.rows[0] as { database?: unknown; listen_addresses?: unknown; socket_path?: unknown } | undefined;
  if (
    row?.database !== input.database ||
    row.listen_addresses !== '' ||
    typeof row.socket_path !== 'string' ||
    !row.socket_path
      .split(',')
      .map((value) => value.trim())
      .includes(input.root)
  ) {
    throw new Error(`Refusing unexpected PostgreSQL identity: ${JSON.stringify(row)}`);
  }
}

async function assertPostgresStopped(dataDir: string): Promise<void> {
  try {
    await execFile('pg_ctl', ['-D', dataDir, 'status']);
  } catch {
    return;
  }
  throw new Error(`PostgreSQL is still running for ${dataDir}`);
}
