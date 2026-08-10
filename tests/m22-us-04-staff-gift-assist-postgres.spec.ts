import { createHmac } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import { InMemoryIdempotencyStore, PostgresAuditSink } from '@blackcat/api/security';
import { InMemoryAccountStore, type AccountBindingRecord } from '@blackcat/api/accounts';
import { InMemoryOrderStore } from '@blackcat/api/orders';
import { PostgresGiftStore, registerGiftRoutes } from '@blackcat/api/gifts';
import { encryptSecret } from '@blackcat/api/mfa';
import { TestWalletFunding } from './support/wallet-fixture';
import { applyCurrentMigrations } from './support/postgres-migrations';

const execFile = promisify(execFileCallback);
const now = new Date('2026-08-13T20:30:00.000Z');
const guildId = '900000000000024100';
const staffDiscordId = '900000000000024101';
const customerDiscordId = '900000000000024102';
const staffId = '00000000-0000-0000-0000-000000024101';
const staffUserId = '00000000-0000-0000-0000-000000024102';
const customerId = '00000000-0000-0000-0000-000000024103';
const playerId = '00000000-0000-0000-0000-000000024104';
const profileId = '00000000-0000-0000-0000-000000024105';
const catalogItemId = '00000000-0000-0000-0000-000000024106';
const catalogVersionId = '00000000-0000-0000-0000-000000024107';
const encryptionKey = 'm22-us-04-test-encryption-key';
const totpSecret = 'JBSWY3DPEHPK3PXP';

let root = '';
let data = '';
let pool: Pool;

describe('M22-US-04 PostgreSQL staff-assisted gift atomicity', () => {
  beforeAll(async () => {
    const port = 62_400 + (process.pid % 100);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m22-staff-gift-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m22_staff_gift']);
    await applyCurrentMigrations({ host: root, port, database: 'blackcat_m22_staff_gift' });
    pool = new Pool({ host: root, port, database: 'blackcat_m22_staff_gift' });
    await seed();
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('increments a bad proof, then atomically consumes the challenge and reserves the bound customer balance once', async () => {
    const binding: AccountBindingRecord = {
      userId: customerId, displayName: '老板', userStatus: 'ACTIVE', userVersion: 1,
      discordAccountId: '00000000-0000-0000-0000-000000024108', guildId,
      discordUserId: customerDiscordId, boundAt: now.toISOString()
    };
    const server = buildApiServer({
      env: { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: {
        auditSink: new PostgresAuditSink({ client: pool }), idempotencyStore: new InMemoryIdempotencyStore(),
        staffDirectory: { resolveByDiscord: () => ({ staffId, userId: staffUserId, level: 'L1_SUPPORT', permissionsVersion: 3, status: 'ACTIVE' }) }
      }
    });
    registerGiftRoutes(server, {
      store: new PostgresGiftStore(pool, encryptionKey), orderStore: new InMemoryOrderStore(),
      accountStore: new InMemoryAccountStore({ bindings: [binding] }), walletFunding: new TestWalletFunding(6_600),
      broadcastChannelId: '900000000000024199', now: () => now
    });
    const baseHeaders = {
      authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT',
      'x-actor-discord-user-id': staffDiscordId, 'x-actor-guild-id': guildId,
      'x-discord-interaction-id': '900000000000024198'
    };
    const createdChallenge = await server.inject({
      method: 'POST', url: '/api/v1/admin/gift-assist/challenges',
      headers: { ...baseHeaders, 'idempotency-key': 'gift:assist:pg:challenge' },
      payload: { customerDiscordUserId: customerDiscordId, authorizationChannelId: '900000000000024103', authorizationMessageId: '900000000000024104' }
    });
    expect(createdChallenge.statusCode, createdChallenge.body).toBe(201);
    const challengeId = createdChallenge.json().data.id as string;
    const payload = { playerProfileId: profileId, giftCatalogVersionId: catalogVersionId,
      expectedCatalogVersion: 1, expectedPriceMinor: 6_600, anonymous: true,
      authorizationReason: '老板在消息中明确要求匿名送礼', totpCode: '000000' };

    const bad = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
      headers: { ...baseHeaders, 'idempotency-key': 'gift:assist:pg:bad-proof' }, payload });
    expect(bad.statusCode, bad.body).toBe(403);
    expect((await pool.query('SELECT failed_attempts,consumed_at FROM staff_gift_assist_challenges WHERE id=$1',[challengeId])).rows[0])
      .toEqual({ failed_attempts: 1, consumed_at: null });
    expect(Number((await pool.query('SELECT count(*) AS count FROM fund_reservations')).rows[0].count)).toBe(0);

    const good = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
      headers: { ...baseHeaders, 'idempotency-key': 'gift:assist:pg:good-proof' },
      payload: { ...payload, totpCode: generateTotp(totpSecret, now) } });
    expect(good.statusCode, good.body).toBe(201);
    const facts = await pool.query(`SELECT gr.initiator_mode::text,gr.sender_visibility::text,gr.sender_id,gr.receiver_id,
      gr.assisted_by_staff_id,gr.gift_assist_challenge_id,fr.user_id AS reservation_user_id,
      event.actor_staff_id,event.actor_user_id,challenge.failed_attempts,challenge.authorization_reason,challenge.consumed_at
      FROM gift_requests gr JOIN fund_reservations fr ON fr.gift_request_id=gr.id
      JOIN fund_reservation_events event ON event.fund_reservation_id=fr.id AND event.sequence=1
      JOIN staff_gift_assist_challenges challenge ON challenge.id=gr.gift_assist_challenge_id`);
    expect(facts.rows[0]).toMatchObject({ initiator_mode: 'STAFF_ASSISTED', sender_visibility: 'ANONYMOUS',
      sender_id: customerId, receiver_id: playerId, assisted_by_staff_id: staffId,
      gift_assist_challenge_id: challengeId, reservation_user_id: customerId,
      actor_staff_id: staffId, actor_user_id: null, failed_attempts: 1,
      authorization_reason: payload.authorizationReason });
    expect(facts.rows[0].consumed_at).toBeInstanceOf(Date);

    const replay = await server.inject({ method: 'POST', url: `/api/v1/admin/gift-assist/challenges/${challengeId}/gift-requests`,
      headers: { ...baseHeaders, 'idempotency-key': 'gift:assist:pg:replay' },
      payload: { ...payload, totpCode: generateTotp(totpSecret, now) } });
    expect(replay.statusCode).toBe(409);
    expect(Number((await pool.query('SELECT count(*) AS count FROM gift_requests')).rows[0].count)).toBe(1);
    expect(JSON.stringify((await pool.query('SELECT reason,before_snapshot,after_snapshot FROM audit_logs')).rows)).not.toContain(generateTotp(totpSecret, now));
  });
});

