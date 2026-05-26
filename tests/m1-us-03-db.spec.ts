import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresOrderStore,
  type OrderEventRecord,
  type OrderRecord
} from '@blackcat/api/orders';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-17T20:00:00.000Z');

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M1-US-03 Postgres order draft integration', () => {
  beforeAll(async () => {
    port = 57_000 + (process.pid % 1_000);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m1-order-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m1_order']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m1_order',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m1_order',
      application_name: 'blackcat_m1_order_test',
      max: 4
    });

    await seedCustomerAndCatalog();
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

  test('commits a draft order, CREATED event and audit record atomically', async () => {
    const store = new PostgresOrderStore({ pool });
    await store.commitCreate({
      order: draftOrder(),
      event: orderEvent({ eventType: 'CREATED', fromStatus: null, toStatus: 'DRAFT', sequence: 1 }),
      auditRecord: auditRecord('CREATE_ORDER', 'order.create'),
      auditSink: new InMemoryAuditSink()
    });

    await expect(store.findActiveByCustomer('00000000-0000-0000-0000-00000000a001')).resolves.toMatchObject({
      id: '00000000-0000-0000-0000-00000000b001',
      status: 'DRAFT',
      amountMinor: 0,
      channelSpec: {
        channelId: '120000000000000001',
        panelMessageId: '120000000000000002',
        voiceChannelId: null
      }
    });
    const sideEffects = await pool.query<{ events: string; audits: string }>(`
SELECT
  (SELECT count(*) FROM order_events WHERE order_id = '00000000-0000-0000-0000-00000000b001') AS events,
  (SELECT count(*) FROM audit_logs WHERE action = 'CREATE_ORDER') AS audits
    `);
    expect(sideEffects.rows[0]).toEqual({ events: '1', audits: '1' });
  });

  test('updates draft catalog snapshots and amounts only through the controlled store transaction', async () => {
    const store = new PostgresOrderStore({ pool });
    const updated = draftOrder({
      version: 2,
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      catalogVersion: 3,
      game: 'VALORANT',
      service: 'ENTERTAINMENT',
      region: 'NA',
      billingUnitMinutes: 60,
      unitCount: 2,
      customerUnitPriceMinor: 6000,
      playerUnitPayoutMinor: 4200,
      amountMinor: 12000,
      playerEarningMinor: 8400,
      notes: '轻松交流，不急着上分',
      channelSpec: {
        channelId: '120000000000000001',
        panelMessageId: '120000000000000002',
        voiceChannelId: '120000000000000003'
      },
      updatedAt: new Date(now.getTime() + 60_000).toISOString()
    });

    await store.commitUpdate({
      order: updated,
      event: orderEvent({ eventType: 'DETAILS_UPDATED', fromStatus: 'DRAFT', toStatus: 'DRAFT', sequence: 2 }),
      expectedVersion: 1,
      auditRecord: auditRecord('UPDATE_ORDER', 'order.update'),
      auditSink: new InMemoryAuditSink()
    });

    await expect(store.findById('00000000-0000-0000-0000-00000000b001')).resolves.toMatchObject({
      version: 2,
      serviceCatalogId: '00000000-0000-0000-0000-00000000c001',
      catalogVersion: 3,
      amountMinor: 12000,
      playerEarningMinor: 8400,
      notes: '轻松交流，不急着上分',
      channelSpec: {
        voiceChannelId: '120000000000000003'
      }
    });
    const directUpdate = pool.query(
      "UPDATE orders SET amount_minor = 999 WHERE id = '00000000-0000-0000-0000-00000000b001'"
    );
    await expect(directUpdate).rejects.toThrow(/protected amount/i);
  });

  test('rolls back order updates and audit when expectedVersion is stale', async () => {
    const store = new PostgresOrderStore({ pool });

    await expect(
      store.commitUpdate({
        order: draftOrder({ version: 3, amountMinor: 5000 }),
        event: orderEvent({ eventType: 'DETAILS_UPDATED', fromStatus: 'DRAFT', toStatus: 'DRAFT', sequence: 3 }),
        expectedVersion: 1,
        auditRecord: auditRecord('UPDATE_ORDER', 'stale-order.update'),
        auditSink: new InMemoryAuditSink()
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const current = await store.findById('00000000-0000-0000-0000-00000000b001');
    const leakedAudit = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_logs WHERE permission_code = 'stale-order.update'"
    );

    expect(current).toMatchObject({ version: 2, amountMinor: 12000 });
    expect(leakedAudit.rows[0]?.count).toBe('0');
  });
});

