import { createHmac, timingSafeEqual } from 'node:crypto';
import { toDiscordModal, toDiscordUpdate } from './discord-renderer.js';
import { buildDiscordIdempotencyKey, type BotActorContext, type BotApiClient } from './service-center-api.js';
import type { OrderExperienceReviewCenter, OrderExperienceReviewTarget } from './service-center-api-contracts.js';
import type { MessageSpec, ModalSpec } from './service-center-components.js';
import type { ServiceCenterRoute } from './service-center-routes.js';
import { formatUserFacingError } from './user-facing-error.js';

const PAGE_SIZE = 25;
const STATE_SIGNATURE_BYTES = 6;

type ReviewButtonRoute = Extract<ServiceCenterRoute, { area: 'experience-review' }>;
type ReviewSelectRoute = Extract<
  ServiceCenterRoute,
  { area: 'experience-review-target-select' | 'experience-review-comment-select' }
>;
type ReviewModalRoute = Extract<ServiceCenterRoute, { area: 'experience-review-comment-modal' }>;

export function createReviewSelectionState(
  center: OrderExperienceReviewCenter,
  selectedTargetKeys: string[],
  actor: BotActorContext,
  secret: string
): string {
  const targets = selectableTargets(center);
  const selected = new Set(selectedTargetKeys);
  const lastIndex = targets.reduce((highest, target, index) => (selected.has(target.targetKey) ? index : highest), -1);
  const bytes = Buffer.alloc(lastIndex < 0 ? 0 : Math.floor(lastIndex / 8) + 1);
  for (let index = 0; index < targets.length; index += 1) {
    if (selected.has(targets[index]!.targetKey)) bytes[Math.floor(index / 8)]! |= 1 << (index % 8);
  }
  const bits = bytes.length ? bytes.toString('base64url') : '0';
  const signature = reviewStateSignature(center.orderId, bits, actor, secret);
  return `${bits}.${signature}`;
}

export function readReviewSelectionState(
  center: OrderExperienceReviewCenter,
  state: string,
  actor: BotActorContext,
  secret: string
): string[] {
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{8})$/u.exec(state);
  if (!match) throw new Error('Review selection state is invalid.');
  const bits = match[1]!;
  const actual = Buffer.from(match[2]!, 'base64url');
  const expected = Buffer.from(reviewStateSignature(center.orderId, bits, actor, secret), 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error('Review selection state is invalid.');
  const bytes = bits === '0' ? Buffer.alloc(0) : Buffer.from(bits, 'base64url');
  return selectableTargets(center).flatMap((target, index) =>
    (bytes[Math.floor(index / 8)] ?? 0) & (1 << (index % 8)) ? [target.targetKey] : []
  );
}

export function buildOrderExperienceReviewMessage(
  center: OrderExperienceReviewCenter,
  actor: BotActorContext,
  secret: string,
  options: { selectedTargetKeys?: string[]; page?: number } = {}
): MessageSpec {
  const orderTarget = center.targets.find((target) => target.targetType === 'ORDER');
  const allOtherTargets = selectableTargets(center);
  const writableTargets = allOtherTargets.filter((target) => target.review === null);
  const selected = [...new Set(options.selectedTargetKeys ?? [])].filter((key) =>
    writableTargets.some((target) => target.targetKey === key)
  );
  if (selected.length > 25) throw new Error('Discord review selection cannot exceed 25 targets.');
  const pageCount = Math.max(1, Math.ceil(allOtherTargets.length / PAGE_SIZE));
  const page = Math.max(0, Math.min(options.page ?? 0, pageCount - 1));
  const visibleTargets = allOtherTargets.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const visible = visibleTargets.filter((target) => target.review === null);
  const state = createReviewSelectionState(center, selected, actor, secret);
  const components: MessageSpec['components'] = [];

  if (orderTarget?.review === null) components.push(scoreRow((score) => `bc:r:${center.orderId}:o${score}`));

  if (visible.length) {
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'STRING_SELECT',
          customId: `bc:r:${center.orderId}:t${page}:${state}`,
          placeholder: '选择陪玩或猫舍前台（可选）',
          minValues: 0,
          maxValues: Math.min(25, visible.length),
          options: visible.map((target) => ({
            label: targetLabel(target).slice(0, 100),
            value: target.targetKey,
            default: selected.includes(target.targetKey)
          }))
        }
      ]
    });
  }

  if (selected.length) components.push(scoreRow((score) => `bc:r:${center.orderId}:s${score}:${state}`));

  if (pageCount > 1) {
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:r:${center.orderId}:p${Math.max(0, page - 1)}:${state}`,
          label: '上一页',
          disabled: page === 0
        },
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:r:${center.orderId}:p${Math.min(pageCount - 1, page + 1)}:${state}`,
          label: '下一页',
          disabled: page >= pageCount - 1
        }
      ]
    });
  }

  const commentable = [...(page === 0 && orderTarget ? [orderTarget] : []), ...visibleTargets].filter(
    (target) => target.review && !target.review.comment
  );
  if (commentable.length) {
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'STRING_SELECT',
          customId: `bc:r:${center.orderId}:c`,
          placeholder: '补充留言（可选）',
          minValues: 1,
          maxValues: 1,
          options: commentable.slice(0, 25).map((target) => ({
            label: targetLabel(target).slice(0, 100),
            value: target.review!.id,
            description: `已保存 ${target.review!.score} 星`
          }))
        }
      ]
    });
  }

  const visibleSummary = center.targets
    .filter((target) => target.targetType === 'ORDER' || visibleTargets.includes(target))
    .slice(0, 25)
    .map((target) => `${[...targetLabel(target)].slice(0, 24).join('')}：${reviewStatus(target)}`);
  return {
    title: `⭐ 评价本次服务 · ${center.orderPublicId}`,
    body: [
      '所有评价均为可选；点击星级即保存，之后可以直接离开。',
      '需要给多位陪玩同分时，先多选对象，再点一次星级。低分不会要求原因，留言也始终可选。',
      selected.length ? `已选择 ${selected.length} 个对象，请点击下方星级。` : '',
      center.hasPublishableFiveStar && !center.publication
        ? '已有五星记录；公开前还会单独展示安全预览并再次征求同意。'
        : '',
      center.publication ? '本单五星公开请求已记录，不会重复申请。' : ''
    ]
      .filter(Boolean)
      .join('\n'),
    visibility: 'EPHEMERAL',
    tone: 'BRAND',
    density: 'EPHEMERAL_FEEDBACK',
    fields: [
      { name: '评价状态', value: [...(visibleSummary.join('\n') || '暂无可评价对象')].slice(0, 1024).join('') },
      { name: '评价截止', value: center.expiresAt }
    ],
    components
  };
}

