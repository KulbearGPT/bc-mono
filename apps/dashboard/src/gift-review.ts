import type { DashboardStaffLevel } from './automation-control.js';

export interface GiftReviewCardInput {
  request: { publicId: string; status: string; version: number; senderDisplay: string; receiverDisplay: string;
    giftName: string; priceMinor: number; currency: string; expiresAt: string };
  reservation: { status: string; amountMinor: number; expiresAt: string };
  task: { id: string; status: string; claimedByCurrentStaff: boolean; guildId: string; channelId: string; voiceChannelId: string | null };
  staffLevel: DashboardStaffLevel;
}

export function buildGiftReviewCard(input: GiftReviewCardInput) {
  const requiredLevel = input.request.priceMinor <= 200_000
    ? 'L2_SUPERVISOR'
    : input.request.priceMinor < 500_000 ? 'L3_OPERATIONS' : 'L4_ADMIN_OWNER';
  const canVerify = input.task.status === 'CLAIMED' && input.task.claimedByCurrentStaff;
  const canDecide = input.task.status === 'VERIFIED' && rank(input.staffLevel) >= rank(requiredLevel);
  return {
    title: `送礼核对 ${input.request.publicId}`,
    senderLabel: input.request.senderDisplay,
    receiverLabel: input.request.receiverDisplay,
    giftLabel: input.request.giftName,
    amountMinor: input.request.priceMinor,
    currency: input.request.currency,
    reservationLabel: input.reservation.status === 'ACTIVE' ? '金额已预留' : '预留不可用',
    requiredLevel,
    links: {
      orderChannel: `https://discord.com/channels/${input.task.guildId}/${input.task.channelId}`,
      voiceChannel: input.task.voiceChannelId ? `https://discord.com/channels/${input.task.guildId}/${input.task.voiceChannelId}` : null
    },
    actions: [
      { id: 'VERIFY', enabled: canVerify },
      { id: 'APPROVE', enabled: canDecide },
      { id: 'REJECT', enabled: canDecide },
      { id: 'ESCALATE', enabled: input.task.status === 'VERIFIED' && !canDecide }
    ]
  };
}

function rank(level: DashboardStaffLevel): number {
  return { L1_SUPPORT: 1, L2_SUPERVISOR: 2, L3_OPERATIONS: 3, L4_ADMIN_OWNER: 4 }[level];
}
