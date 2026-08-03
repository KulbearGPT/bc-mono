import { BOT_COPY } from './bot-copy.js';
import { buildExperienceMessage } from './discord-experience.js';
import type { OrderLifecyclePanelSummary } from './service-center-api.js';
import type { ComponentSpec, MessageSpec } from './service-center-components.js';

export function buildServiceLifecyclePanelMessage(order: OrderLifecyclePanelSummary): MessageSpec {
  const giftsEnabled = Array.isArray(order.enabledFeatures) && order.enabledFeatures.includes('GIFTS');

  if (order.status === 'ACCEPTED') {
    const participants = order.readiness.participants;
    const playerLines = participants.length
      ? participants.map((participant) => `${participant.displayName}：${readinessMilestone(participant.readiness)}`)
      : ['陪玩名单：正在同步'];
    const allPlayersReady = order.readiness.allActivePlayersReady;
    const components = lifecycleActionRows(order, giftsEnabled);

    return buildExperienceMessage({
      title: `订单 #${order.publicId} · 等待陪玩全员就绪`,
      icon: '🤝',
      introduction: '人已经找齐啦～所有本单陪玩确认准备好之后，系统才会开始本次服务。',
      visibility: 'PRIVATE_CHANNEL',
      density: 'PRIVATE_ORDER',
      tone: 'WAITING',
      coreFacts: [
        {
          name: '👥 就绪名单',
          value: playerLines.join('\n')
        },
        ...(order.readiness.readyDeadlineAt ? [{ name: '⏰ 确认时限', value: order.readiness.readyDeadlineAt }] : [])
      ],
      progress: allPlayersReady
        ? '全部有效陪玩都已就绪，正在更新订单状态。'
        : '仍有陪玩尚未就绪；只有全部有效陪玩确认就绪后才会开始服务。',
      nextStep:
        order.actorRole === 'PLAYER'
          ? '尚未确认的陪玩点击“陪玩：我已准备好”；如果准备遇到问题，可联系猫舍前台。'
          : '老板无需提交就绪；请等待全部陪玩确认，或在需要时联系猫舍前台。',
      components
    });
  }

  if (order.status === 'IN_SERVICE') {
    const components = lifecycleActionRows(order, giftsEnabled);

    return buildExperienceMessage({
      title: `订单 #${order.publicId} · 陪玩服务已开始`,
      icon: '🎮',
      introduction: '全员就绪，这次陪伴正式开始啦。祝你们玩得开心～',
      visibility: 'PRIVATE_CHANNEL',
      density: 'PRIVATE_ORDER',
      tone: 'SUCCESS',
      coreFacts: [
        { name: '🎮 服务状态', value: '服务进行中' },
        { name: '⏱️ 开始时间', value: order.readiness.startedAt ?? '已开始，精确时间暂未回传' }
      ],
      progress: '服务进行中；尚未提交完成申请。',
      nextStep:
        order.actorRole === 'PLAYER'
          ? '服务结束后由陪玩点击“陪玩：提交服务完成”；需要协助时可联系猫舍前台。'
          : '请继续享受服务；陪玩提交完成申请后，你会在这里确认。',
      components
    });
  }

  if (order.status === 'PENDING_CONFIRMATION') {
    const components = lifecycleActionRows(order, giftsEnabled);

    return buildExperienceMessage({
      title: `订单 #${order.publicId} · 等待老板确认完成`,
      icon: '📨',
      introduction: '陪玩已经提交完成申请，现在需要老板做最后确认。',
      visibility: 'PRIVATE_CHANNEL',
      density: 'PRIVATE_ORDER',
      tone: 'WAITING',
      coreFacts: [{ name: '📨 完成申请', value: BOT_COPY.orders.completionPending }],
      progress: '服务已暂停在完成确认阶段，尚未完成最终结算。',
      nextStep:
        order.actorRole === 'CUSTOMER'
          ? '核对无误后点击“老板：确认服务完成”；确认后才会完成订单结算。'
          : '请等待老板确认；如有异议或需协助，可联系猫舍前台。',
      components
    });
  }

  if (order.status === 'COMPLETED')
    return buildExperienceMessage({
      title: `订单 #${order.publicId} · 服务圆满完成`,
      icon: '✨',
      introduction: '谢谢老板与陪玩今天的相伴，这次服务已经顺利收尾。',
      visibility: 'PRIVATE_CHANNEL',
      density: 'PRIVATE_ORDER',
      tone: 'SUCCESS',
      coreFacts: [{ name: '✅ 服务结果', value: '已完成' }],
      progress: '订单已完成；资金与收益结果以本卡显示为准。',
      nextStep: '如需查看明细、补充反馈或申诉，请使用下方入口。',
      components: lifecycleActionRows(order, giftsEnabled)
    });

  if (order.status === 'EXCEPTION' || order.readiness.staffTaskId) {
    return {
      title: `🛎️ 订单 #${order.publicId} · 客服处理中`,
      body: [
        order.readiness.staffTaskId
          ? `客服任务已创建：${order.readiness.staffTaskId}`
          : '客服任务已创建，等待客服核对。',
        BOT_COPY.orders.staffReviewScope
      ].join('\n'),
      visibility: 'PRIVATE_CHANNEL',
      components: lifecycleActionRows(order, giftsEnabled)
    };
  }

  return {
    title: `📋 订单 #${order.publicId}`,
    body: `当前状态：${order.status}`,
    visibility: 'PRIVATE_CHANNEL',
    components: lifecycleActionRows(order, giftsEnabled)
  };
}

