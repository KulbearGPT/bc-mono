import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { insertPostgresAuditRecord, registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type AuditRecord } from './security.js';

export interface PlayerRegistrationResult {
  userId: string;
  walletAccountId: string;
  guildId: string;
  discordUserId: string;
  playerRoleId: string;
  created: boolean;
  roleSyncStatus: 'PENDING';
}

export interface CompanionApplicationResult extends PlayerRegistrationResult {
  playerProfileId: string;
  reviewStatus: 'PENDING_REVIEW';
  companionApplicantRoleId: string | null;
}

export interface OnboardingMessageProjection { guildId: string; channelId: string; messageId: string | null; renderedVersion: number; updatedAt: string }
export interface DiscordProductRoleTaskProjection {
  id: string;
  guildId: string;
  discordUserId: string;
  roleId: string;
  action: 'ADD' | 'REMOVE';
  status: 'PENDING' | 'FAILED';
  attemptCount: number;
}

interface OnboardingInput {
  guildId: string;
  discordUserId: string;
  displayName: string;
  idempotencyKey: string;
  interactionId: string;
  now: Date;
}

interface Staged<T> { data: T; commit(audit: AuditRecord): Promise<void> | void }

export interface OnboardingStore {
  stageRegister(input: OnboardingInput): Promise<Staged<PlayerRegistrationResult>> | Staged<PlayerRegistrationResult>;
  stageCompanionApplication(input: OnboardingInput): Promise<Staged<CompanionApplicationResult>> | Staged<CompanionApplicationResult>;
  getMessage(guildId: string): Promise<OnboardingMessageProjection | null> | OnboardingMessageProjection | null;
  stageSaveMessage(input: OnboardingMessageProjection & { now: Date }): Promise<Staged<OnboardingMessageProjection>> | Staged<OnboardingMessageProjection>;
  listRoleTasks?(guildId: string): Promise<DiscordProductRoleTaskProjection[]> | DiscordProductRoleTaskProjection[];
  stageCompleteRoleTask?(input: { taskId: string; applied: boolean; errorCode: string | null; now: Date }): Promise<Staged<{ taskId: string; status: 'APPLIED' | 'FAILED' }>> | Staged<{ taskId: string; status: 'APPLIED' | 'FAILED' }>;
}

export class OnboardingError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'CONFIGURATION_ERROR' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'OnboardingError';
  }
}

export class InMemoryOnboardingStore implements OnboardingStore {
  readonly registrations = new Map<string, PlayerRegistrationResult>();
  readonly applications = new Map<string, CompanionApplicationResult>();
  readonly audits: AuditRecord[] = [];
  readonly messages = new Map<string, OnboardingMessageProjection>();

  constructor(private readonly roles: { playerRoleId: string; companionApplicantRoleId?: string | null }) {}

  stageRegister(input: OnboardingInput): Staged<PlayerRegistrationResult> {
    const key = identityKey(input);
    const existing = this.registrations.get(key);
    const data = existing ? { ...existing, created: false } : registrationProjection(input, this.roles.playerRoleId, true);
    return { data, commit: (audit) => { if (!existing) this.registrations.set(key, structuredClone(data)); this.audits.push(structuredClone(audit)); } };
  }

  stageCompanionApplication(input: OnboardingInput): Staged<CompanionApplicationResult> {
    const key = identityKey(input);
    const registration = this.registrations.get(key) ?? registrationProjection(input, this.roles.playerRoleId, true);
    const existing = this.applications.get(key);
    const data = existing ?? { ...registration, playerProfileId: stableUuid(`companion:${key}`), reviewStatus: 'PENDING_REVIEW', companionApplicantRoleId: this.roles.companionApplicantRoleId ?? null } as const;
    return { data, commit: (audit) => { this.registrations.set(key, structuredClone(registration)); if (!existing) this.applications.set(key, structuredClone(data)); this.audits.push(structuredClone(audit)); } };
  }
  getMessage(guildId: string) { return structuredClone(this.messages.get(guildId) ?? null); }
  stageSaveMessage(input: OnboardingMessageProjection & { now: Date }): Staged<OnboardingMessageProjection> {
    const data = { guildId: input.guildId, channelId: input.channelId, messageId: input.messageId, renderedVersion: input.renderedVersion, updatedAt: input.now.toISOString() };
    return { data, commit: (audit) => { this.messages.set(input.guildId, structuredClone(data)); this.audits.push(structuredClone(audit)); } };
  }
}

