import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOrderChannelEventStore, recordOrderChannelEvent } from '@blackcat/api/order-channel-events';
import { PostgresSupportResponseJobStore } from '@blackcat/api/support-response-jobs';
import { startIsolatedPostgres, type IsolatedPostgres } from './support/isolated-postgres';

const guildId='999999999999999999';
const channelId='777777777777777777';
const orderId='00000000-0000-0000-0000-000000013001';
const customerId='00000000-0000-0000-0000-000000013002';
const staffIds=['00000000-0000-0000-0000-000000013003','00000000-0000-0000-0000-000000013004'];
let isolated:IsolatedPostgres;let pool:Pool;

describe('M12-US-03 PostgreSQL first response concurrency',()=>{
  beforeAll(async()=>{
    isolated=await startIsolatedPostgres('a4_first_response');
    pool=isolated.pool;
    await pool.query(`INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
      ($1,'客户','ACTIVE',1,now(),now()),($2,'店主','ACTIVE',1,now(),now()),($3,'一线客服','ACTIVE',1,now(),now())`,[customerId,...staffIds]);
    await pool.query(`INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES
      ($1,$1,'L4_ADMIN_OWNER','ACTIVE','MANUAL',1,now(),now()),($2,$2,'L1_SUPPORT','ACTIVE','MANUAL',1,now(),now())`,staffIds);
    await pool.query(`INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES
      (gen_random_uuid(),$1,$3,'444444444444444444',now(),now(),now()),(gen_random_uuid(),$2,$3,'555555555555555555',now(),now(),now())`,[...staffIds,guildId]);
    await pool.query(`INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,guild_id,channel_id,updated_at)
      VALUES($1,'P-M12-RESPONSE',$2,$2,'IN_SERVICE',1,$3,$4,now())`,[orderId,customerId,guildId,channelId]);
    await pool.query(`INSERT INTO staff_tasks(id,public_id,type,reason_code,status,row_version,order_id,context_snapshot,created_at,updated_at) VALUES
      ('00000000-0000-0000-0000-000000013011','T-M12-OLD','ORDER_ASSIST','CUSTOMER_HELP','OPEN',1,$1,'{}','2026-08-05T16:00:00Z','2026-08-05T16:00:00Z'),
      ('00000000-0000-0000-0000-000000013012','T-M12-NEW','SERVICE_INTERRUPTED','CUSTOMER_HELP','OPEN',1,$1,'{}','2026-08-05T16:00:30Z','2026-08-05T16:00:30Z')`,[orderId]);
  },40_000);

  afterAll(async()=>isolated.stop());

  test('two staff replies serialize to one owner while both response facts converge',async()=>{
    const store=new PostgresOrderChannelEventStore(pool);
    const event=(discordUserId:string,messageId:string)=>({guildId,channelId,messageId,eventId:`CREATED:${messageId}`,eventType:'CREATED' as const,
      authorDiscordId:discordUserId,authorDisplayName:'客服',authorIsBot:false,content:'我来处理',embeds:[],attachments:[],replyToMessageId:null,
      discordCreatedAt:'2026-08-05T16:01:00.000Z',discordEditedAt:null});
    await Promise.all([
      recordOrderChannelEvent({store,event:event('444444444444444444','666666666666666661'),observedAt:new Date('2026-08-05T16:01:01Z')}),
      recordOrderChannelEvent({store,event:event('555555555555555555','666666666666666662'),observedAt:new Date('2026-08-05T16:01:02Z')})
    ]);
    const tasks=await pool.query(`SELECT public_id,status::text,response_status::text,claimed_by_staff_id,first_response_event_id
      FROM staff_tasks WHERE order_id=$1 ORDER BY created_at`,[orderId]);
    expect(tasks.rows).toHaveLength(2);
    expect(tasks.rows[0]).toMatchObject({public_id:'T-M12-OLD',status:'CLAIMED',response_status:'MET',claimed_by_staff_id:expect.stringMatching(/^00000000-/),first_response_event_id:expect.any(String)});
    expect(tasks.rows[1]).toMatchObject({public_id:'T-M12-NEW',status:'OPEN',response_status:'MET',claimed_by_staff_id:null,first_response_event_id:expect.any(String)});
    expect((await pool.query(`SELECT count(*)::int count FROM audit_logs WHERE action='AUTO_CLAIM_STAFF_TASK'`)).rows[0].count).toBe(1);
    expect((await pool.query(`SELECT count(*)::int count FROM outbox_events WHERE aggregate_type='staff_task'`)).rows[0].count).toBe(6);
    expect((await pool.query(`SELECT count(*)::int count FROM outbox_events WHERE event_type='SUPPORT_RESPONSE_REMINDER' AND dedupe_key LIKE 'support-response-reminder-met:%'`)).rows[0].count).toBe(2);
  });

  test('projects readiness timeout duration and pending sides for the customer reminder',async()=>{
    const readinessOrderId='00000000-0000-0000-0000-000000013021';
    const readinessTaskId='00000000-0000-0000-0000-000000013022';
    await pool.query(`INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,guild_id,channel_id,accepted_at,readiness_due_at,updated_at)
      VALUES($1,'P-M12-READY',$2,$2,'ACCEPTED',1,$3,'777777777777777779','2026-08-05T16:00:00Z','2026-08-05T16:10:00Z','2026-08-05T16:00:00Z')`,[readinessOrderId,staffIds[0],guildId]);
    await pool.query(`INSERT INTO staff_tasks(id,public_id,type,reason_code,status,row_version,order_id,context_snapshot,created_at,updated_at)
      VALUES($1,'TASK-P-M12-READY','ORDER_ASSIST','READINESS_TIMEOUT','OPEN',1,$2,$3::jsonb,'2026-08-05T16:10:00Z','2026-08-05T16:10:00Z')`,[
        readinessTaskId,readinessOrderId,JSON.stringify({readinessDueAt:'2026-08-05T16:10:00.000Z',readinessParticipants:[
          {participantId:'participant-ready',displayName:'陪玩 A',readiness:'READY'},
          {participantId:'participant-pending',displayName:'陪玩 B',readiness:'NOT_READY'}
        ]})
      ]);
    const reminder=await new PostgresSupportResponseJobStore(pool).getReminder(readinessTaskId,new Date('2026-08-05T16:14:00Z'));
    expect(reminder).toMatchObject({
      publicId:'TASK-P-M12-READY',reasonCode:'READINESS_TIMEOUT',state:'WAITING',
      readiness:{waitMinutes:10,pendingPlayers:['陪玩 B'],activePlayerCount:2}
    });
  });
});
