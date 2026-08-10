import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ButtonInteraction,
  MessageContextMenuCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction
} from 'discord.js';
import { buildBotActorContext } from './actor-context.js';
import { toDiscordModal, toDiscordUpdate } from './discord-renderer.js';
import type { BotApiClient } from './service-center-api-client-contract.js';
import type { BotActorContext } from './service-center-api-contracts.js';
import type {
  StaffAssistedGiftRequestData,
  StaffGiftAssistChallengeData
} from './service-center-api-client-staff-gift-contract.js';
import type { MessageSpec, ModalSpec } from './service-center-components.js';
import { buildDiscordIdempotencyKey } from './service-center.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, formatCustomerWalletAmount } from './wallet-display.js';
import { formatDiscordError } from './user-facing-error.js';

export interface StaffGiftAssistContinuation {
  challengeId: string;
  playerProfileId: string;
  giftCatalogVersionId: string;
  catalogVersion: number;
  priceMinor: number;
}

export type StaffGiftAssistSelectRoute =
  { action: 'recipient'; challengeId: string } | { action: 'gift'; challengeId: string; playerProfileId: string };
export type StaffGiftAssistButtonRoute =
  { action: 'back'; challengeId: string } | { action: 'refresh' | 'public' | 'anonymous'; token: string };
export type StaffGiftAssistModalRoute = { anonymous: boolean; token: string };

