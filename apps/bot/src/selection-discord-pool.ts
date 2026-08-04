import { buildExperienceMessage } from './discord-experience.js';
import { type MessageSpec } from './service-center-components.js';
import { type OrderSummary, type SelectionPoolSummary } from './service-center-api.js';
import { closeCustomId, short } from './selection-discord-codec.js';

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
      nextStep: '点击“开始招募陪玩”，系统会在派单频道发布报名卡。',
      components: [
        selectionActionButton(`bc:sp:new:${order.id}:o${order.version}`, '开始招募陪玩'),
        ...selectionOrderControls(order)
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
          label: '结束报名，进入试音'
        }
      ]
    });
  if (emptySelection)
    components.push(
      selectionActionButton(
        `bc:sp:r:${short(order.id)}:${short(pool.id)}:v${pool.version}:o${order.version}`,
        '再发起一轮报名'
      )
    );
  components.push(...selectionOrderControls(order));
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
      ? '名单合适时点击“结束报名，进入试音”。'
      : emptySelection
        ? '点击“再发起一轮报名”，或取消订单。'
        : '刷新报名名单后选择想试音的陪玩；如状态不一致，请联系猫舍前台。',
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

function selectionOrderControls(order: OrderSummary): NonNullable<MessageSpec['components']> {
  return [
    {
      type: 'ACTION_ROW',
      components: [
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:order:${order.id}:refresh`,
          label: '刷新最新状态'
        },
        {
          type: 'BUTTON',
          style: 'SECONDARY',
          customId: `bc:service:support:${order.id}:v${order.version}`,
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
          customId: `bc:order:${order.id}:cancel:v${order.version}`,
          label: '取消订单'
        }
      ]
    }
  ];
}
