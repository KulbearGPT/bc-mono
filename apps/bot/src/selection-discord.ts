import { buildExperienceMessage } from './discord-experience.js';
import type { MessageSpec } from './service-center-components.js';
import type { OrderSummary, SelectionPoolSummary } from './service-center-api.js';

export interface SelectionRequirementOffer {
  id: string;
  label: string;
  remainingSlots: number;
  expectedEarningMinor: number;
  currency: string;
}
export interface SelectionCandidate {
  id: string;
  playerDisplayName: string;
  playerDiscordUserId?: string;
  orderRequirementId: string;
  publicGameTags: string[];
  publicServiceTags: string[];
}
export type SelectionRoute =
  | {
      action: 'start';
      orderId: string;
      poolId: string | null;
      expectedPoolVersion: number | null;
      expectedOrderVersion: number;
    }
  | {
      action: 'apply';
      orderId: string;
      poolId: string;
      requirementId: string;
      expectedPoolVersion: number;
    }
  | {
      action: 'apply-menu';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number;
    }
  | {
      action: 'withdraw';
      orderId: string;
      poolId: string;
      applicationId: string;
      expectedPoolVersion: number;
      expectedApplicationVersion: number;
    }
  | {
      action: 'close';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number;
    }
  | {
      action: 'finalize';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number;
      expectedOrderVersion: number;
    }
  | {
      action: 'reselect';
      orderId: string;
      poolId: string;
      expectedPoolVersion: number | null;
      expectedOrderVersion: number | null;
    }
  | {
      action: 'page';
      orderId: string;
      poolId: string;
      expectedOrderVersion: number;
      cursor: string;
    }
  | { action: 'unknown' };

export function buildSelectionPoolOfferMessage(input: {
  orderId: string;
  poolId: string;
  poolVersion: number;
  orderPublicId: string;
  requirements: SelectionRequirementOffer[];
}): MessageSpec {
  const requirements = input.requirements.filter((item) => item.remainingSlots > 0).slice(0, 25);
  return buildExperienceMessage({
    title: `新单报名 #${input.orderPublicId}`,
    icon: '🐾',
    introduction: '猫舍有新委托啦～报名不占用正式订单名额，合适就来留个爪印。',
    visibility: 'PUBLIC',
    density: 'PUBLIC_MILESTONE',
    tone: 'BRAND',
    coreFacts: [
      {
        name: '🎮 可报名项目',
        value:
          requirements.map((item, index) => `${index + 1}️⃣ ${item.label} · 缺 ${item.remainingSlots} 位`).join('\n') ||
          '暂无可报名项目'
      }
    ],
    progress: '持续招募中，直到老板手动终止',
    nextStep: '选择你想报名的项目；取消报名后会自动退出本轮。',
    components: requirements.length
      ? [
          {
            type: 'ACTION_ROW',
            components: [
              {
                type: 'STRING_SELECT',
                customId: `bc:sp:m:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}`,
                placeholder: '选择要报名的项目',
                options: requirements.map((item) => ({
                  label: item.label.slice(0, 100),
                  value: short(item.id),
                  description: `缺 ${item.remainingSlots} 位`
                })),
                minValues: 1,
                maxValues: 1
              }
            ]
          }
        ]
      : []
  });
}