export function buildStaffGiftAssistRecipientMessage(data: StaffGiftAssistChallengeData): MessageSpec {
  return {
    title: `🎁 协助 ${data.customer.displayName} 送礼`,
    body: '客户身份来自这条授权消息的同服务器绑定。请选择一位陪玩；后续最终确认需要填写原因和你的六位 TOTP。',
    visibility: 'EPHEMERAL',
    tone: 'INFO',
    density: 'HIGH_RISK',
    fields: [
      { name: '🐟 老板当前可用猫条', value: giftAmount(data.balance.availableMinor) },
      { name: '🔐 授权边界', value: '你是最终确认人；验证码不会保存，错误或重放不会建立预留。' }
    ],
    components: data.recipients.length
      ? [
          {
            type: 'ACTION_ROW',
            components: [
              {
                type: 'STRING_SELECT',
                customId: `bc:ga:r:${data.id}`,
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

export function buildStaffGiftAssistCatalogMessage(
  data: StaffGiftAssistChallengeData,
  playerProfileId: string,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): MessageSpec {
  const recipient = requireRecipient(data, playerProfileId);
  return {
    title: `🎁 给 ${recipient.displayName} 选择礼物`,
    body: `付款人仍是 ${data.customer.displayName}；选择礼物只做余额预检，不会直接预留。`,
    visibility: 'EPHEMERAL',
    tone: 'INFO',
    density: 'HIGH_RISK',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'STRING_SELECT',
            customId: `bc:ga:g:${data.id}:${playerProfileId}`,
            placeholder: '选择一份礼物',
            minValues: 1,
            maxValues: 1,
            options: data.items.slice(0, 25).map((item) => ({
              label: `${item.name} · ${giftAmount(item.priceMinor)}`.slice(0, 100),
              value: createStaffGiftAssistToken(
                {
                  challengeId: data.id,
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
        components: [{ type: 'BUTTON', style: 'SECONDARY', customId: `bc:ga:b:${data.id}`, label: '← 重选陪玩' }]
      }
    ]
  };
}

export function buildStaffGiftAssistConfirmationMessage(input: {
  center: StaffGiftAssistChallengeData;
  affordability: Awaited<ReturnType<BotApiClient['checkStaffGiftAssistAffordability']>>;
  token: string;
}): MessageSpec {
  const recipient = requireRecipient(input.center, input.affordability.playerProfileId);
  const gift = requireGift(input.center, input.affordability.giftCatalogVersionId);
  const ready = input.affordability.canAfford && !input.affordability.stale;
  return {
    title: ready ? '🔐 客服最终确认' : '🐟 老板猫条余额不足',
    body: ready
      ? '选择公开或匿名后会打开最终确认框；填写客户授权原因和你的六位 TOTP 才会直接预留老板余额。'
      : '本次尚未创建礼物、预留或客服任务。充值核对完成后可刷新。',
    visibility: 'EPHEMERAL',
    tone: ready ? 'INFO' : 'DANGER',
    density: 'HIGH_RISK',
    fields: [
      { name: '老板', value: input.center.customer.displayName },
      { name: '礼物', value: `${gift.name} → ${recipient.displayName}` },
      {
        name: '资金',
        value: ready
          ? `将预留 ${giftAmount(input.affordability.totalPriceMinor)}`
          : `还差 ${giftAmount(input.affordability.shortfallMinor)}`
      }
    ],
    components: [
      ...(ready
        ? [
            {
              type: 'ACTION_ROW' as const,
              components: [
                {
                  type: 'BUTTON' as const,
                  style: 'PRIMARY' as const,
                  customId: assistActionId('p', input.token),
                  label: '公开赠送并验证'
                },
                {
                  type: 'BUTTON' as const,
                  style: 'SECONDARY' as const,
                  customId: assistActionId('a', input.token),
                  label: '🕶️ 匿名赠送并验证'
                }
              ]
            }
          ]
        : []),
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'SECONDARY', customId: assistActionId('f', input.token), label: '🔄 刷新余额' },
          { type: 'BUTTON', style: 'SECONDARY', customId: `bc:ga:b:${input.center.id}`, label: '← 重新选择' }
        ]
      }
    ]
  };
}

export function buildStaffGiftAssistFinalModal(token: string, anonymous: boolean): ModalSpec {
  const customId = `bc:ga:m:${anonymous ? 'a' : 'p'}:${token}`;
  if (customId.length > 100) throw new Error('Staff gift assist modal custom ID exceeds 100 characters.');
  return {
    title: anonymous ? '确认匿名辅助送礼' : '确认公开辅助送礼',
    customId,
    components: [
      {
        type: 'TEXT_INPUT',
        customId: 'authorizationReason',
        label: '客户授权原因',
        style: 'PARAGRAPH',
        required: true,
        maxLength: 1000
      },
      { type: 'TEXT_INPUT', customId: 'totpCode', label: '你的六位 TOTP', style: 'SHORT', required: true, maxLength: 6 }
    ]
  };
}

export function buildStaffAssistedGiftResultMessage(data: StaffAssistedGiftRequestData): MessageSpec {
  return {
    title: data.senderVisibility === 'ANONYMOUS' ? '🕶️ 匿名辅助送礼已提交' : '🎁 客服辅助送礼已提交',
    body: '客户授权、客服执行者和资金归属已经分别记录；礼物进入既有猫舍前台核对流程。',
    visibility: 'EPHEMERAL',
    tone: 'WAITING',
    density: 'HIGH_RISK',
    fields: [
      { name: '礼物', value: `${data.gift.name} · ${data.senderVisibility === 'ANONYMOUS' ? '匿名展示' : '公开展示'}` },
      { name: '资金', value: `已从老板钱包预留 ${giftAmount(data.reservation.amountMinor)}；尚未正式扣除` }
    ],
    components: []
  };
}

export function createStaffGiftAssistToken(
  context: StaffGiftAssistContinuation,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): string {
  if (secret.length < 32) throw new Error('Gift continuation signing secret must be at least 32 characters.');
  const payload = Buffer.alloc(59);
  uuidBytes(context.challengeId).copy(payload, 0);
  uuidBytes(context.playerProfileId).copy(payload, 16);
  uuidBytes(context.giftCatalogVersionId).copy(payload, 32);
  payload.writeUInt16BE(context.catalogVersion, 48);
  payload.writeUIntBE(context.priceMinor, 50, 5);
  payload.writeUInt32BE(Math.floor(now.getTime() / 1000) + 600, 55);
  const signature = assistSignature(payload, actor, secret);
  return `a_${Buffer.concat([payload, signature]).toString('base64url')}`;
}

export function readStaffGiftAssistToken(
  token: string,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): StaffGiftAssistContinuation {
  if (!/^a_[A-Za-z0-9_-]{86}$/u.test(token)) throw new Error('Staff gift assist continuation context is invalid.');
  const bytes = Buffer.from(token.slice(2), 'base64url');
  const payload = bytes.subarray(0, 59);
  const signature = bytes.subarray(59);
  if (bytes.length !== 64 || !timingSafeEqual(signature, assistSignature(payload, actor, secret)))
    throw new Error('Staff gift assist continuation context is invalid.');
  if (payload.readUInt32BE(55) < Math.floor(now.getTime() / 1000))
    throw new Error('Staff gift assist continuation context expired.');
  return {
    challengeId: uuidString(payload.subarray(0, 16)),
    playerProfileId: uuidString(payload.subarray(16, 32)),
    giftCatalogVersionId: uuidString(payload.subarray(32, 48)),
    catalogVersion: payload.readUInt16BE(48),
    priceMinor: payload.readUIntBE(50, 5)
  };
}

export function parseStaffGiftAssistSelect(customId: string): StaffGiftAssistSelectRoute | null {
  const recipient = /^bc:ga:r:([0-9a-f-]{36})$/u.exec(customId);
  if (recipient) return { action: 'recipient', challengeId: recipient[1]! };
  const gift = /^bc:ga:g:([0-9a-f-]{36}):([0-9a-f-]{36})$/u.exec(customId);
  return gift ? { action: 'gift', challengeId: gift[1]!, playerProfileId: gift[2]! } : null;
}

export function parseStaffGiftAssistButton(customId: string): StaffGiftAssistButtonRoute | null {
  const back = /^bc:ga:b:([0-9a-f-]{36})$/u.exec(customId);
  if (back) return { action: 'back', challengeId: back[1]! };
  const action = /^bc:ga:([fpa]):(a_[A-Za-z0-9_-]{86})$/u.exec(customId);
  return action
    ? { action: action[1] === 'f' ? 'refresh' : action[1] === 'p' ? 'public' : 'anonymous', token: action[2]! }
    : null;
}

export function parseStaffGiftAssistModal(customId: string): StaffGiftAssistModalRoute | null {
  const match = /^bc:ga:m:([pa]):(a_[A-Za-z0-9_-]{86})$/u.exec(customId);
  return match ? { anonymous: match[1] === 'a', token: match[2]! } : null;
}

export async function executeStaffGiftAssistContextMenu(input: {
  interaction: MessageContextMenuCommandInteraction;
  api: BotApiClient;
}): Promise<void> {
  const actor = buildBotActorContext(input.interaction);
  if (!actor || !input.interaction.inGuild() || input.interaction.targetMessage.author.bot) {
    await input.interaction.reply({ content: '请在服务器内对老板本人发送的消息使用此功能。', ephemeral: true });
    return;
  }
  await input.interaction.deferReply({ ephemeral: true });
  try {
    const challenge = await input.api.createStaffGiftAssistChallenge(
      {
        customerDiscordUserId: input.interaction.targetMessage.author.id,
        authorizationChannelId: input.interaction.targetMessage.channelId,
        authorizationMessageId: input.interaction.targetMessage.id
      },
      actor,
      buildDiscordIdempotencyKey('gift:assist:challenge', input.interaction.id)
    );
    await input.interaction.editReply(toDiscordUpdate(buildStaffGiftAssistRecipientMessage(challenge)));
  } catch (error) {
    await input.interaction.editReply(formatDiscordError(error, '创建客服辅助送礼', input.interaction.id));
  }
}

export async function executeStaffGiftAssistSelect(input: {
  interaction: StringSelectMenuInteraction;
  route: StaffGiftAssistSelectRoute;
  api: BotApiClient;
  secret: string;
}): Promise<void> {
  const actor = requireActor(input.interaction);
  await input.interaction.deferUpdate();
  try {
    const center = await input.api.getStaffGiftAssistChallenge(input.route.challengeId, actor);
    if (input.route.action === 'recipient') {
      const playerProfileId = input.interaction.values[0] ?? '';
      await input.interaction.editReply(
        toDiscordUpdate(buildStaffGiftAssistCatalogMessage(center, playerProfileId, actor, input.secret))
      );
      return;
    }
    const token = input.interaction.values[0] ?? '';
    const context = readStaffGiftAssistToken(token, actor, input.secret);
    if (context.challengeId !== input.route.challengeId || context.playerProfileId !== input.route.playerProfileId)
      throw new Error('Staff gift assist selection context changed.');
    const affordability = await input.api.checkStaffGiftAssistAffordability(
      context.challengeId,
      context.playerProfileId,
      context.giftCatalogVersionId,
      actor
    );
    const currentToken = createStaffGiftAssistToken(
      { ...context, catalogVersion: affordability.catalogVersion, priceMinor: affordability.priceMinor },
      actor,
      input.secret
    );
    await input.interaction.editReply(
      toDiscordUpdate(buildStaffGiftAssistConfirmationMessage({ center, affordability, token: currentToken }))
    );
  } catch (error) {
    await input.interaction.editReply(formatDiscordError(error, '选择客服辅助礼物', input.interaction.id));
  }
}

export async function executeStaffGiftAssistButton(input: {
  interaction: ButtonInteraction;
  route: StaffGiftAssistButtonRoute;
  api: BotApiClient;
  secret: string;
}): Promise<void> {
  const actor = requireActor(input.interaction);
  if (input.route.action === 'public' || input.route.action === 'anonymous') {
    readStaffGiftAssistToken(input.route.token, actor, input.secret);
    await input.interaction.showModal(
      toDiscordModal(buildStaffGiftAssistFinalModal(input.route.token, input.route.action === 'anonymous'))
    );
    return;
  }
  await input.interaction.deferUpdate();
  try {
    if (input.route.action === 'back') {
      const center = await input.api.getStaffGiftAssistChallenge(input.route.challengeId, actor);
      await input.interaction.editReply(toDiscordUpdate(buildStaffGiftAssistRecipientMessage(center)));
      return;
    }
    const context = readStaffGiftAssistToken(input.route.token, actor, input.secret);
    const [center, affordability] = await Promise.all([
      input.api.getStaffGiftAssistChallenge(context.challengeId, actor),
      input.api.checkStaffGiftAssistAffordability(
        context.challengeId,
        context.playerProfileId,
        context.giftCatalogVersionId,
        actor
      )
    ]);
    const currentToken = createStaffGiftAssistToken(
      { ...context, catalogVersion: affordability.catalogVersion, priceMinor: affordability.priceMinor },
      actor,
      input.secret
    );
    await input.interaction.editReply(
      toDiscordUpdate(buildStaffGiftAssistConfirmationMessage({ center, affordability, token: currentToken }))
    );
  } catch (error) {
    await input.interaction.editReply(formatDiscordError(error, '刷新客服辅助送礼', input.interaction.id));
  }
}

export async function executeStaffGiftAssistModal(input: {
  interaction: ModalSubmitInteraction;
  route: StaffGiftAssistModalRoute;
  api: BotApiClient;
  secret: string;
}): Promise<void> {
  const actor = requireActor(input.interaction);
  await input.interaction.deferReply({ ephemeral: true });
  try {
    const context = readStaffGiftAssistToken(input.route.token, actor, input.secret);
    const result = await input.api.createStaffAssistedGiftRequest(
      context.challengeId,
      {
        playerProfileId: context.playerProfileId,
        giftCatalogVersionId: context.giftCatalogVersionId,
        expectedCatalogVersion: context.catalogVersion,
        expectedPriceMinor: context.priceMinor,
        anonymous: input.route.anonymous,
        authorizationReason: input.interaction.fields.getTextInputValue('authorizationReason'),
        totpCode: input.interaction.fields.getTextInputValue('totpCode')
      },
      actor,
      buildDiscordIdempotencyKey('gift:assist:confirm', input.interaction.id)
    );
    await input.interaction.editReply(toDiscordUpdate(buildStaffAssistedGiftResultMessage(result)));
  } catch (error) {
    await input.interaction.editReply(formatDiscordError(error, '确认客服辅助送礼', input.interaction.id));
  }
}

function assistActionId(action: 'f' | 'p' | 'a', token: string) {
  const customId = `bc:ga:${action}:${token}`;
  if (customId.length > 100) throw new Error('Staff gift assist custom ID exceeds 100 characters.');
  return customId;
}

function assistSignature(payload: Buffer, actor: BotActorContext, secret: string) {
  return createHmac('sha256', secret)
    .update(actor.guildId)
    .update('\0')
    .update(actor.discordUserId)
    .update('\0')
    .update(payload)
    .digest()
    .subarray(0, 5);
}

function uuidBytes(value: string) {
  const compact = value.replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/iu.test(compact)) throw new Error('Staff gift assist UUID is invalid.');
  return Buffer.from(compact, 'hex');
}

function uuidString(value: Buffer) {
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireActor(interaction: { guildId: string | null; id: string; user: { id: string } }) {
  const actor = buildBotActorContext(interaction);
  if (!actor) throw new Error('Staff gift assist must be used in a Guild.');
  return actor;
}

function requireRecipient(center: StaffGiftAssistChallengeData, playerProfileId: string) {
  const recipient = center.recipients.find((value) => value.playerProfileId === playerProfileId);
  if (!recipient) throw new Error('Staff gift assist recipient is no longer available.');
  return recipient;
}

function requireGift(center: StaffGiftAssistChallengeData, giftCatalogVersionId: string) {
  const gift = center.items.find((value) => value.id === giftCatalogVersionId);
  if (!gift) throw new Error('Staff gift assist catalog item is no longer available.');
  return gift;
}

function giftAmount(value: number) {
  return formatCustomerWalletAmount(value, DEFAULT_WALLET_DISPLAY_CONFIG);
}
