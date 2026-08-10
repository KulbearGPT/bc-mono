import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryOrderStore } from '@blackcat/api/orders';
import { PostgresGiftStore, registerGiftRoutes } from '@blackcat/api/gifts';
import { TestWalletFunding } from './support/wallet-fixture';
import { applyCurrentMigrations } from './support/postgres-migrations';

const execFile = promisify(execFileCallback);
const now = new Date('2026-08-13T18:00:00.000Z');
const guildId = '900000000000022100';
const customerId = '00000000-0000-0000-0000-000000022101';
const playerId = '00000000-0000-0000-0000-000000022102';
const staffId = '00000000-0000-0000-0000-000000022103';
const profileId = '00000000-0000-0000-0000-000000022104';
const catalogItemId = '00000000-0000-0000-0000-000000022105';
const catalogVersionId = '00000000-0000-0000-0000-000000022106';

let root = '';
let data = '';
let pool: Pool;

describe('M22-US-02 PostgreSQL standalone gift concurrency', () => {
  beforeAll(async () => {
    const port = 62_200 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m22-standalone-gift-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m22_standalone_gift']);
    await applyCurrentMigrations({ host: root, port, database: 'blackcat_m22_standalone_gift' });
    pool = new Pool({ host: root, port, database: 'blackcat_m22_standalone_gift' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('serializes two requests against the same available balance and persists one anonymous standalone gift', async () => {
    const binding: AccountBindingRecord = {
      userId: customerId, displayName: '老板', userStatus: 'ACTIVE', userVersion: 1,
      discordAccountId: '00000000-0000-0000-0000-000000022111', guildId,
      discordUserId: '900000000000022101', externalAccountId: '00000000-0000-0000-0000-000000022112',
      provider: 'internal', externalUserId: 'customer-22101', externalUserDisplay: 'customer-***',
      externalAccountStatus: 'ACTIVE', boundAt: now.toISOString()
    };
    const server = buildApiServer({
      env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() }
    });
    registerGiftRoutes(server, {
      store: new PostgresGiftStore(pool), orderStore: new InMemoryOrderStore(),
      accountStore: new InMemoryAccountStore({ bindings: [binding] }), walletFunding: new TestWalletFunding(5_200),
      broadcastChannelId: '900000000000022130', now: () => now
    });
    const baseHeaders = {
      authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
      'x-actor-discord-user-id': '900000000000022101', 'x-actor-guild-id': guildId,
      'x-discord-interaction-id': '900000000000022109'
    };
    const payload = { playerProfileId: profileId, giftCatalogVersionId: catalogVersionId,
      expectedCatalogVersion: 1, expectedPriceMinor: 5_200, anonymous: true };

    const responses = await Promise.all([
      server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests', headers: { ...baseHeaders, 'idempotency-key': 'gift:m22:postgres:a' }, payload }),
      server.inject({ method: 'POST', url: '/api/v1/gift-center/gift-requests', headers: { ...baseHeaders, 'idempotency-key': 'gift:m22:postgres:b' }, payload })
    ]);

    expect(responses.map((response) => response.statusCode).sort(), responses.map((response) => response.body).join('\n')).toEqual([201, 422]);
    const facts = await pool.query(`SELECT
      count(DISTINCT gr.id)::int AS gift_count,
      count(DISTINCT fr.id)::int AS reservation_count,
      count(DISTINCT st.id)::int AS task_count,
      min(gr.origin::text) AS origin,
      min(gr.sender_visibility::text) AS sender_visibility,
      min(gr.order_id::text) AS order_id,
      min(gr.receiver_id::text) AS receiver_id
      FROM gift_requests gr
      LEFT JOIN fund_reservations fr ON fr.gift_request_id=gr.id
      LEFT JOIN staff_tasks st ON st.gift_request_id=gr.id`);
    expect(facts.rows[0]).toEqual({ gift_count: 1, reservation_count: 1, task_count: 1,
      origin: 'STANDALONE', sender_visibility: 'ANONYMOUS', order_id: null, receiver_id: playerId });
  });
});

async function seed() {
  await pool.query(`
    INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${customerId}','老板','ACTIVE',1,now(),now()),
      ('${playerId}','阿青','ACTIVE',1,now(),now()),
      ('${staffId}','Operator','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,permissions_version,created_at,updated_at)
      VALUES ('${staffId}','${staffId}','L3_OPERATIONS','ACTIVE','MANUAL',1,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000022113','${customerId}','${guildId}','900000000000022101',now(),now(),now()),
      ('00000000-0000-0000-0000-000000022114','${playerId}','${guildId}','900000000000022102',now(),now(),now());
    INSERT INTO player_profiles (id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at)
      VALUES ('${profileId}','${playerId}','ACTIVE',1,'AVAILABLE','ONLINE',now(),now());
    INSERT INTO gift_catalog_items (id,code,created_at,updated_at)
      VALUES ('${catalogItemId}','MOON_CAKE',now(),now());
    INSERT INTO gift_catalog_versions (id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at)
      VALUES ('${catalogVersionId}','${catalogItemId}',1,'ACTIVE','${catalogItemId}','月亮蛋糕',5200,'CAT','{sender_name} 向 {receiver_name} 送出 {gift_name}','${staffId}',now(),now());
    INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
      VALUES ('00000000-0000-0000-0000-000000022115','${customerId}','CAT','ACTIVE',1,now(),now());
    INSERT INTO wallet_entries (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES ('00000000-0000-0000-0000-000000022116','00000000-0000-0000-0000-000000022115','TOP_UP_CREDIT','CREDIT',5200,'CAT','TOP_UP','00000000-0000-0000-0000-000000022117','m22:wallet:credit',now(),now());
  `);
}