export class PostgresOnboardingStore implements OnboardingStore {
  constructor(private readonly pool: Pool) {}

  async getMessage(guildId: string): Promise<OnboardingMessageProjection | null> {
    const result = await this.pool.query<{ guild_id:string;channel_id:string;message_id:string|null;rendered_version:number;updated_at:Date|string }>(
      'SELECT guild_id,channel_id,message_id,rendered_version,updated_at FROM guild_onboarding_messages WHERE guild_id=$1', [guildId]);
    const row=result.rows[0];return row?{guildId:row.guild_id,channelId:row.channel_id,messageId:row.message_id,renderedVersion:row.rendered_version,updatedAt:new Date(row.updated_at).toISOString()}:null;
  }

  async listRoleTasks(guildId: string): Promise<DiscordProductRoleTaskProjection[]> {
    const result = await this.pool.query<{ id:string;guild_id:string;discord_user_id:string;role_id:string;action:'ADD'|'REMOVE';status:'PENDING'|'FAILED';attempt_count:number }>(`
      SELECT id,guild_id,discord_user_id,role_id,action,status,attempt_count
      FROM discord_product_role_tasks
      WHERE guild_id=$1 AND status IN ('PENDING','FAILED')
      ORDER BY created_at ASC LIMIT 100`, [guildId]);
    return result.rows.map((row) => ({ id:row.id,guildId:row.guild_id,discordUserId:row.discord_user_id,roleId:row.role_id,
      action:row.action,status:row.status,attemptCount:row.attempt_count }));
  }

  async stageCompleteRoleTask(input: { taskId: string; applied: boolean; errorCode: string | null; now: Date }): Promise<Staged<{ taskId: string; status: 'APPLIED' | 'FAILED' }>> {
    if (!/^[0-9a-f-]{36}$/iu.test(input.taskId)) throw new OnboardingError('VALIDATION_ERROR', 'taskId is invalid.');
    const status = input.applied ? 'APPLIED' as const : 'FAILED' as const;
    return { data:{ taskId:input.taskId,status }, commit:async(audit) => { const client=await this.pool.connect();try{await client.query('BEGIN');
      const updated=await client.query(`UPDATE discord_product_role_tasks SET status=$2,attempt_count=attempt_count+1,last_error_code=$3,updated_at=$4
        WHERE id=$1 AND status IN ('PENDING','FAILED')`,[input.taskId,status,input.applied?null:input.errorCode,input.now]);
      if(updated.rowCount!==1)throw new OnboardingError('CONFLICT','Discord role task is no longer pending.');
      await insertPostgresAuditRecord(client,audit);await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}} };
  }

  async stageSaveMessage(input: OnboardingMessageProjection & { now: Date }): Promise<Staged<OnboardingMessageProjection>> {
    const data={guildId:input.guildId,channelId:input.channelId,messageId:input.messageId,renderedVersion:input.renderedVersion,updatedAt:input.now.toISOString()};
    return {data,commit:async(audit)=>{const client=await this.pool.connect();try{await client.query('BEGIN');
      await client.query(`INSERT INTO guild_onboarding_messages(guild_id,channel_id,message_id,rendered_version,last_ensured_at,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$5,$5) ON CONFLICT (guild_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,message_id=EXCLUDED.message_id,
        rendered_version=EXCLUDED.rendered_version,last_ensured_at=EXCLUDED.last_ensured_at,updated_at=EXCLUDED.updated_at`,
        [input.guildId,input.channelId,input.messageId,input.renderedVersion,input.now]);await insertPostgresAuditRecord(client,audit);await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}}};
  }

  async stageRegister(input: OnboardingInput): Promise<Staged<PlayerRegistrationResult>> {
    validateInput(input);
    const roles = await this.roles(input.guildId);
    const existing = await this.pool.query<{ user_id: string; wallet_id: string | null }>(`
      SELECT d.user_id,w.id wallet_id FROM discord_accounts d
      LEFT JOIN wallet_accounts w ON w.user_id=d.user_id
      WHERE d.guild_id=$1 AND d.discord_user_id=$2`, [input.guildId, input.discordUserId]);
    const data = existing.rows[0]
      ? { userId: existing.rows[0].user_id, walletAccountId: existing.rows[0].wallet_id ?? stableUuid(`wallet:${identityKey(input)}`),
          guildId: input.guildId, discordUserId: input.discordUserId, playerRoleId: roles.playerRoleId,
          created: existing.rows[0].wallet_id === null, roleSyncStatus: 'PENDING' as const }
      : registrationProjection(input, roles.playerRoleId, true);
    return { data, commit: (audit) => this.commitRegistration(input, data, roles.playerRoleId, audit) };
  }

