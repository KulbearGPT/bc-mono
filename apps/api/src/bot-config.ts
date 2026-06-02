import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type ActorSource,
  type AuditRecord,
  type AuditSink,
  type StaffLevel
} from './security.js';
import { hasStaffPermission } from './authorization-policy.js';
import { createPilotFeaturePolicy } from './pilot-features.js';

export type BotConfigValue = string | number | boolean | null;
export type BotConfigValues = Partial<Record<BotConfigFieldName, BotConfigValue>>;

export interface BotConfigSnapshot {
  guildId: string;
  version: number;
  values: BotConfigValues;
  updatedByStaffId: string | null;
  updatedAt: string;
}

export interface BotConfigEvent {
  id: string;
  guildId: string;
  version: number;
  changes: BotConfigValues;
  previousValues: BotConfigValues;
  reason: string;
  actorStaffId: string;
  source: 'DISCORD_BOT' | 'DASHBOARD';
  createdAt: string;
}

interface BotConfigUpdateInput {
  guildId: string;
  expectedVersion: number;
  changes: BotConfigValues;
  reason: string;
  actorStaffId: string;
  source: 'DISCORD_BOT' | 'DASHBOARD';
  now: Date;
  eventId: string;
}

interface StagedBotConfigWrite {
  data: { guildId: string; previousVersion: number; version: number; auditEventId: string; updatedAt: string };
  commit(record: AuditRecord, auditSink: AuditSink): Promise<void> | void;
}

export interface BotConfigStore {
  get(guildId: string): Promise<BotConfigSnapshot | null> | BotConfigSnapshot | null;
  stageUpdate(input: BotConfigUpdateInput): Promise<StagedBotConfigWrite> | StagedBotConfigWrite;
}

export async function resolveBotConfigString(store:BotConfigStore|undefined,guildId:string|null|undefined,field:BotConfigFieldName,fallback:string){
  if(!store||!guildId)return fallback;const value=(await store.get(guildId))?.values[field];return typeof value==='string'&&value?value:fallback;
}

export interface BotConfigDiscordAdapter {
  validateObject(input: { guildId: string; field: string; value: string }): Promise<
    { ok: true } | { ok: false; code: string; message: string }
  >;
  sendTestMessage(input: { guildId: string; channelId: string; content: string }): Promise<{ messageId: string }>;
}

export class DiscordHttpBotConfigAdapter implements BotConfigDiscordAdapter {
  private botUserId: string | null = null;
  constructor(private readonly token: string, private readonly apiBaseUrl = 'https://discord.com/api/v10') {
    if (!token.trim()) throw new Error('Discord Bot token is required.');
  }

  async validateObject(input: { guildId: string; field: string; value: string }) {
    if ((channelFields as readonly string[]).includes(input.field)) return this.validateChannel(input);
    return this.validateRole(input);
  }

  async sendTestMessage(input: { guildId: string; channelId: string; content: string }) {
    const channel = await this.discord<{ guild_id?: string }>(`/channels/${input.channelId}`);
    if (channel.guild_id !== input.guildId) throw new BotConfigError('BUSINESS_RULE_ERROR', 'The test channel is outside this Guild.');
    const message = await this.discord<{ id: string }>(`/channels/${input.channelId}/messages`, { method: 'POST', body: JSON.stringify({ content: input.content, allowed_mentions: { parse: [] } }) });
    return { messageId: message.id };
  }

  private async validateChannel(input: { guildId: string; field: string; value: string }) {
    try {
      const channel = await this.discord<DiscordChannel>(`/channels/${input.value}`);
      if (channel.guild_id !== input.guildId) return invalidObject('WRONG_GUILD', 'The selected channel does not belong to this Guild.');
      const category = input.field === 'private_order_category_id' || input.field === 'order_archive_category_id';
      if ((category && channel.type !== 4) || (!category && ![0, 5].includes(channel.type))) return invalidObject('WRONG_CHANNEL_TYPE', 'The selected Discord channel type is not valid for this field.');
      const permissions = await this.channelPermissions(input.guildId, channel);
      const required = category ? [PERMISSION_VIEW_CHANNEL, PERMISSION_MANAGE_CHANNELS] : [PERMISSION_VIEW_CHANNEL, PERMISSION_SEND_MESSAGES];
      if (!required.every((flag) => (permissions & flag) === flag)) return invalidObject('MISSING_BOT_PERMISSION', 'The Bot lacks the required Discord channel permissions.');
      return { ok: true as const };
    } catch (error) { return invalidObject('DISCORD_OBJECT_UNAVAILABLE', publicDiscordError(error)); }
  }

