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
      : [`陪玩名单：${order.readiness.player ? readinessMilestone(order.readiness.player) : '等待 API 返回'}`];
    const allPlayersReady = order.readiness.allActivePlayersReady;
    const controls: ComponentSpec[] = [
      {
        type: 'BUTTON',
        style: 'DANGER',
        customId: `bc:order:${order.orderId}:cancel:v${order.version}`,
        label: '取消订单'
      },
      {
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:service:support:${order.orderId}:v${order.version}`,
        label: '我要申诉'
      },
      ...(order.actorRole === 'CUSTOMER' && giftsEnabled
        ? [
            {
              type: 'BUTTON' as const,
              style: 'SECONDARY' as const,
              customId: `bc:gift:open:${order.orderId}:v${order.version}`,
              label: '赠送礼物'
            }
          ]
        : []),
      refreshOrderControl(order.orderId)
    ];
    if (order.actorRole === 'PLAYER')
      controls.unshift({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:ready:${order.orderId}:v${order.version}`,
        label: '我已就绪'
      });

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
        ? '全部有效陪玩都已就绪，等待业务 API 确认进入服务中。'
        : '仍有陪玩尚未就绪；只有全部有效陪玩 READY 后才会开始服务。',
      nextStep:
        order.actorRole === 'PLAYER'
          ? '尚未确认的陪玩点击“我已就绪”；如果准备遇到问题，可随时申诉。'
          : '老板无需提交就绪；请等待全部陪玩确认，或在需要时联系猫舍前台。',
      components: [
        {
          type: 'ACTION_ROW',
          components: controls
        }
      ]
    });
  }

  if (order.status === 'IN_SERVICE') {
    const components: ComponentSpec[] = orderMenuControls(order.orderId, order.version);
    if (order.actorRole === 'PLAYER') {
      components.unshift({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:request-completion:${order.orderId}:v${order.version}`,
        label: '申请完成'
      });
    }
    if (order.actorRole === 'CUSTOMER' && giftsEnabled)
      components.unshift({
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:gift:open:${order.orderId}:v${order.version}`,
        label: '赠送礼物'
      });

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
          ? '服务结束后由陪玩点击“申请完成”；需要协助时可申诉。'
          : '请继续享受服务；陪玩提交完成申请后，你会在这里确认。',
      components: [{ type: 'ACTION_ROW', components }]
    });
  }

  if (order.status === 'PENDING_CONFIRMATION') {
    const components: ComponentSpec[] = orderMenuControls(order.orderId, order.version);
    if (order.actorRole === 'CUSTOMER') {
      components.unshift({
        type: 'BUTTON',
        style: 'PRIMARY',
        customId: `bc:service:confirm:${order.orderId}:v${order.version}`,
        label: '确认完成'
      });
      if (giftsEnabled)
        components.push({
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:gift:open:${order.orderId}:v${order.version}`,
          label: '赠送礼物'
        });
    }

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
          ? '核对无误后点击“确认完成”；确认后才会完成订单结算。'
          : '请等待老板确认；如有异议或需协助，可发起申诉。',
      components: [{ type: 'ACTION_ROW', components }]
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
      progress: '订单与资金结果已由业务 API 记录；本卡不重新计算收益或金额。',
      nextStep: '如需查看明细、补充反馈或申诉，请使用下方入口。',
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            refreshOrderControl(order.orderId),
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${order.orderId}:v${order.version}`,
              label: '我要申诉'
            }
          ]
        }
      ]
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
      components: [
        {
          type: 'ACTION_ROW',
          components: [
            {
              type: 'BUTTON',
              style: 'SECONDARY',
              customId: `bc:service:support:${order.orderId}:v${order.version}`,
              label: '联系客服'
            },
            refreshOrderControl(order.orderId)
          ]
        }
      ]
    };
  }

  return {
    title: `📋 订单 #${order.publicId}`,
    body: `当前状态：${order.status}`,
    visibility: 'PRIVATE_CHANNEL',
    components: [{ type: 'ACTION_ROW', components: [refreshOrderControl(order.orderId)] }]
  };
}

function readinessMilestone(value: 'READY' | 'NOT_READY'): string {
  return value === 'READY' ? '✅ 已就绪' : '⏳ 未就绪';
}

function orderMenuControls(orderId: string, version: number): ComponentSpec[] {
  return [
    refreshOrderControl(orderId),
    {
      type: 'BUTTON',
      style: 'DANGER',
      customId: `bc:order:${orderId}:cancel:v${version}`,
      label: '取消订单'
    },
    {
      type: 'BUTTON',
      style: 'SECONDARY',
      customId: `bc:service:support:${orderId}:v${version}`,
      label: '我要申诉'
    }
  ];
}

function refreshOrderControl(orderId: string): ComponentSpec {
  return {
    type: 'BUTTON',
    style: 'SECONDARY',
    customId: `bc:order:${orderId}:refresh`,
    label: '刷新订单'
  };
}