export async function executeOrderExperienceReviewButton(input: {
  interaction: {
    id: string;
    deferReply?(options: { ephemeral: true }): Promise<unknown>;
    deferUpdate(): Promise<unknown>;
    editReply(options: unknown): Promise<unknown>;
    followUp(options: { content: string; ephemeral: true }): Promise<unknown>;
  };
  route: ReviewButtonRoute;
  actor: BotActorContext;
  api: BotApiClient;
  secret: string;
}): Promise<void> {
  if (input.route.action === 'open') await input.interaction.deferReply?.({ ephemeral: true });
  else await input.interaction.deferUpdate();
  try {
    let center = await input.api.getOrderExperienceReview(input.route.orderId, input.actor);
    if (input.route.action === 'overall') {
      await input.api.createOrderExperienceRatings(
        input.route.orderId,
        { targetKeys: ['order'], score: input.route.score },
        input.actor,
        buildDiscordIdempotencyKey('review:rating:order', input.interaction.id)
      );
      center = await input.api.getOrderExperienceReview(input.route.orderId, input.actor);
    }
    if (input.route.action === 'rate') {
      const targetKeys = readReviewSelectionState(center, input.route.state, input.actor, input.secret).filter((key) =>
        center.targets.some((target) => target.targetKey === key && target.review === null)
      );
      if (!targetKeys.length) throw new Error('Review selection state is stale.');
      await input.api.createOrderExperienceRatings(
        input.route.orderId,
        { targetKeys, score: input.route.score },
        input.actor,
        buildDiscordIdempotencyKey('review:rating:targets', input.interaction.id)
      );
      center = await input.api.getOrderExperienceReview(input.route.orderId, input.actor);
    }
    const selectedTargetKeys =
      input.route.action === 'page'
        ? readReviewSelectionState(center, input.route.state, input.actor, input.secret)
        : [];
    await input.interaction.editReply(
      toDiscordUpdate(
        buildOrderExperienceReviewMessage(center, input.actor, input.secret, {
          selectedTargetKeys,
          page: input.route.action === 'page' ? input.route.page : 0
        })
      )
    );
  } catch (error) {
    await recoverReviewInteraction(input, error);
  }
}

export async function executeOrderExperienceReviewSelect(input: {
  interaction: {
    id?: string;
    values: string[];
    deferUpdate?(): Promise<unknown>;
    editReply?(options: unknown): Promise<unknown>;
    followUp?(options: { content: string; ephemeral: true }): Promise<unknown>;
    showModal(modal: unknown): Promise<unknown>;
  };
  route: ReviewSelectRoute;
  actor: BotActorContext;
  api: BotApiClient;
  secret: string;
}): Promise<void> {
  if (input.route.area === 'experience-review-comment-select') {
    const reviewId = input.interaction.values[0] ?? '';
    if (!uuid(reviewId)) throw new Error('Review comment selection is invalid.');
    await input.interaction.showModal(toDiscordModal(buildReviewCommentModal(input.route.orderId, reviewId)));
    return;
  }
  await input.interaction.deferUpdate?.();
  try {
    const center = await input.api.getOrderExperienceReview(input.route.orderId, input.actor);
    const previous = readReviewSelectionState(center, input.route.state, input.actor, input.secret);
    const visible = selectableTargets(center)
      .slice(input.route.page * PAGE_SIZE, input.route.page * PAGE_SIZE + PAGE_SIZE)
      .filter((target) => target.review === null);
    const visibleKeys = new Set(visible.map((target) => target.targetKey));
    const allowedSubmitted = input.interaction.values.filter((key) => visibleKeys.has(key));
    if (allowedSubmitted.length !== input.interaction.values.length)
      throw new Error('Review target selection is stale.');
    const selectedTargetKeys = [...previous.filter((key) => !visibleKeys.has(key)), ...allowedSubmitted];
    await input.interaction.editReply?.(
      toDiscordUpdate(
        buildOrderExperienceReviewMessage(center, input.actor, input.secret, {
          selectedTargetKeys,
          page: input.route.page
        })
      )
    );
  } catch (error) {
    try {
      const center = await input.api.getOrderExperienceReview(input.route.orderId, input.actor);
      await input.interaction.editReply?.(
        toDiscordUpdate(buildOrderExperienceReviewMessage(center, input.actor, input.secret))
      );
    } catch {
      // Keep the traceable follow-up below even when the recovery read also fails.
    }
    await input.interaction.followUp?.({
      content: formatUserFacingError(error, {
        operation: '选择评价对象',
        localRequestId: `discord-interaction-${input.interaction.id ?? 'unknown'}`
      }),
      ephemeral: true
    });
  }
}

