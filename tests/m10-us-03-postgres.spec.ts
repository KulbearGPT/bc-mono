import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { buildApiServer } from '@blackcat/api/server';
import { PostgresOrderParticipantStore } from '@blackcat/api/order-participants';
import { PostgresOrderRequirementStore } from '@blackcat/api/order-requirements';
import { PostgresAuditSink, type StaffDirectory } from '@blackcat/api/security';

const execFile = promisify(execFileCallback);
let root = ''; let data = ''; let port = 0; let pool: Pool;
const database = 'blackcat_m10_participant_api';
const guildId = '999999999999999999';
const orderId = '00000000-0000-0000-0000-000000010001';
const rollbackOrderId = '00000000-0000-0000-0000-000000010009';
const fundedOrderId='00000000-0000-0000-0000-000000010011';
const fundedCustomerId='00000000-0000-0000-0000-000000010012';
const playerId = '00000000-0000-0000-0000-000000010002';
const catalogId = '00000000-0000-0000-0000-000000010003';
const staffId = '00000000-0000-0000-0000-000000010004';
const staffUserId = '00000000-0000-0000-0000-000000010005';
const discordId = '222222222222222222';
const requirementOrderId='00000000-0000-0000-0000-000000010021';
const requirementCustomerId='00000000-0000-0000-0000-000000010022';
const requirementDiscordId='333333333333333333';
const env = { NODE_ENV: 'test', DATABASE_URL: '', API_PORT: '0', API_BASE_URL: 'http://localhost:3000', BOT_SERVICE_TOKEN: 'token' };

