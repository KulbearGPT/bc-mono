import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { buildAdminBusinessPage } from "@blackcat/dashboard/admin-business";
import { botConfigBooleanFields } from "@blackcat/bot/bot-config";

describe("M9-US-15 customer-controlled selection windows", () => {
  test("retires auto/manual dispatch controls from every production client", async () => {
    const [worker, server, adminBusiness] = await Promise.all([
      readFile("apps/api/src/worker.ts", "utf8"),
      readFile("apps/api/src/server.ts", "utf8"),
      readFile("apps/dashboard/src/admin-business.ts", "utf8"),
    ]);
    expect(worker).not.toContain("auto_dispatch_enabled");
    expect(server).not.toContain("registerDispatchRoutes(server");
    expect(adminBusiness).not.toContain("MANUAL_DISPATCH");
    expect(botConfigBooleanFields).not.toContain("auto_dispatch_enabled");
  });

  test("does not offer staff a customer-selection action", () => {
    const page = buildAdminBusinessPage({
      page: "orders",
      permissions: ["order.read", "dispatch.manual"],
      status: "READY",
      items: [{ id: "order-1", version: 7, status: "PENDING_DISPATCH" }],
    });
    expect(page.actions.map((action) => action.id)).not.toContain("MANUAL_DISPATCH");
  });
});