export async function executeOrderExperienceReviewModal(input: {
  interaction: {
    id: string;
    deferUpdate(): Promise<unknown>;
    editReply(options: unknown): Promise<unknown>;
    followUp(options: { content: string; ephemeral: true }): Promise<unknown>;
    fields: { getTextInputValue(customId: string): string };
  };
  route: ReviewModalRoute;
  actor: BotActorContext;
  api: BotApiClient;
  secret: string;
}): Promise<void> {
  await input.interaction.deferUpdate();
  try {
    await input.api.appendOrderExperienceReviewComment(
      input.route.orderId,
      input.route.reviewId,
      { comment: input.interaction.fields.getTextInputValue('review-comment') },
      input.actor,
      buildDiscordIdempotencyKey('review:comment', input.interaction.id)
    );
    const center = await input.api.getOrderExperienceReview(input.route.orderId, input.actor);
    await input.interaction.editReply(
      toDiscordUpdate(buildOrderExperienceReviewMessage(center, input.actor, input.secret))
    );
  } catch (error) {
    await input.interaction.followUp({
      content: formatUserFacingError(error, {
        operation: '补充评价留言',
        localRequestId: `discord-interaction-${input.interaction.id}`
      }),
      ephemeral: true
    });
  }
}

function scoreRow(customId: (score: number) => string): MessageSpec['components'][number] {
  return {
    type: 'ACTION_ROW',
    components: [1, 2, 3, 4, 5].map((score) => ({
      type: 'BUTTON' as const,
      style: 'SECONDARY' as const,
      customId: customId(score),
      label: `${score} 星`
    }))
  };
}

function buildReviewCommentModal(orderId: string, reviewId: string): ModalSpec {
  return {
    title: '📝 补充评价留言（可选）',
    customId: `bc:rc:${orderId}:${reviewId}`,
    components: [
      {
        type: 'TEXT_INPUT',
        customId: 'review-comment',
        label: '想补充的话（最多 500 字）',
        style: 'PARAGRAPH',
        required: true,
        maxLength: 500
      }
    ]
  };
}

function selectableTargets(center: OrderExperienceReviewCenter): OrderExperienceReviewTarget[] {
  return center.targets.filter((target) => target.targetType !== 'ORDER');
}

function targetLabel(target: OrderExperienceReviewTarget): string {
  if (target.targetType === 'PLAYER') return `陪玩 · ${target.displayName}`;
  return target.displayName;
}

function reviewStatus(target: OrderExperienceReviewTarget): string {
  if (!target.review) return '尚未评价';
  return `已保存 ${'★'.repeat(target.review.score)}${target.review.comment ? ' · 已收到留言' : ''}`;
}

function reviewStateSignature(orderId: string, bits: string, actor: BotActorContext, secret: string): string {
  if (!secret.trim()) throw new Error('Review selection state secret is required.');
  return createHmac('sha256', secret)
    .update(`${orderId}:${actor.guildId}:${actor.discordUserId}:${bits}`)
    .digest()
    .subarray(0, STATE_SIGNATURE_BYTES)
    .toString('base64url');
}

async function recoverReviewInteraction(
  input: {
    interaction: {
      id: string;
      editReply(options: unknown): Promise<unknown>;
      followUp(options: { content: string; ephemeral: true }): Promise<unknown>;
    };
    route: ReviewButtonRoute;
    actor: BotActorContext;
    api: BotApiClient;
    secret: string;
  },
  error: unknown
) {
  try {
    const center = await input.api.getOrderExperienceReview(input.route.orderId, input.actor);
    await input.interaction.editReply(
      toDiscordUpdate(buildOrderExperienceReviewMessage(center, input.actor, input.secret))
    );
  } catch {
    // The traceable follow-up below remains available even when recovery refresh also fails.
  }
  await input.interaction.followUp({
    content: formatUserFacingError(error, {
      operation: '保存订单评价',
      localRequestId: `discord-interaction-${input.interaction.id}`
    }),
    ephemeral: true
  });
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}
