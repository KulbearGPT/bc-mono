import type {
  BalanceSummary,
  ConsumptionPage,
  CurrentCommissionPage,
  CurrentPlayerWeeklyReport,
  CurrentPlayerWeeklyReportPage,
  CurrentUserOrderPage,
  CurrentUserProfileSummary,
  CurrentUserSummary,
  OrderSummary
} from './service-center-api.js';
import { paginationCustomId, type ActionRowSpec, type MessageSpec } from './service-center-components.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, customerWalletLabel, formatCustomerWalletAmount } from './wallet-display.js';

export function buildServiceCenterMessage(input: {
  currentUser: CurrentUserSummary;
  balance: BalanceSummary;
  activeOrder: OrderSummary | null;
  consumptions: ConsumptionPage;
  commissions: CurrentCommissionPage;
}): MessageSpec {
  const activeOrderLine = input.activeOrder
    ? `当前订单：#${input.activeOrder.publicId} · ${input.activeOrder.automation?.state === 'PAUSED' ? '客服处理中' : input.activeOrder.status}`
    : '当前订单：暂无进行中订单';
  const consumptionLine = input.consumptions.items.length === 0 ? '消费记录：暂无记录' : '消费记录：已有记录';
  const hasCommissionActivity =
    input.commissions.summary.pendingMinor !== 0 ||
    input.commissions.summary.confirmedMinor !== 0 ||
    input.commissions.summary.paidMinor !== 0;
  const commissionLine = hasCommissionActivity
    ? '我的收益：有待处理记录，请打开“我的收益”查看。'
    : '我的收益：暂无可领取记录';

  return {
    title: '🐈‍⬛ 我的服务中心',
    body: [
      `**👤 玩家账户**\n${input.currentUser.user.displayName}`,
      '',
      '**🐟 猫条钱包**',
      `账本余额：${formatCustomerMoney(input.balance.ledgerBalanceMinor, input.balance.currency)}`,
      `预留中：${formatCustomerMoney(input.balance.reservedMinor, input.balance.currency)}`,
      `可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      '',
      '**📋 当前进度**',
      activeOrderLine,
      consumptionLine,
      commissionLine,
      '',
      `-# 余额计算时间：${input.balance.calculatedAt}`
    ].join('\n'),
    visibility: 'EPHEMERAL',
    components: [
      ...(input.activeOrder
        ? [
            {
              type: 'ACTION_ROW' as const,
              components: [
                {
                  type: 'BUTTON' as const,
                  style: 'PRIMARY' as const,
                  customId: `bc:order:${input.activeOrder.id}:open`,
                  label: '打开当前订单'
                },
                {
                  type: 'BUTTON' as const,
                  style: 'SECONDARY' as const,
                  customId: 'bc:profile:open',
                  label: '打开个人中心'
                }
              ]
            }
          ]
        : [
            {
              type: 'ACTION_ROW' as const,
              components: [
                {
                  type: 'BUTTON' as const,
                  style: 'PRIMARY' as const,
                  customId: 'bc:profile:open',
                  label: '打开个人中心'
                }
              ]
            }
          ]),
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:entry:service-center',
            label: '刷新服务中心'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:profile:consumptions:first',
            label: '查看消费记录'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:service-center:commissions',
            label: '查看我的收益'
          }
        ]
      }
    ]
  };
}

export function buildCurrentWalletMessage(balance: BalanceSummary): MessageSpec {
  return {
    title: `🐟 我的${customerWalletLabel(DEFAULT_WALLET_DISPLAY_CONFIG)}`,
    body: [
      '**余额概览**',
      `账本余额：${formatCustomerMoney(balance.ledgerBalanceMinor, balance.currency)}`,
      `已预留：${formatCustomerMoney(balance.reservedMinor, balance.currency)}`,
      `可用余额：${formatCustomerMoney(balance.availableMinor, balance.currency)}`,
      '',
      `-# 计算时间：${balance.calculatedAt}`
    ].join('\n'),
    visibility: 'EPHEMERAL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:entry:service-center',
            label: '🔄 刷新'
          }
        ]
      }
    ]
  };
}

export function buildCurrentUserCommissionsMessage(page: CurrentCommissionPage): MessageSpec {
  return {
    title: '✨ 我的收益',
    body: [
      '**收益概览**',
      `待确认：${formatCustomerMoney(page.summary.pendingMinor, page.summary.currency)}`,
      `已确认：${formatCustomerMoney(page.summary.confirmedMinor, page.summary.currency)}`,
      `已结算：${formatCustomerMoney(page.summary.paidMinor, page.summary.currency)}`,
      '',
      '返佣来源与被推荐用户信息不会在此展示。'
    ].join('\n'),
    visibility: 'EPHEMERAL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'SECONDARY', customId: 'bc:entry:service-center', label: '🐈‍⬛ 返回服务中心' }
        ]
      }
    ]
  };
}

export function buildCurrentUserProfileMessage(input: CurrentUserProfileSummary): MessageSpec {
  const balance = input.balance;
  return {
    title: '👤 个人中心',
    body: [
      `**玩家账户**\n${input.user.displayName}`,
      '',
      '**🐟 猫条钱包**',
      `账本余额：${formatCustomerMoney(balance.ledgerBalanceMinor, balance.currency)}`,
      `预留：${formatCustomerMoney(balance.reservedMinor, balance.currency)}`,
      `可用：${formatCustomerMoney(balance.availableMinor, balance.currency)}`,
      '',
      '**📊 账户统计**',
      `进行中订单：${input.statistics.activeOrderCount}`,
      `累计订单消费：${formatCustomerMoney(input.statistics.orderSpendMinor, input.statistics.currency)}`,
      `累计礼物消费：${formatCustomerMoney(input.statistics.giftSpendMinor, input.statistics.currency)}`,
      '',
      `-# 余额计算时间：${balance.calculatedAt}`
    ].join('\n'),
    visibility: 'EPHEMERAL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:profile:refresh',
            label: '🔄 刷新余额'
          }
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:profile:orders:first',
            label: '📋 我的订单'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:profile:consumptions:first',
            label: '🧾 消费记录'
          }
        ]
      }
    ]
  };
}

