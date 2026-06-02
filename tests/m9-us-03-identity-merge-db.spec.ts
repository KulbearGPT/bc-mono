import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';

const execFile=promisify(execFileCallback);
const targetUserId='00000000-0000-0000-0000-000000009201';
const splitUserId='00000000-0000-0000-0000-000000009202';
const walletId='00000000-0000-0000-0000-000000009203';
const profileId='00000000-0000-0000-0000-000000009204';
const entryId='00000000-0000-0000-0000-000000009205';
const taskId='00000000-0000-0000-0000-000000009206';
const sourceId='00000000-0000-0000-0000-000000009207';
const guildId='999999999999999999';
const discordUserId='111111111111111111';
let root='';let data='';let port=0;let pool:Pool;

describe('M9 onboarding identity repair migration',()=>{
  beforeAll(async()=>{
    port=62400+(process.pid%80);root=await mkdtemp(join(tmpdir(),'blackcat-m9-identity-'));data=join(root,'data');
    await execFile('initdb',['-D',data,'--no-locale','--encoding=UTF8']);
    await execFile('pg_ctl',['-D',data,'-o',`-p ${port} -k ${root}`,'-l',join(root,'postgres.log'),'start']);
    await execFile('createdb',['-h',root,'-p',String(port),'blackcat_m9_identity']);
    const migrationRoot='database/prisma/migrations';
    for(const directory of (await readdir(migrationRoot)).sort().filter((name)=>name<'000012_onboarding_identity_repair')){
      await execFile('psql',['-h',root,'-p',String(port),'-d','blackcat_m9_identity','-v','ON_ERROR_STOP=1','-f',join(migrationRoot,directory,'migration.sql')]);
    }
    pool=new Pool({host:root,port,database:'blackcat_m9_identity'});
    await pool.query(`INSERT INTO users(id,display_name,updated_at) VALUES ($1,'Existing Staff',now()),($2,'Split Player',now())`,[targetUserId,splitUserId]);
    await pool.query(`INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,username,updated_at)
      VALUES(gen_random_uuid(),$1,$2,$3,'Existing Staff',now())`,[targetUserId,guildId,discordUserId]);
    await pool.query(`INSERT INTO wallet_accounts(id,user_id,currency,status,row_version,updated_at) VALUES($1,$2,'CAT','ACTIVE',2,now())`,[walletId,splitUserId]);
    await pool.query(`INSERT INTO wallet_entries(id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at)
      VALUES($1,$2,'ADJUSTMENT_CREDIT','CREDIT',1000,'CAT','ADJUSTMENT',$3,'identity-repair-credit',now())`,[entryId,walletId,sourceId]);
    await pool.query(`INSERT INTO player_profiles(id,user_id,review_status,row_version,availability,discord_presence,updated_at)
      VALUES($1,$2,'PENDING_REVIEW',1,'OFFLINE','UNKNOWN',now())`,[profileId,splitUserId]);
    await pool.query(`INSERT INTO discord_product_role_tasks(id,guild_id,user_id,discord_user_id,role_id,action,status,dedupe_key,updated_at)
      VALUES($1,$2,$3,$4,'222222222222222222','ADD','APPLIED',$5,now())`,[taskId,guildId,splitUserId,discordUserId,`product-role:${guildId}:${discordUserId}:222222222222222222:ADD:player`]);
  },40_000);

  afterAll(async()=>{await pool?.end().catch(()=>undefined);if(data)await execFile('pg_ctl',['-D',data,'stop','-m','fast']).catch(()=>undefined);if(root)await rm(root,{recursive:true,force:true});});

  test('moves onboarding-owned facts to the Discord-linked user without losing wallet entries',async()=>{
    await execFile('psql',['-h',root,'-p',String(port),'-d','blackcat_m9_identity','-v','ON_ERROR_STOP=1','-f','database/prisma/migrations/000012_onboarding_identity_repair/migration.sql']);
    const result=await pool.query(`SELECT
      (SELECT user_id FROM wallet_accounts WHERE id=$1) wallet_user_id,
      (SELECT user_id FROM player_profiles WHERE id=$2) profile_user_id,
      (SELECT user_id FROM discord_product_role_tasks WHERE id=$3) task_user_id,
      (SELECT amount_minor::int FROM wallet_entries WHERE id=$4) amount_minor,
      EXISTS(SELECT 1 FROM users WHERE id=$5) split_user_exists`,[walletId,profileId,taskId,entryId,splitUserId]);
    expect(result.rows[0]).toEqual({wallet_user_id:targetUserId,profile_user_id:targetUserId,task_user_id:targetUserId,amount_minor:1000,split_user_exists:false});
  });
});