async function seed() {
  const ciphertext = encryptSecret(totpSecret, encryptionKey);
  await pool.query(`
    INSERT INTO users (id,display_name,status,row_version,created_at,updated_at) VALUES
      ('${staffUserId}','客服','ACTIVE',1,now(),now()),
      ('${customerId}','老板','ACTIVE',1,now(),now()),
      ('${playerId}','阿岚','ACTIVE',1,now(),now());
    INSERT INTO staff_accounts (id,user_id,level,status,role_source,mfa_enrolled,permissions_version,created_at,updated_at)
      VALUES ('${staffId}','${staffUserId}','L1_SUPPORT','ACTIVE','MANUAL',true,3,now(),now());
    INSERT INTO discord_accounts (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000024110','${staffUserId}','${guildId}','${staffDiscordId}',now(),now(),now()),
      ('00000000-0000-0000-0000-000000024111','${customerId}','${guildId}','${customerDiscordId}',now(),now(),now()),
      ('00000000-0000-0000-0000-000000024112','${playerId}','${guildId}','900000000000024105',now(),now(),now());
    INSERT INTO player_profiles (id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at)
      VALUES ('${profileId}','${playerId}','ACTIVE',1,'AVAILABLE','ONLINE',now(),now());
    INSERT INTO gift_catalog_items (id,code,created_at,updated_at) VALUES ('${catalogItemId}','STAR',now(),now());
    INSERT INTO gift_catalog_versions (id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at)
      VALUES ('${catalogVersionId}','${catalogItemId}',1,'ACTIVE','${catalogItemId}','星星礼盒',6600,'CAT','{sender_name} 向 {receiver_name} 送出 {gift_name}','${staffId}',now(),now());
    INSERT INTO wallet_accounts (id,user_id,currency,status,row_version,created_at,updated_at)
      VALUES ('00000000-0000-0000-0000-000000024113','${customerId}','CAT','ACTIVE',1,now(),now());
    INSERT INTO wallet_entries (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
      VALUES ('00000000-0000-0000-0000-000000024114','00000000-0000-0000-0000-000000024113','TOP_UP_CREDIT','CREDIT',6600,'CAT','TOP_UP','00000000-0000-0000-0000-000000024115','m22:assist:wallet',now(),now());
  `);
  await pool.query(`INSERT INTO staff_mfa_credentials
    (id,staff_account_id,method,secret_ciphertext,verified_at,created_at,updated_at)
    VALUES ('00000000-0000-0000-0000-000000024109',$1,'TOTP',$2,now(),now(),now())`, [staffId,ciphertext]);
}

function generateTotp(secret: string, at: Date): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) => Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}
