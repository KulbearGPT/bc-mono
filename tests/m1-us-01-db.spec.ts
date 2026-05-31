import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { PostgresServiceCatalogStore, type ServiceCatalogRecord } from '@blackcat/api/catalog';
import { InMemoryAuditSink, PostgresStaffDirectory, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-17T15:00:00.000Z');

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let client: Client;

describe('M1-US-01 Postgres catalog integration', () => {
  beforeAll(async () => {
    port = 55_000 + (process.pid % 1_000);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m1-catalog-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m1_catalog']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m1_catalog',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    client = new Client({
      host: socketDir,
      port,
      database: 'blackcat_m1_catalog',
      application_name: 'blackcat_m1_catalog_test'
    });
    await client.connect();
    await client.query(`
INSERT INTO users (id, display_name, updated_at)
VALUES ('00000000-0000-0000-0000-000000000033', 'Ops Staff', now());

INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, username, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000044',
  '00000000-0000-0000-0000-000000000033',
  '999999999999999999',
  '333333333333333333',
  'ops-staff',
  now()
);

INSERT INTO staff_accounts (id, user_id, level, role_source, mfa_enrolled, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000333',
  '00000000-0000-0000-0000-000000000033',
  'L3_OPERATIONS',
  'BOOTSTRAP',
  true,
  now()
);
    `);
  }, 30_000);

  afterAll(async () => {
    await client?.end().catch(() => undefined);
    if (dataDir) {
      await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']).catch(() => undefined);
    }
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('commits catalog versions and success audit in one database transaction', async () => {
    const store = new PostgresServiceCatalogStore({ client });
    await store.commit({
      records: [service()],
      auditRecord: auditRecord('CREATE_SERVICE_CATALOG_VERSION', 'INITIAL_CATALOG_VERSION'),
      auditSink: new InMemoryAuditSink()
    });

    const records = await store.list();
    const audit = await client.query<{ count: string; reason: string | null }>(
      "SELECT count(*) AS count, max(reason) AS reason FROM audit_logs WHERE action = 'CREATE_SERVICE_CATALOG_VERSION'"
    );

    expect(records).toEqual([service()]);
    expect(audit.rows[0]).toEqual({ count: '1', reason: 'INITIAL_CATALOG_VERSION' });
  });

  test('keyset-paginates catalog versions by createdAt and id', async () => {
    const store = new PostgresServiceCatalogStore({ client });
    await store.save(service({
      id: '00000000-0000-0000-0000-00000000d011',
      status: 'RETIRED',
      version: 11,
      createdAt: '2026-07-17T16:00:00.000Z',
      retiredAt: '2026-07-17T16:30:00.000Z'
    }));
    await store.save(service({
      id: '00000000-0000-0000-0000-00000000d012',
      status: 'RETIRED',
      version: 12,
      createdAt: '2026-07-17T16:00:00.000Z',
      retiredAt: '2026-07-17T16:30:00.000Z'
    }));

    const first = await store.listPage({ cursor: null, limit: 1 });
    const second = await store.listPage({ cursor: decodeCursor(first.nextCursor!), limit: 1 });

    expect(first.items.map((item) => item.id)).toEqual(['00000000-0000-0000-0000-00000000d012']);
    expect(second.items.map((item) => item.id)).toEqual(['00000000-0000-0000-0000-00000000d011']);
  });

  test('resolves active staff accounts from bound Discord accounts', async () => {
    const directory = new PostgresStaffDirectory({ client });

    await expect(
      directory.resolveByDiscord({
        guildId: '999999999999999999',
        discordUserId: '333333333333333333'
      })
    ).resolves.toEqual({
      staffId: '00000000-0000-0000-0000-000000000333',
      userId: '00000000-0000-0000-0000-000000000033',
      level: 'L3_OPERATIONS',
      permissionsVersion: 1,
      status: 'ACTIVE'
    });
  });

  test('rolls back catalog writes when the same transaction violates the active-version constraint', async () => {
    const store = new PostgresServiceCatalogStore({ client });

    await expect(
      store.commit({
        records: [
          service({
            id: '00000000-0000-0000-0000-00000000d001',
            version: 4,
            customerUnitPriceMinor: 7000
          }),
          service({
            id: '00000000-0000-0000-0000-00000000d002',
            version: 5,
            customerUnitPriceMinor: 8000
          })
        ],
        auditRecord: auditRecord('CREATE_SERVICE_CATALOG_VERSION', 'BAD_DOUBLE_ACTIVE'),
        auditSink: new InMemoryAuditSink()
      })
    ).rejects.toThrow();

    const leakedVersions = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM service_catalog_versions WHERE id IN ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d002')"
    );
    const leakedAudit = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_logs WHERE reason = 'BAD_DOUBLE_ACTIVE'"
    );

    expect(leakedVersions.rows[0]?.count).toBe('0');
    expect(leakedAudit.rows[0]?.count).toBe('0');
  });
});

function service(overrides: Partial<ServiceCatalogRecord> = {}): ServiceCatalogRecord {
  return {
    id: '00000000-0000-0000-0000-00000000c001',
    offeringKey: 'VALORANT|ENTERTAINMENT|NA',
    game: 'VALORANT',
    service: 'ENTERTAINMENT',
    region: 'NA',
    billingUnitMinutes: 60,
    minimumUnits: 1,
    customerUnitPriceMinor: 6000,
    playerUnitPayoutMinor: 4200,
    currency: 'CAT',
    status: 'ACTIVE',
    version: 3,
    createdByStaffId: '00000000-0000-0000-0000-000000000333',
    createdAt: now.toISOString(),
    activatedAt: now.toISOString(),
    retiredAt: null,
    ...overrides
  };
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt: string; id: string };
}

function auditRecord(action: string, reason: string): AuditRecord {
  return {
    id: crypto.randomUUID(),
    actorId: '00000000-0000-0000-0000-000000000033',
    actorStaffId: '00000000-0000-0000-0000-000000000333',
    actorLevel: 'L3_OPERATIONS',
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT',
    interactionId: '777777777777777777',
    permissionCode: 'catalog.manage',
    action,
    targetType: 'service_catalog_version',
    targetId: '00000000-0000-0000-0000-00000000c001',
    outcome: 'SUCCEEDED',
    reason,
    requestId: 'req_catalog_db_test',
    approvalRequestId: null,
    occurredAt: now.toISOString()
  };
}