export function buildSelectionCandidatePanel(input: {
  orderId: string;
  poolId: string;
  poolVersion: number;
  orderVersion: number;
  items: SelectionCandidate[];
  nextCursor: string | null;
  selectedApplicationIds: string[];
}): MessageSpec {
  const selected = new Set(input.selectedApplicationIds);
  const options = input.items.map((item) => ({
    label: item.playerDisplayName.slice(0, 100),
    value: short(item.id),
    description: [...item.publicGameTags, ...item.publicServiceTags].join(' · ').slice(0, 100) || '公开资料',
    default: selected.has(item.id)
  }));
  const components: MessageSpec['components'] = [];
  if (options.length)
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'STRING_SELECT',
          customId: `bc:sp:s:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}:o${input.orderVersion}`,
          placeholder: '选择本页入选陪玩（下一步确认）',
          options,
          minValues: 1,
          maxValues: Math.min(25, options.length)
        }
      ]
    });
  if (input.nextCursor)
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:sp:n:${short(input.orderId)}:${short(input.poolId)}:o${input.orderVersion}:${input.nextCursor}`,
          label: '下一页 →'
        }
      ]
    });
  if (options.length)
    components.push(
      selectionActionButton(
        `bc:sp:r:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}:o${input.orderVersion}`,
        '本轮暂无合适陪玩，重新招募'
      )
    );
  return buildExperienceMessage({
    title: '试音匹配·选择陪玩',
    icon: '🎧',
    introduction: input.items.length
      ? '本轮报名已终止，请结合公开资料选择想试音的陪玩。'
      : '本轮没有收到报名，可以再开一轮招募。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: input.items.length ? 'BRAND' : 'WAITING',
    coreFacts: [
      {
        name: '🐾 报名陪玩',
        value: input.items.length
          ? input.items
              .map(
                (item) =>
                  `**${item.playerDisplayName}**\n${[...item.publicGameTags, ...item.publicServiceTags].join(' / ') || '暂无公开标签'}`
              )
              .join('\n\n')
          : '暂无报名陪玩'
      }
    ],
    progress: input.items.length ? '试音匹配进行中' : '本轮招募已终止',
    nextStep: input.items.length ? '选中陪玩后进入确认页；如都不合适，可重新招募。' : '重新开始招募，或取消订单。',
    components
  });
}

export function buildSelectionCandidateConfirmation(input: {
  orderId: string;
  poolId: string;
  poolVersion: number;
  orderVersion: number;
  selectedCandidates: Array<{ id: string; playerDisplayName: string }>;
}): MessageSpec {
  if (input.selectedCandidates.length < 1 || input.selectedCandidates.length > 25)
    throw new Error('Selection confirmation requires one to twenty-five candidates.');
  const count = input.selectedCandidates.length;
  return buildExperienceMessage({
    title: '确认试音匹配结果',
    icon: '🐈‍⬛',
    introduction: '这是最后一次核对；确认后，系统将为选中的陪玩创建正式席位。',
    visibility: 'EPHEMERAL',
    density: 'EPHEMERAL_FEEDBACK',
    tone: 'INFO',
    coreFacts: [
      {
        name: '🎧 本次选择',
        value: input.selectedCandidates.map((candidate) => `• **${candidate.playerDisplayName}**`).join('\n')
      }
    ],
    nextStep: '名单无误就点击“确认选择”；如需调整，返回报名名单重新选择。',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'STRING_SELECT',
            customId: `bc:sp:p:${short(input.orderId)}:${short(input.poolId)}`,
            placeholder: `已选择 ${count} 位陪玩`,
            options: input.selectedCandidates.map((candidate) => ({
              label: candidate.playerDisplayName.slice(0, 100),
              value: short(candidate.id),
              default: true
            })),
            minValues: count,
            maxValues: count,
            disabled: true
          }
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'PRIMARY',
            customId: `bc:sp:f:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}:o${input.orderVersion}`,
            label: '确认选择'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:sp:b:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}:o${input.orderVersion}`,
            label: '返回重选'
          }
        ]
      }
    ]
  });
}

export function selectionIdsFromConfirmationComponents(components: readonly unknown[]): string[] {
  for (const row of components) {
    const children = (row as { components?: readonly unknown[] } | null)?.components;
    if (!children) continue;
    for (const component of children) {
      const candidate = component as {
        customId?: unknown;
        custom_id?: unknown;
        options?: ReadonlyArray<{ value?: unknown }>;
      };
      const customId = candidate.customId ?? candidate.custom_id;
      if (typeof customId !== 'string' || !customId.startsWith('bc:sp:p:') || !candidate.options) continue;
      return Array.from(
        new Set(
          candidate.options
            .map((option) => option.value)
            .filter((value): value is string => typeof value === 'string')
            .map(decodeSelectionId)
        )
      );
    }
  }
  return [];
}

export function selectionFinalizeRouteFromConfirmationComponents(
  components: readonly unknown[]
): Extract<SelectionRoute, { action: 'finalize' }> | null {
  for (const row of components) {
    const children = (row as { components?: readonly unknown[] } | null)?.components;
    if (!children) continue;
    for (const component of children) {
      const candidate = component as { customId?: unknown; custom_id?: unknown };
      const customId = candidate.customId ?? candidate.custom_id;
      if (typeof customId !== 'string') continue;
      const route = parseSelectionCustomId(customId);
      if (route.action === 'finalize') return route;
    }
  }
  return null;
}

