import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll,beforeAll,describe,expect,test } from 'vitest';
import { Pool } from 'pg';
import { PostgresServicePackageStore } from '@blackcat/api/service-packages';
import type { AuditRecord } from '@blackcat/api/security';

const execFile=promisify(execFileCallback);const database='blackcat_m10_packages';
const guildId='999999999999999999',discordUserId='111111111111111111';
const customerId='00000000-0000-0000-0000-000000108501',staffUserId='00000000-0000-0000-0000-000000108502',staffId='00000000-0000-0000-0000-000000108503';
const rollbackCustomerId='00000000-0000-0000-0000-000000108513',rollbackDiscordUserId='111111111111111112';
const orderId='00000000-0000-0000-0000-000000108504',rollbackOrderId='00000000-0000-0000-0000-000000108505';
const catalogId='00000000-0000-0000-0000-000000108506',packageId='00000000-0000-0000-0000-000000108507';
let root='',data='',port=0,pool:Pool;

describe('M10-US-08 PostgreSQL package transaction',()=>{
  beforeAll(async()=>{port=62650+(process.pid%100);root=await mkdtemp(join(tmpdir(),'blackcat-m10-package-'));data=join(root,'data');await execFile('initdb',['-D',data,'--no-locale','--encoding=UTF8']);await execFile('pg_ctl',['-D',data,'-o',`-p ${port} -k ${root}`,'-l',join(root,'postgres.log'),'start']);await execFile('createdb',['-h',root,'-p',String(port),database]);for(const migration of (await readdir('database/prisma/migrations')).sort())await execFile('psql',['-h',root,'-p',String(port),'-d',database,'-v','ON_ERROR_STOP=1','-f',`database/prisma/migrations/${migration}/migration.sql`]);pool=new Pool({host:root,port,database,max:4});await seed();},40_000);
  afterAll(async()=>{await pool?.end().catch(()=>undefined);if(data)await execFile('pg_ctl',['-D',data,'stop','-m','fast']).catch(()=>undefined);if(root)await rm(root,{recursive:true,force:true});});

  test('replaces the basket with independent slots, notes, events, package price and audit atomically',async()=>{
    const store=new PostgresServicePackageStore(pool);const staged=await store.apply(input(orderId,'package:postgres:apply'));expect(staged.data).toMatchObject({orderVersion:2,derivedTotalMinor:180,requirements:[{requestedPlayerCount:1,customerNote:'负责技术护航'},{requestedPlayerCount:1,customerNote:'可改成聊天陪伴'}]});await staged.commit(audit('00000000-0000-0000-0000-000000108520',staffId));
    const facts=await pool.query(`SELECT orders.amount_minor::text,orders.row_version,orders.composition_mode::text,COUNT(requirement.id)::int active_count,COUNT(DISTINCT requirement.source_package_slot_id)::int slot_count,COUNT(event.id)::int event_count,(SELECT count(*)::int FROM audit_logs WHERE target_id::text=$1::text) audit_count FROM orders JOIN order_requirements requirement ON requirement.order_id=orders.id AND requirement.status='ACTIVE' JOIN order_requirement_events event ON event.order_requirement_id=requirement.id WHERE orders.id=$1::uuid GROUP BY orders.id`,[orderId]);expect(facts.rows[0]).toEqual({amount_minor:'180',row_version:2,composition_mode:'PACKAGE_DEFAULT',active_count:2,slot_count:2,event_count:2,audit_count:1});
  });

  test('rolls every generated slot, event and order change back when audit append fails',async()=>{
    const store=new PostgresServicePackageStore(pool);const staged=await store.apply(input(rollbackOrderId,'package:postgres:rollback'));await expect(staged.commit(audit('00000000-0000-0000-0000-000000108521','00000000-0000-0000-0000-000000108599'))).rejects.toThrow();const facts=await pool.query(`SELECT orders.amount_minor::text,orders.row_version,orders.composition_mode::text,(SELECT count(*)::int FROM order_requirements WHERE order_id=orders.id AND status='ACTIVE') active_count,(SELECT count(*)::int FROM order_requirement_events event JOIN order_requirements requirement ON requirement.id=event.order_requirement_id WHERE requirement.order_id=orders.id) event_count FROM orders WHERE id=$1`,[rollbackOrderId]);expect(facts.rows[0]).toEqual({amount_minor:'0',row_version:1,composition_mode:null,active_count:0,event_count:0});
  });

  test('creates and publishes a new immutable version while retiring the former active version',async()=>{
    const store=new PostgresServicePackageStore(pool);const created=await store.createAdmin({actorStaffId:staffId,payload:{code:'DELTA_ESCORT',displayName:'三角洲轻松护航',description:'技术猫与聊天猫组合',defaultCustomerPriceMinor:160,currency:'CAT',activate:false,slots:[{serviceCatalogVersionId:catalogId,unitCount:1,customerNoteTemplate:'负责技术护航'},{serviceCatalogVersionId:catalogId,unitCount:1,customerNoteTemplate:'技术要求不高，会聊天就行'}],reasonCode:'NEW_PACKAGE_VERSION'},now:new Date('2026-08-04T12:10:00Z')});expect(created.data).toMatchObject({version:2,status:'DRAFT',slots:[{position:1},{position:2}]});await created.commit(audit('00000000-0000-0000-0000-000000108522',staffId));const activated=await store.updateAdmin({actorStaffId:staffId,servicePackageVersionId:created.data.id,payload:{expectedStatus:'DRAFT',action:'ACTIVATE',reasonCode:'PUBLISH_PACKAGE'},now:new Date('2026-08-04T12:11:00Z')});await activated.commit(audit('00000000-0000-0000-0000-000000108523',staffId));const versions=await pool.query(`SELECT version,status::text FROM service_package_versions WHERE service_package_id='00000000-0000-0000-0000-000000108510' ORDER BY version`);expect(versions.rows).toEqual([{version:1,status:'RETIRED'},{version:2,status:'ACTIVE'}]);
  });

  test('keeps historical versions readable after a catalog retires while hiding invalid active packages from customers',async()=>{await pool.query(`UPDATE service_catalog_versions SET status='RETIRED',active_offering_key=NULL,retired_at=now() WHERE id=$1`,[catalogId]);const store=new PostgresServicePackageStore(pool);const admin=await store.listAdmin({cursor:null,limit:10});expect(admin.items.map(item=>item.version)).toEqual([2,1]);const customer=await store.list({actorGuildId:guildId,actorDiscordUserId:discordUserId,cursor:null,limit:10});expect(customer.items).toEqual([]);});
});

