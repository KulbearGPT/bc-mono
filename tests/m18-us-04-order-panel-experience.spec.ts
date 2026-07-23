import { describe, expect, test } from 'vitest';
import {
  buildOrderPanelMessage,
  buildSubmittedOrderMessage,
  type OrderSummary
} from '@blackcat/bot/service-center';
import { buildSelectionPoolRefreshMessage } from '../apps/bot/src/selection-discord.js';

const orderId = '00000000-0000-0000-0000-000000180401';

describe('M18-US-04 order panel hierarchy', () => {
  test('groups stable order facts, boss request, status, and next step on the generic panel', () => {
    const message = buildOrderPanelMessage(order({ status: 'COMPLETED', notes: '轻松聊天，不急着上分。' }));
    expect(message.density).toBe('PRIVATE_ORDER');
    expect(message.fields?.map((field) => field.name)).toEqual([
      '🎮 服务内容',
      '🐟 订单金额',
      '💬 老板需求',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    expect(message.fields?.find((field) => field.name === '💬 老板需求')?.value).toBe(
      '> 轻松聊天，不急着上分。'
    );
    expect(message.body).not.toContain('轻松聊天');
    expect(JSON.stringify(message.components)).not.toContain('取消订单');
  });

  test('makes the submitted reservation panel readable without hiding that funds are only reserved', () => {
    const message = buildSubmittedOrderMessage({
      orderId,
      status: 'PENDING_DISPATCH',
      version: 3,
      reservation: {
        reservationId: '00000000-0000-0000-0000-000000180402',
        amountMinor: 200,
        capturedMinor: 0,
        releasedMinor: 0,
        currency: 'CAT',
        status: 'ACTIVE',
        version: 1,
        expiresAt: '2026-08-08T12:30:00.000Z'
      },
      balance: {
        ledgerBalanceMinor: 1000,
        reservedMinor: 200,
        availableMinor: 800,
        currency: 'CAT',
        calculatedAt: '2026-08-08T12:00:00.000Z'
      }
    });
    expect(message.fields?.map((field) => field.name)).toEqual([
      '📋 订单状态',
      '🐟 资金状态',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    const funds = message.fields?.find((field) => field.name === '🐟 资金状态')?.value ?? '';
    expect(funds).toContain('本单预留：20.0 CAT');
    expect(funds).toContain('还没有产生正式消费');
    expect(message.body).not.toContain('本单预留');
    expect(JSON.stringify(message.components)).toContain('开始招募');
  });

  test('shows collecting applicants as a quiet mention list with one primary stop action', () => {
    const message = buildSelectionPoolRefreshMessage(
      order(),
      {
        id: '00000000-0000-0000-0000-000000180403',
        orderId,
        round: 2,
        status: 'COLLECTING',
        version: 4,
        waitMinutes: null,
        openedAt: '2026-08-08T12:00:00.000Z',
        closesAt: null,
        closedAt: null,
        closeReason: null,
        applicationCount: 2,
        applicantDiscordUserIds: ['111111111111111111', '222222222222222222']
      }
    );
    expect(message.title).toContain('报名进行中');
    expect(message.fields?.map((field) => field.name)).toEqual([
      '📋 本轮招募',
      '🐾 当前报名',
      '⏳ 当前进度',
      '👉 下一步'
    ]);
    expect(message.fields?.find((field) => field.name === '🐾 当前报名')?.value).toContain(
      '<@111111111111111111>'
    );
    expect(JSON.stringify(message)).not.toContain('当前候选');
    const primary = message.components
      .flatMap((row) => (row.type === 'ACTION_ROW' ? row.components : []))
      .filter((component) => component.type === 'BUTTON' && component.style === 'PRIMARY');
    expect(primary).toEqual([expect.objectContaining({ label: '终止招募' })]);
  });

  test('renders the stopped round as trial matching rather than draft terminology', () => {
    const message = buildSelectionPoolRefreshMessage(
      order(),
      {
        id: '00000000-0000-0000-0000-000000180404',
        orderId,
        round: 2,
        status: 'SELECTION',
        version: 5,
        waitMinutes: null,
        openedAt: '2026-08-08T12:00:00.000Z',
        closesAt: null,
        closedAt: '2026-08-08T12:10:00.000Z',
        closeReason: 'CUSTOMER_STOPPED',
        applicationCount: 1,
        applicantDiscordUserIds: ['111111111111111111']
      }
    );
    expect(message.title).toContain('试音匹配');
    expect(JSON.stringify(message)).toContain('报名陪玩');
    expect(JSON.stringify(message)).not.toContain('候选');
  });
});

function order(overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: orderId,
    publicId: 'P-M18-PANEL',
    status: 'PENDING_DISPATCH',
    version: 3,
    serviceCatalogId: '00000000-0000-0000-0000-000000180405',
    game: 'VALORANT',
    gameDisplayName: '无畏契约',
    service: 'FUN',
    serviceDisplayName: '娱乐陪玩',
    region: 'NA',
    regionDisplayName: '北美',
    billingUnitMinutes: 60,
    unitCount: 2,
    amountMinor: 200,
    currency: 'CAT',
    notes: null,
    channelSpec: {
      channelId: '333333333333333333',
      panelMessageId: '444444444444444444',
      voiceChannelId: null
    },
    ...overrides
  };
}
