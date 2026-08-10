import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ButtonInteraction, Guild, Message, StringSelectMenuInteraction } from 'discord.js';
import { buildExperienceMessage } from './discord-experience.js';
import { toDiscordReply, toDiscordUpdate } from './discord-renderer.js';
import { buildDiscordIdempotencyKey, type BotActorContext, type BotApiClient } from './service-center-api.js';
import type { MessageSpec } from './service-center-components.js';
import type { ServiceCenterRoute } from './service-center-routes.js';
import { formatUserFacingError } from './user-facing-error.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, formatCustomerWalletAmount } from './wallet-display.js';

export const STANDALONE_GIFT_ENTRY_CUSTOM_ID = 'bc:g2:o';
export const STANDALONE_GIFT_ENTRY_RENDERED_VERSION = 1;

export interface StandaloneGiftCenterData {
  recipients: Array<{ playerProfileId: string; displayName: string; discordUserId?: string }>;
  items: Array<{
    id: string;
    code: string;
    name: string;
    version: number;
    priceMinor: number;
    currency: 'CAT';
    affordable: boolean;
  }>;
  balance: StandaloneGiftBalance;
}
export interface StandaloneGiftBalance {
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: 'CAT';
  calculatedAt: string;
}
export interface StandaloneGiftAffordabilityData {
  playerProfileId: string;
  giftCatalogVersionId: string;
  catalogVersion: number;
  priceMinor: number;
  recipientCount: 1;
  totalPriceMinor: number;
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  shortfallMinor: number;
  currency: 'CAT';
  calculatedAt: string;
  stale: boolean;
  canAfford: boolean;
  topUpInstructions: string;
}
export interface StandaloneGiftRequestData {
  origin: 'STANDALONE';
  senderVisibility: 'PUBLIC' | 'ANONYMOUS';
  orderId: null;
  playerProfileId: string;
  receiverId: string;
  id: string;
  publicId: string;
  status: 'PENDING_REVIEW';
  expiresAt: string;
  gift: { code: string; name: string; priceMinor: number; currency: 'CAT' };
  reservation: { id: string; status: string; amountMinor: number; currency: 'CAT'; expiresAt: string };
  staffTask: { id: string; publicId: string; type: 'GIFT_REVIEW'; status: string };
  balance: StandaloneGiftBalance;
}
export interface StandaloneGiftContinuationContext {
  playerProfileId: string;
  giftCatalogVersionId: string;
  catalogVersion: number;
  priceMinor: number;
}
export interface GiftEntryMessageProjection {
  guildId: string;
  channelId: string;
  messageId: string | null;
  renderedVersion: number;
  updatedAt: string;
}
export interface GiftEntryMessageApi {
  getGiftEntryMessage(guildId: string): Promise<GiftEntryMessageProjection | null>;
  saveGiftEntryMessage(value: Omit<GiftEntryMessageProjection, 'updatedAt'>): Promise<GiftEntryMessageProjection>;
}

export function buildStandaloneGiftEntryMessage(): MessageSpec {
  return buildExperienceMessage({
    title: '🎁 随时给陪玩送份心意',
    icon: '🐈‍⬛',
    introduction: '不需要绑定订单，选一位陪玩和一份礼物即可开始。陪玩、余额和价格都会在私密界面里实时读取。',
    visibility: 'PUBLIC',
    density: 'PUBLIC_WELCOME',
    tone: 'BRAND',
    coreFacts: [
      { name: '🎁 送礼流程', value: '选陪玩 → 选礼物 → 公开或匿名确认' },
      { name: '🐟 猫条不足', value: '不会创建礼物或扣款；充值后可以原路刷新。' },
      { name: '🕶️ 匿名可选', value: '陪玩和公开播报只看到“匿名老板”，内部资金与审计仍可追踪。' }
    ],
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'PRIMARY', customId: STANDALONE_GIFT_ENTRY_CUSTOM_ID, label: '🎁 送礼物' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:profile:open', label: '🐟 查看猫条' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:service-center:recharge', label: '充值帮助' }
        ]
      }
    ]
  });
}

