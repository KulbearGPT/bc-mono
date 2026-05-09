export interface SupportTaskCardInput {
  id: string;
  publicId: string;
  type: string;
  status: string;
  version: number;
  claimedBy: string | null;
  orderId: string | null;
  channelId: string | null;
  voiceChannelId: string | null;
  guildId?: string;
  createdAt: string;
}

export function buildSupportWorkbench(input: {
  guildId: string;
  currentStaffId: string;
  permissions: string[];
  tasks: SupportTaskCardInput[];
}) {
  const permissions = new Set(input.permissions);
  const cards = input.tasks.map((task) => ({
    ...task,
    statusLabel: task.status === 'OPEN' ? '待认领' : task.status === 'CLAIMED' ? '处理中' : '待上级处理',
    links: {
      orderChannel: task.channelId ? `https://discord.com/channels/${task.guildId ?? input.guildId}/${task.channelId}` : null,
      voiceChannel: task.voiceChannelId ? `https://discord.com/channels/${task.guildId ?? input.guildId}/${task.voiceChannelId}` : null
    },
    actions: [
      { id: 'CLAIM' as const, enabled: task.status === 'OPEN' && permissions.has('staff_task.claim') },
      { id: 'ADD_NOTE' as const, enabled: task.status === 'CLAIMED' && task.claimedBy === input.currentStaffId && permissions.has('staff_task.verify') },
      { id: 'ESCALATE' as const, enabled: task.status === 'CLAIMED' && task.claimedBy === input.currentStaffId && permissions.has('staff_task.verify') }
    ]
  }));
  return {
    filters: [
      { id: 'ALL' as const, label: '全部' },
      { id: 'MINE' as const, label: '我的任务' },
      { id: 'UNCLAIMED' as const, label: '待认领' }
    ],
    sections: {
      mine: cards.filter((task) => task.claimedBy === input.currentStaffId),
      unclaimed: cards.filter((task) => task.status === 'OPEN')
    }
  };
}
