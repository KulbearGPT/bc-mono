import { type GuildBotActorContext } from './actor-context.js';

export const botConfigChannelFields = [
  'public_entry_channel_id',
  'private_order_category_id',
  'order_archive_category_id',
  'dispatch_channel_id',
  'player_workbench_channel_id',
  'gift_review_channel_id',
  'gift_broadcast_channel_id',
  'gift_entry_channel_id',
  'review_broadcast_channel_id',
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

export const botConfigBooleanFields = ['new_orders_enabled', 'gift_requests_enabled', 'maintenance_notice'] as const;
export const botConfigTextFields = ['gift_broadcast_template'] as const;

export type BotConfigChannelField = (typeof botConfigChannelFields)[number];
export type BotConfigRoleField = (typeof botConfigRoleFields)[number];
export type BotConfigSelectableField = BotConfigChannelField | BotConfigRoleField;
export type BotConfigScalarField =
  | (typeof botConfigIntegerFields)[number]
  | (typeof botConfigBooleanFields)[number]
  | (typeof botConfigTextFields)[number];
export type BotConfigManageableField = BotConfigSelectableField | BotConfigScalarField;
export type BotConfigValue = string | number | boolean | null;
export type BotConfigValues = Partial<Record<string, BotConfigValue>>;

export interface BotConfigActorContext extends GuildBotActorContext {
  discordUserId?: string;
  interactionId?: string;
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

export interface WelcomeDmContext {
  guildId: string;
  publicEntryChannelId: string | null;
}

export interface BotConfigApiClient {
  getBotConfig(guildId: string, actor: BotConfigActorContext): Promise<BotConfigSnapshot>;
  getWelcomeDmContext(
    guildId: string,
    targetDiscordUserId: string,
    actor: BotConfigActorContext
  ): Promise<WelcomeDmContext>;
  validateBotConfigChange(
    input: BotConfigChangeRequest,
    actor: BotConfigActorContext,
    idempotencyKey: string
  ): Promise<BotConfigValidationResult>;
  updateBotConfig(
    input: BotConfigChangeRequest & { validationToken: string },
    actor: BotConfigActorContext,
    idempotencyKey: string
  ): Promise<BotConfigUpdateResult>;
  testBotConfigDelivery(
    input: {
      guildId: string;
      expectedVersion: number;
      channelField: BotConfigChannelField;
      channelId: string;
      reason: string;
    },
    actor: BotConfigActorContext,
    idempotencyKey: string
  ): Promise<BotConfigDeliveryTestResult>;
}
