import type { StaffLevel } from './security.js';

export const staffLevels = ['L1_SUPPORT', 'L2_SUPERVISOR', 'L3_OPERATIONS', 'L4_ADMIN_OWNER'] as const;

const permissionsByMinimumLevel: Record<StaffLevel, readonly string[]> = {
  L1_SUPPORT: ['staff.session.active', 'mfa.manage_self', 'step_up.execute', 'dashboard.view', 'staff_task.read', 'staff_task.claim', 'staff_task.verify', 'order.read', 'order.pause', 'gift_request.read', 'audit.read', 'customer_profile.read'],
  L2_SUPERVISOR: ['staff_task.resolve', 'gift.approve', 'gift.reject', 'refund.execute', 'order.resolve', 'order.reassign', 'order.resume', 'user.read', 'player.read', 'player.tags.manage', 'catalog.read', 'gift_catalog.read', 'earnings.read', 'user.risk.manage', 'referral.read', 'job.read', 'job.retry', 'settlement.read', 'weekly_report.read'],
  L3_OPERATIONS: ['catalog.manage', 'gift_catalog.manage', 'user.status.manage', 'player.approve', 'player.status.manage', 'earnings.manage', 'commission.read', 'commission.manage', 'referral.manage', 'policy.read', 'policy.manage', 'bot_config.read', 'bot_config.operational.manage', 'settlement.manage', 'settlement.approve', 'weekly_report.manage'],
  L4_ADMIN_OWNER: ['access.read', 'access.manage', 'bot_config.security.manage', 'settlement.void', 'sandbox_funding.read', 'sandbox_funding.manage']
};

export type StaffScope = 'SELF' | 'TEAM' | 'BUSINESS' | 'ALL';

export function levelRank(level: StaffLevel): number { return staffLevels.indexOf(level) + 1; }

export function resolveStaffPolicy(level: StaffLevel) {
  const rank = levelRank(level);
  return {
    level,
    scope: (rank === 1 ? 'SELF' : rank === 2 ? 'TEAM' : rank === 3 ? 'BUSINESS' : 'ALL') as StaffScope,
    permissions: staffLevels.slice(0, rank).flatMap((item) => permissionsByMinimumLevel[item]),
    referralVisibility: rank >= 3 ? 'CONFIDENTIAL' as const : rank >= 2 ? 'REDACTED' as const : 'NONE' as const,
    maximumRoleGrant: level,
    destructiveActions: [] as string[]
  };
}

export function hasStaffPermission(level: StaffLevel | null, permission: string): boolean {
  return Boolean(level && resolveStaffPolicy(level).permissions.includes(permission));
}

export function requiredLevelForAmount(
  amountMinor: number,
  thresholds: { l2LimitMinor: number; l4FromMinor: number }
): 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER' {
  if (amountMinor >= thresholds.l4FromMinor) return 'L4_ADMIN_OWNER';
  if (amountMinor > thresholds.l2LimitMinor) return 'L3_OPERATIONS';
  return 'L2_SUPERVISOR';
}

export function canGrantRole(actorLevel: StaffLevel, targetLevel: StaffLevel): boolean {
  return actorLevel === 'L4_ADMIN_OWNER' && levelRank(targetLevel) <= levelRank(actorLevel);
}
