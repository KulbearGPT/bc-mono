import { buildExperienceMessage } from './discord-experience.js';
import { type MessageSpec } from './service-center-components.js';
import { SelectionCandidate, SelectionRoute } from './selection-discord-contracts.js';
import {
  parseSelectionCustomId,
  decodeSelectionId,
  short,
  selectionPageCustomId,
  normalizeSelectedCandidates,
  walkComponents
} from './selection-discord-codec.js';

export function buildSelectionCandidatePanel(input: {
  orderId: string;
  poolId: string;
  poolVersion: number;
  orderVersion: number;
  items: SelectionCandidate[];
  nextCursor: string | null;
  selectedApplicationIds: string[];
  selectedCandidates?: Array<{ id: string; playerDisplayName: string }>;
  pageIndex?: number;
}): MessageSpec {
  const pageIndex = input.pageIndex ?? 0;
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw new Error('Selection page index is invalid.');
  const selectedCandidates = normalizeSelectedCandidates(input);
  const selected = new Set(selectedCandidates.map((candidate) => candidate.id));
  const options = input.items.map((item) => ({
    label: item.playerDisplayName.slice(0, 100),
    value: short(item.id),
    description: [...item.publicGameTags, ...item.publicServiceTags].join(' · ').slice(0, 100) || '公开资料',
    default: selected.has(item.id)
  }));
  const components: MessageSpec['components'] = [];
  if (selectedCandidates.length)
    components.push({
      type: 'ACTION_ROW',
      components: [
        {
          type: 'STRING_SELECT',
          customId: `bc:sp:p:${short(input.orderId)}:${short(input.poolId)}`,
          placeholder: `已选择 ${selectedCandidates.length} 位陪玩`,
          options: selectedCandidates.map((candidate) => ({
            label: candidate.playerDisplayName.slice(0, 100),
            value: short(candidate.id),
            default: true
          })),
          minValues: selectedCandidates.length,
          maxValues: selectedCandidates.length,
          disabled: true
        }
      ]
    });
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
  const navigation = [];
  if (pageIndex > 0)
    navigation.push({
      type: 'BUTTON' as const,
      style: 'SECONDARY' as const,
      customId: selectionPageCustomId(input, pageIndex - 1),
      label: '← 上一页'
    });
  if (input.nextCursor)
    navigation.push({
      type: 'BUTTON' as const,
      style: 'SECONDARY' as const,
      customId: selectionPageCustomId(input, pageIndex + 1),
      label: '下一页 →'
    });
  if (options.length)
    navigation.push({
      type: 'BUTTON' as const,
      style: 'PRIMARY' as const,
      customId: `bc:sp:r:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}:o${input.orderVersion}`,
      label: '再发起一轮报名'
    });
  if (navigation.length)
    components.push({
      type: 'ACTION_ROW',
      components: navigation
    });
  components.push(
    {
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:order:${input.orderId}:refresh`,
          label: '刷新最新状态'
        },
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:service:support:${input.orderId}:v${input.orderVersion}`,
          label: '联系猫舍前台'
        }
      ]
    },
    {
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'DANGER',
          customId: `bc:order:${input.orderId}:cancel:v${input.orderVersion}`,
          label: '取消订单'
        }
      ]
    }
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
    progress: input.items.length
      ? `试音匹配进行中 · 第 ${pageIndex + 1} 页${selectedCandidates.length ? ` · 已选 ${selectedCandidates.length} 位` : ''}`
      : '本轮招募已终止',
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
    nextStep: '名单无误就点击“确认这些陪玩”；如需调整，返回报名名单重新选择。',
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
            label: '确认这些陪玩'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:sp:b:${short(input.orderId)}:${short(input.poolId)}:v${input.poolVersion}:o${input.orderVersion}`,
            label: '修改陪玩名单'
          }
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:order:${input.orderId}:refresh`,
            label: '刷新最新状态'
          },
          {
            type: 'BUTTON',
            style: 'SECONDARY',
            customId: `bc:service:support:${input.orderId}:v${input.orderVersion}`,
            label: '联系猫舍前台'
          }
        ]
      },
      {
        type: 'ACTION_ROW',
        components: [
          {
            type: 'BUTTON',
            style: 'DANGER',
            customId: `bc:order:${input.orderId}:cancel:v${input.orderVersion}`,
            label: '取消订单'
          }
        ]
      }
    ]
  });
}

export function selectionIdsFromConfirmationComponents(components: readonly unknown[]): string[] {
  return selectionCandidatesFromComponents(components).map((candidate) => candidate.id);
}

export function selectionCandidatesFromComponents(
  components: readonly unknown[]
): Array<{ id: string; playerDisplayName: string }> {
  for (const component of walkComponents(components)) {
    const candidate = component as {
      customId?: unknown;
      custom_id?: unknown;
      options?: ReadonlyArray<{ value?: unknown; label?: unknown }>;
    };
    const customId = candidate.customId ?? candidate.custom_id;
    if (typeof customId !== 'string' || !customId.startsWith('bc:sp:p:') || !candidate.options) continue;
    const unique = new Map<string, string>();
    for (const option of candidate.options) {
      if (typeof option.value !== 'string') continue;
      const id = decodeSelectionId(option.value);
      unique.set(id, typeof option.label === 'string' ? option.label : '已选陪玩');
    }
    return [...unique].map(([id, playerDisplayName]) => ({ id, playerDisplayName }));
  }
  return [];
}

export function mergeSelectionCandidates(input: {
  retainedCandidates: Array<{ id: string; playerDisplayName: string }>;
  currentPageCandidates: Array<{ id: string; playerDisplayName: string }>;
  selectedCurrentPageIds: string[];
}): Array<{ id: string; playerDisplayName: string }> {
  const currentPageIds = new Set(input.currentPageCandidates.map((candidate) => candidate.id));
  const selectedIds = new Set(input.selectedCurrentPageIds);
  const merged = [
    ...input.retainedCandidates.filter((candidate) => !currentPageIds.has(candidate.id)),
    ...input.currentPageCandidates.filter((candidate) => selectedIds.has(candidate.id))
  ];
  return [...new Map(merged.map((candidate) => [candidate.id, candidate])).values()];
}

export function selectionFinalizeRouteFromConfirmationComponents(
  components: readonly unknown[]
): Extract<SelectionRoute, { action: 'finalize' }> | null {
  for (const component of walkComponents(components)) {
    const candidate = component as { customId?: unknown; custom_id?: unknown };
    const customId = candidate.customId ?? candidate.custom_id;
    if (typeof customId !== 'string') continue;
    const route = parseSelectionCustomId(customId);
    if (route.action === 'finalize') return route;
  }
  return null;
}
