import { type BotActorContext, type BotApiClient } from './service-center-api.js';
import { type BotFlowResult, type ComponentSpec, type MessageSpec } from './service-center-components.js';
import { buildExperienceMessage } from './discord-experience.js';
import { formatApiError } from './service-center-shared.js';

export function buildSupportRatingMessage(orderId: string): MessageSpec {
  return buildExperienceMessage({
    title: '这次猫舍前台照顾得怎么样？',
    icon: '⭐',
    introduction: '谢谢老板愿意留一点真实感受，这会帮助我们把下一次服务做得更贴心。',
    visibility: 'EPHEMERAL',
    density: 'EPHEMERAL_FEEDBACK',
    tone: 'BRAND',
    coreFacts: [{ name: '🛎️ 评价对象', value: '本次订单中实际为你回复的客服' }],
    nextStep: '请选择 1–5 分；评价不会影响订单扣款或任何陪玩收益。',
    components: [
      {
        type: 'ACTION_ROW',
        components: [1, 2, 3, 4, 5].map((score): ComponentSpec => ({
          type: 'BUTTON',
          style: score <= 2 ? 'DANGER' : 'SECONDARY',
          customId: `bc:support-rating:${orderId}:s${score}`,
          label: `${score} 分`
        }))
      }
    ]
  });
}

export function buildLowRatingReasonMessage(orderId: string, score: number): MessageSpec {
  const reasons = [
    ['RUDE_LANGUAGE', '言语不礼貌'],
    ['COLD_OR_DISMISSIVE', '态度冷淡'],
    ['RESPONSIBILITY_SHIRKING', '推卸责任'],
    ['PRESSURING_CUSTOMER', '催促或施压'],
    ['OTHER', '其他']
  ] as const;
  return buildExperienceMessage({
    title: '请告诉我们最需要改进的地方',
    icon: '📝',
    introduction: '你的低分反馈会被认真记录，不需要在这里写很长的说明。',
    visibility: 'EPHEMERAL',
    density: 'EPHEMERAL_FEEDBACK',
    tone: 'INFO',
    coreFacts: [{ name: '🧭 记录说明', value: `${score} 分 · 请选择一个最主要原因` }],
    nextStep: '选择“其他”时会再打开一个简短文字框。',
    components: [
      {
        type: 'ACTION_ROW',
        components: reasons.map(([reason, label]) => ({
          type: 'BUTTON' as const,
          style: 'SECONDARY' as const,
          customId: `bc:support-rating:${orderId}:s${score}:r${reason}`,
          label
        }))
      }
    ]
  });
}

export async function handleSupportRatingAction(input: {
  api: BotApiClient;
  actor: BotActorContext;
  orderId: string;
  score: number | null;
  reason: string | null;
  idempotencyKey: string;
}): Promise<BotFlowResult> {
  if (input.score === null) {
    return {
      kind: 'SHOW_SUPPORT_RATING',
      message: buildSupportRatingMessage(input.orderId)
    };
  }
  if (input.score <= 2 && !input.reason) {
    return {
      kind: 'SHOW_SUPPORT_RATING',
      message: buildLowRatingReasonMessage(input.orderId, input.score)
    };
  }
  if (input.reason === 'OTHER') {
    return {
      kind: 'SHOW_MODAL',
      modal: {
        title: '📝 补充客服评价',
        customId: `bc:support-rating-comment:${input.orderId}:s${input.score}`,
        components: [
          {
            type: 'TEXT_INPUT',
            customId: 'comment',
            label: '请简要说明',
            style: 'PARAGRAPH',
            required: true,
            maxLength: 500
          }
        ]
      }
    };
  }
  try {
    await input.api.submitSupportRating(
      input.orderId,
      { score: input.score, reason: input.reason },
      input.actor,
      input.idempotencyKey
    );
    return { kind: 'EPHEMERAL_MESSAGE', message: '✨ 谢谢老板认真告诉我们，评价已经记录。' };
  } catch (error) {
    return {
      kind: 'EPHEMERAL_MESSAGE',
      message: formatApiError(error, '提交客服评价')
    };
  }
}