export function buildStandaloneGiftRecipientMessage(data: StandaloneGiftCenterData): MessageSpec {
  return {
    title: '🎁 选择收到礼物的陪玩',
    body: data.recipients.length
      ? '只显示当前同服务器且通过审核的陪玩。本次只选一位，下一步再选礼物。'
      : '当前没有可选的陪玩，请稍后再试。',
    visibility: 'EPHEMERAL',
    tone: data.recipients.length ? 'BRAND' : 'WAITING',
    density: 'EPHEMERAL_FEEDBACK',
    fields: [{ name: '🐟 当前可用猫条', value: giftAmount(data.balance.availableMinor) }],
    components: data.recipients.length
      ? [
          {
            type: 'ACTION_ROW',
            components: [
              {
                type: 'STRING_SELECT',
                customId: 'bc:g2:r',
                placeholder: '选择一位陪玩',
                minValues: 1,
                maxValues: 1,
                options: data.recipients.slice(0, 25).map((recipient) => ({
                  label: recipient.displayName.slice(0, 100),
                  value: recipient.playerProfileId
                }))
              }
            ]
          }
        ]
      : []
  };
}

export function buildStandaloneGiftCatalogMessage(
  data: StandaloneGiftCenterData,
  playerProfileId: string,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): MessageSpec {
  const recipient = requireRecipient(data, playerProfileId);
  if (data.items.length > 25) throw new Error('Gift catalog exceeds the Discord component limit.');
  return {
    title: `🎁 给 ${recipient.displayName} 选一份礼物`,
    body: '选定后会读取最新价格和可用猫条，但不会直接提交。',
    visibility: 'EPHEMERAL',
    tone: 'BRAND',
    density: 'EPHEMERAL_FEEDBACK',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'STRING_SELECT',
            customId: 'bc:g2:g',
            placeholder: '选择一份礼物',
            minValues: 1,
            maxValues: 1,
            options: data.items.map((item) => ({
              label: `${item.name} · ${giftAmount(item.priceMinor)}`.slice(0, 100),
              value: createStandaloneGiftContinuationToken(
                {
                  playerProfileId,
                  giftCatalogVersionId: item.id,
                  catalogVersion: item.version,
                  priceMinor: item.priceMinor
                },
                actor,
                secret,
                now
              )
            }))
          }
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [{ type: 'BUTTON', style: 'SECONDARY', customId: 'bc:g2:b', label: '← 重选陪玩' }]
      }
    ]
  };
}

export function buildStandaloneGiftAffordabilityMessage(
  data: StandaloneGiftAffordabilityData,
  token: string,
  recipientName: string,
  giftName: string
): MessageSpec {
  const ready = data.canAfford && !data.stale;
  return buildExperienceMessage({
    title: ready ? '确认这份礼物心意' : data.stale ? '🐟 猫条需要刷新' : '🐟 猫条余额不足',
    icon: ready ? '🎁' : '🐟',
    introduction: ready
      ? '陪玩、礼物和金额已核对好。请直接选择公开或匿名赠送。'
      : '本次礼物尚未提交，也没有建立新的资金预留。',
    visibility: 'EPHEMERAL',
    density: 'HIGH_RISK',
    tone: ready ? 'INFO' : 'DANGER',
    coreFacts: [
      { name: '🎁 赠送内容', value: `${giftName} → ${recipientName}` },
      {
        name: '🐟 资金核对',
        value: ready ? `确认后将预留：${giftAmount(data.totalPriceMinor)}` : `还差：${giftAmount(data.shortfallMinor)}`
      }
    ],
    progress: ready ? '尚未预留或扣除，等待最终确认。' : '资金状态未改变。',
    nextStep: ready ? '选择公开或匿名赠送；提交后由猫舍前台核对。' : `${data.topUpInstructions} 完成后点击刷新。`,
    components: [
      ...(ready
        ? [
            {
              type: 'ACTION_ROW' as const,
              components: [
                {
                  type: 'BUTTON' as const,
                  style: 'PRIMARY' as const,
                  customId: standaloneActionId('confirm-public', token),
                  label: '公开赠送'
                },
                {
                  type: 'BUTTON' as const,
                  style: 'SECONDARY' as const,
                  customId: standaloneActionId('confirm-anonymous', token),
                  label: '🕶️ 匿名赠送'
                }
              ]
            }
          ]
        : []),
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'SECONDARY', customId: standaloneActionId('refresh', token), label: '🔄 刷新余额' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:service-center:recharge', label: '充值帮助' },
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:g2:b', label: '← 重新选择' }
        ]
      }
    ]
  });
}