function input(id:string,idempotencyKey:string){return{orderId:id,servicePackageVersionId:packageId,expectedOrderVersion:1,actorGuildId:guildId,actorDiscordUserId:id===rollbackOrderId?rollbackDiscordUserId:discordUserId,idempotencyKey,now:new Date('2026-08-04T12:00:00Z')};}
function audit(id:string,actorStaffId:string):AuditRecord{return{id,actorId:staffUserId,actorStaffId,actorLevel:'L2_SUPERVISOR',actorSource:'DISCORD_BOT',clientId:'DISCORD_BOT',interactionId:'222222222222222222',permissionCode:'order.update',action:'APPLY_SERVICE_PACKAGE',targetType:'order',targetId:orderId,outcome:'SUCCEEDED',reason:null,requestId:`req_${id}`,approvalRequestId:null,occurredAt:'2026-08-04T12:00:00Z',changes:[]};}
async function seed(){await pool.query(`
INSERT INTO users(id,display_name,status,row_version,created_at,updated_at) VALUES ('${customerId}','老板猫','ACTIVE',1,now(),now()),('${rollbackCustomerId}','回滚老板猫','ACTIVE',1,now(),now()),('${staffUserId}','店长猫','ACTIVE',1,now(),now());
INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,username,created_at,updated_at) VALUES ('00000000-0000-0000-0000-000000108508','${customerId}','${guildId}','${discordUserId}','老板猫#1024',now(),now()),('00000000-0000-0000-0000-000000108514','${rollbackCustomerId}','${guildId}','${rollbackDiscordUserId}','回滚老板猫#1025',now(),now());
INSERT INTO staff_accounts(id,user_id,level,status,role_source,permissions_version,created_at,updated_at) VALUES ('${staffId}','${staffUserId}','L2_SUPERVISOR','ACTIVE','MANUAL',1,now(),now());
INSERT INTO service_offerings(id,code,game_code,game_name,service_code,service_name,region_code,created_at,updated_at) VALUES ('00000000-0000-0000-0000-000000108509','DELTA-TECH-NA','DELTA','三角洲行动','TECH','技术护航','NA',now(),now());
INSERT INTO service_catalog_versions(id,service_offering_id,version,status,billing_unit_minutes,minimum_units,customer_unit_price_minor,player_unit_payout_minor,default_player_payout_bps,currency,created_by_staff_id,created_at) VALUES ('${catalogId}','00000000-0000-0000-0000-000000108509',1,'ACTIVE',60,1,100,60,6000,'CAT','${staffId}',now());
INSERT INTO service_packages(id,code,updated_at) VALUES ('00000000-0000-0000-0000-000000108510','DELTA_ESCORT',now());
INSERT INTO service_package_versions(id,service_package_id,version,status,active_package_key,display_name,description,default_customer_price_minor,currency,created_by_staff_id,activated_at) VALUES ('${packageId}','00000000-0000-0000-0000-000000108510',1,'ACTIVE','00000000-0000-0000-0000-000000108510','三角洲护航','两只技术猫猫护航',180,'CAT','${staffId}',now());
INSERT INTO service_package_slots(id,service_package_version_id,service_catalog_version_id,position,unit_count,customer_note_template) VALUES ('00000000-0000-0000-0000-000000108511','${packageId}','${catalogId}',1,1,'负责技术护航'),('00000000-0000-0000-0000-000000108512','${packageId}','${catalogId}',2,1,'可改成聊天陪伴');
INSERT INTO orders(id,public_id,customer_id,active_customer_slot_id,status,row_version,amount_minor,expected_player_earning_minor,currency,guild_id,channel_id,panel_message_id,created_at,updated_at) VALUES ('${orderId}','P-PACKAGE-DB','${customerId}','${customerId}','DRAFT',1,0,0,'CAT','${guildId}','333333333333333333','444444444444444444',now(),now()),('${rollbackOrderId}','P-PACKAGE-RB','${rollbackCustomerId}','${rollbackCustomerId}','DRAFT',1,0,0,'CAT','${guildId}','333333333333333334','444444444444444445',now(),now());
`);}
