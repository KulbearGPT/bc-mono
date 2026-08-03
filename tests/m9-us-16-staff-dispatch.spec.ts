import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { buildAdminBusinessPage } from "@blackcat/dashboard/admin-business";
import { buildSelectionVoicePlan } from "@blackcat/bot/selection-discord";

describe("M9-US-16 staff selection observer", () => {
  test("gives configured staff roles voice access and a notice without a selection action", () => {
    const plan = buildSelectionVoicePlan({
      phase: "SELECTION",
      guildId: "999999999999999999",
      orderId: "00000000-0000-0000-0000-000000000001",
      orderPublicId: "P-1",
      customerDiscordUserId: "111111111111111111",
      applicantDiscordUserIds: ["222222222222222222"],
      selectedDiscordUserIds: [],
      staffRoleIds: ["333333333333333333"],
      voiceChannelId: null,
      staffTaskChannelId: "444444444444444444",
    });
    expect(plan.allowRoleIds).toEqual(["333333333333333333"]);
    expect(plan.staffNotice).toContain("客服可以加入试音房");
    const page = buildAdminBusinessPage({
      page: "orders",
      permissions: ["order.read", "dispatch.manual"],
      status: "READY",
      items: [],
    });
    expect(page.actions.map((action) => action.id)).not.toContain("MANUAL_DISPATCH");
  });

  test("retires the old targeted-dispatch client entry points", async () => {
    const [server, dashboard] = await Promise.all([
      readFile("apps/api/src/server.ts", "utf8"),
      readFile("apps/dashboard/src/AdminBusinessRoute.tsx", "utf8"),
    ]);
    expect(server).not.toContain("registerDispatchRoutes(server");
    expect(dashboard).not.toContain("dispatch-candidates");
    expect(dashboard).not.toContain("MANUAL_DISPATCH");
  });
});