export function buildStandaloneGiftRequestMessage(data: StandaloneGiftRequestData): MessageSpec {
  return buildExperienceMessage({
    title: data.senderVisibility === 'ANONYMOUS' ? '🕶️ 匿名礼物已送达猫舍前台' : '🎁 礼物已送达猫舍前台',
    icon: '🎁',
    introduction: '这份心意已经登记，猫舍前台会按既有流程核对。',
    visibility: 'EPHEMERAL',
    density: 'EPHEMERAL_FEEDBACK',
    tone: 'WAITING',
    coreFacts: [
      {
        name: '🎁 礼物',
        value: `${data.gift.name} · ${data.senderVisibility === 'ANONYMOUS' ? '匿名展示' : '公开展示'}`
      },
      { name: '🐟 资金状态', value: `已预留：${giftAmount(data.reservation.amountMinor)}；尚未正式扣除` }
    ],
    progress: '等待猫舍前台核对；通过并完成捕获后才会正式送达。',
    nextStep: '无需重复提交。',
    components: []
  });
}

export function createStandaloneGiftContinuationToken(
  context: StandaloneGiftContinuationContext,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): string {
  if (secret.length < 32) throw new Error('Gift continuation signing secret must be at least 32 characters.');
  const payload = Buffer.alloc(52);
  uuidBytes(context.playerProfileId).copy(payload, 0);
  uuidBytes(context.giftCatalogVersionId).copy(payload, 16);
  payload.writeUInt16BE(context.catalogVersion, 32);
  payload.writeUIntBE(context.priceMinor, 34, 6);
  payload.writeUInt32BE(Math.floor(now.getTime() / 1000) + 1_800, 40);
  actorDigest(actor, secret).copy(payload, 44);
  payload.writeUInt16BE(1, 50);
  return `s1_${Buffer.concat([payload, tokenSignature(payload, secret)]).toString('base64url')}`;
}

export function readStandaloneGiftContinuationToken(
  token: string,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): StandaloneGiftContinuationContext {
  if (!/^s1_[A-Za-z0-9_-]{80}$/u.test(token)) throw new Error('Standalone gift continuation context is invalid.');
  const bytes = Buffer.from(token.slice(3), 'base64url');
  const payload = bytes.subarray(0, 52);
  const actual = bytes.subarray(52);
  if (
    bytes.length !== 60 ||
    payload.readUInt16BE(50) !== 1 ||
    !timingSafeEqual(actual, tokenSignature(payload, secret)) ||
    !timingSafeEqual(payload.subarray(44, 50), actorDigest(actor, secret))
  )
    throw new Error('Standalone gift continuation context is invalid.');
  if (payload.readUInt32BE(40) < Math.floor(now.getTime() / 1000))
    throw new Error('Standalone gift continuation context expired.');
  return {
    playerProfileId: uuidString(payload.subarray(0, 16)),
    giftCatalogVersionId: uuidString(payload.subarray(16, 32)),
    catalogVersion: payload.readUInt16BE(32),
    priceMinor: payload.readUIntBE(34, 6)
  };
}