async function seedCustomerAndCatalog(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a001', 'mock-***-ok', now()),
  ('00000000-0000-0000-0000-000000000033', 'Ops Staff', now());

INSERT INTO staff_accounts (id, user_id, level, role_source, mfa_enrolled, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000333',
  '00000000-0000-0000-0000-000000000033',
  'L3_OPERATIONS',
  'BOOTSTRAP',
  true,
  now()
);

INSERT INTO service_offerings (id, code, game_code, game_name, service_code, service_name, region_code, updated_at)
VALUES (
  '00000000-0000-0000-0000-00000000c100',
  'VALORANT|ENTERTAINMENT|NA',
  'VALORANT',
  'VALORANT',
  'ENTERTAINMENT',
  'ENTERTAINMENT',
  'NA',
  now()
);

INSERT INTO service_catalog_versions (
  id, service_offering_id, version, status, active_offering_key,
  billing_unit_minutes, minimum_units, customer_unit_price_minor, player_unit_payout_minor,
  currency, created_by_staff_id, activated_at, created_at
)
VALUES (
  '00000000-0000-0000-0000-00000000c001',
  '00000000-0000-0000-0000-00000000c100',
  3,
  'ACTIVE',
  '00000000-0000-0000-0000-00000000c100',
  60,
  1,
  6000,
  4200,
  'USD',
  '00000000-0000-0000-0000-000000000333',
  now(),
  now()
);
  `);
}

function draftOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: '00000000-0000-0000-0000-00000000b001',
    publicId: 'P-M1-ORD-1',
    customerId: '00000000-0000-0000-0000-00000000a001',
    playerId: null,
    status: 'DRAFT',
    version: 1,
    serviceCatalogId: null,
    catalogVersion: null,
    game: null,
    service: null,
    region: null,
    billingUnitMinutes: null,
    unitCount: null,
    customerUnitPriceMinor: null,
    playerUnitPayoutMinor: null,
    amountMinor: 0,
    playerEarningMinor: 0,
    currency: 'USD',
    notes: null,
    channelSpec: {
      channelId: '120000000000000001',
      panelMessageId: '120000000000000002',
      voiceChannelId: null
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function orderEvent(overrides: Partial<OrderEventRecord>): OrderEventRecord {
  return {
    id: crypto.randomUUID(),
    orderId: '00000000-0000-0000-0000-00000000b001',
    sequence: 1,
    eventType: 'CREATED',
    fromStatus: null,
    toStatus: 'DRAFT',
    actorUserId: null,
    actorStaffId: null,
    actorSource: 'DISCORD_BOT',
    interactionId: '777777777777777777',
    payload: {},
    createdAt: now.toISOString(),
    ...overrides
  };
}

function auditRecord(action: string, permissionCode: string): AuditRecord {
  return {
    id: crypto.randomUUID(),
    actorId: null,
    actorStaffId: null,
    actorLevel: null,
    actorSource: 'DISCORD_BOT',
    clientId: 'DISCORD_BOT',
    interactionId: '777777777777777777',
    permissionCode,
    action,
    targetType: 'order',
    targetId: '00000000-0000-0000-0000-00000000b001',
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: `req_${permissionCode}`,
    approvalRequestId: null,
    occurredAt: now.toISOString()
  };
}