describe('M10-US-03 PostgreSQL participant transaction', () => {
  beforeAll(async () => {
    port = 62_500 + (process.pid % 150); root = await mkdtemp(join(tmpdir(), 'blackcat-m10-participant-api-')); data = join(root, 'data');
    await execFile('initdb', ['-D', data, '--no-locale', '--encoding=UTF8']);
    await execFile('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${root}`, '-l', join(root, 'postgres.log'), 'start']);
    await execFile('createdb', ['-h', root, '-p', String(port), database]);
    const migrations = (await readdir('database/prisma/migrations')).sort();
    for (const migration of migrations) await execFile('psql', ['-h', root, '-p', String(port), '-d', database, '-v', 'ON_ERROR_STOP=1', '-f', `database/prisma/migrations/${migration}/migration.sql`]);
    pool = new Pool({ host: root, port, database }); await seed();
  }, 30_000);
  afterAll(async () => { await pool?.end().catch(() => undefined); if(data)await execFile('pg_ctl',['-D',data,'stop','-m','fast']).catch(()=>undefined); if(root)await rm(root,{recursive:true,force:true}); });

  test('commits participant, derived total, event and audit in one successful route write', async () => {
    const directory: StaffDirectory = { resolveByDiscord: ({ discordUserId }) => discordUserId === discordId ? { staffId, userId: staffUserId, level: 'L2_SUPERVISOR', permissionsVersion: 1, status: 'ACTIVE' } : null };
    const store = new PostgresOrderParticipantStore(pool);
    await store.add({orderId,actorStaffId:staffId,actorLevel:'L2_SUPERVISOR',guildId,playerId,serviceCatalogVersionId:catalogId,unitCount:3,linePriceMinor:360,expectedOrderVersion:1,reasonCode:'ADD_TECH_PLAYER',idempotencyKey:'m10:postgres:preflight',now:new Date('2026-08-04T12:00:00Z')});
    const server = buildApiServer({ env, security: { staffDirectory: directory, auditSink: new PostgresAuditSink({ client: pool }) }, orderParticipants: { store, now: () => new Date('2026-08-04T12:00:00Z') } });
    const response = await server.inject({ method:'POST',url:`/api/v1/admin/orders/${orderId}/participants`,headers:{authorization:'Bearer token','x-client-source':'DASHBOARD','x-actor-discord-user-id':discordId,'x-actor-guild-id':guildId,'idempotency-key':'m10:postgres:add:0001'},payload:{playerId,serviceCatalogVersionId:catalogId,unitCount:3,linePriceMinor:360,expectedOrderVersion:1,reasonCode:'ADD_TECH_PLAYER'} });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({orderVersion:2,derivedTotalMinor:360,participant:{gameDisplayName:'瓦洛兰特',serviceDisplayName:'技术陪玩',expectedEarningMinor:216}});
    const facts=await pool.query(`SELECT orders.amount_minor::text,orders.row_version,participant.service_catalog_version_id,event.event_type::text,audit.permission_code FROM orders JOIN order_participants participant ON participant.order_id=orders.id JOIN order_participant_events event ON event.order_participant_id=participant.id JOIN audit_logs audit ON audit.request_id=$2 WHERE orders.id=$1`,[orderId,response.json().requestId]);
    expect(facts.rows[0]).toMatchObject({amount_minor:'360',row_version:2,service_catalog_version_id:catalogId,event_type:'ADDED',permission_code:'order.participants.manage'});
  });

  test('rolls participant, total and event back when the audit append fails', async () => {
    const store=new PostgresOrderParticipantStore(pool);
    const staged=await store.add({orderId:rollbackOrderId,actorStaffId:staffId,actorLevel:'L2_SUPERVISOR',guildId,playerId,serviceCatalogVersionId:catalogId,unitCount:2,linePriceMinor:240,expectedOrderVersion:1,reasonCode:'ADD_PLAYER',idempotencyKey:'m10:postgres:rollback',now:new Date('2026-08-04T12:01:00Z')});
    await expect(staged.commit({id:'00000000-0000-0000-0000-000000019999',actorId:staffUserId,actorStaffId:'00000000-0000-0000-0000-000000019998',actorLevel:'L2_SUPERVISOR',actorSource:'DASHBOARD',clientId:'DASHBOARD',interactionId:null,permissionCode:'order.participants.manage',action:'ADD_ADMIN_ORDER_PARTICIPANT',targetType:'order_participant',targetId:staged.data.participant.id,outcome:'SUCCEEDED',reason:'ADD_PLAYER',requestId:'req_m10_rollback',approvalRequestId:null,occurredAt:'2026-08-04T12:01:00Z'})).rejects.toThrow();
    const facts=await pool.query(`SELECT orders.amount_minor::text,orders.row_version,(SELECT count(*)::int FROM order_participants WHERE order_id=orders.id) participant_count,(SELECT count(*)::int FROM order_participant_events event JOIN order_participants participant ON participant.id=event.order_participant_id WHERE participant.order_id=orders.id) event_count FROM orders WHERE id=$1`,[rollbackOrderId]);
    expect(facts.rows[0]).toEqual({amount_minor:'0',row_version:1,participant_count:0,event_count:0});
  });

  test('atomically increases and decreases the active wallet reservation with participant pricing',async()=>{
    const directory:StaffDirectory={resolveByDiscord:()=>({staffId,userId:staffUserId,level:'L2_SUPERVISOR',permissionsVersion:1,status:'ACTIVE'})};const store=new PostgresOrderParticipantStore(pool);await store.add({orderId:fundedOrderId,actorStaffId:staffId,actorLevel:'L2_SUPERVISOR',guildId,playerId,serviceCatalogVersionId:catalogId,unitCount:3,linePriceMinor:360,expectedOrderVersion:1,reasonCode:'ADD_PLAYER',idempotencyKey:'m10:funded:preflight',now:new Date('2026-08-04T12:02:00Z')});const server=buildApiServer({env,security:{staffDirectory:directory,auditSink:new PostgresAuditSink({client:pool})},orderParticipants:{store,now:()=>new Date('2026-08-04T12:02:00Z')}});
    const added=await server.inject({method:'POST',url:`/api/v1/admin/orders/${fundedOrderId}/participants`,headers:{authorization:'Bearer token','x-client-source':'DASHBOARD','x-actor-discord-user-id':discordId,'x-actor-guild-id':guildId,'idempotency-key':'m10:funded:add:0001'},payload:{playerId,serviceCatalogVersionId:catalogId,unitCount:3,linePriceMinor:360,expectedOrderVersion:1,reasonCode:'ADD_PLAYER'}});expect(added.statusCode,added.body).toBe(201);const participantId=added.json().data.participant.id;
    let reservation=await pool.query(`SELECT amount_minor::text,row_version,status::text FROM fund_reservations WHERE order_id=$1`,[fundedOrderId]);expect(reservation.rows[0]).toEqual({amount_minor:'360',row_version:2,status:'ACTIVE'});
    const changed=await server.inject({method:'PATCH',url:`/api/v1/admin/orders/${fundedOrderId}/participants/${participantId}`,headers:{authorization:'Bearer token','x-client-source':'DASHBOARD','x-actor-discord-user-id':discordId,'x-actor-guild-id':guildId,'idempotency-key':'m10:funded:change:0002'},payload:{expectedOrderVersion:2,expectedParticipantVersion:1,action:'CHANGE_PRICE',serviceCatalogVersionId:null,unitCount:null,linePriceMinor:200,reasonCode:'LOWER_PRICE'}});expect(changed.statusCode,changed.body).toBe(200);
    reservation=await pool.query(`SELECT amount_minor::text,row_version,status::text FROM fund_reservations WHERE order_id=$1`,[fundedOrderId]);expect(reservation.rows[0]).toEqual({amount_minor:'200',row_version:3,status:'ACTIVE'});const events=await pool.query(`SELECT event.event_type::text,event.amount_minor::text FROM fund_reservation_events event JOIN fund_reservations reservation ON reservation.id=event.fund_reservation_id WHERE reservation.order_id=$1 ORDER BY event.sequence`,[fundedOrderId]);expect(events.rows).toEqual([{event_type:'CREATED',amount_minor:'100'},{event_type:'INCREASED',amount_minor:'260'},{event_type:'DECREASED',amount_minor:'160'}]);
    const insufficient=await server.inject({method:'PATCH',url:`/api/v1/admin/orders/${fundedOrderId}/participants/${participantId}`,headers:{authorization:'Bearer token','x-client-source':'DASHBOARD','x-actor-discord-user-id':discordId,'x-actor-guild-id':guildId,'idempotency-key':'m10:funded:insufficient:0003'},payload:{expectedOrderVersion:3,expectedParticipantVersion:2,action:'CHANGE_PRICE',serviceCatalogVersionId:null,unitCount:null,linePriceMinor:2000,reasonCode:'RAISE_PRICE'}});expect(insufficient.statusCode).toBe(422);const unchanged=await pool.query(`SELECT orders.amount_minor::text,orders.row_version,participant.line_price_minor::text,participant.row_version participant_version,reservation.amount_minor::text reservation_minor,reservation.row_version reservation_version FROM orders JOIN order_participants participant ON participant.order_id=orders.id JOIN fund_reservations reservation ON reservation.order_id=orders.id WHERE orders.id=$1`,[fundedOrderId]);expect(unchanged.rows[0]).toEqual({amount_minor:'200',row_version:3,line_price_minor:'200',participant_version:2,reservation_minor:'200',reservation_version:3});
  });

  test('persists owner-authored requirements, derived estimate, events and audit atomically',async()=>{
    const store=new PostgresOrderRequirementStore(pool);const server=buildApiServer({env,security:{auditSink:new PostgresAuditSink({client:pool})},orderRequirements:{store,now:()=>new Date('2026-08-04T12:03:00Z')}});
    const headers={authorization:'Bearer token','x-client-source':'DISCORD_BOT','x-actor-discord-user-id':requirementDiscordId,'x-actor-guild-id':guildId,'x-discord-interaction-id':'444444444444444444','idempotency-key':'m10:requirement:add:0001'};
    const added=await server.inject({method:'POST',url:`/api/v1/orders/${requirementOrderId}/requirements`,headers,payload:{expectedOrderVersion:1,serviceCatalogVersionId:catalogId,unitCount:2,requestedPlayerCount:3}});expect(added.statusCode,added.body).toBe(201);expect(added.json().data).toMatchObject({orderVersion:2,derivedTotalMinor:600,requirement:{gameDisplayName:'瓦洛兰特',serviceDisplayName:'技术陪玩',estimatedLinePriceMinor:600}});
    const facts=await pool.query(`SELECT orders.amount_minor::text,orders.row_version,requirement.requested_player_count,requirement.estimated_line_price_minor::text,event.event_type::text,audit.permission_code FROM orders JOIN order_requirements requirement ON requirement.order_id=orders.id JOIN order_requirement_events event ON event.order_requirement_id=requirement.id JOIN audit_logs audit ON audit.request_id=$2 WHERE orders.id=$1`,[requirementOrderId,added.json().requestId]);expect(facts.rows[0]).toEqual({amount_minor:'600',row_version:2,requested_player_count:3,estimated_line_price_minor:'600',event_type:'ADDED',permission_code:'order.update'});
    await server.close();
  });
});

async function seed(){await pool.query(`
  INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES
    ('${staffUserId}','主管','ACTIVE',1,now(),now()),('${playerId}','奶糖','ACTIVE',1,now(),now()),('00000000-0000-0000-0000-000000010006','老板','ACTIVE',1,now(),now()),('00000000-0000-0000-0000-000000010010','另一位老板','ACTIVE',1,now(),now()),('${fundedCustomerId}','已充值老板','ACTIVE',1,now(),now()),('${requirementCustomerId}','多项目老板','ACTIVE',1,now(),now());
  INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000010023','${requirementCustomerId}','${guildId}','${requirementDiscordId}',now(),now());
  INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES('${staffId}','${staffUserId}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
  INSERT INTO player_profiles(id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000010007','${playerId}','ACTIVE',1,'AVAILABLE','ONLINE',now(),now());
  INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000010008','VAL-TECH-NA','VALORANT','瓦洛兰特','TECH','技术陪玩','NA',now(),now());
  INSERT INTO service_catalog_versions(id,service_offering_id,version,status,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at) VALUES('${catalogId}','00000000-0000-0000-0000-000000010008',1,'ACTIVE',60,1,100,60,6000,'CAT','${staffId}',now());
  INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,channel_id,panel_message_id,created_at,updated_at) VALUES
    ('${orderId}','P-M10-API','00000000-0000-0000-0000-000000010006','00000000-0000-0000-0000-000000010006','DRAFT',1,0,0,'CAT','${guildId}','111111111111111111','222222222222222223',now(),now()),
    ('${rollbackOrderId}','P-M10-ROLLBACK','00000000-0000-0000-0000-000000010010','00000000-0000-0000-0000-000000010010','DRAFT',1,0,0,'CAT','${guildId}','111111111111111112','222222222222222224',now(),now()),
    ('${fundedOrderId}','P-M10-FUNDED','${fundedCustomerId}','${fundedCustomerId}','PENDING_DISPATCH',1,100,60,'CAT','${guildId}','111111111111111113','222222222222222225',now(),now()),
    ('${requirementOrderId}','P-M10-REQ','${requirementCustomerId}','${requirementCustomerId}','DRAFT',1,0,0,'CAT','${guildId}','111111111111111114','222222222222222226',now(),now());
  INSERT INTO wallet_accounts(id,user_id,currency,status,row_version,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000010013','${fundedCustomerId}','CAT','ACTIVE',1,now(),now());
  INSERT INTO wallet_entries(id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at) VALUES('00000000-0000-0000-0000-000000010014','00000000-0000-0000-0000-000000010013','TOP_UP_CREDIT','CREDIT',1000,'CAT','TOP_UP','00000000-0000-0000-0000-000000010015','seed:wallet:credit',now(),now());
  INSERT INTO fund_reservations(id,user_id,source_type,order_id,mode,amount_minor,currency,status,row_version,idempotency_key,expires_at,activated_at,created_at,updated_at) VALUES('00000000-0000-0000-0000-000000010016','${fundedCustomerId}','ORDER','${fundedOrderId}','LOCAL_RESERVATION',100,'CAT','ACTIVE',1,'seed:reservation',now()+interval '30 minutes',now(),now(),now());
  INSERT INTO fund_reservation_events(id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_source,created_at) VALUES('00000000-0000-0000-0000-000000010017','00000000-0000-0000-0000-000000010016',1,'CREATED',NULL,'ACTIVE',100,1,'seed:reservation:event','SYSTEM_JOB',now());
`);}