export async function ensureStandaloneGiftEntryMessage(input: {
  guild: Guild;
  channelId: string;
  api: GiftEntryMessageApi;
}): Promise<{ messageId: string; created: boolean; removedDuplicates: number; pinned: boolean }> {
  const channel = await input.guild.channels.fetch(input.channelId);
  if (!channel || !channel.isTextBased() || !('messages' in channel) || !('send' in channel))
    throw new Error('The configured standalone gift entry channel is unavailable.');
  const projection = await input.api.getGiftEntryMessage(input.guild.id);
  const payload = toDiscordReply(buildStandaloneGiftEntryMessage());
  let projected: Message | null = null;
  if (projection?.channelId === input.channelId && projection.messageId)
    projected = await channel.messages
      .fetch({ message: projection.messageId, cache: false, force: true })
      .catch(() => null);
  if (projection && projection.channelId !== input.channelId && projection.messageId) {
    const previousChannel = await input.guild.channels.fetch(projection.channelId).catch(() => null);
    if (previousChannel?.isTextBased() && 'messages' in previousChannel) {
      const previous = await previousChannel.messages
        .fetch({ message: projection.messageId, cache: false, force: true })
        .catch(() => null);
      await previous?.delete().catch(() => undefined);
    }
  }
  const recent = await channel.messages.fetch({ limit: 100 });
  const candidates = [...recent.values()].filter(
    (message) => message.author.id === input.guild.client.user?.id && isStandaloneGiftEntryMessage(message)
  );
  let message = projected ?? candidates[0] ?? null;
  const created = !message;
  if (message)
    await message.edit({ embeds: payload.embeds, components: payload.components, allowedMentions: { parse: [] } });
  else
    message = await channel.send({
      embeds: payload.embeds,
      components: payload.components,
      allowedMentions: { parse: [] }
    });
  let removedDuplicates = 0;
  for (const duplicate of candidates) {
    if (duplicate.id === message.id) continue;
    await duplicate.delete().catch(() => undefined);
    removedDuplicates += 1;
  }
  const pinned = !message.pinned;
  if (pinned) await message.pin();
  await input.api.saveGiftEntryMessage({
    guildId: input.guild.id,
    channelId: input.channelId,
    messageId: message.id,
    renderedVersion: STANDALONE_GIFT_ENTRY_RENDERED_VERSION
  });
  return { messageId: message.id, created, removedDuplicates, pinned };
}

export async function executeStandaloneGiftButton(input: {
  interaction: ButtonInteraction;
  route: Extract<ServiceCenterRoute, { area: 'standalone-gift' }>;
  actor: BotActorContext;
  api: BotApiClient;
  secret: () => string;
}): Promise<void> {
  if (input.route.action === 'open') await input.interaction.deferReply({ ephemeral: true });
  else await input.interaction.deferUpdate();
  try {
    if (input.route.action === 'open' || input.route.action === 'back') {
      const center = await input.api.getStandaloneGiftCenter(input.actor);
      await input.interaction.editReply(toDiscordUpdate(buildStandaloneGiftRecipientMessage(center)));
      return;
    }
    if (!('token' in input.route)) throw new Error('Standalone gift continuation context is missing.');
    const context = readStandaloneGiftContinuationToken(input.route.token, input.actor, input.secret());
    if (input.route.action === 'refresh') {
      const [affordability, center] = await Promise.all([
        input.api.checkStandaloneGiftAffordability(context.playerProfileId, context.giftCatalogVersionId, input.actor),
        input.api.getStandaloneGiftCenter(input.actor)
      ]);
      const currentToken = createStandaloneGiftContinuationToken(
        {
          playerProfileId: context.playerProfileId,
          giftCatalogVersionId: affordability.giftCatalogVersionId,
          catalogVersion: affordability.catalogVersion,
          priceMinor: affordability.priceMinor
        },
        input.actor,
        input.secret()
      );
      await input.interaction.editReply(
        toDiscordUpdate(
          buildStandaloneGiftAffordabilityMessage(
            affordability,
            currentToken,
            requireRecipient(center, context.playerProfileId).displayName,
            requireGift(center, context.giftCatalogVersionId).name
          )
        )
      );
      return;
    }
    const created = await input.api.createStandaloneGiftRequest(
      {
        playerProfileId: context.playerProfileId,
        giftCatalogVersionId: context.giftCatalogVersionId,
        expectedCatalogVersion: context.catalogVersion,
        expectedPriceMinor: context.priceMinor,
        anonymous: input.route.action === 'confirm-anonymous'
      },
      input.actor,
      buildDiscordIdempotencyKey('gift:standalone:confirm', input.interaction.id)
    );
    await input.interaction.editReply(toDiscordUpdate(buildStandaloneGiftRequestMessage(created)));
  } catch (error) {
    await standaloneGiftFailure(input.interaction, error);
  }
}

