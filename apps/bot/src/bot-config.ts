import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  type InteractionReplyOptions
} from 'discord.js';

export const botConfigChannelFields = [
  'public_entry_channel_id',
  'private_order_category_id',
  'order_archive_category_id',
  'dispatch_channel_id',
  'player_workbench_channel_id',
  'gift_review_channel_id',
  'gift_broadcast_channel_id',
  'staff_task_channel_id',
  'operations_alert_channel_id'
] as const;

export const botConfigRoleFields = [
  'player_role_id',
  'companion_applicant_role_id',
  'companion_role_id',
  'staff_l1_role_id',
  'staff_l2_role_id',
  'staff_l3_role_id',
  'staff_l4_role_id',
  'staff_notification_role_id',
  'operations_notification_role_id'
] as const;

export const botConfigIntegerFields = [
  'dispatch_timeout_minutes',
  'dispatch_max_rounds',
  'readiness_timeout_minutes',
  'completion_confirmation_minutes',
  'gift_review_reminder_minutes',
  'channel_archive_after_completion_minutes'
] as const;

export const botConfigBooleanFields = ['new_orders_enabled', 'auto_dispatch_enabled', 'gift_requests_enabled', 'maintenance_notice'] as const;
export const botConfigTextFields = ['gift_broadcast_template'] as const;

export type BotConfigChannelField = typeof botConfigChannelFields[number];
export type BotConfigRoleField = typeof botConfigRoleFields[number];
export type BotConfigSelectableField = BotConfigChannelField | BotConfigRoleField;
export type BotConfigScalarField = typeof botConfigIntegerFields[number] | typeof botConfigBooleanFields[number] | typeof botConfigTextFields[number];
export type BotConfigManageableField = BotConfigSelectableField | BotConfigScalarField;
export type BotConfigValue = string | number | boolean | null;
export type BotConfigValues = Partial<Record<string, BotConfigValue>>;

export interface BotConfigActorContext {
  guildId: string;
  discordUserId?: string;
  interactionId?: string;
  clientSource: 'DISCORD_BOT';
}

export interface BotConfigSnapshot {
  guildId: string;
  version: number;
  values: BotConfigValues;
  manageableFields: string[];
  updatedByStaffId: string | null;
  updatedAt: string;
  enabledFeatures?: Array<'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6'>;
  businessEnvironment?: 'SANDBOX' | 'PRODUCTION';
  displayRole?: 'STAFF' | 'OWNER' | null;
}

export interface BotConfigChangeRequest {
  guildId: string;
  expectedVersion: number;
  changes: BotConfigValues;
  reason: string;
}

export interface BotConfigValidationIssue {
  field: string | null;
  code: string;
  message: string;
}

export interface BotConfigValidationResult {
  guildId: string;
  currentVersion: number;
  normalizedChanges: BotConfigValues;
  warnings: BotConfigValidationIssue[];
  errors: BotConfigValidationIssue[];
  mayApply: boolean;
  requiredPermissions: string[];
  validationToken: string | null;
  validationExpiresAt: string | null;
}

export interface BotConfigUpdateResult {
  guildId: string;
  previousVersion: number;
  version: number;
  auditEventId: string;
  updatedAt: string;
}

export interface BotConfigDeliveryTestResult {
  guildId: string;
  version: number;
  channelField: BotConfigChannelField;
  channelId: string;
  delivered: boolean;
  messageId: string | null;
  testedAt: string;
}

export interface BotConfigApiClient {
  getBotConfig(guildId: string, actor: BotConfigActorContext): Promise<BotConfigSnapshot>;
  validateBotConfigChange(input: BotConfigChangeRequest, actor: BotConfigActorContext, idempotencyKey: string): Promise<BotConfigValidationResult>;
  updateBotConfig(input: BotConfigChangeRequest & { validationToken: string }, actor: BotConfigActorContext, idempotencyKey: string): Promise<BotConfigUpdateResult>;
  testBotConfigDelivery(input: {
    guildId: string;
    expectedVersion: number;
    channelField: BotConfigChannelField;
    channelId: string;
    reason: string;
  }, actor: BotConfigActorContext, idempotencyKey: string): Promise<BotConfigDeliveryTestResult>;
}

export class BotConfigApiError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;

  public constructor(input: { code: string; message: string; requestId: string; statusCode: number }) {
    super(input.message);
    this.name = 'BotConfigApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.statusCode = input.statusCode;
  }
}

