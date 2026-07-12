import { describe, expect, test } from "vitest";
import { resolveStaffPolicy } from "../apps/api/src/authorization-policy.js";
import {InMemoryCustomerProfileStore,updateAdminCustomerProfile} from "../apps/api/src/customer-profiles.js";
import { buildCustomerProfileUpdateRequest } from "../apps/dashboard/src/customer-profile.js";

describe("M15-US-07 customer display-name correction", () => {
  test("is available from L2 but not L1", () => {
    expect(resolveStaffPolicy("L1_SUPPORT").permissions).not.toContain(
      "customer_profile.manage",
    );
    expect(resolveStaffPolicy("L2_SUPERVISOR").permissions).toContain(
      "customer_profile.manage",
    );
  });

  test("only sends displayName, version, reason and note", () => {
    expect(
      buildCustomerProfileUpdateRequest(
        "00000000-0000-0000-0000-000000000501",
        {
          displayName: "北美老板小林",
          expectedVersion: 2,
          reasonCode: "CUSTOMER_REQUEST",
          note: "老板联系客服纠正业务展示名。",
        },
      ),
    ).toEqual({
      method: "PATCH",
      path: "/api/v1/admin/users/00000000-0000-0000-0000-000000000501/profile-summary",
      body: {
        displayName: "北美老板小林",
        expectedVersion: 2,
        reasonCode: "CUSTOMER_REQUEST",
        note: "老板联系客服纠正业务展示名。",
      },
    });
  });

  test("updates only the scoped customer and rejects a stale version",async()=>{
    const store=new InMemoryCustomerProfileStore({users:[{id:"00000000-0000-0000-0000-000000000501",guildId:"guild-a",discordUserId:"discord-owner",displayName:"旧名称",status:"ACTIVE",version:2}]});
    const actor={actorUserId:"user-staff",actorStaffId:"staff-l2",actorLevel:"L2_SUPERVISOR" as const,actorSource:"DASHBOARD" as const,clientId:"dashboard",guildId:"guild-a",discordUserId:null,interactionId:null,permissionsVersion:1};
    const updated=await updateAdminCustomerProfile({store,actor,userId:"00000000-0000-0000-0000-000000000501",body:{displayName:"新名称",expectedVersion:2,reasonCode:"CUSTOMER_REQUEST",note:"客服核验"},now:new Date("2026-08-06T12:00:00Z")});
    expect(updated).toMatchObject({displayName:"新名称",discordUserId:"discord-owner",version:3});
    await expect(updateAdminCustomerProfile({store,actor,userId:"00000000-0000-0000-0000-000000000501",body:{displayName:"并发旧写入",expectedVersion:2,reasonCode:"CUSTOMER_REQUEST"},now:new Date("2026-08-06T12:01:00Z")})).rejects.toMatchObject({code:"CONFLICT"});
  });
});
