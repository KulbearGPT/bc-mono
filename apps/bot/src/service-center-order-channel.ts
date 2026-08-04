import {
  type PermissionName,
  type PermissionOverwriteSpec,
  type PrivateOrderChannelPlan
} from './service-center-components.js';

export function buildPrivateOrderChannelPlan(input: {
  guildId: string;
  orderPublicId: string;
  customerDiscordUserId: string;
  botUserId: string;
  staffRoleIds: string[];
  playerRoleId?: string | null;
}): PrivateOrderChannelPlan {
  const overwrites: PermissionOverwriteSpec[] = [
    { id: input.guildId, kind: 'ROLE', allow: [], deny: ['VIEW_CHANNEL'] },
    {
      id: input.customerDiscordUserId,
      kind: 'MEMBER',
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
      deny: ['MANAGE_CHANNELS']
    },
    {
      id: input.botUserId,
      kind: 'MEMBER',
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS'],
      deny: []
    },
    ...input.staffRoleIds.map((roleId) => ({
      id: roleId,
      kind: 'ROLE' as const,
      allow: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_CHANNELS'] as PermissionName[],
      deny: []
    }))
  ];

  if (input.playerRoleId) {
    overwrites.push({
      id: input.playerRoleId,
      kind: 'ROLE',
      allow: [],
      deny: ['VIEW_CHANNEL']
    });
  }

  return {
    name: `订单-${input.orderPublicId.toLowerCase()}`,
    pinPanel: true,
    permissionOverwrites: overwrites
  };
}