export class HttpBotConfigApiClient implements BotConfigApiClient {
  private readonly apiBaseUrl: string;
  private readonly botServiceToken: string;

  public constructor(input: { apiBaseUrl: string; botServiceToken: string }) {
    this.apiBaseUrl = input.apiBaseUrl.replace(/\/$/u, '');
    this.botServiceToken = input.botServiceToken;
  }

  public getBotConfig(guildId: string, actor: BotConfigActorContext): Promise<BotConfigSnapshot> {
    return this.request(`/api/v1/admin/bot-config?guildId=${encodeURIComponent(guildId)}`, { method: 'GET', actor });
  }

  public validateBotConfigChange(input: BotConfigChangeRequest, actor: BotConfigActorContext, idempotencyKey: string): Promise<BotConfigValidationResult> {
    return this.request('/api/v1/admin/bot-config/validate', { method: 'POST', actor, idempotencyKey, body: input });
  }

  public updateBotConfig(input: BotConfigChangeRequest & { validationToken: string }, actor: BotConfigActorContext, idempotencyKey: string): Promise<BotConfigUpdateResult> {
    return this.request('/api/v1/admin/bot-config', { method: 'PATCH', actor, idempotencyKey, body: input });
  }

  public testBotConfigDelivery(input: {
    guildId: string;
    expectedVersion: number;
    channelField: BotConfigChannelField;
    channelId: string;
    reason: string;
  }, actor: BotConfigActorContext, idempotencyKey: string): Promise<BotConfigDeliveryTestResult> {
    return this.request('/api/v1/admin/bot-config/test-delivery', { method: 'POST', actor, idempotencyKey, body: input });
  }