export interface PaginationNavigation {
  previousCursor: string | null;
}

export function buildCurrentUserOrdersMessage(
  page: CurrentUserOrderPage,
  navigation: PaginationNavigation = { previousCursor: null }
): MessageSpec {
  return {
    title: '📋 我的订单',
    body: page.items.length
      ? page.items
          .map(
            (item) =>
              `**#${item.publicId} · ${item.status}**\n${item.gameKey ?? '-'} / ${item.serviceKey ?? '-'} · ${formatCustomerMoney(item.amountMinor, item.currency)}\n-# ${item.createdAt}`
          )
          .join('\n\n')
      : '暂无订单。',
    visibility: 'EPHEMERAL',
    components: paginationRows('bc:profile:orders', page.nextCursor, navigation, 'bc:profile:open', '👤 返回个人中心')
  };
}

export function buildCurrentUserConsumptionsMessage(
  page: ConsumptionPage,
  navigation: PaginationNavigation = { previousCursor: null }
): MessageSpec {
  return {
    title: '🧾 消费记录',
    body: page.items.length
      ? page.items
          .map(
            (item) =>
              `**${item.type} · ${item.targetDisplay}**\n${formatCustomerMoney(item.amountMinor, item.currency)}\n-# ${item.occurredAt}`
          )
          .join('\n\n')
      : '暂无消费记录。',
    visibility: 'EPHEMERAL',
    components: paginationRows(
      'bc:profile:consumptions',
      page.nextCursor,
      navigation,
      'bc:profile:open',
      '👤 返回个人中心'
    )
  };
}

export function buildCurrentPlayerWeeklyReportListMessage(
  page: CurrentPlayerWeeklyReportPage,
  navigation: PaginationNavigation = { previousCursor: null }
): MessageSpec {
  return {
    title: '📊 我的周报',
    body: page.items.length
      ? page.items.map((item) => `${item.periodStart} 至 ${item.periodEnd} · ${item.status}`).join('\n')
      : '暂无周报。',
    visibility: 'EPHEMERAL',
    components: [
      ...page.items.slice(0, 4).map((item): ActionRowSpec => ({
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:reports:detail:${item.id}`,
            label: `${item.periodStart.slice(0, 10)} 周报`
          }
        ]
      })),
      ...paginationRows('bc:reports:list', page.nextCursor, navigation, 'bc:entry:player-workbench', '🎧 返回工作台')
    ]
  };
}

function paginationRows(
  prefix: string,
  nextCursor: string | null,
  navigation: PaginationNavigation,
  returnCustomId: string,
  returnLabel: string
): ActionRowSpec[] {
  const components: ActionRowSpec['components'] = [
    { type: 'BUTTON', style: 'SECONDARY', customId: returnCustomId, label: returnLabel }
  ];
  if (navigation.previousCursor !== null) {
    components.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId:
        navigation.previousCursor === 'first'
          ? `${prefix}:first`
          : paginationCustomId(prefix, navigation.previousCursor),
      label: '← 上一页'
    });
  }
  if (nextCursor) {
    components.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: paginationCustomId(prefix, nextCursor),
      label: '下一页 →'
    });
  }
  return [{ type: 'ACTION_ROW', components }];
}

export function buildCurrentPlayerWeeklyReportDetailMessage(report: CurrentPlayerWeeklyReport): MessageSpec {
  const metrics = report.metrics;
  return {
    title: '📊 我的周报详情',
    body: [
      `**${report.periodStart} 至 ${report.periodEnd}**\n状态：${report.status}`,
      '',
      '**服务数据**',
      `完成订单：${metrics.completedOrderCount} · 取消：${metrics.cancelledOrderCount} · 服务：${metrics.serviceMinutes} 分钟`,
      '',
      '**收益明细**',
      `订单收益：${formatPlatformMoney(metrics.orderEarningMinor, report.currency)} · 礼物收益：${formatPlatformMoney(metrics.giftEarningMinor, report.currency)}`,
      `调整：${formatPlatformMoney(metrics.adjustmentMinor, report.currency)}`,
      `待确认：${formatPlatformMoney(metrics.pendingMinor, report.currency)} · 可结算：${formatPlatformMoney(metrics.settlementReadyMinor, report.currency)}`,
      `已入批次：${formatPlatformMoney(metrics.batchedMinor, report.currency)}`,
      '',
      `-# 修订版本：${report.currentRevision}`
    ].join('\n'),
    visibility: 'EPHEMERAL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:reports:list:first',
            label: '📊 返回周报'
          }
        ]
      }
    ]
  };
}

function formatPlatformMoney(amountMinor: number, currency: string): string {
  if (currency === 'CAT') return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
  const prefix = `${currency}\u00a0`;
  return `${prefix}${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100)}`;
}

function formatCustomerMoney(amountMinor: number, currency: string): string {
  if (currency !== 'CAT') throw new Error('Customer wallet display requires canonical CAT subunits.');
  return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
}