export async function executeStandaloneGiftSelect(input: {
  interaction: StringSelectMenuInteraction;
  route: Extract<ServiceCenterRoute, { area: 'standalone-gift-recipient-select' | 'standalone-gift-catalog-select' }>;
  actor: BotActorContext;
  api: BotApiClient;
  secret: string;
}): Promise<void> {
  await input.interaction.deferUpdate();
  try {
    const center = await input.api.getStandaloneGiftCenter(input.actor);
    if (input.route.area === 'standalone-gift-recipient-select') {
      const playerProfileId = input.interaction.values[0] ?? '';
      requireRecipient(center, playerProfileId);
      await input.interaction.editReply(
        toDiscordUpdate(buildStandaloneGiftCatalogMessage(center, playerProfileId, input.actor, input.secret))
      );
      return;
    }
    const context = readStandaloneGiftContinuationToken(input.interaction.values[0] ?? '', input.actor, input.secret);
    const affordability = await input.api.checkStandaloneGiftAffordability(
      context.playerProfileId,
      context.giftCatalogVersionId,
      input.actor
    );
    const currentToken = createStandaloneGiftContinuationToken(
      {
        playerProfileId: context.playerProfileId,
        giftCatalogVersionId: affordability.giftCatalogVersionId,
        catalogVersion: affordability.catalogVersion,
        priceMinor: affordability.priceMinor
      },
      input.actor,
      input.secret
    );
    await input.interaction.editReply(
      toDiscordUpdate(
        buildStandaloneGiftAffordabilityMessage(
          affordability,
          currentToken,
          requireRecipient(center, context.playerProfileId).displayName,
          requireGift(center, context.giftCatalogVersionId).name
        )
      )
    );
  } catch (error) {
    await standaloneGiftFailure(input.interaction, error);
  }
}

function requireRecipient(center: StandaloneGiftCenterData, playerProfileId: string) {
  const recipient = center.recipients.find((value) => value.playerProfileId === playerProfileId);
  if (!recipient) throw new Error('Standalone gift recipient is no longer available.');
  return recipient;
}
function requireGift(center: StandaloneGiftCenterData, giftCatalogVersionId: string) {
  const gift = center.items.find((value) => value.id === giftCatalogVersionId);
  if (!gift) throw new Error('Standalone gift catalog changed.');
  return gift;
}
async function standaloneGiftFailure(
  interaction: Pick<ButtonInteraction | StringSelectMenuInteraction, 'id' | 'followUp'>,
  error: unknown
) {
  await interaction.followUp({
    content: formatUserFacingError(error, {
      operation: '处理独立送礼',
      localRequestId: `discord-interaction-${interaction.id}`
    }),
    ephemeral: true
  });
}
function standaloneActionId(action: 'refresh' | 'confirm-public' | 'confirm-anonymous', token: string) {
  const code = action === 'refresh' ? 'f' : action === 'confirm-public' ? 'p' : 'a';
  const value = `bc:g2:${code}:${token}`;
  if (value.length > 100) throw new Error('Standalone gift custom ID is too long.');
  return value;
}
function isStandaloneGiftEntryMessage(message: Pick<Message, 'components'>): boolean {
  const json = message.components.map((component) =>
    typeof component.toJSON === 'function' ? component.toJSON() : component
  );
  return JSON.stringify(json).includes(STANDALONE_GIFT_ENTRY_CUSTOM_ID);
}
function giftAmount(value: number) {
  return formatCustomerWalletAmount(value, DEFAULT_WALLET_DISPLAY_CONFIG);
}
function tokenSignature(payload: Buffer, secret: string) {
  return createHmac('sha256', secret).update('blackcat-standalone-gift-v1').update(payload).digest().subarray(0, 8);
}
function actorDigest(actor: BotActorContext, secret: string) {
  return createHmac('sha256', secret).update(`${actor.guildId}:${actor.discordUserId}`).digest().subarray(0, 6);
}
function uuidBytes(value: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) throw new Error('Standalone gift ID is invalid.');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}
function uuidString(value: Buffer) {
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