  private async request<T>(path: string, input: {
    method: 'GET' | 'POST' | 'PATCH';
    actor: BotConfigActorContext;
    idempotencyKey?: string;
    body?: unknown;
  }): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.botServiceToken}`,
      'x-client-source': input.actor.clientSource
    };
    if (input.actor.discordUserId) {
      headers['x-actor-discord-user-id'] = input.actor.discordUserId;
      headers['x-actor-guild-id'] = input.actor.guildId;
    }
    if (input.actor.interactionId) headers['x-discord-interaction-id'] = input.actor.interactionId;
    if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
    if (input.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body)
      });
    } catch {
      throw new BotConfigApiError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Unified API is unavailable.',
        requestId: 'bot-api-unreachable',
        statusCode: 503
      });
    }
    let envelope: {
      requestId?: string;
      data?: T;
      error?: { code?: string; message?: string };
    };
    try {
      envelope = await response.json() as {
        requestId?: string;
        data?: T;
        error?: { code?: string; message?: string };
      };
    } catch {
      throw new BotConfigApiError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Unified API returned an invalid response.',
        requestId: 'bot-api-invalid-response',
        statusCode: 502
      });
    }
    if (!response.ok) {
      throw new BotConfigApiError({
        code: envelope.error?.code ?? 'SERVICE_UNAVAILABLE',
        message: envelope.error?.message ?? 'Unified API request failed.',
        requestId: envelope.requestId ?? 'unknown',
        statusCode: response.status
      });
    }
    return envelope.data as T;
  }
}

export class BotConfigCache {
  private readonly snapshots = new Map<string, BotConfigSnapshot>();

  public get(guildId: string): BotConfigSnapshot | undefined {
    return this.snapshots.get(guildId);
  }

  public set(snapshot: BotConfigSnapshot): void {
    this.snapshots.set(snapshot.guildId, structuredClone(snapshot));
  }
}

interface BotConfigSession {
  id: string;
  guildId: string;
  discordUserId: string;
  version: number;
  selectedField?: BotConfigManageableField;
  currentValue?: BotConfigValue;
  proposedValue?: BotConfigValue;
  validation?: BotConfigValidationResult;
  reason?: string;
  expiresAt: number;
}

export class BotConfigSessionStore {
  private readonly sessions = new Map<string, BotConfigSession>();
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly ttlMs: number;

  public constructor(input: { idFactory?: () => string; now?: () => number; ttlMs?: number } = {}) {
    this.idFactory = input.idFactory ?? (() => randomUUID().replaceAll('-', '').slice(0, 12));
    this.now = input.now ?? Date.now;
    this.ttlMs = input.ttlMs ?? 5 * 60_000;
  }

  public create(actor: BotConfigActorContext, snapshot: BotConfigSnapshot): BotConfigSession {
    if (!actor.discordUserId) throw new Error('A human actor is required for a Bot config session.');
    const id = this.idFactory();
    if (!/^[A-Za-z0-9_-]{8,16}$/u.test(id)) throw new Error('Bot config session ids must be short and URL-safe.');
    const session = { id, guildId: actor.guildId, discordUserId: actor.discordUserId, version: snapshot.version, expiresAt: this.now() + this.ttlMs };
    this.sessions.set(id, session);
    return session;
  }

  public require(actor: BotConfigActorContext, sessionId: string): BotConfigSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= this.now() || session.guildId !== actor.guildId || session.discordUserId !== actor.discordUserId) {
      this.sessions.delete(sessionId);
      throw new Error('Bot config session is missing, expired, or belongs to another actor.');
    }
    return session;
  }

  public delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export type BotConfigComponentSpec =
  | { type: 'STRING_SELECT'; customId: string; placeholder: string; options: Array<{ label: string; value: string }> }
  | { type: 'CHANNEL_SELECT'; customId: string; placeholder: string; channelTypes: ChannelType[] }
  | { type: 'ROLE_SELECT'; customId: string; placeholder: string }
  | { type: 'BUTTON'; customId: string; label: string; style: 'PRIMARY' | 'SECONDARY' | 'DANGER' };

export interface BotConfigReply {
  content: string;
  components: Array<{ components: BotConfigComponentSpec[] }>;
  ephemeral: true;
}

export class BotConfigFlow {
  private readonly api: BotConfigApiClient;
  private readonly cache: BotConfigCache;
  private readonly sessions: BotConfigSessionStore;

  public constructor(input: { api: BotConfigApiClient; cache: BotConfigCache; sessions: BotConfigSessionStore }) {
    this.api = input.api;
    this.cache = input.cache;
    this.sessions = input.sessions;
  }

  public async open(actor: BotConfigActorContext): Promise<BotConfigReply> {
    const snapshot = await this.api.getBotConfig(actor.guildId, actor);
    this.cache.set(snapshot);
    const session = this.sessions.create(actor, snapshot);
    return presentFieldPicker(session, snapshot);
  }

  public chooseField(actor: BotConfigActorContext, sessionId: string, field: string): BotConfigReply {
    const session = this.sessions.require(actor, sessionId);
    const snapshot=this.cache.get(actor.guildId);
    if (!snapshot?.manageableFields.includes(field) || !isManageableField(field)) {
      throw new Error('The selected Bot config field is not manageable in this session.');
    }
    session.selectedField = field;
    session.currentValue=snapshot.values[field];
    session.proposedValue = undefined;
    session.validation = undefined;
    return presentValuePicker(session);
  }

  public async previewValue(actor: BotConfigActorContext, sessionId: string, value: BotConfigValue, idempotencyKey: string): Promise<BotConfigReply> {
    const session = this.sessions.require(actor, sessionId);
    if (!session.selectedField) throw new Error('Select a Bot config field first.');
    const reason = `Discord /bot-config update: ${session.selectedField}`;
    const validation = await this.api.validateBotConfigChange({
      guildId: session.guildId,
      expectedVersion: session.version,
      changes: { [session.selectedField]: value },
      reason
    }, actor, idempotencyKey);
    session.proposedValue = value;
    session.validation = validation;
    session.reason = reason;
    return presentPreview(session);
  }

  public async confirm(actor: BotConfigActorContext, sessionId: string, idempotencyKey: string): Promise<BotConfigReply> {
    const session = this.sessions.require(actor, sessionId);
    const validationToken = session.validation?.validationToken;
    if (!session.selectedField || session.proposedValue === undefined || !session.reason || !session.validation?.mayApply || !validationToken) {
      throw new Error('A successful Bot config preview is required before confirmation.');
    }
    const result = await this.api.updateBotConfig({
      guildId: session.guildId,
      expectedVersion: session.version,
      changes: session.validation.normalizedChanges,
      reason: session.reason,
      validationToken
    }, actor, idempotencyKey);

    this.cache.set({
      ...(this.cache.get(session.guildId) as BotConfigSnapshot),
      version: result.version,
      values: { ...(this.cache.get(session.guildId)?.values??{}), ...session.validation.normalizedChanges },
      updatedAt: result.updatedAt
    });
    const refreshed = await this.api.getBotConfig(session.guildId, actor);
    this.cache.set(refreshed);
    this.sessions.delete(sessionId);
    return presentSaved(refreshed);
  }

  public async testDelivery(actor: BotConfigActorContext, sessionId: string, idempotencyKey: string): Promise<BotConfigReply> {
    const session = this.sessions.require(actor, sessionId);
    if (!session.selectedField || !isChannelField(session.selectedField) || typeof session.proposedValue !== 'string') {
      throw new Error('A channel preview is required before testing delivery.');
    }
    const result = await this.api.testBotConfigDelivery({
      guildId: session.guildId,
      expectedVersion: session.version,
      channelField: session.selectedField,
      channelId: session.proposedValue,
      reason: `Discord /bot-config delivery test: ${session.selectedField}`
    }, actor, idempotencyKey);
    return {
      ...presentPreview(session),
      content: `${presentPreview(session).content}\n\n${result.delivered ? '测试消息已送达。' : '测试消息未送达。'}`
    };
  }

  public cancel(actor: BotConfigActorContext, sessionId: string): BotConfigReply {
    this.sessions.require(actor, sessionId);
    this.sessions.delete(sessionId);
    return { content: '已取消本次 Bot 配置修改。', components: [], ephemeral: true };
  }

  public describeTextInput(actor: BotConfigActorContext, sessionId: string) {
    const field = this.sessions.require(actor, sessionId).selectedField;
    if (!field || (!isIntegerField(field) && !isTextField(field))) throw new Error('This field does not use text input.');
    return { field, title: `修改 ${fieldLabel(field)}`, label: isIntegerField(field) ? '请输入整数' : '请输入播报模板', paragraph: isTextField(field) };
  }

  public previewTextInput(actor: BotConfigActorContext, sessionId: string, rawValue: string, idempotencyKey: string) {
    const field = this.sessions.require(actor, sessionId).selectedField;
    if (!field || (!isIntegerField(field) && !isTextField(field))) throw new Error('This field does not use text input.');
    const value = isIntegerField(field) ? parseIntegerInput(rawValue) : rawValue.trim();
    return this.previewValue(actor, sessionId, value, idempotencyKey);
  }
}

export async function reloadBotConfigCache(input: {
  api: BotConfigApiClient;
  cache: BotConfigCache;
  guildIds: Iterable<string>;
  actorForGuild: (guildId: string) => BotConfigActorContext;
  onError?: (error: unknown, guildId: string) => void;
}): Promise<{ loaded: number; failed: number }> {
  let loaded = 0;
  let failed = 0;
  for (const guildId of input.guildIds) {
    try {
      input.cache.set(await input.api.getBotConfig(guildId, input.actorForGuild(guildId)));
      loaded += 1;
    } catch (error) {
      failed += 1;
      input.onError?.(error, guildId);
    }
  }
  return { loaded, failed };
}

export function parseBotConfigCustomId(customId: string): { operation: 'field' | 'security' | 'value' | 'input' | 'modal' | 'clear' | 'test' | 'confirm' | 'cancel'; sessionId: string } | null {
  const match = /^bc:cfg:(field|security|value|input|modal|clear|test|confirm|cancel):([A-Za-z0-9_-]{8,16})$/u.exec(customId);
  return match ? { operation: match[1] as 'field' | 'security' | 'value' | 'input' | 'modal' | 'clear' | 'test' | 'confirm' | 'cancel', sessionId: match[2] } : null;
}

export function toDiscordBotConfigReply(reply: BotConfigReply): InteractionReplyOptions {
  return {
    content: reply.content,
    components: reply.components.map((row) => new ActionRowBuilder<StringSelectMenuBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder>()
      .addComponents(row.components.map(toDiscordComponent))),
    ephemeral: true
  };
}

function toDiscordComponent(component: BotConfigComponentSpec) {
  if (component.type === 'STRING_SELECT') {
    return new StringSelectMenuBuilder().setCustomId(component.customId).setPlaceholder(component.placeholder).addOptions(component.options);
  }
  if (component.type === 'CHANNEL_SELECT') {
    return new ChannelSelectMenuBuilder().setCustomId(component.customId).setPlaceholder(component.placeholder).setChannelTypes(...component.channelTypes);
  }
  if (component.type === 'ROLE_SELECT') {
    return new RoleSelectMenuBuilder().setCustomId(component.customId).setPlaceholder(component.placeholder);
  }
  return new ButtonBuilder()
    .setCustomId(component.customId)
    .setLabel(component.label)
    .setStyle(component.style === 'PRIMARY' ? ButtonStyle.Primary : component.style === 'DANGER' ? ButtonStyle.Danger : ButtonStyle.Secondary);
}

function presentFieldPicker(session: BotConfigSession, snapshot: BotConfigSnapshot): BotConfigReply {
  const manageableFields = snapshot.manageableFields;
  const operational = manageableFields.filter((field) => isManageableField(field) && !isSecurityRoleField(field)).map((field) => ({ label: fieldLabel(field), value: field }));
  const security = manageableFields.filter(isSecurityRoleField).map((field) => ({ label: fieldLabel(field), value: field }));
  const components: BotConfigReply['components'] = [];
  if (operational.length) components.push({ components: [{ type: 'STRING_SELECT', customId: customId('field', session.id), placeholder: '选择运营配置字段', options: operational }] });
  if (security.length) components.push({ components: [{ type: 'STRING_SELECT', customId: customId('security', session.id), placeholder: '选择权限角色映射', options: security }] });
  return {
    content: [
      snapshot.businessEnvironment === 'SANDBOX' ? 'SANDBOX 测试环境 · 测试余额不代表真实资金' : null,
      `**Bot 配置${snapshot.displayRole ? ` · ${snapshot.displayRole}` : ''}**`,
      `当前版本 ${session.version}。请选择要修改的配置字段。`
    ].filter(Boolean).join('\n'),
    components,
    ephemeral: true
  };
}

function presentValuePicker(session: BotConfigSession): BotConfigReply {
  const field = session.selectedField as BotConfigManageableField;
  const component: BotConfigComponentSpec = isChannelField(field)
    ? { type: 'CHANNEL_SELECT', customId: customId('value', session.id), placeholder: `选择${fieldLabel(field)}`, channelTypes: channelTypesForField(field) }
    : isRoleField(field)
      ? { type: 'ROLE_SELECT', customId: customId('value', session.id), placeholder: `选择${fieldLabel(field)}` }
      : isBooleanField(field)
        ? { type: 'STRING_SELECT', customId: customId('value', session.id), placeholder: '选择开关状态', options: [{ label: '开启', value: 'true' }, { label: '关闭', value: 'false' }] }
        : { type: 'BUTTON', customId: customId('input', session.id), label: '填写新值', style: 'PRIMARY' };
  const rows: BotConfigReply['components'] = [{ components: [component] }];
  if (isNullableRoleField(field)) rows.push({ components: [{ type: 'BUTTON', customId: customId('clear', session.id), label: '清除当前角色', style: 'DANGER' }] });
  return {
    content: `**Bot 配置 · ${fieldLabel(field)}**\n当前值：${formatConfigValue(field, session.currentValue)}`,
    components: rows,
    ephemeral: true
  };
}

function presentPreview(session: BotConfigSession): BotConfigReply {
  const field = session.selectedField as BotConfigManageableField;
  const validation = session.validation as BotConfigValidationResult;
  const issues = [...validation.errors, ...validation.warnings].map((issue) => `- ${issue.message}`).join('\n');
  const buttons: BotConfigComponentSpec[] = [];
  if (isChannelField(field)) buttons.push({ type: 'BUTTON', customId: customId('test', session.id), label: '测试投递', style: 'SECONDARY' });
  if (validation.mayApply && validation.validationToken) buttons.push({ type: 'BUTTON', customId: customId('confirm', session.id), label: '确认应用', style: 'PRIMARY' });
  buttons.push({ type: 'BUTTON', customId: customId('cancel', session.id), label: '取消', style: 'DANGER' });
  return {
    content: `**Bot 配置变更预览**\n字段：${fieldLabel(field)}\n旧值：${formatConfigValue(field, session.currentValue)}\n新值：${formatConfigValue(field, session.proposedValue)}${issues ? `\n${issues}` : ''}`,
    components: [{ components: buttons }],
    ephemeral: true
  };
}

function presentSaved(snapshot: BotConfigSnapshot): BotConfigReply {
  return { content: `Bot 配置已应用并刷新缓存。当前版本 ${snapshot.version}。`, components: [], ephemeral: true };
}

function customId(operation: 'field' | 'security' | 'value' | 'input' | 'modal' | 'clear' | 'test' | 'confirm' | 'cancel', sessionId: string): string {
  return `bc:cfg:${operation}:${sessionId}`;
}

function isSelectableField(field: string): field is BotConfigSelectableField {
  return isChannelField(field) || (botConfigRoleFields as readonly string[]).includes(field);
}

function isManageableField(field:string):field is BotConfigManageableField{return isSelectableField(field)||isIntegerField(field)||isBooleanField(field)||isTextField(field);}
function isRoleField(field:string):field is BotConfigRoleField{return (botConfigRoleFields as readonly string[]).includes(field);}
function isSecurityRoleField(field:string):field is BotConfigRoleField{return ['player_role_id','companion_applicant_role_id','companion_role_id','staff_l1_role_id','staff_l2_role_id','staff_l3_role_id','staff_l4_role_id'].includes(field);}
function isNullableRoleField(field:string){return field==='staff_notification_role_id'||field==='operations_notification_role_id';}
function isIntegerField(field:string):field is typeof botConfigIntegerFields[number]{return (botConfigIntegerFields as readonly string[]).includes(field);}
function isBooleanField(field:string):field is typeof botConfigBooleanFields[number]{return (botConfigBooleanFields as readonly string[]).includes(field);}
function isTextField(field:string):field is typeof botConfigTextFields[number]{return (botConfigTextFields as readonly string[]).includes(field);}

function isChannelField(field: string): field is BotConfigChannelField {
  return (botConfigChannelFields as readonly string[]).includes(field);
}

function channelTypesForField(field: BotConfigChannelField): ChannelType[] {
  return field === 'private_order_category_id' || field === 'order_archive_category_id'
    ? [ChannelType.GuildCategory]
    : [ChannelType.GuildText, ChannelType.GuildAnnouncement];
}

function formatConfigValue(field: BotConfigManageableField, value: BotConfigValue | undefined): string {
  if (value === null || value === undefined || value === '') return '未设置';
  if (isChannelField(field)) return `<#${value}>`;
  if (isRoleField(field)) return `<@&${value}>`;
  if (isBooleanField(field)) return value ? '开启' : '关闭';
  return String(value);
}

