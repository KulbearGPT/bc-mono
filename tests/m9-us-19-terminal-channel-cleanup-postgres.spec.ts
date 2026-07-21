import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import {
  enqueueTerminalChannelArchive,
  PostgresTerminalChannelCleanupStore
} from '../apps/api/src/order-channel-cleanup.js';

const execFile = promisify(execFileCallback);
const guildId = '999999999999999919';
const customerId = '00000000-0000-0000-0000-000000009190';
const completedOrderId = '00000000-0000-0000-0000-000000009191';
const cancelledOrderId = '00000000-0000-0000-0000-000000009192';
const activeOrderId = '00000000-0000-0000-0000-000000009193';
const blockedOrderId = '00000000-0000-0000-0000-000000009194';
const now = new Date('2026-08-07T12:00:00.000Z');
let root = '';
let data = '';
let pool: Pool;

describe('M9-US-19 PostgreSQL terminal channel reconciliation', () => {
  beforeAll(async () => {
    const port = 63_060 + (process.pid % 20);
    root = await mkdtemp(join(tmpdir(), 'blackcat-m9-channel-cleanup-'));
    data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), 'blackcat_m9_channel_cleanup']);
    for (const migration of (await readdir('database/prisma/migrations')).sort()) {
      await execFile('psql', [
        '-h',
        root,
        '-p',
        String(port),
        '-d',
        'blackcat_m9_channel_cleanup',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        `database/prisma/migrations/${migration}/migration.sql`
      ]);
    }
    pool = new Pool({ host: root, port, database: 'blackcat_m9_channel_cleanup', max: 5 });
    await pool.query(
      `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
       VALUES($1,'客户','ACTIVE',1,$2,$2)`,
      [customerId, now]
    );
    await pool.query(
      `INSERT INTO orders(
         id,public_id,customer_id,active_customer_slot_id,status,row_version,guild_id,channel_id,panel_message_id,
         selection_voice_channel_id,voice_channel_id,amount_minor,currency,completed_at,cancelled_at,created_at,updated_at
       ) VALUES
       ($1,'P-CLEAN-C',$5,NULL,'COMPLETED',7,$6,'211111111111111111','311111111111111111','411111111111111111','511111111111111111',100,'CAT',$7,NULL,$7,$7),
       ($2,'P-CLEAN-X',$5,NULL,'CANCELLED',4,$6,'221111111111111111','321111111111111111','421111111111111111','521111111111111111',100,'CAT',NULL,$7,$7,$7),
       ($3,'P-CLEAN-A',$5,$5,'DRAFT',3,$6,'231111111111111111','331111111111111111',NULL,'531111111111111111',100,'CAT',NULL,NULL,$7,$7),
       ($4,'P-CLEAN-B',$5,NULL,'CANCELLED',5,$6,'241111111111111111','341111111111111111',NULL,'541111111111111111',100,'CAT',NULL,$7,$7,$7)`,
      [
        completedOrderId,
        cancelledOrderId,
        activeOrderId,
        blockedOrderId,
        customerId,
        guildId,
        new Date(now.getTime() - 2 * 86_400_000)
      ]
    );
    await pool.query(
      `INSERT INTO outbox_events(
         id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at
       ) VALUES(gen_random_uuid(),'PANEL_SYNC','order',$1,$1,'blocked-panel-sync',$2::jsonb,'FAILED',2,1,8,$3,$3,$3)`,
      [blockedOrderId, JSON.stringify({ orderId: blockedOrderId }), now]
    );
  }, 40_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    if (data) await execFile('pg_ctl', ['-D', data, 'stop', '-m', 'fast']).catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('terminal transition enqueues one versioned job and non-terminal transition enqueues none', async () => {
    await enqueueTerminalChannelArchive(pool, { orderId: completedOrderId, orderVersion: 7, now });
    await enqueueTerminalChannelArchive(pool, { orderId: completedOrderId, orderVersion: 7, now });
    await enqueueTerminalChannelArchive(pool, { orderId: activeOrderId, orderVersion: 3, now });
    const result = await pool.query<{ order_id: string; dedupe_key: string; delay_seconds: number }>(
      `SELECT order_id,dedupe_key,extract(epoch FROM available_at-$2::timestamptz)::int delay_seconds
         FROM outbox_events WHERE event_type='CHANNEL_ARCHIVE' AND order_id IN ($1,$3)`,
      [completedOrderId, now, activeOrderId]
    );
    expect(result.rows).toEqual([
      {
        order_id: completedOrderId,
        dedupe_key: `terminal-channel-cleanup:${completedOrderId}:v7`,
        delay_seconds: 86_405
      }
    ]);
  });

  test('sweep queues only due terminal orders without an outstanding panel synchronization', async () => {
    const store = new PostgresTerminalChannelCleanupStore(pool);
    expect(await store.enqueueDueTerminalOrders(now)).toBe(1);
    expect(await store.enqueueDueTerminalOrders(now)).toBe(0);
    const queued = await pool.query<{ order_id: string }>(
      `SELECT order_id FROM outbox_events WHERE event_type='CHANNEL_ARCHIVE' ORDER BY order_id`
    );
    expect(queued.rows.map((row) => row.order_id)).toEqual([completedOrderId, cancelledOrderId]);
  });

  test('snapshot backfill is append-only and idempotent by the live listener event id', async () => {
    const store = new PostgresTerminalChannelCleanupStore(pool);
    const current = await store.getProjection(completedOrderId);
    expect(current).toMatchObject({ status: 'COMPLETED', panelSyncOutstanding: false });
    if (!current) throw new Error('projection missing');
    const input = {
      projection: current,
      message: {
        id: '611111111111111111',
        author: { id: '711111111111111111', username: 'customer', global_name: 'Customer', bot: false },
        member: { nick: '老板' },
        content: 'terminal transcript',
        embeds: [{ title: '状态' }],
        attachments: [
          {
            id: '811111111111111111',
            filename: 'proof.png',
            size: 123,
            content_type: 'image/png',
            url: 'https://cdn.discord.test/proof.png'
          }
        ],
        message_reference: { message_id: '911111111111111111' },
        timestamp: '2026-08-07T11:00:00.000Z',
        edited_timestamp: null
      },
      observedAt: now
    };
    await store.appendSnapshot(input);
    await store.appendSnapshot(input);
    const events = await pool.query<{
      event_id: string;
      content_snapshot: string;
      attachments_snapshot: unknown;
      observed_at: Date;
    }>(
      `SELECT event_id,content_snapshot,attachments_snapshot,observed_at FROM order_channel_message_events WHERE order_id=$1`,
      [completedOrderId]
    );
    expect(events.rows).toEqual([
      {
        event_id: '611111111111111111:CREATED:v1',
        content_snapshot: 'terminal transcript',
        attachments_snapshot: [
          {
            id: '811111111111111111',
            name: 'proof.png',
            size: 123,
            contentType: 'image/png',
            url: 'https://cdn.discord.test/proof.png'
          }
        ],
        observed_at: new Date('2026-08-07T11:00:00.000Z')
      }
    ]);
    await expect(
      pool.query(`UPDATE order_channel_message_events SET content_snapshot='changed' WHERE order_id=$1`, [
        completedOrderId
      ])
    ).rejects.toThrow(/append-only/i);
  });
});
