import type { PlayerWorkbenchSummary } from './service-center-api.js';
import type { ActionRowSpec, ComponentSpec, MessageSpec } from './service-center-components.js';
import { DEFAULT_WALLET_DISPLAY_CONFIG, formatCustomerWalletAmount } from './wallet-display.js';

export function buildPlayerWorkbenchMessage(workbench: PlayerWorkbenchSummary): MessageSpec {
  const currentOrder = workbench.currentOrder
    ? `当前订单：#${workbench.currentOrder.publicId} · ${workbench.currentOrder.status}`
    : '当前订单：暂无';
  const failedChecks = workbench.eligibility.checks.filter((check) => !check.passed);
  const actions = (workbench.availableActions ?? []).filter((action) => action.enabled && action.role === 'PLAYER');
  const primary: ComponentSpec[] = [];
  if (workbench.currentOrder && actions.some((action) => action.key === 'PLAYER_OPEN_CURRENT_ORDER'))
    primary.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:order:${workbench.currentOrder.id}:open`,
      label: '打开当前订单'
    });
  if (workbench.currentOrder && actions.some((action) => action.key === 'PLAYER_SET_READINESS'))
    primary.push({
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:service:ready:${workbench.currentOrder.id}:v${workbench.currentOrder.version}`,
      label: '陪玩：我已准备好'
    });
  if (workbench.currentOrder && actions.some((action) => action.key === 'PLAYER_REQUEST_COMPLETION'))
    primary.push({
      type: 'BUTTON',
      style: 'PRIMARY',
      customId: `bc:service:request-completion:${workbench.currentOrder.id}:v${workbench.currentOrder.version}`,
      label: '陪玩：提交服务完成'
    });
  const utility: ComponentSpec[] = [
    {
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: 'bc:entry:player-workbench',
      label: '刷新陪玩工作台'
    },
    {
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: 'bc:reports:list:first',
      label: '查看我的周报'
    }
  ];
  if (workbench.currentOrder && actions.some((action) => action.key === 'PLAYER_CONTACT_SUPPORT'))
    utility.push({
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:service:support:${workbench.currentOrder.id}:v${workbench.currentOrder.version}`,
      label: '联系猫舍前台'
    });
  const components: ActionRowSpec[] = [
    ...(primary.length ? [{ type: 'ACTION_ROW' as const, components: primary }] : []),
    { type: 'ACTION_ROW', components: utility }
  ];
  return {
    title: '🎧 陪玩工作台',
    body: [
      '**接单状态**',
      `准入状态：${workbench.eligibility.eligible ? '可报名' : '暂不可报名'}`,
      failedChecks.length > 0
        ? `未满足条件：${failedChecks.map((check) => check.reason ?? check.code).join('；')}`
        : null,
      currentOrder,
      '可报名新单：请查看派单频道；报名不会占用正式订单名额。',
      '\n**收益概览**',
      `待确认收益：${formatPlatformMoney(workbench.earningsSummary.pendingMinor, workbench.earningsSummary.currency)}`,
      `已确认收益：${formatPlatformMoney(workbench.earningsSummary.confirmedMinor, workbench.earningsSummary.currency)}`,
      `已支付收益：${formatPlatformMoney(workbench.earningsSummary.paidMinor, workbench.earningsSummary.currency)}`,
      `\n-# 更新时间：${workbench.earningsSummary.calculatedAt}`
    ]
      .filter(Boolean)
      .join('\n'),
    visibility: 'EPHEMERAL',
    components
  };
}

function formatPlatformMoney(amountMinor: number, currency: string): string {
  if (currency !== 'CAT') throw new Error('Player earnings display requires canonical CAT subunits.');
  return formatCustomerWalletAmount(amountMinor, DEFAULT_WALLET_DISPLAY_CONFIG);
}