  private async validateRole(input: { guildId: string; field: string; value: string }) {
    try {
      const [roles, member] = await Promise.all([this.discord<DiscordRole[]>(`/guilds/${input.guildId}/roles`), this.botMember(input.guildId)]);
      const role = roles.find((item) => item.id === input.value);
      if (!role) return invalidObject('WRONG_GUILD', 'The selected Role does not belong to this Guild.');
      if (role.managed) return invalidObject('MANAGED_ROLE', 'Discord-managed Roles cannot be used for this mapping.');
      const botRoles = roles.filter((item) => member.roles.includes(item.id));
      const base = botRoles.reduce((value, item) => value | BigInt(item.permissions), BigInt(roles.find((item) => item.id === input.guildId)?.permissions ?? '0'));
      const highest = Math.max(0, ...botRoles.map((item) => item.position));
      if ((base & PERMISSION_ADMINISTRATOR) !== PERMISSION_ADMINISTRATOR && (base & PERMISSION_MANAGE_ROLES) !== PERMISSION_MANAGE_ROLES) return invalidObject('MISSING_BOT_PERMISSION', 'The Bot lacks Manage Roles permission.');
      if (role.position >= highest) return invalidObject('ROLE_HIERARCHY', 'The selected Role must be below the Bot highest Role.');
      return { ok: true as const };
    } catch (error) { return invalidObject('DISCORD_OBJECT_UNAVAILABLE', publicDiscordError(error)); }
  }

  private async channelPermissions(guildId: string, channel: DiscordChannel) {
    const [roles, member] = await Promise.all([this.discord<DiscordRole[]>(`/guilds/${guildId}/roles`), this.botMember(guildId)]);
    let permissions = BigInt(roles.find((role) => role.id === guildId)?.permissions ?? '0');
    for (const role of roles) if (member.roles.includes(role.id)) permissions |= BigInt(role.permissions);
    if ((permissions & PERMISSION_ADMINISTRATOR) === PERMISSION_ADMINISTRATOR) return ALL_DISCORD_PERMISSIONS;
    const everyone = channel.permission_overwrites?.find((item) => item.type === 0 && item.id === guildId); permissions = applyOverwrite(permissions, everyone);
    let roleAllow = 0n; let roleDeny = 0n;
    for (const item of channel.permission_overwrites ?? []) if (item.type === 0 && member.roles.includes(item.id)) { roleAllow |= BigInt(item.allow); roleDeny |= BigInt(item.deny); }
    permissions = (permissions & ~roleDeny) | roleAllow;
    const botId = await this.currentBotUserId();
    return applyOverwrite(permissions, channel.permission_overwrites?.find((item) => item.type === 1 && item.id === botId));
  }

  private async botMember(guildId: string) { return this.discord<{ roles: string[] }>(`/guilds/${guildId}/members/${await this.currentBotUserId()}`); }
  private async currentBotUserId() { if (!this.botUserId) this.botUserId = (await this.discord<{ id: string }>('/users/@me')).id; return this.botUserId; }
  private async discord<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, { ...init, headers: { authorization: `Bot ${this.token}`, 'content-type': 'application/json', ...init.headers } });
    if (!response.ok) throw new Error(`Discord API request failed with ${response.status}.`);
    return response.json() as Promise<T>;
  }
}

export class BotConfigError extends Error {
  constructor(readonly code: 'VALIDATION_ERROR' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'CONFIG_VERSION_CONFLICT' | 'BUSINESS_RULE_ERROR', message: string, readonly details: Array<{ field: string; reason: string }> = []) {
    super(message);
  }
}

export class InMemoryBotConfigStore implements BotConfigStore {
  private readonly snapshots = new Map<string, BotConfigSnapshot>();
  readonly events: BotConfigEvent[] = [];
  private readonly staffRoleMappings = new Map<string,string>();

