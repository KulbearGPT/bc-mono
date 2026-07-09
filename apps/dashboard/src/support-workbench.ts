export interface SupportTaskCardInput {
  id: string;
  publicId: string;
  type: string;
  status: string;
  version: number;
  claimedBy: string | null;
  orderId: string | null;
  giftRequestId?: string | null;
  links: { orderChannel: string | null; voiceChannel: string | null };
  triage: {
    orderPublicId: string | null; customerDisplayName: string | null; gameDisplayName: string | null; serviceDisplayName: string | null;
    amountMinor: number | null; currency: string | null; reasonLabel: string; waitStartedAt: string; nextActionLabel: string;
  };
  responseStatus?: 'NOT_REQUIRED' | 'PENDING' | 'MET' | 'OVERDUE';
  responseDueAt?: string | null;
  firstRespondedAt?: string | null;
  createdAt: string;
}

export function buildSupportWorkbench(input: {
  guildId: string;
  currentStaffId: string;
  permissions: string[];
  tasks: SupportTaskCardInput[];
}) {
  const permissions = new Set(input.permissions);
  const cards = input.tasks.filter((task) => ['OPEN', 'CLAIMED', 'VERIFIED', 'APPROVED', 'PENDING_APPROVAL'].includes(task.status)).map((task) => {
    const triage=task.triage??{orderPublicId:null,customerDisplayName:null,gameDisplayName:null,serviceDisplayName:null,amountMinor:null,currency:null,reasonLabel:'需要客服处理',waitStartedAt:task.createdAt,nextActionLabel:'查看任务并确认下一步'};
    return ({
    ...task,triage,
    statusLabel: task.status === 'OPEN' ? '待认领' : task.status === 'CLAIMED' ? '处理中' : '待上级处理',
    links: { orderChannel: safeDiscordChannelUrl((task.links as SupportTaskCardInput['links']|undefined)?.orderChannel??null), voiceChannel: safeDiscordChannelUrl((task.links as SupportTaskCardInput['links']|undefined)?.voiceChannel??null) },
    actions: [
      { id: 'CLAIM' as const, enabled: task.status === 'OPEN' && permissions.has('staff_task.claim') },
      { id: 'ADD_NOTE' as const, enabled: task.status === 'CLAIMED' && task.claimedBy === input.currentStaffId && permissions.has('staff_task.verify') },
      { id: 'ESCALATE' as const, enabled: task.status === 'CLAIMED' && task.claimedBy === input.currentStaffId && permissions.has('staff_task.verify') },
      { id: 'RESOLVE' as const, enabled: ['CLAIMED', 'VERIFIED', 'APPROVED'].includes(task.status) && (task.type !== 'GIFT_REVIEW' || task.status === 'APPROVED') && permissions.has('staff_task.resolve') },
      { id: 'VERIFY_GIFT' as const, enabled: task.type === 'GIFT_REVIEW' && Boolean(task.giftRequestId) && task.status === 'CLAIMED' && task.claimedBy === input.currentStaffId && permissions.has('staff_task.verify') },
      { id: 'APPROVE_GIFT' as const, enabled: task.type === 'GIFT_REVIEW' && Boolean(task.giftRequestId) && task.status === 'VERIFIED' && permissions.has('gift.approve') },
      { id: 'REJECT_GIFT' as const, enabled: task.type === 'GIFT_REVIEW' && Boolean(task.giftRequestId) && task.status === 'VERIFIED' && permissions.has('gift.reject') }
    ]
  });});
  return {
    filters: [
      { id: 'ALL' as const, label: '全部' },
      { id: 'MINE' as const, label: '我的任务' },
      { id: 'UNCLAIMED' as const, label: '待认领' }
    ],
    sections: {
      all: cards,
      mine: cards.filter((task) => task.claimedBy === input.currentStaffId),
      unclaimed: cards.filter((task) => task.status === 'OPEN')
    }
  };
}

function safeDiscordChannelUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'discord.com' && /^\/channels\/\d{17,20}\/\d{17,20}$/.test(url.pathname) ? url.toString() : null;
  } catch { return null; }
}