  async stageCompanionApplication(input: OnboardingInput): Promise<Staged<CompanionApplicationResult>> {
    validateInput(input);
    const roles = await this.roles(input.guildId);
    const registered = await this.stageRegister(input);
    const profile = await this.pool.query<{ id: string; review_status: string }>(`
      SELECT p.id,p.review_status FROM player_profiles p
      JOIN discord_accounts d ON d.user_id=p.user_id
      WHERE d.guild_id=$1 AND d.discord_user_id=$2`, [input.guildId, input.discordUserId]);
    if (profile.rows[0] && profile.rows[0].review_status !== 'PENDING_REVIEW') {
      throw new OnboardingError('CONFLICT', `Companion profile is already ${profile.rows[0].review_status}.`);
    }
    const data: CompanionApplicationResult = {
      ...registered.data,
      playerProfileId: profile.rows[0]?.id ?? stableUuid(`companion:${identityKey(input)}`),
      reviewStatus: 'PENDING_REVIEW',
      companionApplicantRoleId: roles.companionApplicantRoleId
    };
    return { data, commit: async (audit) => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identityKey(input)]);
        await upsertRegistration(client, input, data, roles.playerRoleId);
        await client.query(`INSERT INTO player_profiles
          (id,user_id,review_status,row_version,availability,discord_presence,created_at,updated_at)
          VALUES ($1,$2,'PENDING_REVIEW',1,'OFFLINE','UNKNOWN',$3,$3)
          ON CONFLICT (user_id) DO NOTHING`, [data.playerProfileId, data.userId, input.now]);
        await client.query(`INSERT INTO companion_review_events
          (id,player_profile_id,from_status,to_status,actor_staff_id,reason_code,note,idempotency_key,created_at)
          VALUES ($1,$2,NULL,'PENDING_REVIEW',NULL,'SELF_APPLICATION',NULL,$3,$4)
          ON CONFLICT (idempotency_key) DO NOTHING`, [randomUUID(), data.playerProfileId, `companion-application:${identityKey(input)}`, input.now]);
        if (roles.companionApplicantRoleId) await insertRoleTask(client, input, data.userId, roles.companionApplicantRoleId, 'ADD', 'companion-applicant');
        await insertPostgresAuditRecord(client, audit);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
    } };
  }

  private async commitRegistration(input: OnboardingInput, data: PlayerRegistrationResult, roleId: string, audit: AuditRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identityKey(input)]);
      await upsertRegistration(client, input, data, roleId);
      await insertPostgresAuditRecord(client, audit);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async roles(guildId: string): Promise<{ playerRoleId: string; companionApplicantRoleId: string | null }> {
    const result = await this.pool.query<{ player_role_id: string | null; applicant_role_id: string | null }>(`
      SELECT config_json->>'player_role_id' player_role_id,
             config_json->>'companion_applicant_role_id' applicant_role_id
      FROM guild_bot_configs WHERE guild_id=$1`, [guildId]);
    const playerRoleId = result.rows[0]?.player_role_id;
    if (!playerRoleId) throw new OnboardingError('CONFIGURATION_ERROR', '基础玩家角色尚未配置。');
    return { playerRoleId, companionApplicantRoleId: result.rows[0]?.applicant_role_id ?? null };
  }
}

