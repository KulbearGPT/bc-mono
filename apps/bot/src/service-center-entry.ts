import { botCopy } from './bot-copy.js';
import { buildExperienceMessage } from './discord-experience.js';
import type { PlayerWorkbenchSummary } from './service-center-api.js';
import type { MessageSpec } from './service-center-components.js';

const dispatchEligibilityReasonLabels: Record<string, string> = {
  ACTIVE_REVIEW_STATUS: '陪玩资格当前不是可接单状态',
  MATCHING_TAGS: '本轮游戏或服务项目不在你的已认证范围内',
  DISCORD_ONLINE: 'Discord 当前未在线',
  AVAILABLE: '旧 availability 仅供诊断，不影响报名',
  NO_ACTIVE_ORDER: '已有进行中的订单'
};

export function buildDispatchIneligibleReply(workbench: PlayerWorkbenchSummary, requestId: string): string {
  const reasons = workbench.eligibility.checks
    .filter((check) => !check.passed)
    .map((check) => dispatchEligibilityReasonLabels[check.code] ?? check.code);
  return botCopy.dispatch.ineligible(reasons, requestId);
}

export function buildPublicServiceEntryMessage(): MessageSpec {
  return buildExperienceMessage({
    title: '陪玩服务中心',
    icon: '🐈‍⬛',
    introduction: '今晚想玩什么？黑猫会陪你把需求一步步说明白。',
    visibility: 'PUBLIC',
    density: 'PUBLIC_WELCOME',
    tone: 'BRAND',
    coreFacts: [
      { name: '🎮 创建新订单', value: '用四步选择游戏、项目和人数，提交前会再次核对价格与需求。' },
      { name: '🐾 继续当前旅程', value: '已有进行中订单时，我们会带你回到原来的私密订单频道。' },
      { name: '🛎️ 下单前请留意', value: '每位客人同一时间只能有一个进行中的订单；需要充值或协助可进入服务中心。' }
    ],
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          { type: 'BUTTON', style: 'PRIMARY', customId: 'bc:entry:create-order', label: '🐾 创建订单' },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: 'bc:entry:service-center',
            label: '🐈‍⬛ 我的服务中心'
          }
        ]
      }
    ]
  });
}