export function buildSelectionPoolRefreshMessage(order: OrderSummary, pool: SelectionPoolSummary | null): MessageSpec {
  if (!pool)
    return buildExperienceMessage({
      title: `订单 #${order.publicId} · 准备招募`,
      icon: '🐾',
      introduction: '订单已就位，预留资金保持有效，现在由你决定何时开始找陪玩。',
      visibility: 'PRIVATE_CHANNEL',
      density: 'PRIVATE_ORDER',
      tone: 'BRAND',
      coreFacts: [{ name: '📋 订单状态', value: '已提交 · 资金预留中' }],
      progress: '尚未开始招募',
      nextStep: '点击“开始招募”，系统会在派单频道发布报名卡。',
      components: [
        selectionActionButton(`bc:sp:new:${order.id}:o${order.version}`, '开始招募'),
        selectionOrderControls(order)
      ]
    });
  const collecting = pool.status === 'COLLECTING';
  const emptySelection = pool.status === 'SELECTION' && pool.applicationCount === 0;
  const components: MessageSpec['components'] = [];
  if (collecting)
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'PRIMARY',
          customId: closeCustomId({ orderId: order.id, poolId: pool.id, poolVersion: pool.version }),
          label: '终止招募'
        }
      ]
    });
  if (emptySelection)
    components.push(
      selectionActionButton(
        `bc:sp:r:${short(order.id)}:${short(pool.id)}:v${pool.version}:o${order.version}`,
        '重新开始招募'
      )
    );
  components.push(selectionOrderControls(order));
  return buildExperienceMessage({
    title: collecting
      ? `订单 #${order.publicId} · 报名进行中`
      : emptySelection
        ? `订单 #${order.publicId} · 本轮无人报名`
        : `订单 #${order.publicId} · 试音匹配`,
    icon: collecting || emptySelection ? '🐾' : '🎧',
    introduction: collecting
      ? '报名卡正在派单频道收集爪印，名单会在这里实时更新。'
      : emptySelection
        ? '本轮招募已结束，但还没有陪玩报名。'
        : '本轮招募已结束，现在可以从报名陪玩中进行试音匹配。',
    visibility: 'PRIVATE_CHANNEL',
    density: 'PRIVATE_ORDER',
    tone: collecting ? 'WAITING' : emptySelection ? 'MUTED' : 'BRAND',
    coreFacts: [
      { name: '📋 本轮招募', value: `第 ${pool.round} 轮 · ${collecting ? '无时限，老板手动终止' : '已终止'}` },
      { name: '🐾 当前报名', value: selectionApplicantMentions(pool.applicantDiscordUserIds ?? []) }
    ],
    progress: collecting ? '报名进行中' : emptySelection ? '本轮无人报名' : '试音匹配进行中',
    nextStep: collecting
      ? '名单合适时点击“终止招募”，再进入试音匹配。'
      : emptySelection
        ? '点击“重新开始招募”，或取消订单。'
        : '刷新报名名单后选择想试音的陪玩；如状态不一致，请联系客服。',
    components
  });
}

export function buildSelectionPoolStartedNotice(
  order: OrderSummary,
  pool: SelectionPoolSummary,
  guildId: string
): MessageSpec {
  return {
    title: '🐾 新一轮报名已开始',
    body: [`第 ${pool.round} 轮招募已开启。`, '实时报名名单会自动同步到订单主卡；招募将持续到你手动终止。'].join('\n'),
    visibility: 'EPHEMERAL',
    layout: 'COMPONENTS_V2',
    components: [
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'LINK_BUTTON',
            style: 'LINK',
            url: `https://discord.com/channels/${guildId}/${order.channelSpec.channelId}/${order.channelSpec.panelMessageId}`,
            label: '查看实时订单卡'
          }
        ]
      }
    ]
  };
}

function selectionActionButton(customId: string, label: string): NonNullable<MessageSpec['components']>[number] {
  return {
    type: 'ACTION_ROW',
    components: [
      {
        type: 'BUTTON',
        style: 'PRIMARY',
        customId,
        label
      }
    ]
  };
}

function selectionApplicantMentions(discordUserIds: string[]): string {
  return discordUserIds.length ? discordUserIds.map((id) => `<@${id}>`).join('、') : '暂无陪玩报名';
}

