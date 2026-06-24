import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresSelectionPoolStore } from '@blackcat/api/selection-pools';
import type { AuditRecord } from '@blackcat/api/security';

const execFile=promisify(execFileCallback);let root='';let data='';let port=0;let pool:Pool;
const guildId='999999999999999999';const customerId='00000000-0000-0000-0000-000000011001';const customerDiscord='111111111111111111';const playerId='00000000-0000-0000-0000-000000011002';const playerDiscord='222222222222222222';const staffId='00000000-0000-0000-0000-000000011003';const catalogId='00000000-0000-0000-0000-000000011011';const orderId='00000000-0000-0000-0000-000000011020';const requirementId='00000000-0000-0000-0000-000000011021';
const secondOrderId='00000000-0000-0000-0000-000000011030';const secondRequirementId='00000000-0000-0000-0000-000000011031';
const secondCustomerId='00000000-0000-0000-0000-000000011032';const secondCustomerDiscord='333333333333333333';

describe('M11-US-02 PostgreSQL selection pool transaction',()=>{
  beforeAll(async()=>{port=62600+(process.pid%100);root=await mkdtemp(join(tmpdir(),'blackcat-m11-selection-'));data=join(root,'data');await execFile('initdb',['-D',data,'--no-locale','--encoding=UTF8']);await execFile('pg_ctl',['-D',data,'-o',`-p ${port} -k ${root}`,'-l',join(root,'postgres.log'),'start']);await execFile('createdb',['-h',root,'-p',String(port),'blackcat_m11_selection']);for(const migration of (await readdir('database/prisma/migrations')).sort())await execFile('psql',['-h',root,'-p',String(port),'-d','blackcat_m11_selection','-v','ON_ERROR_STOP=1','-f',`database/prisma/migrations/${migration}/migration.sql`]);pool=new Pool({host:root,port,database:'blackcat_m11_selection',max:8});await seed();},30000);
  afterAll(async()=>{await pool?.end().catch(()=>undefined);if(data)await execFile('pg_ctl',['-D',data,'stop','-m','fast']).catch(()=>undefined);if(root)await rm(root,{recursive:true,force:true});});

  test('allows cross-order applications while offline, then atomically grants only one active slot',async()=>{
    const store=new PostgresSelectionPoolStore(pool);const now=new Date('2026-08-04T12:00:00Z');
    const created=await commit(await store.createPool({orderId,actorGuildId:guildId,actorDiscordUserId:customerDiscord,expectedOrderVersion:1,waitMinutes:3,idempotencyKey:'m11:pool:create:0001',now}),customerId);
    const secondCreated=await commit(await store.createPool({orderId:secondOrderId,actorGuildId:guildId,actorDiscordUserId:secondCustomerDiscord,expectedOrderVersion:1,waitMinutes:3,idempotencyKey:'m11:pool:create:1001',now}),secondCustomerId);
    const applied=await commit(await store.apply({orderId,selectionPoolId:created.pool.id,orderRequirementId:requirementId,actorGuildId:guildId,actorDiscordUserId:playerDiscord,expectedPoolVersion:created.pool.version,idempotencyKey:'m11:pool:apply:0002',now}),playerId);
    const secondApplied=await commit(await store.apply({orderId:secondOrderId,selectionPoolId:secondCreated.pool.id,orderRequirementId:secondRequirementId,actorGuildId:guildId,actorDiscordUserId:playerDiscord,expectedPoolVersion:secondCreated.pool.version,idempotencyKey:'m11:pool:apply:1002',now}),playerId);
    expect(applied.application).toMatchObject({playerId,status:'APPLIED'});
    expect((await pool.query(`SELECT availability::text,discord_presence::text FROM player_profiles WHERE user_id=$1`,[playerId])).rows[0]).toEqual({availability:'BUSY',discord_presence:'OFFLINE'});
    const closed=await commit(await store.closePool({orderId,selectionPoolId:created.pool.id,actorGuildId:guildId,actorDiscordUserId:customerDiscord,expectedPoolVersion:applied.pool.version,reason:'CUSTOMER_EARLY_CLOSE',idempotencyKey:'m11:pool:close:0003',now}),customerId);
    const secondClosed=await commit(await store.closePool({orderId:secondOrderId,selectionPoolId:secondCreated.pool.id,actorGuildId:guildId,actorDiscordUserId:secondCustomerDiscord,expectedPoolVersion:secondApplied.pool.version,reason:'CUSTOMER_EARLY_CLOSE',idempotencyKey:'m11:pool:close:1003',now}),secondCustomerId);
    const firstFinal=await store.finalize({orderId,selectionPoolId:created.pool.id,actorGuildId:guildId,actorDiscordUserId:customerDiscord,expectedOrderVersion:1,expectedPoolVersion:closed.pool.version,applicationIds:[applied.application.id],idempotencyKey:'m11:pool:finalize:0004',now});
    const secondFinal=await store.finalize({orderId:secondOrderId,selectionPoolId:secondCreated.pool.id,actorGuildId:guildId,actorDiscordUserId:secondCustomerDiscord,expectedOrderVersion:1,expectedPoolVersion:secondClosed.pool.version,applicationIds:[secondApplied.application.id],idempotencyKey:'m11:pool:finalize:1004',now});
    const outcomes=await Promise.allSettled([commit(firstFinal,customerId),commit(secondFinal,secondCustomerId)]);expect(outcomes.filter((item)=>item.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter((item)=>item.status==='rejected')).toHaveLength(1);
    const facts=await pool.query(`SELECT (SELECT count(*)::int FROM order_participants WHERE player_id=$1 AND status='ACTIVE') participant_count,(SELECT count(*)::int FROM orders WHERE id=ANY($2::uuid[]) AND status='ACCEPTED') accepted_count,(SELECT count(*)::int FROM selection_applications WHERE player_user_id=$1 AND status='SELECTED') selected_count,(SELECT count(*)::int FROM selection_applications WHERE player_user_id=$1 AND status='INVALIDATED') invalidated_count,(SELECT count(*)::int FROM fund_reservations WHERE order_id=ANY($2::uuid[])) reservation_count,(SELECT count(*)::int FROM order_participant_events event JOIN order_participants participant ON participant.id=event.order_participant_id WHERE participant.player_id=$1) participant_event_count`,[playerId,[orderId,secondOrderId]]);
    expect(facts.rows[0]).toEqual({participant_count:1,accepted_count:1,selected_count:1,invalidated_count:1,reservation_count:0,participant_event_count:1});
    await expect(pool.query(`UPDATE selection_pool_events SET snapshot='{}' WHERE selection_pool_id=$1`,[created.pool.id])).rejects.toThrow(/append-only/u);
  });
});

async function commit<T>(staged:{data:T;commit(audit:AuditRecord):Promise<void>|void},actorId:string){await staged.commit({id:crypto.randomUUID(),actorId,actorStaffId:null,actorLevel:null,actorSource:'DISCORD_BOT',clientId:'DISCORD_BOT',interactionId:null,permissionCode:'order.selection_pool.create',action:'TEST_SELECTION_WRITE',targetType:'selection_pool',targetId:orderId,outcome:'SUCCEEDED',reason:null,requestId:`req_${crypto.randomUUID()}`,idempotencyKey:null,approvalRequestId:null,occurredAt:'2026-08-04T12:00:00.000Z'});return staged.data;}

async function seed(){
  await pool.query(`INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES($1,'老板','ACTIVE',1,now(),now()),($2,'离线猫','ACTIVE',1,now(),now()),($3,'店主','ACTIVE',1,now(),now()),($4,'另一位老板','ACTIVE',1,now(),now())`,[customerId,playerId,staffId,secondCustomerId]);
  await pool.query(`INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011004',$1,$3,$4,now(),now(),now()),('00000000-0000-0000-0000-000000011005',$2,$3,$5,now(),now(),now()),('00000000-0000-0000-0000-000000011033',$6,$3,$7,now(),now(),now())`,[customerId,playerId,guildId,customerDiscord,playerDiscord,secondCustomerId,secondCustomerDiscord]);
  await pool.query(`INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES($1,$1,'L4_ADMIN_OWNER','ACTIVE','MANUAL',1,now(),now())`,[staffId]);
  await pool.query(`INSERT INTO player_profiles(id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011006',$1,'ACTIVE',1,'BUSY','OFFLINE',now(),now())`,[playerId]);
  await pool.query(`INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000011010','VAL-TECH-NA','VALORANT','瓦洛兰特','TECH','技术陪玩','NA',now(),now())`);
  await pool.query(`INSERT INTO service_catalog_versions(id,service_offering_id,version,status,active_offering_key,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at) VALUES($1,'00000000-0000-0000-0000-000000011010',1,'ACTIVE','00000000-0000-0000-0000-000000011010',60,1,100,60,6000,'CAT',$2,now())`,[catalogId,staffId]);
  await pool.query(`INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,submitted_at,created_at,updated_at) VALUES($1,'P-M11-POOL',$2,$2,'PENDING_DISPATCH',1,200,120,'CAT',$3,now(),now(),now())`,[orderId,customerId,guildId]);
  await pool.query(`INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,estimated_line_price_minor,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,2,1,100,200,now(),now())`,[requirementId,orderId,catalogId]);
  await pool.query(`INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,submitted_at,created_at,updated_at) VALUES($1,'P-M11-POOL-2',$2,$2,'PENDING_DISPATCH',1,200,120,'CAT',$3,now(),now(),now())`,[secondOrderId,secondCustomerId,guildId]);
  await pool.query(`INSERT INTO order_requirements(id,order_id,service_catalog_version_id,status,row_version,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,requested_player_count,customer_unit_price_minor_snapshot,estimated_line_price_minor,created_at,updated_at) VALUES($1,$2,$3,'ACTIVE',1,'VALORANT','瓦洛兰特','TECH','技术陪玩','NA','北美',60,2,1,100,200,now(),now())`,[secondRequirementId,secondOrderId,catalogId]);
}
