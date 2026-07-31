export type StaffLevel = 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';

export interface RoleMappingRecord {
  guildId: string;
  discordRoleId: string;
  targetLevel: StaffLevel;
  enabled: boolean;
  version: number;
  reconciliationQueued: boolean;
}
export interface StaffAccountRecord {
  staffId: string;
  displayName: string;
  effectiveLevel: StaffLevel;
  pendingElevationLevel: StaffLevel | null;
  permissionsVersion: number;
  activeSessions: number;
  status: 'ACTIVE' | 'REVOKED';
  roleSyncedAt?: string | null;
  observedDiscordRoleIds?: string[];
  lastRoleSyncStatus?: string | null;
  roleSyncQueueStatus?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | null;
  lastRoleSyncError?: string | null;
}

export type AccessManagementModel =
  | { kind: 'LOADING'; mappings: RoleMappingRecord[]; requestId: null }
  | { kind: 'READY'; mappings: RoleMappingRecord[]; requestId: null }
  | { kind: 'EMPTY'; mappings: RoleMappingRecord[]; requestId: null }
  | { kind: 'FORBIDDEN'; mappings: RoleMappingRecord[]; requestId: string | null }
  | { kind: 'STEP_UP_REQUIRED'; mappings: RoleMappingRecord[]; requestId: string | null }
  | { kind: 'ERROR'; mappings: RoleMappingRecord[]; requestId: string | null };
export type StaffAccountPage={items:StaffAccountRecord[];nextCursor:string|null};

export function buildRoleMappingUpdateRequest(input: {
  mapping: RoleMappingRecord;
  discordRoleId: string;
  reasonCode: string;
}) {
  const discordRoleId = requireText(input.discordRoleId, 'discordRoleId');
  const reasonCode = requireText(input.reasonCode, 'reasonCode').toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,99}$/u.test(reasonCode)) throw new Error('reasonCode is invalid.');
  return {
    method: 'PUT' as const,
    path: `/api/v1/admin/discord-role-mappings/${input.mapping.targetLevel}`,
    body: {
      guildId: input.mapping.guildId,
      discordRoleId,
      expectedVersion: input.mapping.version,
      enabled: true,
      reasonCode
    }
  };
}

export const staffLevelLabels: Record<StaffLevel, string> = {
  L1_SUPPORT: 'L1 客服',
  L2_SUPERVISOR: 'L2 主管',
  L3_OPERATIONS: 'L3 运营',
  L4_ADMIN_OWNER: 'L4 所有者'
};
export function buildStaffElevationApprovalRequest(staff:StaffAccountRecord,reasonCode:string){if(!staff.pendingElevationLevel)throw new Error('No role elevation is pending.');return{method:'POST' as const,path:`/api/v1/admin/staff/${encodeURIComponent(staff.staffId)}/role-elevation/approve`,body:{expectedPermissionsVersion:staff.permissionsVersion,requestedLevel:staff.pendingElevationLevel,reasonCode:reason(reasonCode)}};}
export function buildStaffRoleUpdateRequest(staff:StaffAccountRecord,level:StaffLevel,status:'ACTIVE'|'REVOKED',reasonCode:string){return{method:'PATCH' as const,path:`/api/v1/admin/staff/${encodeURIComponent(staff.staffId)}/role`,body:{expectedPermissionsVersion:staff.permissionsVersion,level,status,reasonCode:reason(reasonCode)}};}
export function buildStaffSessionRevocationRequest(staff:StaffAccountRecord,reasonCode:string){return{method:'POST' as const,path:`/api/v1/admin/staff/${encodeURIComponent(staff.staffId)}/revoke-sessions`,body:{reasonCode:reason(reasonCode)}};}
export function buildStaffRoleReconciliationRequest(staff: StaffAccountRecord) {
  return {
    method: 'POST' as const,
    path: `/api/v1/admin/staff/${encodeURIComponent(staff.staffId)}/discord-role-reconcile`,
    body: { reasonCode: 'ROLE_SYNC_RECOVERY' }
  };
}
function reason(value:string){const normalized=requireText(value,'reasonCode').toUpperCase();if(!/^[A-Z][A-Z0-9_]{2,99}$/u.test(normalized))throw new Error('reasonCode is invalid.');return normalized;}

function requireText(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}
