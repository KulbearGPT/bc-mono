import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { buildSubmittedOrderMessage } from "@blackcat/bot/service-center";

describe("M9-US-13 candidate-pool dispatch replacement", () => {
  test("order submission no longer enqueues first-wins work and offers a customer-selected wait window", async () => {
    const [orders, worker] = await Promise.all([
      readFile("apps/api/src/orders.ts", "utf8"),
      readFile("apps/api/src/worker.ts", "utf8"),
    ]);
    expect(orders).not.toContain("'DISPATCH_START'");
    expect(orders).not.toContain("dispatchStartJob");
    expect(worker).toContain("createSelectionPoolCloseHandler");
    expect(worker).not.toContain("TIMEOUT_RETRY");
    const message = buildSubmittedOrderMessage({
      orderId: "00000000-0000-0000-0000-000000009014",
      status: "PENDING_DISPATCH",
      version: 5,
      reservation: {
        id: "00000000-0000-0000-0000-000000009015",
        status: "ACTIVE",
        amountMinor: 100,
        currency: "CAT",
        version: 1,
      },
      balance: {
        ledgerBalanceMinor: 1000,
        reservedMinor: 100,
        availableMinor: 900,
        currency: "CAT",
        calculatedAt: "2026-08-04T00:00:00Z",
        version: 1,
      },
    });
    const waits = message.components.slice(0, 1).flatMap((row) => row.components);
    expect(waits.every((component) => component.type === "STRING_SELECT")).toBe(true);
    expect(waits.flatMap((component) => component.options?.map((option) => option.value) ?? [])).toEqual(
      ["1", "3", "5", "10", "15", "30"],
    );
  });

  test("Discord handler acknowledges before applying and never exposes first-wins accept/decline", async () => {
    const handler = await readFile(
      "apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts",
      "utf8",
    );
    expect(handler.indexOf("await interaction.deferReply(")).toBeGreaterThan(
      -1,
    );
    expect(handler.indexOf("await interaction.deferReply(")).toBeLessThan(
      handler.indexOf("await api.applyToSelectionPool("),
    );
    expect(handler).toContain("formatUserFacingError(error");
    expect(handler).not.toContain("acceptOrder(");
    expect(handler).not.toContain("declineOrderOffer(");
  });
});
