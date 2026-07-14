import type { MessageSpec } from './service-center.js';

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
  orderRequirementId: string;
  publicGameTags: string[];
  publicServiceTags: string[];
}
export type SelectionRoute =
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
  closesAt: string;
  requirements: SelectionRequirementOffer[];
}): MessageSpec {
  const requirements = input.requirements.filter((item) => item.remainingSlots > 0).slice(0, 25);
  return {
    title: `候选池 #${input.orderPublicId}`,
    body: [
      `报名截止：<t:${Math.floor(Date.parse(input.closesAt) / 1000)}:R>`,
      '可同时报名多个订单；报名不会占用正式订单名额。',
      ...requirements.map(
        (item) =>
          `${item.label} · 缺 ${item.remainingSlots} 位 · 默认预计收益 ${item.expectedEarningMinor} ${item.currency}`
      )
    ].join('\n'),
    visibility: 'PUBLIC',
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
                  description:
                    `缺 ${item.remainingSlots} 位 · 默认预计收益 ${item.expectedEarningMinor} ${item.currency}`.slice(
                      0,
                      100
                    )
                })),
                minValues: 1,
                maxValues: 1
              }
            ]
          }
        ]
      : []
  };
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
          placeholder: '选择并确认本页入选陪玩',
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
          label: '下一页'
        }
      ]
    });
  return {
    title: '选择陪玩',
    body: input.items.length
      ? input.items
          .map(
            (item) =>
              `${item.playerDisplayName} · ${[...item.publicGameTags, ...item.publicServiceTags].join(' / ') || '暂无公开标签'}`
          )
          .join('\n')
      : '本轮暂无报名。请选择继续等待或取消订单。',
    visibility: 'PRIVATE_CHANNEL',
    components
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
    userLimit: 0,
    allowMemberIds: [
      projection.customerDiscordUserId,
      ...(projection.phase === 'SELECTION' ? applicants : projection.selectedDiscordUserIds)
    ],
    allowRoleIds: [...new Set(projection.staffRoleIds)],
    revokeMemberIds: rejected,
    disconnectMemberIds: rejected,
    staffNotice: `订单 ${projection.orderPublicId} 已开始陪玩选拔，客服可以加入语音频道处理。`
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