function selectionOrderControls(order: OrderSummary): NonNullable<MessageSpec['components']>[number] {
  return {
    type: 'ACTION_ROW',
    components: [
      {
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:order:${order.id}:refresh`,
        label: '刷新订单'
      },
      {
        type: 'BUTTON',
        style: 'DANGER',
        customId: `bc:order:${order.id}:cancel:v${order.version}`,
        label: '取消订单'
      },
      {
        type: 'BUTTON',
        style: 'SECONDARY',
        customId: `bc:service:support:${order.id}:v${order.version}`,
        label: '我要申诉'
      }
    ]
  };
}

export function withdrawCustomId(input: {
  orderId: string;
  poolId: string;
  applicationId: string;
  poolVersion: number;
  applicationVersion: number;
}) {
  return `bc:sp:w:${short(input.orderId)}:${short(input.poolId)}:${short(input.applicationId)}:v${input.poolVersion}:a${input.applicationVersion}`;
}
export function closeCustomId(input: { orderId: string; poolId: string; poolVersion: number }) {
  return `bc:sp:c:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}`;
}

export function parseSelectionCustomId(value: string): SelectionRoute {
  let initial = /^bc:sp:new:([0-9a-f-]{36}):o(\d+)$/u.exec(value);
  if (initial)
    return {
      action: 'start',
      orderId: initial[1]!,
      poolId: null,
      expectedPoolVersion: null,
      expectedOrderVersion: Number(initial[2])
    };
  initial = /^bc:sp:r:([^:]+):([^:]+):v(\d+):o(\d+)$/u.exec(value);
  if (initial)
    return {
      action: 'start',
      orderId: long(initial[1]!),
      poolId: long(initial[2]!),
      expectedPoolVersion: Number(initial[3]),
      expectedOrderVersion: Number(initial[4])
    };
  let match = /^bc:sp:a:([^:]+):([^:]+):([^:]+):v(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'apply',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      requirementId: long(match[3]!),
      expectedPoolVersion: Number(match[4])
    };
  match = /^bc:sp:m:([^:]+):([^:]+):v(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'apply-menu',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3])
    };
  match = /^bc:sp:w:([^:]+):([^:]+):([^:]+):v(\d+):a(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'withdraw',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      applicationId: long(match[3]!),
      expectedPoolVersion: Number(match[4]),
      expectedApplicationVersion: Number(match[5])
    };
  match = /^bc:sp:c:([^:]+):([^:]+):v(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'close',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3])
    };
  match = /^bc:sp:f:([^:]+):([^:]+):v(\d+):o(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'finalize',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3]),
      expectedOrderVersion: Number(match[4])
    };
  match = /^bc:sp:b:([^:]+):([^:]+):v(\d+):o(\d+)$/u.exec(value);
  if (match)
    return {
      action: 'reselect',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: Number(match[3]),
      expectedOrderVersion: Number(match[4])
    };
  match = /^bc:sp:b:([^:]+):([^:]+)$/u.exec(value);
  if (match)
    return {
      action: 'reselect',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedPoolVersion: null,
      expectedOrderVersion: null
    };
  match = /^bc:sp:n:([^:]+):([^:]+):o(\d+):([A-Za-z0-9_-]+)$/u.exec(value);
  if (match)
    return {
      action: 'page',
      orderId: long(match[1]!),
      poolId: long(match[2]!),
      expectedOrderVersion: Number(match[3]),
      cursor: match[4]!
    };
  return { action: 'unknown' };
}
export function decodeSelectionId(value: string) {
  return long(value);
}

export interface SelectionVoiceProjection {
  phase: 'SELECTION' | 'FINALIZED';
  guildId: string;
  orderId: string;
  orderPublicId: string;
  customerDiscordUserId: string;
  applicantDiscordUserIds: string[];
  selectedDiscordUserIds: string[];
  staffRoleIds: string[];
  voiceChannelId: string | null;
  staffTaskChannelId: string;
}
export function buildSelectionVoicePlan(projection: SelectionVoiceProjection) {
  const applicants = [...new Set(projection.applicantDiscordUserIds)];
  const selected = new Set(projection.selectedDiscordUserIds);
  const rejected = projection.phase === 'FINALIZED' ? applicants.filter((id) => !selected.has(id)) : [];
  return {
    projection,
    serviceChannelName: `service-${projection.orderPublicId}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/gu, '-')
      .slice(0, 90),
    userLimit: 0,
    allowMemberIds: [
      projection.customerDiscordUserId,
      ...(projection.phase === 'SELECTION' ? applicants : projection.selectedDiscordUserIds)
    ],
    allowRoleIds: [...new Set(projection.staffRoleIds)],
    revokeMemberIds: rejected,
    disconnectMemberIds: rejected,
    moveMemberIds:
      projection.phase === 'FINALIZED' ? [projection.customerDiscordUserId, ...projection.selectedDiscordUserIds] : [],
    staffNotice: `订单 ${projection.orderPublicId} 已进入试音匹配，客服可以加入试音房处理。`
  };
}

function short(uuid: string) {
  if (!/^[0-9a-f-]{36}$/iu.test(uuid)) throw new Error('Invalid UUID.');
  return Buffer.from(uuid.replaceAll('-', ''), 'hex').toString('base64url');
}
function long(value: string) {
  const hex = Buffer.from(value, 'base64url').toString('hex');
  if (hex.length !== 32) throw new Error('Invalid compact UUID.');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
