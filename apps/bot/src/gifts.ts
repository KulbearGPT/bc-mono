import { createHmac, timingSafeEqual } from 'node:crypto';
import { BOT_COPY, botCopy } from './bot-copy.js';
import type { BotActorContext, MessageSpec } from './service-center.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, customerWalletLabel, formatCustomerWalletAmount } from './wallet-display.js';

export interface GiftPanelData {
  orderId: string;
  orderPublicId: string;
  receiver: { userId: string; displayName: string };
  recipients: Array<{ participantId: string; playerId: string; displayName: string }>;
  balance: BalanceData;
  items: Array<{
    id: string;
    code: string;
    name: string;
    version: number;
    priceMinor: number;
    currency: string;
    affordable: boolean;
  }>;
}

export interface GiftRequestItemResult {
  id: string;
  publicId: string;
  orderId: string;
  senderId: string;
  receiverId: string;
  participantId: string;
  status: 'PENDING_REVIEW';
  expiresAt: string;
  gift: { code: string; name: string; priceMinor: number; currency: string };
  reservation: {
    id: string;
    sourceType: 'GIFT';
    status: string;
    amountMinor: number;
    currency: string;
    expiresAt: string;
  };
  staffTask: { id: string; publicId: string; type: 'GIFT_REVIEW'; status: string };
  balance: BalanceData;
}
export interface GiftRequestResult {
  unitPriceMinor: number;
  recipientCount: number;
  totalAmountMinor: number;
  items: GiftRequestItemResult[];
}

export interface GiftAffordabilityResult {
  giftCatalogVersionId: string;
  catalogVersion: number;
  priceMinor: number;
  recipientCount: number;
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

export interface GiftContinuationContext {
  orderId: string;
  orderVersion: number;
  giftCatalogVersionId: string;
  catalogVersion: number;
  priceMinor: number;
}

interface BalanceData {
  ledgerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: string;
  calculatedAt: string;
}

export function buildGiftPanel(data: GiftPanelData) {
  return {
    title: `订单 ${data.orderPublicId} · 赠送礼物`,
    targetLabel: data.receiver.displayName,
    availableMinor: data.balance.availableMinor,
    currency: data.balance.currency,
    options: data.items.map((item) => ({
      label: `${item.name} · ${formatGiftAmount(item.priceMinor, item.currency)}`,
      value: item.id,
      disabled: false
    })),
    actions: ['CONFIRM_GIFT', 'RECHARGE', 'BACK_TO_ORDER'] as const
  };
}

export function buildGiftAffordabilityMessage(
  data: GiftAffordabilityResult,
  token: string,
  recipients: Array<{ participantId: string; displayName: string }> = []
): MessageSpec {
  const displayConfig = DEFAULT_WALLET_DISPLAY_CONFIG;
  const walletLabel = customerWalletLabel(displayConfig);
  const confirmationRow =
    data.canAfford && !data.stale
      ? [
          {
            type: 'ACTION_ROW' as const,
            components: [
              {
                type: 'BUTTON' as const,
                style: 'PRIMARY' as const,
                customId: customId('confirm', token),
                label: '确认赠送'
              }
            ]
          }
        ]
      : [];
  return {
    title:
      data.canAfford && !data.stale ? '确认礼物' : data.stale ? `${walletLabel}需要刷新` : `${walletLabel}余额不足`,
    body:
      data.canAfford && !data.stale
        ? botCopy.gifts.affordable(
            `${data.recipientCount} 位猫猫 · ${formatGiftAmount(data.totalPriceMinor, data.currency)}`
          )
        : data.stale
          ? BOT_COPY.gifts.staleBalance
          : botCopy.gifts.shortfall(formatGiftAmount(data.shortfallMinor, data.currency), data.topUpInstructions),
    visibility: 'EPHEMERAL',
    components: [
      ...chunk(recipients, 25)
        .slice(0, 3)
        .map((page, index) => recipientSelectionRow(`bc:gift:selected:${index}`, page, true)),
      ...confirmationRow,
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'SECONDARY', customId: customId('refresh', token), label: '刷新余额' },
          { type: 'BUTTON', style: 'SECONDARY', customId: customId('back', token), label: '返回礼物' }
        ]
      }
    ]
  };
}