function readinessMilestone(value: 'READY' | 'NOT_READY'): string {
  return value === 'READY' ? '✅ 已就绪' : '⏳ 未就绪';
}

function refreshOrderControl(orderId: string): ComponentSpec {
  return {
    type: 'BUTTON',
    style: 'SECONDARY',
    customId: `bc:order:${orderId}:refresh`,
    label: '刷新最新状态'
  };
}

function lifecycleActionRows(order: OrderLifecyclePanelSummary, giftsEnabled: boolean): MessageSpec['components'] {
  const actions = (order.availableActions ?? []).filter((action) => action.enabled && action.role === order.actorRole);
  const primary: ComponentSpec[] = [];
  const utility: ComponentSpec[] = [];
  const danger: ComponentSpec[] = [];
  for (const action of actions) {
    if (action.key === 'PLAYER_SET_READINESS')
      primary.push({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:ready:${order.orderId}:v${order.version}`,
        label: '陪玩：我已准备好'
      });
    if (action.key === 'PLAYER_REQUEST_COMPLETION')
      primary.push({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:request-completion:${order.orderId}:v${order.version}`,
        label: '陪玩：提交服务完成'
      });
    if (action.key === 'CUSTOMER_CONFIRM_COMPLETION')
      primary.push({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:confirm:${order.orderId}:v${order.version}`,
        label: '老板：确认服务完成'
      });
    if (action.key === 'CUSTOMER_SEND_GIFT' && giftsEnabled)
      utility.push({
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:gift:open:${order.orderId}:v${order.version}`,
        label: '赠送礼物'
      });
    if (action.key === 'CUSTOMER_REFRESH_ORDER' || action.key === 'PLAYER_REFRESH_WORKBENCH')
      utility.push(refreshOrderControl(order.orderId));
    if (action.key === 'CUSTOMER_CONTACT_SUPPORT' || action.key === 'PLAYER_CONTACT_SUPPORT')
      utility.push({
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:service:support:${order.orderId}:v${order.version}`,
        label: '联系猫舍前台'
      });
    if (action.key === 'CUSTOMER_CANCEL_ORDER' || action.key === 'CUSTOMER_REQUEST_CANCELLATION')
      danger.push({
        type: 'BUTTON',
        style: 'DANGER',
        customId: `bc:order:${order.orderId}:cancel:v${order.version}`,
        label: action.key === 'CUSTOMER_REQUEST_CANCELLATION' ? '申请取消订单' : '取消订单'
      });
    if (action.key === 'CUSTOMER_VIEW_CANCELLATION_STATUS')
      utility.push({
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:order:${order.orderId}:cancel:v${order.version}`,
        label: '查看取消处理进度'
      });
  }
  return [
    ...(primary.length ? [{ type: 'ACTION_ROW' as const, components: primary }] : []),
    ...(utility.length ? [{ type: 'ACTION_ROW' as const, components: utility.slice(0, 3) }] : []),
    ...(danger.length ? [{ type: 'ACTION_ROW' as const, components: danger }] : [])
  ];
}
