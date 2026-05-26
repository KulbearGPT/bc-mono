import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import { PostgresAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { PostgresOrderStore, registerOrderRoutes } from '@blackcat/api/orders';
import { PostgresServiceCatalogStore } from '@blackcat/api/catalog';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { applyCurrentMigrations } from './support/postgres-migrations';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T08:00:00.000Z');
const orderId = '00000000-0000-0000-0000-00000000ba10';
let tmpRoot = '';
let dataDir = '';
let socketDir = '';
let port = 0;
let pool: Pool;

describe('M2-US-10 PostgreSQL cancellation preview transaction', () => {
  beforeAll(async () => {
    port = 60_100 + (process.pid % 200);
    tmpRoot = await mkdtemp(join(tmpdir(), 'blackcat-m2-cancel-preview-'));
    dataDir = join(tmpRoot, 'data');
    socketDir = tmpRoot;
    await execFile('initdb', ['-D', dataDir, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', dataDir, '-o', `-p ${port} -k ${socketDir}`, '-l', join(tmpRoot, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', socketDir, '-p', String(port), 'blackcat_m2_cancel_preview']);
    await applyCurrentMigrations({ host: socketDir, port, database: 'blackcat_m2_cancel_preview' });
    pool = new Pool({ host: socketDir, port, database: 'blackcat_m2_cancel_preview', application_name: 'blackcat_m2_cancel_preview_test', max: 4 });
    await seedAccount();
    await seedOrder();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (dataDir) await execFile('pg_ctl', ['-D', dataDir, 'stop', '-m', 'fast']).catch(() => undefined);
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('applies the matching preview and releases reservation atomically', async () => {
    const accountStore = new PostgresAccountStore({ pool });
    const orderStore = new PostgresOrderStore({ pool });
    const server = buildApiServer({
      env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() }
    });
    registerOrderRoutes(server, {
      accountStore, orderStore, catalogStore: new PostgresServiceCatalogStore({ pool }),
      now: () => now
    });
    const preview = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancellation-preview`, headers: headers('db:cancel-preview:P-A10'),
      payload: { expectedVersion: 3, reasonCode: 'CUSTOMER_REQUEST' }
    });
    const cancelled = await server.inject({
      method: 'POST', url: `/api/v1/orders/${orderId}/cancel`, headers: headers('db:cancel-confirm:P-A10'),
      payload: { expectedVersion: 3, previewId: preview.json().data.previewId, reasonCode: 'CUSTOMER_REQUEST' }
    });
    const snapshot = await pool.query(`
SELECT
  (SELECT status FROM orders WHERE id = '${orderId}') AS order_status,
  (SELECT status FROM fund_reservations WHERE order_id = '${orderId}') AS reservation_status,
  (SELECT status FROM cancellation_previews WHERE order_id = '${orderId}') AS preview_status,
  (SELECT count(*)::text FROM fund_reservation_events WHERE fund_reservation_id = '00000000-0000-0000-0000-00000000fa10' AND event_type = 'RELEASED') AS release_events
    `);
    expect(preview.statusCode).toBe(200);
    expect(cancelled.statusCode, JSON.stringify(cancelled.json())).toBe(200);
    expect(snapshot.rows[0]).toMatchObject({ order_status: 'CANCELLED', reservation_status: 'RELEASED', preview_status: 'APPLIED', release_events: '1' });
  });
});

function headers(idempotencyKey: string) {
  return {
    authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
    'x-actor-discord-user-id': '111111111111111111', 'x-actor-guild-id': '999999999999999999',
    'x-discord-interaction-id': '777777777777777777', 'idempotency-key': idempotencyKey
  };
}

function binding(): AccountBindingRecord {
  return {
    userId: '00000000-0000-0000-0000-00000000aa10', displayName: 'Customer', userStatus: 'ACTIVE', userVersion: 1,
    discordAccountId: '00000000-0000-0000-0000-00000000da10', guildId: '999999999999999999', discordUserId: '111111111111111111',
    externalAccountId: '00000000-0000-0000-0000-00000000ea10', provider: 'mock-provider', externalUserId: 'mock-user-a10',
    externalUserDisplay: 'mock-***-a10', externalAccountStatus: 'ACTIVE', boundAt: now.toISOString()
  };
}

async function seedAccount() {
  await pool.query(`
INSERT INTO users (id, display_name, status, row_version, created_at, updated_at)
VALUES ('${binding().userId}', 'Customer', 'ACTIVE', 1, now(), now());
INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, bound_at, created_at, updated_at)
VALUES ('${binding().discordAccountId}', '${binding().userId}', '${binding().guildId}', '${binding().discordUserId}', now(), now(), now());`);
}

async function seedOrder() {
  await pool.query(`
INSERT INTO orders (
  id, public_id, customer_id, active_customer_slot_id, status, row_version,
  game_code_snapshot, service_code_snapshot, region_code_snapshot, billing_unit_minutes, unit_count,
  customer_unit_price_minor, player_unit_payout_minor, amount_minor, expected_player_earning_minor,
  currency, guild_id, channel_id, panel_message_id, submitted_at, created_at, updated_at
) VALUES (
  '${orderId}', 'P-A10', '${binding().userId}', '${binding().userId}', 'PENDING_DISPATCH', 3,
  'VALORANT', 'ENTERTAINMENT', 'NA', 60, 2, 6000, 4200, 12000, 8400,
  'USD', '999999999999999999', '444444444444444444', '555555555555555555', now(), now(), now()
);
INSERT INTO fund_reservations (
  id, user_id, source_type, order_id, mode, provider, amount_minor, currency, status, row_version,
  idempotency_key, expires_at, activated_at, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-00000000fa10', '${binding().userId}', 'ORDER', '${orderId}',
  'LOCAL_RESERVATION', 'mock-provider', 12000, 'USD', 'ACTIVE', 1,
  'submit:P-A10', now() + interval '30 minutes', now(), now(), now()
);
INSERT INTO fund_reservation_events (
  id, fund_reservation_id, sequence, event_type, from_status, to_status, amount_minor,
  reservation_version, idempotency_key, actor_user_id, actor_source, created_at
) VALUES (
  '00000000-0000-0000-0000-00000000fe10', '00000000-0000-0000-0000-00000000fa10', 1,
  'CREATED', NULL, 'ACTIVE', 12000, 1, 'submit:P-A10', '${binding().userId}', 'DISCORD_BOT', now()
);
  `);
}