export function registerOnboardingRoutes(server: FastifyInstance, options: { store: OnboardingStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Onboarding routes require security options.');
  const now = options.now ?? (() => new Date());
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/me/player-registration', permission: 'account.register_self', action: 'REGISTER_DISCORD_PLAYER',
    targetType: 'discord_account', acceptedSources: ['DISCORD_BOT'], successStatusCode: 201, mapError,
    targetId: (request) => String(request.headers['x-actor-discord-user-id'] ?? 'unknown'),
    auditChanges: (_request, _actor, payload) => registrationChanges(payload as PlayerRegistrationResult),
    handler: (request, actor) => options.store.stageRegister(parseInput(request, actor, now()))
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/me/companion-application', permission: 'player.apply_self', action: 'APPLY_FOR_COMPANION',
    targetType: 'player_profile', acceptedSources: ['DISCORD_BOT'], successStatusCode: 201, mapError,
    targetId: (request) => String(request.headers['x-actor-discord-user-id'] ?? 'unknown'),
    auditChanges: (_request, _actor, payload) => [
      ...registrationChanges(payload as CompanionApplicationResult),
      { targetType: 'player_profile', targetId: (payload as CompanionApplicationResult).playerProfileId, changeType: 'CREATE', beforeSnapshot: null,
        afterSnapshot: { reviewStatus: 'PENDING_REVIEW' }, changedFields: ['reviewStatus'] }
    ],
    handler: (request, actor) => options.store.stageCompanionApplication(parseInput(request, actor, now()))
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method:'GET',url:'/api/v1/internal/onboarding-message',permission:'onboarding.message.manage',action:'GET_ONBOARDING_MESSAGE',targetType:'guild_onboarding_message',
    acceptedSources:['DISCORD_BOT'],allowServiceActor:true,targetId:(request)=>String((request.query as Record<string,unknown>).guildId??'unknown'),mapError,
    handler:(request)=>options.store.getMessage(requireSnowflake((request.query as Record<string,unknown>).guildId,'guildId'))
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method:'PUT',url:'/api/v1/internal/onboarding-message',permission:'onboarding.message.manage',action:'SAVE_ONBOARDING_MESSAGE',targetType:'guild_onboarding_message',
    acceptedSources:['DISCORD_BOT'],allowServiceActor:true,targetId:(request)=>String((request.body as Record<string,unknown>)?.guildId??'unknown'),mapError,
    handler:(request)=>{const body=request.body as Record<string,unknown>;const input={guildId:requireSnowflake(body.guildId,'guildId'),channelId:requireSnowflake(body.channelId,'channelId'),
      messageId:body.messageId===null?null:requireSnowflake(body.messageId,'messageId'),renderedVersion:Number(body.renderedVersion),updatedAt:'',now:now()};
      if(!Number.isSafeInteger(input.renderedVersion)||input.renderedVersion<1)throw new OnboardingError('VALIDATION_ERROR','renderedVersion is invalid.');
      return options.store.stageSaveMessage(input);}
  });
  if (options.store.listRoleTasks && options.store.stageCompleteRoleTask) {
    registerSecureReadRoute(server, server.securityOptions, {
      method:'GET',url:'/api/v1/internal/product-role-tasks',permission:'onboarding.message.manage',action:'LIST_PRODUCT_ROLE_TASKS',targetType:'discord_product_role_task',
      acceptedSources:['DISCORD_BOT'],allowServiceActor:true,targetId:(request)=>String((request.query as Record<string,unknown>).guildId??'unknown'),mapError,
      handler:(request)=>options.store.listRoleTasks!(requireSnowflake((request.query as Record<string,unknown>).guildId,'guildId'))
    });
    registerSecureWriteRoute(server, server.securityOptions, {
      method:'POST',url:'/api/v1/internal/product-role-tasks/:taskId/result',permission:'onboarding.message.manage',action:'COMPLETE_PRODUCT_ROLE_TASK',targetType:'discord_product_role_task',
      acceptedSources:['DISCORD_BOT'],allowServiceActor:true,targetId:(request)=>String((request.params as Record<string,unknown>).taskId??'unknown'),mapError,
      auditChanges:(_request,_actor,payload)=>[{targetType:'discord_product_role_task',targetId:(payload as {taskId:string}).taskId,changeType:'STATE_TRANSITION',beforeSnapshot:null,
        afterSnapshot:{status:(payload as {status:string}).status},changedFields:['status','attemptCount','lastErrorCode']}],
      handler:(request)=>{const body=request.body as Record<string,unknown>;const applied=body?.applied;
        if(typeof applied!=='boolean')throw new OnboardingError('VALIDATION_ERROR','applied is invalid.');
        const errorCode=body.errorCode===null||body.errorCode===undefined?null:typeof body.errorCode==='string'?body.errorCode.trim():'';
        if(!applied&&(!errorCode||errorCode.length>100))throw new OnboardingError('VALIDATION_ERROR','errorCode is required for a failed task.');
        return options.store.stageCompleteRoleTask!({taskId:String((request.params as Record<string,unknown>).taskId),applied,errorCode,now:now()});}
    });
  }
}

