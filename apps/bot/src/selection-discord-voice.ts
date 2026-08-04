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