  constructor(input: { snapshots?: BotConfigSnapshot[] } = {}) {
    for (const snapshot of input.snapshots ?? []) {this.snapshots.set(snapshot.guildId, clone(snapshot));for(const [field,value] of Object.entries(snapshot.values))if(isStaffRoleField(field)&&typeof value==='string')this.staffRoleMappings.set(`${snapshot.guildId}:${field}`,value);}
  }

  get(guildId: string) { return this.snapshot(guildId); }
  snapshot(guildId: string) { const value = this.snapshots.get(guildId); return value ? clone(value) : null; }
  roleMapping(guildId:string,field:string){return this.staffRoleMappings.get(`${guildId}:${field}`)??null;}

  stageUpdate(input: BotConfigUpdateInput): StagedBotConfigWrite {
    const current = this.snapshots.get(input.guildId);
    assertCurrentVersion(current, input.expectedVersion);
    const previousValues = pickValues(current!.values, Object.keys(input.changes) as BotConfigFieldName[]);
    const next: BotConfigSnapshot = { ...clone(current!), version: input.expectedVersion + 1, values: { ...current!.values, ...input.changes }, updatedByStaffId: input.actorStaffId, updatedAt: input.now.toISOString() };
    const event: BotConfigEvent = { id: input.eventId, guildId: input.guildId, version: next.version, changes: clone(input.changes), previousValues, reason: input.reason, actorStaffId: input.actorStaffId, source: input.source, createdAt: input.now.toISOString() };
    return {
      data: { guildId: input.guildId, previousVersion: input.expectedVersion, version: next.version, auditEventId: input.eventId, updatedAt: next.updatedAt },
      commit: async (record, auditSink) => {
        const latest = this.snapshots.get(input.guildId);
        assertCurrentVersion(latest, input.expectedVersion);
        await auditSink.append(record);
        this.snapshots.set(input.guildId, clone(next));
        this.events.push(clone(event));
        for(const [field,value] of Object.entries(input.changes))if(isStaffRoleField(field)&&typeof value==='string')this.staffRoleMappings.set(`${input.guildId}:${field}`,value);
      }
    };
  }
}

export class PostgresBotConfigStore implements BotConfigStore {
  constructor(private readonly pool: Pool) {}