function parseInput(request: FastifyRequest, actor: ActorContext, now: Date): OnboardingInput {
  if (!actor.guildId || !actor.discordUserId || !actor.interactionId) throw new OnboardingError('VALIDATION_ERROR', 'Trusted Discord actor context is required.');
  const body = request.body as Record<string, unknown>;
  const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
  if (!displayName || [...displayName].length > 100) throw new OnboardingError('VALIDATION_ERROR', 'displayName is invalid.');
  return { guildId: actor.guildId, discordUserId: actor.discordUserId, displayName,
    idempotencyKey: String(request.headers['idempotency-key'] ?? ''), interactionId: actor.interactionId, now };
}

function validateInput(input: OnboardingInput): void {
  if (!/^\d{17,20}$/u.test(input.guildId) || !/^\d{17,20}$/u.test(input.discordUserId)) throw new OnboardingError('VALIDATION_ERROR', 'Discord identity is invalid.');
}
function requireSnowflake(value:unknown,field:string):string{if(typeof value!=='string'||!/^\d{17,20}$/u.test(value))throw new OnboardingError('VALIDATION_ERROR',`${field} is invalid.`);return value;}

function registrationProjection(input: OnboardingInput, playerRoleId: string, created: boolean): PlayerRegistrationResult {
  return { userId: stableUuid(`user:${identityKey(input)}`), walletAccountId: stableUuid(`wallet:${identityKey(input)}`), guildId: input.guildId,
    discordUserId: input.discordUserId, playerRoleId, created, roleSyncStatus: 'PENDING' };
}

async function upsertRegistration(client: { query(sql: string, values?: unknown[]): Promise<unknown> }, input: OnboardingInput,
  data: PlayerRegistrationResult, roleId: string): Promise<void> {
  await client.query(`INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
    VALUES ($1,$2,'ACTIVE',1,$3,$3) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=EXCLUDED.updated_at`, [data.userId,input.displayName,input.now]);
  await client.query(`INSERT INTO discord_accounts(id,user_id,guild_id,discord_user_id,username,bound_at,last_seen_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$6)
    ON CONFLICT (guild_id,discord_user_id) DO UPDATE SET username=EXCLUDED.username,last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at`,
    [stableUuid(`discord:${identityKey(input)}`),data.userId,input.guildId,input.discordUserId,input.displayName,input.now]);
  await client.query(`INSERT INTO wallet_accounts(id,user_id,currency,status,row_version,created_at,updated_at)
    VALUES ($1,$2,'CAT','ACTIVE',1,$3,$3) ON CONFLICT (user_id) DO NOTHING`, [data.walletAccountId,data.userId,input.now]);
  await insertRoleTask(client,input,data.userId,roleId,'ADD','player');
}

async function insertRoleTask(client: { query(sql: string, values?: unknown[]): Promise<unknown> }, input: OnboardingInput, userId: string,
  roleId: string, action: 'ADD' | 'REMOVE', purpose: string): Promise<void> {
  const dedupeKey = `product-role:${input.guildId}:${input.discordUserId}:${roleId}:${action}:${purpose}`;
  await client.query(`INSERT INTO discord_product_role_tasks
    (id,guild_id,user_id,discord_user_id,role_id,action,status,dedupe_key,attempt_count,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,'PENDING',$7,0,$8,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(),input.guildId,userId,input.discordUserId,roleId,action,dedupeKey,input.now]);
}

function registrationChanges(payload: PlayerRegistrationResult) {
  return [
    { targetType: 'user', targetId: payload.userId, changeType: 'CREATE' as const, beforeSnapshot: null, afterSnapshot: { status: 'ACTIVE' }, changedFields: ['status'] },
    { targetType: 'wallet_account', targetId: payload.walletAccountId, changeType: 'CREATE' as const, beforeSnapshot: null, afterSnapshot: { currency: 'CAT' }, changedFields: ['currency'] }
  ];
}

function identityKey(input: Pick<OnboardingInput, 'guildId' | 'discordUserId'>): string { return `${input.guildId}:${input.discordUserId}`; }
function stableUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8','9','a','b'][Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0,8)}-${joined.slice(8,12)}-${joined.slice(12,16)}-${joined.slice(16,20)}-${joined.slice(20)}`;
}
function mapError(error: unknown) {
  if (!(error instanceof OnboardingError)) return null;
  return { statusCode: error.code === 'CONFLICT' ? 409 : error.code === 'CONFIGURATION_ERROR' ? 422 : 400, code: error.code, message: error.message };
}
