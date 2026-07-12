import { describe, expect, test } from "vitest";
import {
  buildStaffElevationApprovalRequest,
  buildStaffRoleUpdateRequest,
  buildStaffSessionRevocationRequest,
} from "../apps/dashboard/src/access-management.js";

const staff={staffId:"staff-target",displayName:"客服小白",effectiveLevel:"L2_SUPERVISOR" as const,pendingElevationLevel:"L3_OPERATIONS" as const,permissionsVersion:4,activeSessions:2,status:"ACTIVE" as const};

describe("M15-US-08 staff account Dashboard actions",()=>{
  test("builds separated approval with the current permissions version",()=>{
    expect(buildStaffElevationApprovalRequest(staff,"ROLE_AND_IDENTITY_VERIFIED")).toEqual({method:"POST",path:"/api/v1/admin/staff/staff-target/role-elevation/approve",body:{expectedPermissionsVersion:4,requestedLevel:"L3_OPERATIONS",reasonCode:"ROLE_AND_IDENTITY_VERIFIED"}});
  });
  test("builds downgrade/revoke and session revocation without client authority claims",()=>{
    expect(buildStaffRoleUpdateRequest(staff,"L1_SUPPORT","ACTIVE","ACCESS_CORRECTION")).toEqual({method:"PATCH",path:"/api/v1/admin/staff/staff-target/role",body:{expectedPermissionsVersion:4,level:"L1_SUPPORT",status:"ACTIVE",reasonCode:"ACCESS_CORRECTION"}});
    expect(buildStaffSessionRevocationRequest(staff,"SECURITY_RESPONSE")).toEqual({method:"POST",path:"/api/v1/admin/staff/staff-target/revoke-sessions",body:{reasonCode:"SECURITY_RESPONSE"}});
  });
});