  async get(guildId: string): Promise<BotConfigSnapshot | null> {
    const result = await this.pool.query<BotConfigRow>('SELECT guild_id,version,config_json,updated_by_staff_id,updated_at FROM guild_bot_configs WHERE guild_id=$1', [guildId]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async stageUpdate(input: BotConfigUpdateInput): Promise<StagedBotConfigWrite> {
    const current = await this.get(input.guildId);
    assertCurrentVersion(current, input.expectedVersion);
    const previousValues = pickValues(current!.values, Object.keys(input.changes) as BotConfigFieldName[]);
    const values = { ...current!.values, ...input.changes };
    const updatedAt = input.now.toISOString();
    return {
      data: { guildId: input.guildId, previousVersion: input.expectedVersion, version: input.expectedVersion + 1, auditEventId: input.eventId, updatedAt },
      commit: async (record) => {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          const locked = await client.query<{ version: number }>('SELECT version FROM guild_bot_configs WHERE guild_id=$1 FOR UPDATE', [input.guildId]);
          assertCurrentVersion(locked.rows[0] ? { version: locked.rows[0].version } : null, input.expectedVersion);
          const updated=await client.query('UPDATE guild_bot_configs SET version=$2,config_json=$3::jsonb,updated_by_staff_id=$4,updated_at=$5 WHERE guild_id=$1 AND version=$6 RETURNING version', [input.guildId, input.expectedVersion + 1, JSON.stringify(values), input.actorStaffId, input.now,input.expectedVersion]);
          if(updated.rowCount!==1)throw new BotConfigError('CONFIG_VERSION_CONFLICT','Bot configuration changed; refresh before retrying.');
          await syncCanonicalStaffRoleMappings(client,input);
          await client.query(`INSERT INTO guild_bot_config_events(id,guild_id,version,changes_json,previous_values_json,reason,actor_staff_id,source,created_at)
            VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)`, [input.eventId, input.guildId, input.expectedVersion + 1, JSON.stringify(input.changes), JSON.stringify(previousValues), input.reason, input.actorStaffId, input.source, input.now]);
          await insertPostgresAuditRecord(client, record);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally { client.release(); }
      }
    };
  }
}

export interface BotConfigRouteOptions {
  store: BotConfigStore;
  discord: BotConfigDiscordAdapter;
  validationSecret: string;
  now?: () => Date;
}

export function registerBotConfigRoutes(server: FastifyInstance, options: BotConfigRouteOptions): void {
  if (!server.securityOptions) throw new Error('Bot configuration routes require security options.');
  if (options.validationSecret.length < 32) throw new Error('Bot configuration validation secret must be at least 32 characters.');
  const security = server.securityOptions;
  const auditSink = security.auditSink ?? new InMemoryAuditSink();
  const now = options.now ?? (() => new Date());

  registerSecureReadRoute(server, security, {
    method: 'GET', url: '/api/v1/admin/bot-config', permission: 'bot_config.read', action: 'GET_BOT_CONFIG', targetType: 'guild_bot_config', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], allowServiceActor: true, mapError,
    targetId: (request) => rawQueryGuildId(request),
    handler: async (request, actor) => {
      const guildId = queryGuildId(request); assertGuildActor(actor, guildId);
      const snapshot = await options.store.get(guildId); if (!snapshot) throw new BotConfigError('NOT_FOUND', 'Bot configuration was not found.');
      return {
        ...snapshot,
        manageableFields: actor.actorLevel ? manageableFields(actor.actorLevel) : [],
        enabledFeatures: [...(security.pilotFeaturePolicy ?? createPilotFeaturePolicy('OFF')).enabledFeatures],
        businessEnvironment: security.businessEnvironment ?? 'SANDBOX',
        displayRole: actor.actorLevel === 'L2_SUPERVISOR' ? 'STAFF' : actor.actorLevel === 'L4_ADMIN_OWNER' ? 'OWNER' : null
      };
    }
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/bot-config/validate', permission: 'bot_config.operational.manage', action: 'VALIDATE_BOT_CONFIG_CHANGE', targetType: 'guild_bot_config', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    targetId: (request) => rawBodyGuildId(request.body), fingerprintBody: (request) => parseChangeRequest(request.body), successReason: (request) => parseChangeRequest(request.body).reason,
    handler: async (request, actor) => {
      const body = parseChangeRequest(request.body); const staff = requireStaff(actor); assertGuildActor(actor, body.guildId); assertFieldPermission(staff.level, body.changes);
      const current = await options.store.get(body.guildId); assertCurrentVersion(current, body.expectedVersion);
      const errors = await validateDiscordObjects(options.discord, body.guildId, body.changes);
      const normalizedChanges = normalizeChanges(body.changes);
      const requiredPermissions = requiredPermissionsFor(normalizedChanges);
      if (errors.length) return { guildId: body.guildId, currentVersion: current!.version, normalizedChanges, warnings: [], errors, mayApply: false, requiredPermissions, validationToken: null, validationExpiresAt: null };
      const expiresAt = new Date(now().getTime() + 5 * 60_000);
      const validationToken = signPreview(options.validationSecret, previewClaims(body, staff.staffId, normalizedChanges, expiresAt));
      return { guildId: body.guildId, currentVersion: current!.version, normalizedChanges, warnings: [], errors: [], mayApply: true, requiredPermissions, validationToken, validationExpiresAt: expiresAt.toISOString() };
    }
  });

  registerSecureWriteRoute(server, security, {
    method: 'PATCH', url: '/api/v1/admin/bot-config', permission: 'bot_config.operational.manage', action: 'UPDATE_BOT_CONFIG', targetType: 'guild_bot_config', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError, retryCommitFailures: true,
    targetId: (request) => rawBodyGuildId(request.body), fingerprintBody: (request) => parseUpdateRequest(request.body), successReason: (request) => parseUpdateRequest(request.body).reason,
    handler: async (request, actor) => {
      const body = parseUpdateRequest(request.body); const staff = requireStaff(actor); assertGuildActor(actor, body.guildId); assertFieldPermission(staff.level, body.changes);
      const normalizedChanges = normalizeChanges(body.changes);
      verifyPreview(options.validationSecret, body, staff.staffId, normalizedChanges, now());
      const current = await options.store.get(body.guildId); assertCurrentVersion(current, body.expectedVersion);
      const discordErrors = await validateDiscordObjects(options.discord, body.guildId, normalizedChanges);
      if (discordErrors.length) throw new BotConfigError('BUSINESS_RULE_ERROR', 'Discord configuration validation changed after preview.', discordErrors.map((issue) => ({ field: issue.field, reason: issue.code })));
      const staged = await options.store.stageUpdate({ ...body, changes: normalizedChanges, actorStaffId: staff.staffId, source: actorSource(actor.actorSource), now: now(), eventId: randomUUID() });
      return { data: staged.data, commit: (record: AuditRecord) => staged.commit(record, auditSink) };
    }
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST', url: '/api/v1/admin/bot-config/test-delivery', permission: 'bot_config.operational.manage', action: 'TEST_BOT_CONFIG_DELIVERY', targetType: 'guild_bot_config', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], mapError,
    targetId: (request) => rawBodyGuildId(request.body), fingerprintBody: (request) => parseDeliveryRequest(request.body), successReason: (request) => parseDeliveryRequest(request.body).reason,
    handler: async (request, actor) => {
      const body = parseDeliveryRequest(request.body); requireStaff(actor); assertGuildActor(actor, body.guildId);
      const current = await options.store.get(body.guildId); assertCurrentVersion(current, body.expectedVersion);
      const validation = await options.discord.validateObject({ guildId: body.guildId, field: body.channelField, value: body.channelId });
      if (!validation.ok) throw new BotConfigError('BUSINESS_RULE_ERROR', validation.message, [{ field: body.channelField, reason: validation.code }]);
      const delivered = await options.discord.sendTestMessage({ guildId: body.guildId, channelId: body.channelId, content: '[配置测试] Bot 频道投递验证，不会创建业务记录。' });
      return { guildId: body.guildId, version: current!.version, channelField: body.channelField, channelId: body.channelId, delivered: true, messageId: delivered.messageId, testedAt: now().toISOString() };
    }
  });
}

const channelFields = ['public_entry_channel_id','private_order_category_id','order_archive_category_id','dispatch_channel_id','player_workbench_channel_id','gift_review_channel_id','gift_broadcast_channel_id','staff_task_channel_id','operations_alert_channel_id'] as const;
const securityRoleFields = ['player_role_id','companion_applicant_role_id','companion_role_id','staff_l1_role_id','staff_l2_role_id','staff_l3_role_id','staff_l4_role_id'] as const;
const notificationRoleFields = ['staff_notification_role_id','operations_notification_role_id'] as const;
const integerRules = {
  dispatch_timeout_minutes: [1,30], dispatch_max_rounds: [1,5], readiness_timeout_minutes: [1,30], completion_confirmation_minutes: [5,120], gift_review_reminder_minutes: [1,60], channel_archive_after_completion_minutes: [0,43200]
} as const;
const booleanFields = ['new_orders_enabled','auto_dispatch_enabled','gift_requests_enabled','maintenance_notice'] as const;
const operationalFields = [...channelFields,...notificationRoleFields,...Object.keys(integerRules), 'gift_broadcast_template', ...booleanFields] as const;
const allFields = [...operationalFields,...securityRoleFields] as const;
export type BotConfigFieldName = typeof allFields[number];
type ChangeRequest = { guildId: string; expectedVersion: number; changes: BotConfigValues; reason: string };
type UpdateRequest = ChangeRequest & { validationToken: string };

function manageableFields(level: StaffLevel): BotConfigFieldName[] { return level === 'L4_ADMIN_OWNER' ? [...allFields] : [...operationalFields]; }
function requiredPermissionsFor(changes: BotConfigValues) { return Object.keys(changes).some((field) => (securityRoleFields as readonly string[]).includes(field)) ? ['bot_config.operational.manage','bot_config.security.manage'] : ['bot_config.operational.manage']; }
function assertFieldPermission(level: StaffLevel, changes: BotConfigValues) { if (Object.keys(changes).some((field) => (securityRoleFields as readonly string[]).includes(field)) && !hasStaffPermission(level, 'bot_config.security.manage')) throw new BotConfigError('PERMISSION_DENIED', 'Role mappings require L4 permission.'); }
function requireStaff(actor: ActorContext) { if (!actor.actorStaffId || !actor.actorLevel) throw new BotConfigError('PERMISSION_DENIED', 'An active staff account is required.'); return { staffId: actor.actorStaffId, level: actor.actorLevel }; }
function assertGuildActor(actor: ActorContext, guildId: string) { if (actor.actorSource === 'DISCORD_BOT' && actor.clientId !== 'DISCORD_BOT_SERVICE' && actor.guildId !== guildId) throw new BotConfigError('PERMISSION_DENIED', 'The Guild is outside this interaction.'); }
function actorSource(source: ActorSource): 'DISCORD_BOT'|'DASHBOARD' { if (source !== 'DISCORD_BOT' && source !== 'DASHBOARD') throw new BotConfigError('PERMISSION_DENIED', 'Unsupported actor source.'); return source; }
function assertCurrentVersion(current: { version: number } | null | undefined, expectedVersion: number): asserts current is { version: number } { if (!current) throw new BotConfigError('NOT_FOUND', 'Bot configuration was not found.'); if (current.version !== expectedVersion) throw new BotConfigError('CONFIG_VERSION_CONFLICT', 'Bot configuration changed; refresh before retrying.', [{ field: 'expectedVersion', reason: `current version is ${current.version}` }]); }

async function validateDiscordObjects(adapter: BotConfigDiscordAdapter, guildId: string, changes: BotConfigValues) {
  const issues: Array<{ field: BotConfigFieldName; code: string; message: string }> = [];
  for (const [field,value] of Object.entries(changes) as Array<[BotConfigFieldName,BotConfigValue]>) {
    if (typeof value !== 'string' || (!(channelFields as readonly string[]).includes(field) && !(securityRoleFields as readonly string[]).includes(field) && !(notificationRoleFields as readonly string[]).includes(field))) continue;
    const result = await adapter.validateObject({ guildId, field, value }); if (!result.ok) issues.push({ field, code: result.code, message: result.message });
  }
  return issues;
}

function parseChangeRequest(value: unknown): ChangeRequest { const input=exact(value,['guildId','expectedVersion','changes','reason']); return { guildId:snowflake(input.guildId,'guildId'),expectedVersion:version(input.expectedVersion),changes:parseChanges(input.changes),reason:text(input.reason,'reason',3,1000) }; }
function parseUpdateRequest(value: unknown): UpdateRequest { const input=exact(value,['guildId','expectedVersion','changes','reason','validationToken']); return { guildId:snowflake(input.guildId,'guildId'),expectedVersion:version(input.expectedVersion),changes:parseChanges(input.changes),reason:text(input.reason,'reason',3,1000),validationToken:text(input.validationToken,'validationToken',32,2048) }; }
function parseDeliveryRequest(value: unknown) { const input=exact(value,['guildId','expectedVersion','channelField','channelId','reason']); const channelField=text(input.channelField,'channelField',1,100); if(!(channelFields as readonly string[]).includes(channelField))throw validation('channelField'); return {guildId:snowflake(input.guildId,'guildId'),expectedVersion:version(input.expectedVersion),channelField:channelField as typeof channelFields[number],channelId:snowflake(input.channelId,'channelId'),reason:text(input.reason,'reason',3,1000)}; }
function parseChanges(value: unknown): BotConfigValues { const input=object(value);const keys=Object.keys(input);if(!keys.length||keys.some((key)=>!(allFields as readonly string[]).includes(key)))throw validation('changes');const result:BotConfigValues={};for(const key of keys as BotConfigFieldName[])result[key]=parseField(key,input[key]);return result; }
function parseField(field:BotConfigFieldName,value:unknown):BotConfigValue {
  if((channelFields as readonly string[]).includes(field)||(securityRoleFields as readonly string[]).includes(field)||(notificationRoleFields as readonly string[]).includes(field)){if(value===null&&(field==='order_archive_category_id'||field==='companion_applicant_role_id'||(notificationRoleFields as readonly string[]).includes(field)))return null;return snowflake(value,field);}
  if(field in integerRules){if(!Number.isSafeInteger(value))throw validation(field);const [min,max]=integerRules[field as keyof typeof integerRules];if(Number(value)<min||Number(value)>max)throw validation(field);return Number(value);}
  if((booleanFields as readonly string[]).includes(field)){if(typeof value!=='boolean')throw validation(field);return value;}
  const template=text(value,field,1,500);for(const token of ['{sender_name}','{receiver_name}','{gift_name}'])if(!template.includes(token))throw validation(field);if(/\{(?!sender_name\}|receiver_name\}|gift_name\})/.test(template))throw validation(field);return template;
}
function normalizeChanges(value:BotConfigValues):BotConfigValues{return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))) as BotConfigValues;}
function exact(value:unknown,allowed:string[]){const input=object(value);if(Object.keys(input).some((key)=>!allowed.includes(key)))throw new BotConfigError('VALIDATION_ERROR','Request contains unsupported fields.');return input;}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new BotConfigError('VALIDATION_ERROR','Object payload is required.');return value as Record<string,unknown>;}
function text(value:unknown,field:string,min:number,max:number){if(typeof value!=='string'||value.trim().length<min||value.length>max)throw validation(field);return value.trim();}
function snowflake(value:unknown,field:string){const result=text(value,field,17,20);if(!/^[0-9]{17,20}$/.test(result))throw validation(field);return result;}
function version(value:unknown){if(!Number.isSafeInteger(value)||Number(value)<1)throw validation('expectedVersion');return Number(value);}
function validation(field:string){return new BotConfigError('VALIDATION_ERROR',`${field} is invalid.`,[{field,reason:'invalid value'}]);}
function queryGuildId(request:FastifyRequest){return snowflake((request.query as Record<string,unknown>).guildId,'guildId');}
function rawQueryGuildId(request:FastifyRequest){const value=(request.query as Record<string,unknown>).guildId;return typeof value==='string'?value.slice(0,100):'unknown';}
function rawBodyGuildId(value:unknown){if(!value||typeof value!=='object'||Array.isArray(value))return 'unknown';const guildId=(value as Record<string,unknown>).guildId;return typeof guildId==='string'?guildId.slice(0,100):'unknown';}

