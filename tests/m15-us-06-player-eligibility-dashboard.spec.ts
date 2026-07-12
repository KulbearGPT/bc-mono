import { describe, expect, test } from "vitest";
import {
  buildAdminActionRequest,
  buildAdminBusinessPage,
} from "../apps/dashboard/src/admin-business.js";

describe("M15-US-06 staff-controlled player eligibility", () => {
  test("exposes the staff-only eligibility action to L3 permissions", () => {
    const model = buildAdminBusinessPage({
      page: "players",
      permissions: ["player.read", "player.status.manage"],
      status: "READY",
      items: [],
    });
    expect(model.actions.map((action) => action.id)).toContain(
      "SET_PLAYER_OPERATIONAL_STATUS",
    );
  });

  test("maps pause to the existing unified player operational-status API", () => {
    expect(
      buildAdminActionRequest({
        actionId: "SET_PLAYER_OPERATIONAL_STATUS",
        item: {
          playerId: "00000000-0000-0000-0000-000000000601",
          version: 3,
        },
        fields: {
          status: "PAUSED",
          reasonCode: "CUSTOMER_COMPLAINT_REVIEW",
          note: "服务中投诉调查期间暂停新接单。",
        },
      }),
    ).toEqual({
      method: "PUT",
      path: "/api/v1/admin/players/00000000-0000-0000-0000-000000000601/operational-status",
      body: {
        expectedVersion: 3,
        reviewStatus: "PAUSED",
        reasonCode: "CUSTOMER_COMPLAINT_REVIEW",
        note: "服务中投诉调查期间暂停新接单。",
      },
    });
  });
});