function fieldLabel(field: BotConfigManageableField): string {
  const labels: Record<BotConfigManageableField, string> = {
    public_entry_channel_id: '新人入口频道',
    private_order_category_id: '私密订单频道分类',
    order_archive_category_id: '订单归档频道分类',
    dispatch_channel_id: '派单频道',
    player_workbench_channel_id: '陪玩工作台频道',
    gift_review_channel_id: '礼物审核频道',
    gift_broadcast_channel_id: '礼物播报频道',
    staff_task_channel_id: '客服任务频道',
    operations_alert_channel_id: '运营告警频道',
    player_role_id: '基础玩家角色',
    companion_applicant_role_id: '待审核陪玩申请人角色（可选）',
    companion_role_id: '已批准陪玩角色',
    staff_l1_role_id: 'L1 客服角色',
    staff_l2_role_id: 'L2 客服主管角色',
    staff_l3_role_id: 'L3 运营负责人角色',
    staff_l4_role_id: 'L4 管理员/所有者角色',
    staff_notification_role_id: '客服通知角色',
    operations_notification_role_id: '运营通知角色',
    dispatch_timeout_minutes: '派单超时时间（分钟）',
    dispatch_max_rounds: '派单最大轮次',
    readiness_timeout_minutes: '就绪确认超时时间（分钟）',
    completion_confirmation_minutes: '完单确认时限（分钟）',
    gift_review_reminder_minutes: '礼物审核提醒间隔（分钟）',
    channel_archive_after_completion_minutes: '完单后频道归档时间（分钟）',
    new_orders_enabled: '允许新订单',
    auto_dispatch_enabled: '启用自动派单',
    gift_requests_enabled: '允许礼物申请',
    maintenance_notice: '启用维护公告',
    gift_broadcast_template: '礼物播报模板'
  };
  return labels[field];
}

function parseIntegerInput(raw:string){if(!/^(?:0|[1-9][0-9]{0,5})$/u.test(raw.trim()))throw new Error('请输入有效整数。');return Number(raw.trim());}

export const botConfigApi = new HttpBotConfigApiClient({
  apiBaseUrl: process.env.API_BASE_URL ?? '',
  botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
});
export const botConfigCache = new BotConfigCache();
export const botConfigSessions = new BotConfigSessionStore();
export const botConfigFlow = new BotConfigFlow({ api: botConfigApi, cache: botConfigCache, sessions: botConfigSessions });