interface PreviewClaims { v:1;actorStaffId:string;guildId:string;expectedVersion:number;changes:BotConfigValues;reason:string;expiresAt:string }
function previewClaims(body:ChangeRequest,actorStaffId:string,changes:BotConfigValues,expiresAt:Date):PreviewClaims{return {v:1,actorStaffId,guildId:body.guildId,expectedVersion:body.expectedVersion,changes,reason:body.reason,expiresAt:expiresAt.toISOString()};}
function signPreview(secret:string,claims:PreviewClaims){const payload=Buffer.from(stableJson(claims)).toString('base64url');return `cfgv1.${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;}
function verifyPreview(secret:string,body:UpdateRequest,actorStaffId:string,changes:BotConfigValues,current:Date){const claims=parsePreview(secret,body.validationToken);const expected=previewClaims(body,actorStaffId,changes,new Date(claims.expiresAt));if(new Date(claims.expiresAt).getTime()<=current.getTime()||stableJson(claims)!==stableJson(expected))throw new BotConfigError('BUSINESS_RULE_ERROR','The validation token is expired or does not match this change.');}
function parsePreview(secret:string,token:string):PreviewClaims{const [prefix,payload,signature,...rest]=token.split('.');if(prefix!=='cfgv1'||!payload||!signature||rest.length)throw new BotConfigError('BUSINESS_RULE_ERROR','The validation token is invalid.');const expected=createHmac('sha256',secret).update(payload).digest();let actual:Buffer;try{actual=Buffer.from(signature,'base64url');}catch{throw new BotConfigError('BUSINESS_RULE_ERROR','The validation token is invalid.');}if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new BotConfigError('BUSINESS_RULE_ERROR','The validation token is invalid.');try{const value=JSON.parse(Buffer.from(payload,'base64url').toString()) as PreviewClaims;if(value.v!==1||typeof value.expiresAt!=='string')throw new Error();return value;}catch{throw new BotConfigError('BUSINESS_RULE_ERROR','The validation token is invalid.');}}
function stableJson(value:unknown):string{if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;if(value&&typeof value==='object')return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;return JSON.stringify(value);}
function pickValues(values:BotConfigValues,fields:BotConfigFieldName[]){return Object.fromEntries(fields.map((field)=>[field,values[field]??null])) as BotConfigValues;}
function clone<T>(value:T):T{return structuredClone(value);}
function mapError(error:unknown){if(!(error instanceof BotConfigError))return null;return {statusCode:error.code==='NOT_FOUND'?404:error.code==='PERMISSION_DENIED'?403:error.code==='CONFIG_VERSION_CONFLICT'?409:error.code==='BUSINESS_RULE_ERROR'?422:400,code:error.code,message:error.message,details:error.details};}
function mapRow(row:BotConfigRow):BotConfigSnapshot{return {guildId:row.guild_id,version:row.version,values:clone(row.config_json),updatedByStaffId:row.updated_by_staff_id,updatedAt:new Date(row.updated_at).toISOString()};}
interface BotConfigRow { guild_id:string;version:number;config_json:BotConfigValues;updated_by_staff_id:string;updated_at:string|Date }

const staffRoleTargets:Record<string,StaffLevel>={staff_l1_role_id:'L1_SUPPORT',staff_l2_role_id:'L2_SUPERVISOR',staff_l3_role_id:'L3_OPERATIONS',staff_l4_role_id:'L4_ADMIN_OWNER'};
function isStaffRoleField(field:string):field is keyof typeof staffRoleTargets{return field in staffRoleTargets;}
async function syncCanonicalStaffRoleMappings(client:PoolClientLike,input:BotConfigUpdateInput){
  const changes=Object.entries(input.changes).filter(([field,value])=>isStaffRoleField(field)&&typeof value==='string') as Array<[keyof typeof staffRoleTargets,string]>;
  if(!changes.length)return;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`blackcat:role-mapping:${input.guildId}`]);
  const result=await client.query<{version:number}>('SELECT COALESCE(max(version),0)::int AS version FROM discord_role_mappings WHERE guild_id=$1',[input.guildId]);let mappingVersion=result.rows[0]?.version??0;
  for(const [field,roleId] of changes){const target=staffRoleTargets[field];mappingVersion+=1;const mappingId=randomUUID();
    await client.query(`UPDATE discord_role_mappings SET enabled=false,active_mapping_key=NULL,active_level_key=NULL,retired_at=$3
      WHERE guild_id=$1 AND (target_level=$2::"StaffLevel" OR discord_role_id=$4) AND retired_at IS NULL`,[input.guildId,target,input.now,roleId]);
    await client.query(`INSERT INTO discord_role_mappings(id,guild_id,discord_role_id,target_level,version,enabled,active_mapping_key,active_level_key,created_by_staff_id,created_at)
      VALUES ($1,$2::varchar,$3::varchar,$4::"StaffLevel",$5,true,
        concat($2::varchar,':',$3::varchar),concat($2::varchar,':',$4::text),$6,$7)`,
      [mappingId,input.guildId,roleId,target,mappingVersion,input.actorStaffId,input.now]);
    await client.query(`INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at)
      VALUES ($1,'ROLE_RECONCILIATION','discord_role_mapping',$2,$3,$4::jsonb,'PENDING',1,0,8,$5,$5,$5)`,[randomUUID(),mappingId,`role-reconciliation:${input.guildId}:${target}:${mappingVersion}`,JSON.stringify({guildId:input.guildId,targetLevel:target,mappingVersion}),input.now]);
  }
}
interface PoolClientLike{query<Row=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:Row[];rowCount?:number|null}>}

interface DiscordRole { id:string;permissions:string;position:number;managed:boolean }
interface DiscordChannel { id:string;guild_id?:string;type:number;permission_overwrites?:Array<{id:string;type:number;allow:string;deny:string}> }
const PERMISSION_MANAGE_CHANNELS=1n<<4n,PERMISSION_VIEW_CHANNEL=1n<<10n,PERMISSION_SEND_MESSAGES=1n<<11n,PERMISSION_MANAGE_ROLES=1n<<28n,PERMISSION_ADMINISTRATOR=1n<<3n,ALL_DISCORD_PERMISSIONS=(1n<<53n)-1n;
function applyOverwrite(value:bigint,overwrite:{allow:string;deny:string}|undefined){return overwrite?(value&~BigInt(overwrite.deny))|BigInt(overwrite.allow):value;}
function invalidObject(code:string,message:string){return {ok:false as const,code,message};}
function publicDiscordError(error:unknown){return error instanceof Error&&/^Discord API request failed with [0-9]+\.$/.test(error.message)?error.message:'The Discord object could not be validated.';}

export function deterministicBotConfigId(guildId:string){const hex=createHash('sha256').update(`guild-bot-config:${guildId}`).digest('hex').slice(0,32);return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
