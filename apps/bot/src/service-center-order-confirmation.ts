import { BOT_COPY } from './bot-copy.js';
import {
  type BalanceSummary,
  type CancellationPreviewSummary,
  type CancellationResultSummary,
  type OrderEstimateSummary,
  type OrderRequirementPageSummary,
  type OrderSummary
} from './service-center-api.js';
import { type MessageSpec } from './service-center-components.js';
import { buildExperienceMessage } from './discord-experience.js';
import { orderStatusDisplay } from './order-display.js';
import {
  formatRequirementDuration,
  customerOrderActionRows,
  refreshOrderControl,
  customerOrderUtilityRows,
  cancelOrderControl,
  formatGame,
  formatService,
  formatRegion,
  formatEstimateDuration,
  formatCustomerMoney,
  missingConfirmationFields,
  confirmationBlockedReason
} from './service-center-shared.js';

export function buildMatchingProgressMessage(order: OrderSummary): MessageSpec {
  const matching = order.matching;
  if (!matching) {
    return {
      title: `📋 订单 #${order.publicId}`,
      body: BOT_COPY.orders.matchingUnavailable,
      visibility: 'PRIVATE_CHANNEL',
      components: customerOrderActionRows(order)
    };
  }
  if (matching.stage === 'ACCEPTED') {
    return {
      title: `✅ 订单 #${order.publicId} · 已匹配`,
      body: [`接单陪玩：${matching.playerSummary?.displayName ?? '已接单陪玩'}`, '下一步：请确认已准备好开始服务'].join(
        '\n'
      ),
      visibility: 'PRIVATE_CHANNEL',
      components: customerOrderActionRows(order)
    };
  }
  const nextStep =
    matching.nextStep === 'CHOOSE_CONTINUE_OR_CANCEL'
      ? '下一步：继续等待、取消订单或联系客服'
      : '下一步：请等待陪玩接单';
  const hasAssemblyProgress =
    Number.isSafeInteger(matching.requestedPlayerCount) &&
    Number.isSafeInteger(matching.filledPlayerCount) &&
    Number(matching.requestedPlayerCount) > 0;
  const remainingPlayerCount = hasAssemblyProgress
    ? Math.max(0, Number(matching.requestedPlayerCount) - Number(matching.filledPlayerCount))
    : null;
  return {
    title: `🔎 订单 #${order.publicId} · ${matching.stage === 'TIMED_OUT' ? '本轮匹配结束' : '正在匹配陪玩'}`,
    body: [
      `已通知符合条件的陪玩：${matching.notifiedCandidateCount} 人`,
      hasAssemblyProgress ? `陪玩到位：${matching.filledPlayerCount}/${matching.requestedPlayerCount}` : null,
      remainingPlayerCount && remainingPlayerCount > 0
        ? `还差 ${remainingPlayerCount} 位，全部到齐后开放准备确认`
        : null,
      matching.timeoutAt ? `本轮截止：${matching.timeoutAt}` : null,
      nextStep
    ]
      .filter(Boolean)
      .join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: customerOrderActionRows(order)
  };
}

