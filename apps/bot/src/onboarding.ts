import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild, type MessageEditOptions } from 'discord.js';
import type { DiscordBotActorContext } from './actor-context.js';
import { BotApiTransport, BotApiTransportError } from './api-transport.js';
import { BOT_COPY } from './bot-copy.js';

export const REGISTER_PLAYER_CUSTOM_ID = 'onboarding:register-player:v1';
export const APPLY_COMPANION_CUSTOM_ID = 'onboarding:apply-companion:v1';
export const ONBOARDING_RENDERED_VERSION = 2;

export interface OnboardingActor extends DiscordBotActorContext {
  displayName: string;
}
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
export interface OnboardingMessageProjection {
  guildId: string;
  channelId: string;
  messageId: string | null;
  renderedVersion: number;
  updatedAt: string;
}
export interface DiscordProductRoleTask {
  id: string;
  guildId: string;
  discordUserId: string;
  roleId: string;
  action: 'ADD' | 'REMOVE';
  status: 'PENDING' | 'FAILED';
  attemptCount: number;
}

export class OnboardingApiError extends Error {
  constructor(
    readonly code: string,
    readonly requestId: string,
    message: string,
    readonly statusCode = 500
  ) {
    super(message);
    this.name = 'OnboardingApiError';
  }
}

export class HttpOnboardingApiClient {
  private readonly transport: BotApiTransport;
  constructor(input: {
    apiBaseUrl: string;
    botServiceToken: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    transport?: BotApiTransport;
  }) {
    this.transport = input.transport ?? new BotApiTransport(input);
  }
  registerPlayer(actor: OnboardingActor) {
    return this.actorRequest<PlayerRegistrationResult>('/api/v1/me/player-registration', actor);
  }
  applyForCompanion(actor: OnboardingActor) {
    return this.actorRequest<CompanionApplicationResult>('/api/v1/me/companion-application', actor);
  }
  async getMessage(guildId: string) {
    return this.request<OnboardingMessageProjection | null>(
      `/api/v1/internal/onboarding-message?guildId=${encodeURIComponent(guildId)}`,
      { method: 'GET' }
    );
  }
  async saveMessage(value: Omit<OnboardingMessageProjection, 'updatedAt'>) {
    return this.request<OnboardingMessageProjection>('/api/v1/internal/onboarding-message', {
      method: 'PUT',
      body: value,
      idempotencyKey: `onboarding-message:${value.guildId}:${value.channelId}:${value.messageId ?? 'none'}:v${value.renderedVersion}`
    });
  }
  async listRoleTasks(guildId: string) {
    return this.request<DiscordProductRoleTask[]>(
      `/api/v1/internal/product-role-tasks?guildId=${encodeURIComponent(guildId)}`,
      { method: 'GET' }
    );
  }
  async completeRoleTask(taskId: string, applied: boolean, errorCode: string | null) {
    return this.request<{ taskId: string; status: 'APPLIED' | 'FAILED' }>(
      `/api/v1/internal/product-role-tasks/${encodeURIComponent(taskId)}/result`,
      {
        method: 'POST',
        body: { applied, errorCode },
        idempotencyKey: `product-role-task:${taskId}:${applied ? 'applied' : `failed:${errorCode}`}`
      }
    );
  }
  private actorRequest<T>(path: string, actor: OnboardingActor) {
    return this.request<T>(path, {
      method: 'POST',
      body: { displayName: actor.displayName },
      idempotencyKey: `discord:onboarding:${actor.interactionId}`,
      actor
    });
  }
  private async request<T>(
    path: string,
    input: { method: 'GET' | 'POST' | 'PUT'; body?: unknown; idempotencyKey?: string; actor?: OnboardingActor }
  ): Promise<T> {
    try {
      return await this.transport.request<T>(path, input);
    } catch (error) {
      if (!(error instanceof BotApiTransportError)) throw error;
      throw new OnboardingApiError(error.code, error.requestId, error.message, error.statusCode);
    }
  }
}

export async function reconcileProductRoleTasks(input: {
  guild: Guild;
  api: HttpOnboardingApiClient;
}): Promise<{ applied: number; failed: number }> {
  const tasks = await input.api.listRoleTasks(input.guild.id);
  let applied = 0;
  let failed = 0;
  for (const task of tasks) {
    try {
      const member = await input.guild.members.fetch(task.discordUserId);
      if (task.action === 'ADD') await member.roles.add(task.roleId, 'Blackcat product role reconciliation');
      else await member.roles.remove(task.roleId, 'Blackcat product role reconciliation');
      await input.api.completeRoleTask(task.id, true, null);
      applied += 1;
    } catch (error) {
      const code = error instanceof Error ? error.name : 'DISCORD_ROLE_SYNC_FAILED';
      await input.api.completeRoleTask(task.id, false, code.slice(0, 100)).catch(() => undefined);
      failed += 1;
    }
  }
  return { applied, failed };
}

export function buildOnboardingMessage(): MessageEditOptions {
  return {
    content: BOT_COPY.onboarding.welcome,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(REGISTER_PLAYER_CUSTOM_ID).setLabel('注册为玩家').setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(APPLY_COMPANION_CUSTOM_ID)
          .setLabel('申请成为陪玩')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('bc:entry:create-order').setLabel('开始找陪玩').setStyle(ButtonStyle.Success)
      )
    ],
    allowedMentions: { parse: [] }
  };
}

export async function ensureOnboardingMessage(input: {
  guild: Guild;
  channelId: string;
  api: HttpOnboardingApiClient;
}): Promise<{ messageId: string; created: boolean }> {
  const channel = await input.guild.channels.fetch(input.channelId);
  if (!channel || !channel.isTextBased() || !('messages' in channel))
    throw new Error(BOT_COPY.onboarding.invalidEntryChannel);
  const projection = await input.api.getMessage(input.guild.id);
  const payload = buildOnboardingMessage();
  let message = null;
  if (projection?.channelId === input.channelId && projection.messageId) {
    message = await channel.messages.fetch(projection.messageId).catch(() => null);
  }
  const created = !message;
  if (message) await message.edit(payload);
  else
    message = await channel.send({
      content: payload.content ?? undefined,
      components: payload.components,
      allowedMentions: payload.allowedMentions
    });
  await input.api.saveMessage({
    guildId: input.guild.id,
    channelId: input.channelId,
    messageId: message.id,
    renderedVersion: ONBOARDING_RENDERED_VERSION
  });
  return { messageId: message.id, created };
}

export const onboardingApi = new HttpOnboardingApiClient({
  apiBaseUrl: process.env.API_BASE_URL ?? '',
  botServiceToken: process.env.BOT_SERVICE_TOKEN ?? ''
});
