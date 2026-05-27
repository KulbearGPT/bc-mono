import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BotActorContext, MessageSpec } from './service-center.js';
import {
  customerWalletLabel,
  formatCustomerWalletAmount,
  parseWalletDisplayConfig
} from './wallet-display.js';

export interface GiftPanelData {
  orderId: string;
  orderPublicId: string;
  receiver: { userId: string; displayName: string };
  balance: BalanceData;
  items: Array<{ id: string; code: string; name: string; version: number; priceMinor: number; currency: string; affordable: boolean }>;
}

export interface GiftRequestResult {
  id: string; publicId: string; orderId: string; senderId: string; receiverId: string;
  status: 'PENDING_REVIEW'; expiresAt: string;
  gift: { code: string; name: string; priceMinor: number; currency: string };
  reservation: { id: string; sourceType: 'GIFT'; status: string; amountMinor: number; currency: string; expiresAt: string };
  staffTask: { id: string; publicId: string; type: 'GIFT_REVIEW'; status: string };
  balance: BalanceData;
}

export interface GiftAffordabilityResult {
  giftCatalogVersionId: string; catalogVersion: number; priceMinor: number;
  ledgerBalanceMinor: number; reservedMinor: number; availableMinor: number; shortfallMinor: number;
  currency: 'USD'; calculatedAt: string; stale: boolean; canAfford: boolean; topUpInstructions: string;
}

export interface GiftContinuationContext {
  orderId: string; orderVersion: number; giftCatalogVersionId: string; catalogVersion: number; priceMinor: number;
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

export function buildGiftAffordabilityMessage(data: GiftAffordabilityResult, token: string): MessageSpec {
  const displayConfig = parseWalletDisplayConfig(process.env);
  const walletLabel = customerWalletLabel(displayConfig);
  const confirmationRow = data.canAfford && !data.stale
    ? [{ type: 'ACTION_ROW' as const, components: [
      { type: 'BUTTON' as const, style: 'PRIMARY' as const, customId: customId('confirm', token), label: '确认赠送' }
    ] }]
    : [];
  return {
    title: data.canAfford && !data.stale ? '确认礼物' : data.stale ? `${walletLabel}需要刷新` : `${walletLabel}余额不足`,
    body: data.canAfford && !data.stale
      ? `${formatGiftAmount(data.priceMinor, data.currency)} 可赠送。请基于当前价格确认。`
      : data.stale ? '当前余额已过期，请刷新后再确认。'
        : `还差 ${formatGiftAmount(data.shortfallMinor, data.currency)}。${data.topUpInstructions}`,
    visibility: 'EPHEMERAL',
    components: [
      ...confirmationRow,
      { type: 'ACTION_ROW', components: [
        { type: 'BUTTON', style: 'SECONDARY', customId: customId('refresh', token), label: '刷新余额' },
        { type: 'BUTTON', style: 'SECONDARY', customId: customId('back', token), label: '返回礼物' }
      ] }
    ]
  };
}

export function buildGiftCatalogMessage(data: GiftPanelData, orderVersion: number, actor: BotActorContext,
  secret: string, now = new Date()): MessageSpec {
  if (data.items.length > 25) throw new Error('Gift catalog exceeds the Discord component limit.');
  const buttons = data.items.map((item) => ({
    type: 'BUTTON' as const, style: 'SECONDARY' as const,
    customId: customId('select', createGiftContinuationToken({ orderId: data.orderId, orderVersion,
      giftCatalogVersionId: item.id, catalogVersion: item.version, priceMinor: item.priceMinor }, actor, secret, now)),
    label: `${item.name} · ${formatGiftAmount(item.priceMinor, item.currency)}`, disabled: false
  }));
  return { title: `订单 ${data.orderPublicId} · 赠送礼物`, body: `赠送对象：${data.receiver.displayName}`,
    visibility: 'EPHEMERAL', components: chunk(buttons, 5).map((components) => ({ type: 'ACTION_ROW', components })) };
}

export function buildGiftRequestMessage(data: GiftRequestResult): MessageSpec {
  return { title: '送礼请求已提交', body: `${data.gift.name} 已预留 ${formatGiftAmount(data.reservation.amountMinor, data.reservation.currency)}，等待客服核对。`,
    visibility: 'EPHEMERAL', components: [] };
}

export function createGiftContinuationToken(context: GiftContinuationContext, actor: BotActorContext,
  secret: string, now = new Date()): string {
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

export function readGiftContinuationToken(token: string, actor: BotActorContext, secret: string,
  now = new Date()): GiftContinuationContext {
  if (!/^g1_[A-Za-z0-9_-]{80}$/u.test(token)) throw new Error('Gift continuation context is invalid.');
  const bytes = Buffer.from(token.slice(3), 'base64url');
  const payload = bytes.subarray(0, 52);
  const actual = bytes.subarray(52);
  if (bytes.length !== 60 || !timingSafeEqual(actual, signature(payload, secret))
    || !timingSafeEqual(payload.subarray(46), actorDigest(actor, secret))) {
    throw new Error('Gift continuation context is invalid.');
  }
  if (payload.readUInt32BE(42) < Math.floor(now.getTime() / 1000)) throw new Error('Gift continuation context expired.');
  return { orderId: uuidString(payload.subarray(0, 16)), giftCatalogVersionId: uuidString(payload.subarray(16, 32)),
    orderVersion: payload.readUInt16BE(32), catalogVersion: payload.readUInt16BE(34), priceMinor: payload.readUIntBE(36, 6) };
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
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) throw new Error('Gift continuation context ID is invalid.');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function uuidString(value: Buffer) {
  const hex = value.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildGiftRequestConfirmation(data: GiftRequestResult) {
  return {
    title: '送礼请求已提交',
    requestPublicId: data.publicId,
    statusLabel: '等待客服核对',
    giftName: data.gift.name,
    reservedMinor: data.reservation.amountMinor,
    capturedMinor: 0,
    availableMinor: data.balance.availableMinor,
    expiresAt: data.expiresAt
  };
}

function formatGiftAmount(amountMinor: number, currency: string): string {
  if (currency !== 'USD') throw new Error('Customer gift display requires canonical USD minor units.');
  return formatCustomerWalletAmount(amountMinor, parseWalletDisplayConfig(process.env));
}