export function buildCancellationPreviewMessage(preview: CancellationPreviewSummary): MessageSpec {
  const handling = preview.staffTaskRequired ? '提交客服核对；不会自动退款、扣款或释放预留' : '确认后立即处理';
  return buildExperienceMessage({
    title: '取消订单前请确认',
    icon: '⚠️',
    introduction: '这是高风险操作，请先核对资金影响；当前页面只是一份预览。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'HIGH_RISK',
    tone: preview.staffTaskRequired ? 'WAITING' : 'DANGER',
    coreFacts: [
      {
        name: '🐟 资金影响',
        value: [
          `释放预留：${formatCustomerMoney(preview.releaseAmountMinor, preview.currency)}`,
          `退款：${formatCustomerMoney(preview.refundAmountMinor, preview.currency)}`
        ].join('\n')
      },
      { name: '🛎️ 处理方式', value: `${handling}\n预览有效期：${preview.validUntil}` }
    ],
    progress: '本次预览没有取消订单，也没有改变任何资金状态。',
    nextStep: preview.staffTaskRequired
      ? '核对后提交客服处理；如不确定，请返回订单保持现状。'
      : '确定取消时点击危险色按钮；否则返回订单，不会产生写入。',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: preview.staffTaskRequired ? 'SECONDARY' : 'DANGER',
            customId: `bc:cancel:${preview.orderId}:${preview.previewId}:confirm:v${preview.orderVersion}`,
            label: preview.staffTaskRequired ? '提交客服处理' : '确认取消'
          }
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${preview.orderId}:refresh`,
            label: '暂不取消，返回订单'
          }
        ]
      }
    ]
  });
}

export function buildOrderConfirmationMessage(input: {
  order: OrderSummary;
  estimate: OrderEstimateSummary;
  balance: BalanceSummary;
}): MessageSpec {
  const missing = missingConfirmationFields(input.order);
  const currencyMismatch = input.estimate.currency !== input.balance.currency;
  const deficitMinor = Math.max(0, input.estimate.amountMinor - input.balance.availableMinor);
  const canSubmit = missing.length === 0 && deficitMinor === 0 && !currencyMismatch;
  const statusLine = canSubmit
    ? '状态：可以提交。提交时系统会再次复核价格、余额和服务内容。'
    : confirmationBlockedReason({
        missing,
        deficitMinor,
        estimateCurrency: input.estimate.currency,
        currencyMismatch
      });

  return {
    title: `📋 订单 #${input.order.publicId} · 最后确认`,
    body: [
      '**委托内容**',
      `游戏：${formatGame(input.order.game)}`,
      `服务：${formatService(input.order.service)}`,
      `区服：${formatRegion(input.order.region)}`,
      `时长：${formatEstimateDuration(input.estimate)}`,
      '匹配方式：按已认证的游戏与服务标签',
      input.order.notes ? `备注：${input.order.notes}` : '备注：未填写',
      '',
      '**价格与余额**',
      `预计价格：${formatCustomerMoney(input.estimate.amountMinor, input.estimate.currency)}`,
      `可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`,
      '',
      '**提交须知**',
      '取消规则：提交前取消不预留；提交后、服务开始前取消将释放预留，异常由客服处理。',
      statusLine,
      `价格有效期：${input.estimate.validUntil}`
    ].join('\n'),
    visibility: 'PRIVATE_CHANNEL',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${input.order.id}:submit-final:v${input.order.version}`,
            label: '提交订单并预留猫条',
            disabled: !canSubmit
          }
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${input.order.id}:refresh`,
            label: '刷新最新状态'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:service:support:${input.order.id}:v${input.order.version}`,
            label: '联系猫舍前台'
          },
          ...(deficitMinor > 0
            ? [
                {
                  type: 'BUTTON' as const,
                  style: 'SECONDARY' as const,
                  customId: 'bc:service-center:recharge',
                  label: '联系前台充值'
                }
              ]
            : [])
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [cancelOrderControl(input.order)]
      }
    ]
  };
}

export function buildMultiProjectOrderConfirmationMessage(input: {
  order: OrderSummary;
  requirements: OrderRequirementPageSummary;
  balance: BalanceSummary;
}): MessageSpec {
  const active = input.requirements.items.filter((item) => item.status === 'ACTIVE');
  const currencyMismatch = input.requirements.currency !== input.balance.currency;
  const deficitMinor = Math.max(0, input.requirements.derivedTotalMinor - input.balance.availableMinor);
  const canSubmit = active.length > 0 && !currencyMismatch && deficitMinor === 0;
  const lines = active
    .map(
      (item, index) =>
        `${index + 1}. ${item.gameDisplayName} · ${item.serviceDisplayName}${item.regionDisplayName ? ` · ${item.regionDisplayName}` : ''}\n   ${formatRequirementDuration(item)} × ${item.requestedPlayerCount} 位 · ${formatCustomerMoney(item.estimatedLinePriceMinor, input.requirements.currency)}${item.customerNote ? `\n   偏好：${item.customerNote}` : ''}`
    )
    .join('\n');
  const submissionStatus = canSubmit
    ? '可以提交 · 系统会再次校验服务内容、价格和余额。'
    : currencyMismatch
      ? '暂不可提交 · 订单币种与钱包币种不一致。'
      : active.length === 0
        ? '暂不可提交 · 请先添加至少一个陪玩项目。'
        : `暂不可提交 · 可用余额还差 ${formatCustomerMoney(deficitMinor, input.requirements.currency)}。`;
  return buildExperienceMessage({
    title: `订单 ${input.order.publicId} · 第 4/4 步 · 最后确认`,
    icon: '📋',
    introduction: '提交前最后看一眼：确认的是最终陪玩清单与当前报价，提交后只创建资金预留。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: canSubmit ? 'SUCCESS' : 'WAITING',
    bossRequest: input.order.notes || null,
    nextStep: canSubmit
      ? '点击“提交订单并预留猫条”；系统只会创建预留，此时不会正式扣款。'
      : '返回编辑或补足钱包后刷新本页。',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:req:${input.order.id}:back:v${input.requirements.orderVersion}`,
            label: '返回编辑'
          },
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:order:${input.order.id}:submit-final:v${input.requirements.orderVersion}`,
            label: '提交订单并预留猫条',
            disabled: !canSubmit
          }
        ]
      },
      ...customerOrderUtilityRows(input.order)
    ],
    layout: 'COMPONENTS_V2',
    coreFacts: [
      { name: '🧭 下单进度', value: '第 4/4 步 · 核对并提交' },
      { name: '🎮 陪玩清单', value: lines || '还没有添加陪玩项目。' },
      {
        name: '🐟 价格与钱包',
        value: `订单合计：${formatCustomerMoney(input.requirements.derivedTotalMinor, input.requirements.currency)}\n可用余额：${formatCustomerMoney(input.balance.availableMinor, input.balance.currency)}`
      },
      { name: '✅ 提交状态', value: submissionStatus }
    ]
  });
}

export function buildCancellationResultMessage(input: CancellationResultSummary): MessageSpec {
  if (input.status !== 'CANCELLED') {
    return buildExperienceMessage({
      title: input.staffTaskId ? '取消申请已转客服' : '取消结果待核对',
      icon: input.staffTaskId ? '🛎️' : '⚠️',
      introduction: input.staffTaskId
        ? '猫舍前台已经接手，会核对订单、服务进度和资金状态。'
        : '当前还无法确认订单已取消，请以最新订单状态为准。',
      visibility: 'PRIVATE_CHANNEL',
      density: 'HIGH_RISK',
      tone: 'WAITING',
      coreFacts: [
        { name: '📋 当前订单状态', value: orderStatusDisplay(input.status) },
        ...(input.staffTaskId ? [{ name: '🛎️ 客服任务', value: input.staffTaskId }] : [])
      ],
      progress: '写入结果仍以最新订单状态为准；当前不会自动退款或释放预留。',
      nextStep: input.staffTaskId
        ? '等待猫舍前台同步结果；期间不要连续提交取消。'
        : '刷新订单核对最新状态；如仍无法判断，请联系猫舍前台。',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${input.orderId}:v${input.version}`,
              label: '联系猫舍前台'
            },
            refreshOrderControl(input.orderId)
          ]
        }
      ]
    });
  }
  return buildExperienceMessage({
    title: '订单已取消',
    icon: '🥀',
    introduction: '这次委托没能继续走下去。订单已结束，资金结果请按下方事实核对。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'HIGH_RISK',
    tone: 'DANGER',
    coreFacts: [
      { name: '📋 订单结果', value: '已取消' },
      {
        name: '🐟 资金结果',
        value: input.releasedReservation
          ? `已释放预留：${formatCustomerMoney(input.releasedReservation.releasedMinor, input.releasedReservation.currency)}\n资金处理：${cancellationFundActionDisplay(input.fundAction)}`
          : `资金处理：${cancellationFundActionDisplay(input.fundAction)}\n没有可展示的预留释放金额`
      }
    ],
    progress: '订单已取消；资金结果以本卡显示为准。',
    nextStep: '如对取消或资金结果有疑问，请从订单入口联系猫舍前台。',
    components: [{ type: 'ACTION_ROW', components: [refreshOrderControl(input.orderId)] }]
  });
}

function cancellationFundActionDisplay(fundAction: string): string {
  const labels: Readonly<Record<string, string>> = {
    RELEASE_RESERVATION: '释放订单预留',
    REFUND_CAPTURED_PAYMENT: '退回已扣款项',
    NONE: '无需资金处理'
  };
  return labels[fundAction] ?? '等待资金结果确认';
}