export function buildGiftCatalogMessage(
  data: GiftPanelData,
  orderVersion: number,
  actor: BotActorContext,
  secret: string,
  now = new Date(),
  selectedParticipantIds: string[] = [],
  page = 0
): MessageSpec {
  if (data.items.length > 25) throw new Error('Gift catalog exceeds the Discord component limit.');
  const giftOptions = data.items.map((item) => ({
    value: createGiftContinuationToken(
      {
        orderId: data.orderId,
        orderVersion,
        giftCatalogVersionId: item.id,
        catalogVersion: item.version,
        priceMinor: item.priceMinor
      },
      actor,
      secret,
      now
    ),
    label: `${item.name} · ${formatGiftAmount(item.priceMinor, item.currency)}`
  }));
  const selected = data.recipients.filter((recipient) => selectedParticipantIds.includes(recipient.participantId));
  const pageCount = Math.max(1, Math.ceil(data.recipients.length / 25));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const pageRecipients = data.recipients.slice(safePage * 25, safePage * 25 + 25);
  const selection = encodeGiftRecipientSelection(data.recipients, selectedParticipantIds);
  return {
    title: `订单 ${data.orderPublicId} · 赠送礼物`,
    body: selected.length
      ? `已选 ${selected.length} 位猫猫。可以继续翻页挑选，或直接选择礼物。`
      : '先选择这次要收到礼物的陪玩猫猫。',
    visibility: 'EPHEMERAL',
    components: [
      recipientSelectionRow(
        `bc:grs:${data.orderId}:${safePage}:v${orderVersion}:${selection}`,
        pageRecipients,
        false,
        selectedParticipantIds
      ),
      ...(selected.length && giftOptions.length
        ? [
            {
              type: 'ACTION_ROW' as const,
              components: [
                {
                  type: 'STRING_SELECT' as const,
                  customId: `bc:gc:${selection}`,
                  placeholder: '选择要赠送的礼物',
                  minValues: 1,
                  maxValues: 1,
                  options: giftOptions
                }
              ]
            }
          ]
        : []),
      ...(pageCount > 1
        ? [
            {
              type: 'ACTION_ROW' as const,
              components: [
                {
                  type: 'BUTTON' as const,
                  style: 'SECONDARY' as const,
                  customId: `bc:grp:${data.orderId}:${Math.max(0, safePage - 1)}:v${orderVersion}:${selection}`,
                  label: '上一页',
                  disabled: safePage === 0
                },
                {
                  type: 'BUTTON' as const,
                  style: 'SECONDARY' as const,
                  customId: `bc:grp:${data.orderId}:${Math.min(pageCount - 1, safePage + 1)}:v${orderVersion}:${selection}`,
                  label: '下一页',
                  disabled: safePage === pageCount - 1
                }
              ]
            }
          ]
        : [])
    ]
  };
}

export function encodeGiftRecipientSelection(
  recipients: Array<{ participantId: string }>,
  selectedParticipantIds: string[]
): string {
  if (recipients.length > 240) throw new Error('Gift recipient list exceeds the Discord continuation limit.');
  const selected = new Set(selectedParticipantIds);
  const bytes = Buffer.alloc(Math.max(1, Math.ceil(recipients.length / 8)));
  recipients.forEach((recipient, index) => {
    if (selected.has(recipient.participantId)) bytes[index >> 3] |= 1 << (index & 7);
  });
  return bytes.toString('base64url');
}

export function decodeGiftRecipientSelection(
  recipients: Array<{ participantId: string }>,
  selection: string
): string[] {
  if (!/^[A-Za-z0-9_-]{1,40}$/u.test(selection)) throw new Error('Gift recipient selection is invalid.');
  const bytes = Buffer.from(selection, 'base64url');
  if (bytes.length < Math.max(1, Math.ceil(recipients.length / 8)))
    throw new Error('Gift recipient selection is invalid.');
  return recipients
    .filter((_recipient, index) => Boolean(bytes[index >> 3]! & (1 << (index & 7))))
    .map((recipient) => recipient.participantId);
}

export function buildGiftRecipientPickerMessage(
  data: GiftPanelData,
  orderVersion: number,
  actor: BotActorContext,
  continuationSecret: string
): MessageSpec {
  return buildGiftCatalogMessage(data, orderVersion, actor, continuationSecret);
}

export function buildGiftRequestMessage(data: GiftRequestResult): MessageSpec {
  const first = data.items[0];
  return {
    title: '送礼请求已提交',
    body: first
      ? botCopy.gifts.requestSubmitted(
          `${first.gift.name} × ${data.recipientCount}`,
          formatGiftAmount(data.totalAmountMinor, first.gift.currency)
        )
      : '礼物请求已提交。',
    visibility: 'EPHEMERAL',
    components: []
  };
}

