import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { PostgresDashboardMetricsStore } from '@blackcat/api/dashboard-metrics';
import { applyCurrentMigrations } from './support/postgres-migrations';

const execFile = promisify(execFileCallback);
const now = new Date('2026-07-18T18:00:00.000Z');
const id = (suffix: string) => `00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
const ids = { staffUser:id('901'),staff:id('902'),customer:id('903'),player:id('904'),order:id('905'),active:id('906'),exception:id('907'),other:id('908'),reservation:id('909'),giftItem:id('910'),giftVersion:id('911'),gift:id('912'),giftDebit:id('913'),giftCredit:id('914'),activeCustomer:id('915'),exceptionCustomer:id('916'),otherCustomer:id('917') };
let root='';let data='';let pool:Pool;

describe('M4-US-09 PostgreSQL dashboard metrics',()=>{
  beforeAll(async()=>{const port=62000+(process.pid%100);root=await mkdtemp(join(tmpdir(),'blackcat-m4-metrics-'));data=join(root,'data');await execFile('initdb',['-D',data,'--no-locale','--encoding=UTF8']);await execFile('pg_ctl',['-D',data,'-o',`-p ${port} -k ${root}`,'-l',join(root,'postgres.log'),'start']);await execFile('createdb',['-h',root,'-p',String(port),'blackcat_m4_metrics']);await applyCurrentMigrations({host:root,port,database:'blackcat_m4_metrics'});pool=new Pool({host:root,port,database:'blackcat_m4_metrics'});await seed();},30000);
  afterAll(async()=>{await pool?.end().catch(()=>undefined);if(data)await execFile('pg_ctl',['-D',data,'stop','-m','fast']).catch(()=>undefined);if(root)await rm(root,{recursive:true,force:true});});

  test('recomputes all eight L2 team metrics from immutable source facts',async()=>{
    const summary=await new PostgresDashboardMetricsStore(pool).getSummary({actorStaffId:ids.staff,actorLevel:'L2_SUPERVISOR',guildId:'900000000000009000',now,timeZone:'Asia/Shanghai',currency:'USD'});
    expect(summary.metrics).toEqual({todayOrderCount:3,inProgressOrderCount:1,pendingStaffTaskCount:3,completedOrderNetConsumptionMinor:8000,giftNetConsumptionMinor:2500,activeReservedMinor:7000,dispatchSuccessRateBps:5000,exceptionCount:2});
  });

  test('returns stable zero values for an empty team scope',async()=>{
    const summary=await new PostgresDashboardMetricsStore(pool).getSummary({actorStaffId:ids.staff,actorLevel:'L2_SUPERVISOR',guildId:'900000000000009998',now,timeZone:'Asia/Shanghai',currency:'USD'});
    expect(summary.metrics).toEqual({todayOrderCount:0,inProgressOrderCount:0,pendingStaffTaskCount:0,completedOrderNetConsumptionMinor:0,giftNetConsumptionMinor:0,activeReservedMinor:0,dispatchSuccessRateBps:0,exceptionCount:0});
  });
});

async function seed(){await pool.query(`
  INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES ('${ids.staffUser}','Supervisor','ACTIVE',1,now(),now()),('${ids.customer}','Customer','ACTIVE',1,now(),now()),('${ids.player}','Player','ACTIVE',1,now(),now()),('${ids.activeCustomer}','Active Customer','ACTIVE',1,now(),now()),('${ids.exceptionCustomer}','Exception Customer','ACTIVE',1,now(),now()),('${ids.otherCustomer}','Other Customer','ACTIVE',1,now(),now());
  INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES ('${ids.staff}','${ids.staffUser}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
  INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at) VALUES (gen_random_uuid(),'${ids.staffUser}','900000000000009000','900000000000009002',now(),now(),now());
  INSERT INTO orders(id,public_id,customer_id,player_id,active_customer_slot_id,status,row_version,currency,amount_minor,guild_id,completed_at,created_at,updated_at) VALUES
    ('${ids.order}','P-0905','${ids.customer}','${ids.player}',NULL,'COMPLETED',3,'USD',10000,'900000000000009000','2026-07-18T17:30:00Z','2026-07-18T16:30:00Z','2026-07-18T17:30:00Z'),
    ('${ids.active}','P-0906','${ids.activeCustomer}',NULL,'${ids.activeCustomer}','PENDING_DISPATCH',2,'USD',12000,'900000000000009000',NULL,'2026-07-18T17:00:00Z','2026-07-18T17:00:00Z'),
    ('${ids.exception}','P-0907','${ids.exceptionCustomer}',NULL,'${ids.exceptionCustomer}','EXCEPTION',4,'USD',5000,'900000000000009000',NULL,'2026-07-18T17:10:00Z','2026-07-18T17:20:00Z'),
    ('${ids.other}','P-0908','${ids.otherCustomer}',NULL,'${ids.otherCustomer}','PENDING_DISPATCH',2,'USD',9000,'900000000000009999',NULL,'2026-07-18T17:00:00Z','2026-07-18T17:00:00Z');
  INSERT INTO staff_tasks(id,public_id,type,reason_code,status,row_version,order_id,claimed_by_staff_id,context_snapshot,created_at,updated_at) VALUES
    (gen_random_uuid(),'T-0910','ORDER_ASSIST','CUSTOMER_ASSIST','OPEN',1,'${ids.active}',NULL,'{}',now(),now()),
    (gen_random_uuid(),'T-0911','AUTOMATION_FAILURE','PROVIDER_TIMEOUT','CLAIMED',1,'${ids.exception}','${ids.staff}','{}',now(),now()),
    (gen_random_uuid(),'T-0912','AUTOMATION_FAILURE','CHANNEL_CREATE_FAILED','OPEN',1,NULL,NULL,'{"guildId":"900000000000009000"}',now(),now()),
    (gen_random_uuid(),'T-0913','ORDER_ASSIST','DONE','RESOLVED',1,'${ids.order}',NULL,'{}',now(),now()),
    (gen_random_uuid(),'T-0914','AUTOMATION_FAILURE','OTHER_GUILD','OPEN',1,'${ids.other}',NULL,'{}',now(),now());
  INSERT INTO consumption_entries(id,user_id,entry_type,direction,order_id,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at) VALUES
    (gen_random_uuid(),'${ids.customer}','ORDER_CHARGE','DEBIT','${ids.order}',10000,'USD','ORDER','${ids.order}','metric:order:charge','2026-07-18T17:30:00Z'),
    (gen_random_uuid(),'${ids.customer}','REFUND_REVERSAL','CREDIT','${ids.order}',2000,'USD','REFUND',gen_random_uuid(),'metric:order:refund','2026-07-18T17:40:00Z');
  INSERT INTO fund_reservations(id,user_id,source_type,order_id,mode,provider,amount_minor,currency,status,row_version,idempotency_key,created_at,updated_at) VALUES ('${ids.reservation}','${ids.activeCustomer}','ORDER','${ids.active}','LOCAL_RESERVATION','mock',10000,'USD','PARTIALLY_SETTLED',2,'metric:reservation',now(),now());
  INSERT INTO fund_reservation_events(id,fund_reservation_id,sequence,event_type,from_status,to_status,amount_minor,reservation_version,idempotency_key,actor_source,created_at) VALUES
    (gen_random_uuid(),'${ids.reservation}',1,'CREATED',NULL,'ACTIVE',10000,1,'metric:reservation:created','SYSTEM_JOB',now()),
    (gen_random_uuid(),'${ids.reservation}',2,'CAPTURED','ACTIVE','PARTIALLY_SETTLED',3000,2,'metric:reservation:captured','SYSTEM_JOB',now());
  INSERT INTO gift_catalog_items(id,code,created_at,updated_at) VALUES ('${ids.giftItem}','METRIC_GIFT',now(),now());
  INSERT INTO gift_catalog_versions(id,gift_catalog_item_id,version,status,active_gift_key,name,price_minor,currency,broadcast_template,created_by_staff_id,activated_at,created_at) VALUES ('${ids.giftVersion}','${ids.giftItem}',1,'ACTIVE','${ids.giftItem}','Metric Gift',3000,'USD','{sender} sent {gift}','${ids.staff}',now(),now());
  INSERT INTO gift_requests(id,public_id,order_id,gift_catalog_version_id,sender_id,receiver_id,status,row_version,gift_code_snapshot,gift_name_snapshot,price_minor,currency,broadcast_template_snapshot,captured_at,expires_at,created_at,updated_at) VALUES ('${ids.gift}','G-0912','${ids.order}','${ids.giftVersion}','${ids.customer}','${ids.player}','CAPTURED',3,'METRIC_GIFT','Metric Gift',3000,'USD','{sender} sent {gift}','2026-07-18T17:20:00Z','2026-07-18T18:20:00Z','2026-07-18T17:15:00Z','2026-07-18T17:20:00Z');
  INSERT INTO consumption_entries(id,user_id,entry_type,direction,gift_request_id,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at) VALUES
    ('${ids.giftDebit}','${ids.customer}','GIFT_CHARGE','DEBIT','${ids.gift}',3000,'USD','GIFT','${ids.gift}','metric:gift:charge','2026-07-18T17:20:00Z'),
    ('${ids.giftCredit}','${ids.customer}','REFUND_REVERSAL','CREDIT','${ids.gift}',500,'USD','REFUND',gen_random_uuid(),'metric:gift:refund','2026-07-18T17:40:00Z');
  INSERT INTO dispatch_attempts(id,order_id,round,status,dispatch_channel_id,candidate_criteria,accepted_player_id,started_at,expires_at,accepted_at,finished_at,created_at,updated_at) VALUES
    (gen_random_uuid(),'${ids.active}',1,'ACCEPTED','900000000000009100','{}','${ids.player}','2026-07-18T17:01:00Z','2026-07-18T17:06:00Z','2026-07-18T17:03:00Z','2026-07-18T17:03:00Z','2026-07-18T17:01:00Z','2026-07-18T17:03:00Z'),
    (gen_random_uuid(),'${ids.active}',2,'TIMED_OUT','900000000000009100','{}',NULL,'2026-07-18T17:10:00Z','2026-07-18T17:15:00Z',NULL,'2026-07-18T17:15:00Z','2026-07-18T17:10:00Z','2026-07-18T17:15:00Z'),
    (gen_random_uuid(),'${ids.other}',1,'ACCEPTED','900000000000009199','{}','${ids.player}','2026-07-18T17:01:00Z','2026-07-18T17:06:00Z','2026-07-18T17:03:00Z','2026-07-18T17:03:00Z','2026-07-18T17:01:00Z','2026-07-18T17:03:00Z');
`);}
