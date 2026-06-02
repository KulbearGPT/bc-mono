import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  buildCurrentPlayerWeeklyReportDetailMessage,
  buildCurrentUserConsumptionsMessage,
  buildCurrentWalletMessage,
  buildOrderConfirmationMessage,
  buildServiceCenterMessage,
  handleOpenServiceCenterFromPublicEntry,
  type BalanceSummary,
  type BotApiClient,
  type OrderSummary
} from '@blackcat/bot/service-center';
import { buildGiftAffordabilityMessage } from '@blackcat/bot/gifts';

describe('M8-US-03 selective customer token rendering', () => {
  test('renders representative customer wallet and spending messages in CAT only', () => {
    const wallet = buildCurrentWalletMessage(balance(20_000));
    const confirmation = buildOrderConfirmationMessage({
      order: order(),
      estimate: {
        serviceCatalogId: 'svc-1', catalogVersion: 1, unitCount: 2, billingUnitMinutes: 60,
        amountMinor: 12_000, currency: 'CAT', validUntil: '2026-07-21T23:00:00Z'
      },
      balance: balance(20_000)
    });
    const gift = buildGiftAffordabilityMessage({
      giftCatalogVersionId: 'gift-1', catalogVersion: 1, priceMinor: 5_000,
      ledgerBalanceMinor: 20_000, reservedMinor: 0, availableMinor: 20_000,
      shortfallMinor: 0, currency: 'CAT', calculatedAt: '2026-07-21T22:00:00Z',
      stale: false, canAfford: true, topUpInstructions: '联系客服并提交付款 receipt。'
    }, 'continuation-token');
    const consumptions = buildCurrentUserConsumptionsMessage({
      items: [{
        id: 'con-1', type: 'ORDER', sourceId: 'ord-1', amountMinor: 8_800, currency: 'CAT',
        status: 'SUCCEEDED', targetDisplay: '陪玩A', occurredAt: '2026-07-21T21:00:00Z', reversalOf: null
      }],
      nextCursor: null
    });

    expect(wallet.title).toBe('我的猫条钱包');
    expect(wallet.body).toContain('2,000.0 CAT');
    expect(confirmation.body).toContain('1,200.0 CAT');
    expect(gift.body).toContain('500.0 CAT');
    expect(consumptions.body).toContain('880.0 CAT');
    expect(JSON.stringify([wallet, confirmation, gift, consumptions])).not.toMatch(/USD|\$/u);
  });

  test('does not mix USD commission amounts into the CAT wallet service-center summary', () => {
    const message = buildServiceCenterMessage({
      currentUser: {
        user: { id: 'user-1', displayName: '客户A', status: 'ACTIVE', externalAccountDisplay: null,
          activeOrderId: null, riskFlags: [], version: 1 },
        activeOrderId: null,
        consumptionSummary: { totalMinor: 0, currency: 'CAT' },
        commissionSummary: { pendingMinor: 200, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' }
      },
      balance: balance(10_000),
      activeOrder: null,
      consumptions: { items: [], nextCursor: null },
      commissions: {
        summary: { pendingMinor: 200, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' },
        items: [{}],
        nextCursor: null
      }
    } as unknown as Parameters<typeof buildServiceCenterMessage>[0]);

    expect(message.body).toContain('我的收益：有待处理记录，请打开“我的收益”查看。');
    expect(JSON.stringify(message)).not.toMatch(/USD|\$/u);
  });

  test('renders a canonical USD 100 top-up balance through the Bot refresh path as 1,000.0 CAT', async () => {
    const creditedAmountMinor = 10_000;
    const api = {
      getCurrentUser: vi.fn().mockResolvedValue({
        user: { id: 'user-1', displayName: '客户A', status: 'ACTIVE', externalAccountDisplay: null,
          activeOrderId: null, riskFlags: [], version: 1 },
        activeOrderId: null,
        consumptionSummary: { totalMinor: 0, currency: 'CAT' },
        commissionSummary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' }
      }),
      getCurrentBalance: vi.fn().mockResolvedValue(balance(creditedAmountMinor)),
      listCurrentUserConsumptions: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      listCurrentUserCommissions: vi.fn().mockResolvedValue({
        summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CAT' },
        items: [], nextCursor: null
      })
    } as unknown as BotApiClient;
    const result = await handleOpenServiceCenterFromPublicEntry({
      api,
      actor: { guildId: 'guild-1', discordUserId: 'discord-1', interactionId: 'interaction-1', clientSource: 'DISCORD_BOT' }
    });

    expect(creditedAmountMinor).toBe(10_000);
    expect(result.kind).toBe('SHOW_SERVICE_CENTER');
    if (result.kind !== 'SHOW_SERVICE_CENTER') throw new Error('Expected the refreshed service center.');
    expect(result.message.body).toContain('1,000.0 CAT');
    expect(result.message.body).not.toMatch(/USD|\$/u);
  });

  test('keeps player earnings and reports in CAT', () => {
    const report = buildCurrentPlayerWeeklyReportDetailMessage({
      id: 'report-1', reportType: 'PLAYER', periodStart: '2026-07-13', periodEnd: '2026-07-20',
      timeZone: 'America/Toronto', currency: 'CAT', status: 'READY', currentRevision: 1,
      metrics: {
        completedOrderCount: 3, cancelledOrderCount: 0, serviceMinutes: 180,
        orderEarningMinor: 8_400, giftEarningMinor: 600, adjustmentMinor: 0,
        pendingMinor: 1_000, settlementReadyMinor: 8_000, batchedMinor: 0
      }
    });

    expect(report.body).toContain('840.0 CAT');
    expect(report.body).not.toMatch(/USD|\$/u);
  });

  test('keeps the staff Dashboard explicit about USD evidence and fixed CAT issuance', () => {
    const panel = readFileSync('apps/dashboard/src/CustomerWalletPanel.tsx', 'utf8');
    const formatter = readFileSync('apps/dashboard/src/customer-wallet.ts', 'utf8');

    expect(formatter).toContain('export function formatWalletMoney');
    expect(formatter).toContain('CAT');
    expect(panel).toContain('固定按 1 USD = 10 猫条发放');
    expect(panel).not.toContain('formatCustomerWalletAmount');
  });

  test('makes every money call site choose explicit CAT semantics', () => {
    const serviceCenter = readFileSync('apps/bot/src/service-center.ts', 'utf8');
    const gifts = readFileSync('apps/bot/src/gifts.ts', 'utf8');

    expect(serviceCenter).not.toMatch(/\bformatMoney\s*\(/u);
    expect(serviceCenter).toContain('formatCustomerWalletAmount');
    expect(serviceCenter).toContain('formatPlatformMoney');
    expect(gifts).toContain('formatCustomerWalletAmount');
    expect(gifts).not.toMatch(/\bformatMinor\s*\(/u);
  });
});

function balance(availableMinor: number): BalanceSummary {
  return {
    ledgerBalanceMinor: availableMinor,
    reservedMinor: 0,
    availableMinor,
    currency: 'CAT',
    calculatedAt: '2026-07-21T22:00:00Z',
    version: 1
  };
}

function order(): OrderSummary {
  return {
    id: 'order-1', publicId: 'P-1', status: 'DRAFT', version: 1,
    game: 'VALORANT', service: 'ENTERTAINMENT', region: 'NA',
    billingUnitMinutes: 60, unitCount: 2, amountMinor: 12_000, currency: 'CAT', notes: null,
    channelSpec: { channelId: 'channel-1', panelMessageId: 'message-1', voiceChannelId: null },
    matching: null
  };
}
