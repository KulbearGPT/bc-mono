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
import {
  botConfigChannelFields,
  botConfigRoleFields,
  botConfigIntegerFields,
  botConfigBooleanFields,
  botConfigTextFields,
  BotConfigChannelField,
  BotConfigRoleField,
  BotConfigSelectableField,
  BotConfigManageableField,
  BotConfigValue,
  BotConfigActorContext,
  BotConfigSnapshot,
  BotConfigValidationResult,
  BotConfigApiClient
} from './bot-config-contracts.js';
import { BotConfigCache, BotConfigSession, BotConfigSessionStore } from './bot-config-state.js';

export type BotConfigComponentSpec =
  | {
      type: 'STRING_SELECT';
      customId: string;
      placeholder: string;
      options: Array<{ label: string; value: string }>;
    }
  | {
      type: 'CHANNEL_SELECT';
      customId: string;
      placeholder: string;
      channelTypes: ChannelType[];
    }
  | { type: 'ROLE_SELECT'; customId: string; placeholder: string }
  | {
      type: 'BUTTON';
      customId: string;
      label: string;
      style: 'PRIMARY' | 'SECONDARY' | 'DANGER';
    };

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
    const snapshot = this.cache.get(actor.guildId);
    if (!snapshot?.manageableFields.includes(field) || !isManageableField(field)) {
      throw new Error('The selected Bot config field is not manageable in this session.');
    }
    session.selectedField = field;
    session.currentValue = snapshot.values[field];
    session.proposedValue = undefined;
    session.validation = undefined;
    return presentValuePicker(session);
  }

  public async previewValue(
    actor: BotConfigActorContext,
    sessionId: string,
    value: BotConfigValue,
    idempotencyKey: string
  ): Promise<BotConfigReply> {
    const session = this.sessions.require(actor, sessionId);
    if (!session.selectedField) throw new Error('Select a Bot config field first.');
    const reason = `Discord /bot-config update: ${session.selectedField}`;
    const validation = await this.api.validateBotConfigChange(
      {
        guildId: session.guildId,
        expectedVersion: session.version,
        changes: { [session.selectedField]: value },
        reason
      },
      actor,
      idempotencyKey
    );
    session.proposedValue = value;
    session.validation = validation;
    session.reason = reason;
    return presentPreview(session);
  }

  public async confirm(
    actor: BotConfigActorContext,
    sessionId: string,
    idempotencyKey: string
  ): Promise<BotConfigReply> {
    const session = this.sessions.require(actor, sessionId);
    const validationToken = session.validation?.validationToken;
    if (
      !session.selectedField ||
      session.proposedValue === undefined ||
      !session.reason ||
      !session.validation?.mayApply ||
      !validationToken
    ) {
      throw new Error('A successful Bot config preview is required before confirmation.');
    }
    const result = await this.api.updateBotConfig(
      {
        guildId: session.guildId,
        expectedVersion: session.version,
        changes: session.validation.normalizedChanges,
        reason: session.reason,
        validationToken
      },
      actor,
      idempotencyKey
    );

    this.cache.set({
      ...(this.cache.get(session.guildId) as BotConfigSnapshot),
      version: result.version,
      values: {
        ...(this.cache.get(session.guildId)?.values ?? {}),
        ...session.validation.normalizedChanges
      },
      updatedAt: result.updatedAt
    });
    const refreshed = await this.api.getBotConfig(session.guildId, actor);
    this.cache.set(refreshed);
    this.sessions.delete(sessionId);
    return presentSaved(refreshed);
  }

  public async testDelivery(
    actor: BotConfigActorContext,
    sessionId: string,
    idempotencyKey: string
  ): Promise<BotConfigReply> {
    const session = this.sessions.require(actor, sessionId);
    if (!session.selectedField || !isChannelField(session.selectedField) || typeof session.proposedValue !== 'string') {
      throw new Error('A channel preview is required before testing delivery.');
    }
    const result = await this.api.testBotConfigDelivery(
      {
        guildId: session.guildId,
        expectedVersion: session.version,
        channelField: session.selectedField,
        channelId: session.proposedValue,
        reason: `Discord /bot-config delivery test: ${session.selectedField}`
      },
      actor,
      idempotencyKey
    );
    return {
      ...presentPreview(session),
      content: `${presentPreview(session).content}\n\n${result.delivered ? '频道预览已送达。' : '频道预览发送失败。'}`
    };
  }

  public cancel(actor: BotConfigActorContext, sessionId: string): BotConfigReply {
    this.sessions.require(actor, sessionId);
    this.sessions.delete(sessionId);
    return {
      content: '已取消本次服务器配置修改。',
      components: [],
      ephemeral: true
    };
  }

  public describeTextInput(actor: BotConfigActorContext, sessionId: string) {
    const field = this.sessions.require(actor, sessionId).selectedField;
    if (!field || (!isIntegerField(field) && !isTextField(field)))
      throw new Error('This field does not use text input.');
    return {
      field,
      title: `修改 ${fieldLabel(field)}`,
      label: isIntegerField(field) ? '请输入整数' : '请输入播报模板',
      paragraph: isTextField(field)
    };
  }

  public previewTextInput(actor: BotConfigActorContext, sessionId: string, rawValue: string, idempotencyKey: string) {
    const field = this.sessions.require(actor, sessionId).selectedField;
    if (!field || (!isIntegerField(field) && !isTextField(field)))
      throw new Error('This field does not use text input.');
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

export function parseBotConfigCustomId(customId: string): {
  operation: 'field' | 'security' | 'value' | 'input' | 'modal' | 'clear' | 'test' | 'confirm' | 'cancel';
  sessionId: string;
} | null {
  const match = /^bc:cfg:(field|security|value|input|modal|clear|test|confirm|cancel):([A-Za-z0-9_-]{8,16})$/u.exec(
    customId
  );
  return match
    ? {
        operation: match[1] as
          'field' | 'security' | 'value' | 'input' | 'modal' | 'clear' | 'test' | 'confirm' | 'cancel',
        sessionId: match[2]
      }
    : null;
}

export function toDiscordBotConfigReply(reply: BotConfigReply): InteractionReplyOptions {
  return {
    content: reply.content,
    components: reply.components.map((row) =>
      new ActionRowBuilder<
        StringSelectMenuBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder | ButtonBuilder
      >().addComponents(row.components.map(toDiscordComponent))
    ),
    ephemeral: true
  };
}

function toDiscordComponent(component: BotConfigComponentSpec) {
  if (component.type === 'STRING_SELECT') {
    return new StringSelectMenuBuilder()
      .setCustomId(component.customId)
      .setPlaceholder(component.placeholder)
      .addOptions(component.options);
  }
  if (component.type === 'CHANNEL_SELECT') {
    return new ChannelSelectMenuBuilder()
      .setCustomId(component.customId)
      .setPlaceholder(component.placeholder)
      .setChannelTypes(...component.channelTypes);
  }
  if (component.type === 'ROLE_SELECT') {
    return new RoleSelectMenuBuilder().setCustomId(component.customId).setPlaceholder(component.placeholder);
  }
  return new ButtonBuilder()
    .setCustomId(component.customId)
    .setLabel(component.label)
    .setStyle(
      component.style === 'PRIMARY'
        ? ButtonStyle.Primary
        : component.style === 'DANGER'
          ? ButtonStyle.Danger
          : ButtonStyle.Secondary
    );
}

function presentFieldPicker(session: BotConfigSession, snapshot: BotConfigSnapshot): BotConfigReply {
  const manageableFields = snapshot.manageableFields;
  const operational = manageableFields
    .filter((field) => isManageableField(field) && !isSecurityRoleField(field))
    .map((field) => ({ label: fieldLabel(field), value: field }));
  const security = manageableFields
    .filter(isSecurityRoleField)
    .map((field) => ({ label: fieldLabel(field), value: field }));
  const components: BotConfigReply['components'] = [];
  if (operational.length)
    components.push({
      components: [
        {
          type: 'STRING_SELECT',
          customId: customId('field', session.id),
          placeholder: '选择运营配置字段',
          options: operational
        }
      ]
    });
  if (security.length)
    components.push({
      components: [
        {
          type: 'STRING_SELECT',
          customId: customId('security', session.id),
          placeholder: '选择权限角色映射',
          options: security
        }
      ]
    });
  return {
    content: [
      snapshot.businessEnvironment === 'SANDBOX' ? '⚠️ 当前余额不代表真实资金，任何操作均不会产生真实收付款' : null,
      `**服务器配置${snapshot.displayRole ? ` · ${snapshot.displayRole}` : ''}**`,
      `配置修订号 ${session.version}。请选择要修改的配置项。`
    ]
      .filter(Boolean)
      .join('\n'),
    components,
    ephemeral: true
  };
}

function presentValuePicker(session: BotConfigSession): BotConfigReply {
  const field = session.selectedField as BotConfigManageableField;
  const component: BotConfigComponentSpec = isChannelField(field)
    ? {
        type: 'CHANNEL_SELECT',
        customId: customId('value', session.id),
        placeholder: `选择${fieldLabel(field)}`,
        channelTypes: channelTypesForField(field)
      }
    : isRoleField(field)
      ? {
          type: 'ROLE_SELECT',
          customId: customId('value', session.id),
          placeholder: `选择${fieldLabel(field)}`
        }
      : isBooleanField(field)
        ? {
            type: 'STRING_SELECT',
            customId: customId('value', session.id),
            placeholder: '选择开关状态',
            options: [
              { label: '开启', value: 'true' },
              { label: '关闭', value: 'false' }
            ]
          }
        : {
            type: 'BUTTON',
            customId: customId('input', session.id),
            label: '填写新值',
            style: 'PRIMARY'
          };
  const rows: BotConfigReply['components'] = [{ components: [component] }];
  if (isNullableRoleField(field))
    rows.push({
      components: [
        {
          type: 'BUTTON',
          customId: customId('clear', session.id),
          label: '清除当前角色',
          style: 'DANGER'
        }
      ]
    });
  return {
    content: `**服务器配置 · ${fieldLabel(field)}**\n当前值：${formatConfigValue(field, session.currentValue)}`,
    components: rows,
    ephemeral: true
  };
}

function presentPreview(session: BotConfigSession): BotConfigReply {
  const field = session.selectedField as BotConfigManageableField;
  const validation = session.validation as BotConfigValidationResult;
  const issues = [...validation.errors, ...validation.warnings].map((issue) => `- ${issue.message}`).join('\n');
  const buttons: BotConfigComponentSpec[] = [];
  if (isChannelField(field))
    buttons.push({
      type: 'BUTTON',
      customId: customId('test', session.id),
      label: '发送频道预览',
      style: 'SECONDARY'
    });
  if (validation.mayApply && validation.validationToken)
    buttons.push({
      type: 'BUTTON',
      customId: customId('confirm', session.id),
      label: '确认应用',
      style: 'PRIMARY'
    });
  buttons.push({
    type: 'BUTTON',
    customId: customId('cancel', session.id),
    label: '取消',
    style: 'DANGER'
  });
  return {
    content: `**服务器配置变更预览**\n配置项：${fieldLabel(field)}\n旧值：${formatConfigValue(field, session.currentValue)}\n新值：${formatConfigValue(field, session.proposedValue)}${issues ? `\n${issues}` : ''}`,
    components: [{ components: buttons }],
    ephemeral: true
  };
}

function presentSaved(snapshot: BotConfigSnapshot): BotConfigReply {
  return {
    content: `服务器配置已应用。配置修订号 ${snapshot.version}。`,
    components: [],
    ephemeral: true
  };
}

function customId(
  operation: 'field' | 'security' | 'value' | 'input' | 'modal' | 'clear' | 'test' | 'confirm' | 'cancel',
  sessionId: string
): string {
  return `bc:cfg:${operation}:${sessionId}`;
}

function isSelectableField(field: string): field is BotConfigSelectableField {
  return isChannelField(field) || (botConfigRoleFields as readonly string[]).includes(field);
}

function isManageableField(field: string): field is BotConfigManageableField {
  return isSelectableField(field) || isIntegerField(field) || isBooleanField(field) || isTextField(field);
}
function isRoleField(field: string): field is BotConfigRoleField {
  return (botConfigRoleFields as readonly string[]).includes(field);
}
function isSecurityRoleField(field: string): field is BotConfigRoleField {
  return [
    'player_role_id',
    'companion_applicant_role_id',
    'companion_role_id',
    'staff_l1_role_id',
    'staff_l2_role_id',
    'staff_l3_role_id',
    'staff_l4_role_id'
  ].includes(field);
}
function isNullableRoleField(field: string) {
  return field === 'staff_notification_role_id' || field === 'operations_notification_role_id';
}
function isIntegerField(field: string): field is (typeof botConfigIntegerFields)[number] {
  return (botConfigIntegerFields as readonly string[]).includes(field);
}
function isBooleanField(field: string): field is (typeof botConfigBooleanFields)[number] {
  return (botConfigBooleanFields as readonly string[]).includes(field);
}
function isTextField(field: string): field is (typeof botConfigTextFields)[number] {
  return (botConfigTextFields as readonly string[]).includes(field);
}

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
    public_entry_channel_id: '玩家入口频道（注册 / 下单）',
    private_order_category_id: '私密订单频道分类',
    order_archive_category_id: '订单归档频道分类',
    dispatch_channel_id: '派单频道',
    player_workbench_channel_id: '陪玩工作台频道',
    gift_review_channel_id: '礼物审核频道',
    gift_broadcast_channel_id: '礼物播报频道',
    gift_entry_channel_id: '独立送礼入口频道',
    review_broadcast_channel_id: '好评展示频道',
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
    channel_archive_after_completion_minutes: '订单终态后频道清理等待（分钟）',
    new_orders_enabled: '允许新订单',
    gift_requests_enabled: '允许礼物申请',
    maintenance_notice: '启用维护公告',
    gift_broadcast_template: '礼物播报模板'
  };
  return labels[field];
}

function parseIntegerInput(raw: string) {
  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(raw.trim())) throw new Error('请输入有效整数。');
  return Number(raw.trim());
}

export const botConfigCache = new BotConfigCache();
