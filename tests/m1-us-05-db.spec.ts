import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresOrderStore,
  type FundReservationEventRecord,
  type FundReservationRecord,
  type OrderEventRecord,
  type OrderRecord
} from '@blackcat/api/orders';
import { InMemoryAuditSink, type AuditRecord } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-17T21:00:00.000Z');

let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M1-US-05 Postgres submit order reservation integration', () => {
  beforeAll(async () => {
    port = 58_000 + (process.pid % 1_000);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m1-submit-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;

    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m1_submit']);
    await execFile('psql', [
      '-h',
      socketDir,
      '-p',
      String(port),
      '-d',
      'blackcat_m1_submit',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'database/prisma/migrations/000001_p0_baseline/migration.sql'
    ]);

    pool = new Pool({
      host: socketDir,
      port,
      database: 'blackcat_m1_submit',
      application_name: 'blackcat_m1_submit_test',
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

  test('commits order submit, fund reservation, events and audit atomically', async () => {
    const store = new PostgresOrderStore({ pool });
    await store.commitCreate({
      order: pricedDraftOrder(),
      event: orderEvent({ eventType: 'CREATED', fromStatus: null, toStatus: 'DRAFT', sequence: 1 }),
      auditRecord: auditRecord('CREATE_ORDER', 'order.create'),
      auditSink: new InMemoryAuditSink()
    });

    await store.commitSubmit!({
      order: pricedDraftOrder({ status: 'PENDING_DISPATCH', version: 3 }),
      expectedVersion: 2,
      providerBalanceMinor: 20000,
      orderEvent: orderEvent({ eventType: 'SUBMITTED', fromStatus: 'DRAFT', toStatus: 'PENDING_DISPATCH', sequence: 2 }),
      reservation: reservation(),
      reservationEvent: reservationEvent(),
      externalTransactions: [],
      auditRecord: auditRecord('SUBMIT_ORDER', 'order.submit'),
      auditSink: new InMemoryAuditSink()
    });

    await expect(store.findById('00000000-0000-0000-0000-00000000b001')).resolves.toMatchObject({
      status: 'PENDING_DISPATCH',
      version: 3
    });
    const sideEffects = await pool.query<{
      reservations: string;
      reservation_events: string;
      order_events: string;
      audits: string;
    }>(`
SELECT
  (SELECT count(*) FROM fund_reservations WHERE order_id = '00000000-0000-0000-0000-00000000b001') AS reservations,
  (SELECT count(*) FROM fund_reservation_events WHERE fund_reservation_id = '00000000-0000-0000-0000-00000000f001') AS reservation_events,
  (SELECT count(*) FROM order_events WHERE order_id = '00000000-0000-0000-0000-00000000b001') AS order_events,
  (SELECT count(*) FROM audit_logs WHERE action = 'SUBMIT_ORDER') AS audits
    `);
    expect(sideEffects.rows[0]).toEqual({
      reservations: '1',
      reservation_events: '1',
      order_events: '2',
      audits: '1'
    });
  });

  test('rolls back reservation and audit when submit expectedVersion is stale', async () => {
    const store = new PostgresOrderStore({ pool });

    await expect(
      store.commitSubmit!({
        order: pricedDraftOrder({
          id: '00000000-0000-0000-0000-00000000b002',
          publicId: 'P-M1-ORD-2',
          status: 'PENDING_DISPATCH',
          version: 3,
          channelSpec: {
            channelId: '120000000000000011',
            panelMessageId: '120000000000000012',
            voiceChannelId: null
          }
        }),
        expectedVersion: 2,
        providerBalanceMinor: 50000,
        orderEvent: orderEvent({
          orderId: '00000000-0000-0000-0000-00000000b002',
          eventType: 'SUBMITTED',
          fromStatus: 'DRAFT',
          toStatus: 'PENDING_DISPATCH',
          sequence: 2
        }),
        reservation: reservation({
          id: '00000000-0000-0000-0000-00000000f002',
          orderId: '00000000-0000-0000-0000-00000000b002',
          idempotencyKey: 'discord:order:submit:stale'
        }),
        reservationEvent: reservationEvent({
          fundReservationId: '00000000-0000-0000-0000-00000000f002',
          idempotencyKey: 'discord:order:submit:stale:reservation'
        }),
        externalTransactions: [],
        auditRecord: auditRecord('SUBMIT_ORDER', 'stale-order.submit', '00000000-0000-0000-0000-00000000b002'),
        auditSink: new InMemoryAuditSink()
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const sideEffects = await pool.query<{ reservations: string; audits: string }>(`
SELECT
  (SELECT count(*) FROM fund_reservations WHERE id = '00000000-0000-0000-0000-00000000f002') AS reservations,
  (SELECT count(*) FROM audit_logs WHERE permission_code = 'stale-order.submit') AS audits
    `);
    expect(sideEffects.rows[0]).toEqual({ reservations: '0', audits: '0' });
  });

  test('rejects submit at commit when active reservations consume provider balance', async () => {
    const store = new PostgresOrderStore({ pool });
    const auditSink = new InMemoryAuditSink();
    const targetDraft = pricedDraftOrder({
      id: '00000000-0000-0000-0000-00000000b011',
      publicId: 'P-M1-ORD-11',
      customerId: '00000000-0000-0000-0000-00000000a003',
      channelSpec: {
        channelId: '120000000000000111',
        panelMessageId: '120000000000000112',
        voiceChannelId: null
      }
    });

    await store.commitCreate({
      order: targetDraft,
      event: orderEvent({
        orderId: targetDraft.id,
        eventType: 'CREATED',
        fromStatus: null,
        toStatus: 'DRAFT',
        sequence: 1
      }),
      auditRecord: auditRecord('CREATE_ORDER', 'commit-recheck.create', targetDraft.id),
      auditSink
    });
    await seedPriorActiveGiftReservation(targetDraft);

    await expect(
      store.commitSubmit!({
        order: { ...targetDraft, status: 'PENDING_DISPATCH', version: 3 },
        expectedVersion: 2,
        providerBalanceMinor: 18000,
        orderEvent: orderEvent({
          orderId: targetDraft.id,
          eventType: 'SUBMITTED',
          fromStatus: 'DRAFT',
          toStatus: 'PENDING_DISPATCH',
          sequence: 2
        }),
        reservation: reservation({
          id: '00000000-0000-0000-0000-00000000f011',
          orderId: targetDraft.id,
          idempotencyKey: 'discord:order:submit:commit-recheck',
          providerHoldRef: 'mock_hold_commit_recheck'
        }),
        reservationEvent: reservationEvent({
          fundReservationId: '00000000-0000-0000-0000-00000000f011',
          idempotencyKey: 'discord:order:submit:commit-recheck:reservation'
        }),
        externalTransactions: [],
        auditRecord: auditRecord('SUBMIT_ORDER', 'commit-recheck.submit', targetDraft.id),
        auditSink
      })
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_BALANCE' });

    const sideEffects = await pool.query<{ order_status: string; reservations: string; audits: string }>(
      `
SELECT
  (SELECT status::text FROM orders WHERE id = '00000000-0000-0000-0000-00000000b011') AS order_status,
  (SELECT count(*) FROM fund_reservations WHERE id = '00000000-0000-0000-0000-00000000f011') AS reservations,
  (SELECT count(*) FROM audit_logs WHERE permission_code = 'commit-recheck.submit') AS audits
      `
    );
    expect(sideEffects.rows[0]).toEqual({ order_status: 'DRAFT', reservations: '0', audits: '0' });
  });

  test('rejects submit at commit when the catalog snapshot is no longer active', async () => {
    const store = new PostgresOrderStore({ pool });
    const targetDraft = pricedDraftOrder({
      id: '00000000-0000-0000-0000-00000000b012',
      publicId: 'P-M1-ORD-12',
      customerId: '00000000-0000-0000-0000-00000000a004',
      channelSpec: {
        channelId: '120000000000000121',
        panelMessageId: '120000000000000122',
        voiceChannelId: null
      }
    });

    await store.commitCreate({
      order: targetDraft,
      event: orderEvent({
        orderId: targetDraft.id,
        eventType: 'CREATED',
        fromStatus: null,
        toStatus: 'DRAFT',
        sequence: 1
      }),
      auditRecord: auditRecord('CREATE_ORDER', 'catalog-recheck.create', targetDraft.id),
      auditSink: new InMemoryAuditSink()
    });
    await pool.query(
      `
UPDATE service_catalog_versions
SET status = 'RETIRED'::"CatalogVersionStatus",
    retired_at = now()
WHERE id = '00000000-0000-0000-0000-00000000c001'
      `
    );

    await expect(
      store.commitSubmit!({
        order: { ...targetDraft, status: 'PENDING_DISPATCH', version: 3 },
        expectedVersion: 2,
        providerBalanceMinor: 20000,
        orderEvent: orderEvent({
          orderId: targetDraft.id,
          eventType: 'SUBMITTED',
          fromStatus: 'DRAFT',
          toStatus: 'PENDING_DISPATCH',
          sequence: 2
        }),
        reservation: reservation({
          id: '00000000-0000-0000-0000-00000000f012',
          userId: targetDraft.customerId,
          orderId: targetDraft.id,
          idempotencyKey: 'discord:order:submit:catalog-recheck',
          providerHoldRef: 'mock_hold_catalog_recheck'
        }),
        reservationEvent: reservationEvent({
          fundReservationId: '00000000-0000-0000-0000-00000000f012',
          idempotencyKey: 'discord:order:submit:catalog-recheck:reservation'
        }),
        externalTransactions: [],
        auditRecord: auditRecord('SUBMIT_ORDER', 'catalog-recheck.submit', targetDraft.id),
        auditSink: new InMemoryAuditSink()
      })
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_AVAILABLE' });

    const sideEffects = await pool.query<{ order_status: string; reservations: string; audits: string }>(
      `
SELECT
  (SELECT status::text FROM orders WHERE id = '00000000-0000-0000-0000-00000000b012') AS order_status,
  (SELECT count(*) FROM fund_reservations WHERE id = '00000000-0000-0000-0000-00000000f012') AS reservations,
  (SELECT count(*) FROM audit_logs WHERE permission_code = 'catalog-recheck.submit') AS audits
      `
    );
    expect(sideEffects.rows[0]).toEqual({ order_status: 'DRAFT', reservations: '0', audits: '0' });
  });
});

async function seedCustomerAndCatalog(): Promise<void> {
  await pool.query(`
INSERT INTO users (id, display_name, updated_at)
VALUES
  ('00000000-0000-0000-0000-00000000a001', 'mock-***-ok', now()),
  ('00000000-0000-0000-0000-00000000a002', 'player-***-ok', now()),
  ('00000000-0000-0000-0000-00000000a003', 'race-***-ok', now()),
  ('00000000-0000-0000-0000-00000000a004', 'catalog-***-ok', now()),
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
  'CNY',
  '00000000-0000-0000-0000-000000000333',
  now(),
  now()
);
  `);
}

async function seedPriorActiveGiftReservation(order: OrderRecord): Promise<void> {
  await pool.query(`
INSERT INTO gift_catalog_items (id, code, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-00000000d010', 'ROCKET', now(), now())
ON CONFLICT (id) DO NOTHING;
  `);
  await pool.query(`
INSERT INTO gift_catalog_versions (
  id, gift_catalog_item_id, version, status, active_gift_key,
  name, price_minor, currency, broadcast_template,
  created_by_staff_id, activated_at, created_at
)
VALUES (
  '00000000-0000-0000-0000-00000000d011',
  '00000000-0000-0000-0000-00000000d010',
  1,
  'ACTIVE'::"CatalogVersionStatus",
  '00000000-0000-0000-0000-00000000d010',
  '火箭',
  7000,
  'CNY',
  '{sender_name} 送给 {receiver_name} {gift_name}',
  '00000000-0000-0000-0000-000000000333',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;
  `);
  await pool.query(
    `
INSERT INTO gift_requests (
  id, public_id, order_id, gift_catalog_version_id, sender_id, receiver_id,
  status, row_version, gift_code_snapshot, gift_name_snapshot, price_minor,
  currency, broadcast_template_snapshot, expires_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000d012',
  'G-M1-10',
  $2,
  '00000000-0000-0000-0000-00000000d011',
  $1,
  '00000000-0000-0000-0000-00000000a002',
  'PENDING_REVIEW'::"GiftRequestStatus",
  1,
  'ROCKET',
  '火箭',
  7000,
  'CNY',
  '{sender_name} 送给 {receiver_name} {gift_name}',
  now() + interval '30 minutes',
  now(),
  now()
);
    `,
    [order.customerId, order.id]
  );
  await pool.query(
    `
INSERT INTO fund_reservations (
  id, user_id, source_type, order_id, gift_request_id, mode, provider, provider_hold_ref,
  amount_minor, currency, status, row_version, idempotency_key,
  expires_at, activated_at, settled_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-00000000f010',
  $1,
  'GIFT'::"FundReservationSourceType",
  NULL,
  '00000000-0000-0000-0000-00000000d012',
  'PROVIDER_NATIVE_HOLD'::"FundReservationMode",
  'mock-provider',
  'mock_hold_prior_commit_recheck',
  7000,
  'CNY',
  'ACTIVE'::"FundReservationStatus",
  1,
  'discord:order:submit:prior-commit-recheck',
  now() + interval '30 minutes',
  now(),
  NULL,
  now(),
  now()
)
    `,
    [order.customerId]
  );
}

function pricedDraftOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: '00000000-0000-0000-0000-00000000b001',
    publicId: 'P-M1-ORD-1',
    customerId: '00000000-0000-0000-0000-00000000a001',
    playerId: null,
    status: 'DRAFT',
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
    currency: 'CNY',
    notes: '轻松交流',
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

function reservation(overrides: Partial<FundReservationRecord> = {}): FundReservationRecord {
  return {
    id: '00000000-0000-0000-0000-00000000f001',
    userId: '00000000-0000-0000-0000-00000000a001',
    sourceType: 'ORDER',
    orderId: '00000000-0000-0000-0000-00000000b001',
    mode: 'PROVIDER_NATIVE_HOLD',
    provider: 'mock-provider',
    providerHoldRef: 'mock_hold_1',
    amountMinor: 12000,
    currency: 'CNY',
    status: 'ACTIVE',
    version: 1,
    idempotencyKey: 'discord:order:submit:0001',
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    activatedAt: now.toISOString(),
    settledAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides
  };
}

function reservationEvent(overrides: Partial<FundReservationEventRecord> = {}): FundReservationEventRecord {
  return {
    id: crypto.randomUUID(),
    fundReservationId: '00000000-0000-0000-0000-00000000f001',
    sequence: 1,
    eventType: 'CREATED',
    fromStatus: null,
    toStatus: 'ACTIVE',
    amountMinor: 12000,
    reservationVersion: 1,
    idempotencyKey: 'discord:order:submit:0001:reservation',
    actorUserId: null,
    actorStaffId: null,
    actorSource: 'DISCORD_BOT',
    reasonCode: 'ORDER_SUBMIT',
    createdAt: now.toISOString(),
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

function auditRecord(action: string, permissionCode: string, targetId = '00000000-0000-0000-0000-00000000b001'): AuditRecord {
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
    targetId,
    outcome: 'SUCCEEDED',
    reason: null,
    requestId: `req_${permissionCode}`,
    approvalRequestId: null,
    occurredAt: now.toISOString()
  };
}