function recipientSelectionRow(
  customId: string,
  recipients: Array<{ participantId: string; displayName: string }>,
  disabled: boolean,
  selectedIds: string[] = recipients.map((recipient) => recipient.participantId)
) {
  const visible = recipients.slice(0, 25);
  return {
    type: 'ACTION_ROW' as const,
    components: [
      {
        type: 'STRING_SELECT' as const,
        customId,
        placeholder: '选择收到礼物的陪玩（可多选）',
        minValues: 1,
        maxValues: visible.length,
        disabled,
        options: visible.map((recipient) => ({
          label: recipient.displayName.slice(0, 100),
          value: recipient.participantId,
          default: selectedIds.includes(recipient.participantId)
        }))
      }
    ]
  };
}

export function createGiftContinuationToken(
  context: GiftContinuationContext,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): string {
  if (secret.length < 32) throw new Error('Gift continuation signing secret must be at least 32 characters.');
  const payload = Buffer.alloc(52);
  uuidBytes(context.orderId).copy(payload, 0);
  uuidBytes(context.giftCatalogVersionId).copy(payload, 16);
  payload.writeUInt16BE(context.orderVersion, 32);
  payload.writeUInt16BE(context.catalogVersion, 34);
  payload.writeUIntBE(context.priceMinor, 36, 6);
  payload.writeUInt32BE(Math.floor(now.getTime() / 1000) + 1_800, 42);
  actorDigest(actor, secret).copy(payload, 46);
  return `g1_${Buffer.concat([payload, signature(payload, secret)]).toString('base64url')}`;
}

export function readGiftContinuationToken(
  token: string,
  actor: BotActorContext,
  secret: string,
  now = new Date()
): GiftContinuationContext {
  if (!/^g1_[A-Za-z0-9_-]{80}$/u.test(token)) throw new Error('Gift continuation context is invalid.');
  const bytes = Buffer.from(token.slice(3), 'base64url');
  const payload = bytes.subarray(0, 52);
  const actual = bytes.subarray(52);
  if (
    bytes.length !== 60 ||
    !timingSafeEqual(actual, signature(payload, secret)) ||
    !timingSafeEqual(payload.subarray(46), actorDigest(actor, secret))
  ) {
    throw new Error('Gift continuation context is invalid.');
  }
  if (payload.readUInt32BE(42) < Math.floor(now.getTime() / 1000))
    throw new Error('Gift continuation context expired.');
  return {
    orderId: uuidString(payload.subarray(0, 16)),
    giftCatalogVersionId: uuidString(payload.subarray(16, 32)),
    orderVersion: payload.readUInt16BE(32),
    catalogVersion: payload.readUInt16BE(34),
    priceMinor: payload.readUIntBE(36, 6)
  };
}

function customId(action: 'select' | 'confirm' | 'refresh' | 'back', token: string) {
  const value = `bc:gift:${action}:${token}`;
  if (value.length > 100) throw new Error('Gift continuation custom ID is too long.');
  return value;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function signature(payload: Buffer, secret: string) {
  return createHmac('sha256', secret).update('blackcat-gift-continuation-v1').update(payload).digest().subarray(0, 8);
}

function actorDigest(actor: BotActorContext, secret: string) {
  return createHmac('sha256', secret).update(`${actor.guildId}:${actor.discordUserId}`).digest().subarray(0, 6);
}

function uuidBytes(value: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))
    throw new Error('Gift continuation context ID is invalid.');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function uuidString(value: Buffer) {
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildGiftRequestConfirmation(data: GiftRequestResult) {
  const first = data.items[0];
  if (!first) throw new Error('Gift request batch is empty.');
  return {
    title: '送礼请求已提交',
    requestPublicId: first.publicId,
    statusLabel: '等待客服核对',
    giftName: `${first.gift.name} × ${data.recipientCount}`,
    reservedMinor: data.totalAmountMinor,
    capturedMinor: 0,
    availableMinor: data.items.at(-1)?.balance.availableMinor ?? first.balance.availableMinor,
    expiresAt: first.expiresAt
  };
}

function formatGiftAmount(amountMinor: number, currency: string): string {
  if (currency !== 'CAT') throw new Error('Customer gift display requires canonical USD minor units.');
  return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
}
