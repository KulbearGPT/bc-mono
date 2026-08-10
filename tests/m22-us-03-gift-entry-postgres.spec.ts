import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import { PostgresOnboardingStore } from '@blackcat/api/onboarding';
import { InMemoryAuditSink, InMemoryIdempotencyStore } from '@blackcat/api/security';
import { applyCurrentMigrations } from './support/postgres-migrations';

const execFile = promisify(execFileCallback);
const guildId = '900000000000022250';
let root = '';
let data = '';
let pool: Pool;

describe('M22-US-03 PostgreSQL gift entry projection', () => {
  beforeAll(async () => {
    const port = 62_250 + (process.pid % 50);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m22-gift-entry-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m22_gift_entry']);
    await applyCurrentMigrations({ host: root, port, database: 'blackcat_m22_gift_entry' });
    pool = new Pool({ host: root, port, database: 'blackcat_m22_gift_entry' });
  }, 30_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('upserts and reloads one durable message pointer through the unified API', async () => {
    const server = buildApiServer({
      env: { NODE_ENV: 'development', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'valid-bot-token' },
      security: { auditSink: new InMemoryAuditSink(), idempotencyStore: new InMemoryIdempotencyStore() },
      onboarding: { store: new PostgresOnboardingStore(pool) }
    });
    const headers = { authorization: 'Bearer valid-bot-token', 'x-client-source': 'DISCORD_BOT' };
    const first = await server.inject({ method: 'PUT', url: '/api/v1/internal/gift-entry-message',
      headers: { ...headers, 'idempotency-key': 'gift-entry:postgres:first:22250' },
      payload: { guildId, channelId: '900000000000022251', messageId: '900000000000022252', renderedVersion: 1 } });
    const moved = await server.inject({ method: 'PUT', url: '/api/v1/internal/gift-entry-message',
      headers: { ...headers, 'idempotency-key': 'gift-entry:postgres:moved:22250' },
      payload: { guildId, channelId: '900000000000022253', messageId: '900000000000022254', renderedVersion: 2 } });
    const loaded = await server.inject({ method: 'GET', url: `/api/v1/internal/gift-entry-message?guildId=${guildId}`, headers });

    expect(first.statusCode, first.body).toBe(200);
    expect(moved.statusCode, moved.body).toBe(200);
    expect(loaded.json().data).toMatchObject({ guildId, channelId: '900000000000022253',
      messageId: '900000000000022254', renderedVersion: 2 });
    const facts = await pool.query('SELECT count(*)::int AS count FROM guild_gift_entry_messages WHERE guild_id=$1', [guildId]);
    expect(facts.rows[0]).toEqual({ count: 1 });
    await server.close();
  });
});
