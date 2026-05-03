import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresAccountStore,
  type AccountBindingRecord
} from '@blackcat/api/accounts';
import { type AuditRecord, InMemoryAuditSink } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-17T18:00:00.000Z');

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M1-US-02 Postgres account binding integration', () => {
  beforeAll(async () => {
    port = 56_000 + (process.pid % 1_000);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m1-account-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m1_account']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m1_account',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m1_account',
      application_name: 'blackcat_m1_account_test',
      max: 4
    });
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

  test('commits user, Discord account, external account and audit atomically', async () => {
    const store = new PostgresAccountStore({ pool });
    await store.commitBinding({
      binding: binding(),
      auditRecord: auditRecord(),
      auditSink: new InMemoryAuditSink()
    });

    await expect(
      store.findByDiscord({
        guildId: '999999999999999999',
        discordUserId: '111111111111111111'
      })
    ).resolves.toMatchObject({
      userId: '00000000-0000-0000-0000-00000000a001',
      externalAccountId: '00000000-0000-0000-0000-00000000e001',
      externalUserDisplay: 'mock-***-ok'
    });
    await expect(
      store.findByExternal({
        provider: 'mock-provider',
        externalUserId: 'mock-user-ok'
      })
    ).resolves.toMatchObject({
      discordUserId: '111111111111111111'
    });
    const audit = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_logs WHERE action = 'CREATE_BINDING'"
    );
    expect(audit.rows[0]?.count).toBe('1');
  });

  test('sums only active reservation statuses for the balance summary', async () => {
    const store = new PostgresAccountStore({ pool });
    await pool.query(`
INSERT INTO orders (id, public_id, customer_id, status, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000b001', 'P-M1-ACC-1', '00000000-0000-0000-0000-00000000a001', 'CANCELLED', now()),
  ('00000000-0000-0000-0000-00000000b002', 'P-M1-ACC-2', '00000000-0000-0000-0000-00000000a001', 'CANCELLED', now()),
  ('00000000-0000-0000-0000-00000000b003', 'P-M1-ACC-3', '00000000-0000-0000-0000-00000000a001', 'CANCELLED', now());

INSERT INTO fund_reservations (
  id, user_id, source_type, order_id, mode, amount_minor, currency, status, idempotency_key, updated_at
)
VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000a001', 'ORDER', '00000000-0000-0000-0000-00000000b001', 'LOCAL_RESERVATION_FALLBACK', 12000, 'CNY', 'PENDING', 'm1-account-r1', now()),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000a001', 'ORDER', '00000000-0000-0000-0000-00000000b002', 'LOCAL_RESERVATION_FALLBACK', 8000, 'CNY', 'ACTIVE', 'm1-account-r2', now()),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000a001', 'ORDER', '00000000-0000-0000-0000-00000000b003', 'LOCAL_RESERVATION_FALLBACK', 5000, 'CNY', 'RELEASED', 'm1-account-r3', now());
    `);

    await expect(
      store.sumActiveReservations({
        userId: '00000000-0000-0000-0000-00000000a001',
        currency: 'CNY'
      })
    ).resolves.toBe(20_000);
  });

  test('rolls back binding records when the audit insert fails', async () => {
    const store = new PostgresAccountStore({ pool });

    await expect(
      store.commitBinding({
        binding: binding({
          userId: '00000000-0000-0000-0000-00000000a002',
          discordAccountId: '00000000-0000-0000-0000-00000000d002',
          discordUserId: '222222222222222222',
          externalAccountId: '00000000-0000-0000-0000-00000000e002',
          externalUserId: 'mock-user-low',
          externalUserDisplay: 'mock-***-low',
          displayName: 'mock-***-low'
        }),
        auditRecord: { ...auditRecord(), id: 'not-a-uuid' },
        auditSink: new InMemoryAuditSink()
      })
    ).rejects.toThrow();

    await expect(
      store.findByDiscord({
        guildId: '999999999999999999',
        discordUserId: '222222222222222222'
      })
    ).resolves.toBeNull();
  });

  test('rolls back direct createBinding when a later uniqueness check fails', async () => {
    const store = new PostgresAccountStore({ pool });

    await expect(
      store.createBinding(
        binding({
          userId: '00000000-0000-0000-0000-00000000a003',
          discordAccountId: '00000000-0000-0000-0000-00000000d003',
          discordUserId: '333333333333333333',
          externalAccountId: '00000000-0000-0000-0000-00000000e003',
          externalUserId: 'mock-user-ok'
        })
      )
    ).rejects.toMatchObject({ code: 'BINDING_CONFLICT' });

    await expect(
      store.findByDiscord({
        guildId: '999999999999999999',
        discordUserId: '333333333333333333'
      })
    ).resolves.toBeNull();
  });
});

function binding(overrides: Partial<AccountBindingRecord> = {}): AccountBindingRecord {
  return {
    userId: '00000000-0000-0000-0000-00000000a001',
    displayName: 'mock-***-ok',
    userStatus: 'ACTIVE',
    userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-00000000d001',
    guildId: '999999999999999999',
    discordUserId: '111111111111111111',
    externalAccountId: '00000000-0000-0000-0000-00000000e001',
    provider: 'mock-provider',
    externalUserId: 'mock-user-ok',
    externalUserDisplay: 'mock-***-ok',
    externalAccountStatus: 'ACTIVE',
    boundAt: now.toISOString(),
    ...overrides
  };
}

function auditRecord(): AuditRecord {
  return {
    id: '00000000-0000-0000-0000-00000000a100',
    actorId: null,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT',
    interactionId: '777777777777777777',
    permissionCode: 'account.bind',
    action: 'CREATE_BINDING',
    targetType: 'external_account_binding',
    targetId: '00000000-0000-0000-0000-000000000000',
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: 'req_binding_db',
    approvalRequestId: null,
    occurredAt: now.toISOString()
  };
}
