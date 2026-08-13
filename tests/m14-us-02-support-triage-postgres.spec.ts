import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PostgresSupportWorkbenchStore } from '@blackcat/api/support-workbench';
import { startIsolatedPostgres, type IsolatedPostgres } from './support/isolated-postgres.js';

const guildId = '999999999999999999';
const otherGuildId = '888888888888888888';
const customerId = '00000000-0000-0000-0000-000000014001';
const staffId = '00000000-0000-0000-0000-000000014002';
let postgres: IsolatedPostgres;

describe('M14-US-02 PostgreSQL task triage projection', () => {
  beforeAll(async () => {
    postgres = await startIsolatedPostgres('m14_support_triage');
    const { pool } = postgres;
    await pool.query(
      `INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
      ($1,'测试客户','ACTIVE',1,now(),now()),($2,'一线客服','ACTIVE',1,now(),now())`,
      [customerId, staffId]
    );
    await pool.query(
      `INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,guild_id,channel_id,voice_channel_id,
      game_code_snapshot,game_name_snapshot,service_code_snapshot,service_name_snapshot,amount_minor,currency,updated_at) VALUES
      ('00000000-0000-0000-0000-000000014011','P-M14-PG-1',$1,$1,'PENDING_DISPATCH',1,$2,'120000000000000001','120000000000000003','VALORANT','无畏契约','FUN','娱乐陪玩',12000,'CAT',now()),
      ('00000000-0000-0000-0000-000000014012','P-M14-PG-2',$1,NULL,'COMPLETED',1,$3,'120000000000000009',NULL,'LOL','英雄联盟','FUN','娱乐陪玩',6000,'CAT',now())`,
      [customerId, guildId, otherGuildId]
    );
    await pool.query(`INSERT INTO staff_tasks(id,public_id,type,reason_code,status,row_version,order_id,context_snapshot,response_status,response_due_at,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000014021','T-M14-PENDING','ORDER_ASSIST','ORDER_ASSIST_REQUESTED','OPEN',1,'00000000-0000-0000-0000-000000014011','{}','PENDING','2026-08-05T20:05:00Z','2026-08-05T20:00:00Z','2026-08-05T20:00:00Z'),
      ('00000000-0000-0000-0000-000000014022','T-M14-OVERDUE','ORDER_ASSIST','ORDER_ASSIST_REQUESTED','OPEN',1,'00000000-0000-0000-0000-000000014011','{}','OVERDUE','2026-08-05T20:01:00Z','2026-08-05T19:59:00Z','2026-08-05T20:06:00Z'),
      ('00000000-0000-0000-0000-000000014023','T-M14-OTHER-GUILD','ORDER_ASSIST','ORDER_ASSIST_REQUESTED','OPEN',1,'00000000-0000-0000-0000-000000014012','{}','OVERDUE','2026-08-05T20:00:00Z','2026-08-05T19:58:00Z','2026-08-05T20:06:00Z')`);
  }, 40_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  test('joins trusted order context, sorts by response urgency and isolates Guild', async () => {
    const store = new PostgresSupportWorkbenchStore(postgres.pool);
    const items = await store.listTasks({
      actor: {
        actorUserId: staffId,
        actorStaffId: staffId,
        actorLevel: 'L1_SUPPORT',
        actorSource: 'DASHBOARD',
        clientId: 'dashboard',
        guildId,
        discordUserId: null,
        interactionId: null,
        permissionsVersion: 1
      },
      limit: 50
    });
    expect(items.map((item) => item.publicId)).toEqual(['T-M14-OVERDUE', 'T-M14-PENDING']);
    expect(items[0]).toMatchObject({
      triage: {
        orderPublicId: 'P-M14-PG-1',
        customerDisplayName: '测试客户',
        gameDisplayName: '无畏契约',
        amountMinor: 12000
      },
      links: {
        orderChannel: `https://discord.com/channels/${guildId}/120000000000000001`,
        voiceChannel: `https://discord.com/channels/${guildId}/120000000000000003`
      }
    });
  });
});
