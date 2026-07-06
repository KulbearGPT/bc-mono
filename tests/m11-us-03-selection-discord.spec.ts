import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { buildSubmittedOrderMessage } from "@blackcat/bot/service-center";
import {
  buildSelectionCandidatePanel,
  buildSelectionPoolOfferMessage,
  buildSelectionVoicePlan,
  parseSelectionCustomId,
} from "@blackcat/bot/selection-discord";
import {
  createSelectionPoolCloseHandler,
  createSelectionPoolSyncHandler,
  DiscordSelectionPoolAdapter,
} from "@blackcat/api/selection-pool-worker";

const orderId = "00000000-0000-0000-0000-000000011020";
const poolId = "00000000-0000-0000-0000-000000011040";
const requirementId = "00000000-0000-0000-0000-000000011050";
const applicationId = "00000000-0000-0000-0000-000000011060";

describe("M11-US-03 Discord selection flow", () => {
  test("does not let the retired pending-dispatch panel overwrite the wait-time selector", async () => {
    const source = await readFile("apps/api/src/orders.ts", "utf8");
    const postgres = source.slice(source.indexOf("export class PostgresOrderStore"));
    const commitSubmit = postgres.slice(
      postgres.indexOf("async commitSubmit(input:"),
      postgres.indexOf("async commitCancel(input:"),
    );

    expect(commitSubmit).not.toContain("ORDER_SUBMITTED_CHANNEL_SYNC");
    expect(commitSubmit).not.toContain("insertOrderPanelSync");
  });

  test("offers the five customer-approved wait-time presets", () => {
    const message = buildSubmittedOrderMessage({
      orderId,
      status: "PENDING_DISPATCH",
      version: 3,
      reservation: {
        reservationId: "00000000-0000-0000-0000-000000011090",
        amountMinor: 100,
        capturedMinor: 0,
        releasedMinor: 0,
        currency: "CAT",
        status: "ACTIVE",
        version: 1,
        expiresAt: "2026-08-04T12:30:00.000Z",
      },
      balance: {
        ledgerBalanceMinor: 1000,
        reservedMinor: 100,
        availableMinor: 900,
        currency: "CAT",
        calculatedAt: "2026-08-04T12:00:00.000Z",
      },
    });
    const selects = message.components.flatMap((row) => row.components).filter(
      (component) => component.type === "STRING_SELECT" && component.customId.startsWith("bc:sp:new:"),
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]!.options.map((option) => Number(option.value))).toEqual([
      3, 5, 10, 15, 30,
    ]);
  });

  test("renders nine-project apply and private customer selection controls under Discord custom-id limits", () => {
    const requirements = Array.from({ length: 9 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${String(11050 + index).padStart(12, "0")}`,
      label: `项目 ${index + 1}`,
      remainingSlots: 2,
      expectedEarningMinor: 120,
      currency: "CAT",
    }));
    const offer = buildSelectionPoolOfferMessage({
      orderId,
      poolId,
      poolVersion: 2,
      orderPublicId: "P-M11",
      closesAt: "2026-08-04T12:03:00Z",
      requirements,
    });
    const apply = offer.components[0]!.components[0]!;
    expect(apply.type).toBe("STRING_SELECT");
    expect(apply.options).toHaveLength(9);
    expect(apply.customId.length).toBeLessThanOrEqual(100);
    expect(parseSelectionCustomId(apply.customId)).toMatchObject({
      action: "apply-menu",
      orderId,
      poolId,
      expectedPoolVersion: 2,
    });
    const panel = buildSelectionCandidatePanel({
      orderId,
      poolId,
      poolVersion: 4,
      orderVersion: 7,
      items: [
        {
          id: applicationId,
          playerDisplayName: "奶糖",
          orderRequirementId: requirementId,
          publicGameTags: ["瓦洛兰特"],
          publicServiceTags: ["技术陪玩"],
        },
      ],
      nextCursor: null,
      selectedApplicationIds: [applicationId],
    });
    expect(panel.body).not.toMatch(/评分|排名|审核原因/u);
    expect(
      panel.components
        .flatMap((row) => row.components)
        .every((component) => component.customId.length <= 100),
    ).toBe(true);
  });

  test("builds an unlimited selection room and revokes/disconnects every nonselected applicant after finalization", () => {
    const selection = buildSelectionVoicePlan({
      phase: "SELECTION",
      guildId: "999999999999999999",
      orderId,
      orderPublicId: "P-M11",
      customerDiscordUserId: "111111111111111111",
      applicantDiscordUserIds: ["222222222222222222", "333333333333333333"],
      selectedDiscordUserIds: [],
      staffRoleIds: ["444444444444444444"],
      voiceChannelId: null,
      staffTaskChannelId: "555555555555555555",
    });
    expect(selection.userLimit).toBe(0);
    expect(selection.allowMemberIds).toEqual([
      "111111111111111111",
      "222222222222222222",
      "333333333333333333",
    ]);
    expect(selection.staffNotice).toContain("客服可以加入语音频道");
    const finalized = buildSelectionVoicePlan({
      ...selection.projection,
      phase: "FINALIZED",
      voiceChannelId: "666666666666666666",
      selectedDiscordUserIds: ["222222222222222222"],
    });
    expect(finalized.revokeMemberIds).toEqual(["333333333333333333"]);
    expect(finalized.disconnectMemberIds).toEqual(["333333333333333333"]);
  });

  test("validates close/sync jobs and delegates idempotent work", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const sync = vi.fn().mockResolvedValue(undefined);
    const closeHandler = createSelectionPoolCloseHandler({ close });
    const syncHandler = createSelectionPoolSyncHandler({ sync });
    await closeHandler(
      job("SELECTION_POOL_CLOSE", { orderId, selectionPoolId: poolId }),
    );
    await syncHandler(
      job("SELECTION_POOL_SYNC", {
        orderId,
        selectionPoolId: poolId,
        phase: "SELECTION",
      }),
    );
    expect(close).toHaveBeenCalledWith(poolId, "2026-08-04T12:03:00.000Z");
    expect(sync).toHaveBeenCalledWith(
      poolId,
      "SELECTION",
      "2026-08-04T12:00:00.000Z",
    );
  });

  test("creates one recovery task only on the terminal Discord sync attempt", async () => {
    const sync = vi.fn().mockRejectedValue(new Error("Discord unavailable"));
    const terminalFailure = vi.fn().mockResolvedValue(undefined);
    const handler = createSelectionPoolSyncHandler({
      sync,
      onTerminalFailure: terminalFailure,
    });
    await expect(
      handler({
        ...job("SELECTION_POOL_SYNC", {
          orderId,
          selectionPoolId: poolId,
          phase: "FINALIZED",
        }),
        attempts: 7,
        maxAttempts: 8,
      }),
    ).rejects.toThrow("Discord unavailable");
    expect(terminalFailure).not.toHaveBeenCalled();
    await expect(
      handler({
        ...job("SELECTION_POOL_SYNC", {
          orderId,
          selectionPoolId: poolId,
          phase: "FINALIZED",
        }),
        attempts: 8,
        maxAttempts: 8,
      }),
    ).rejects.toThrow("Discord unavailable");
    expect(terminalFailure).toHaveBeenCalledOnce();
  });

  test("uses Discord REST idempotently with user_limit zero and explicit loser cleanup", async () => {
    const calls: Array<{
      url: string;
      method: string;
      body: Record<string, unknown> | null;
    }> = [];
    let voiceCreated = false;
    const postedMessages = new Map<string, Array<{ nonce: string; timestamp: string }>>();
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null;
        calls.push({ url, method: init?.method ?? "GET", body });
        if (
          url.endsWith("/guilds/999999999999999999/channels") &&
          init?.method === "GET"
        )
          return Response.json(
            voiceCreated
              ? [{ id: "666666666666666666", name: "selection-p-m11", type: 2, parent_id: null }]
              : [],
          );
        if (
          url.endsWith("/guilds/999999999999999999/channels") &&
          init?.method === "POST"
        ) {
          voiceCreated = true;
          return Response.json({ id: "666666666666666666" });
        }
        if (url.endsWith("/users/@me/channels"))
          return Response.json({ id: "888888888888888888" });
        if (url.includes("/messages?limit=100"))
          return Response.json(postedMessages.get(url.split("/messages?")[0]!) ?? []);
        if (init?.method === "POST") {
          if (url.endsWith("/messages") && typeof body?.nonce === "string") {
            const channel = url.slice(0, -"/messages".length);
            postedMessages.set(channel, [
              ...(postedMessages.get(channel) ?? []),
              { nonce: body.nonce, timestamp: "2026-08-04T12:00:00.000Z" },
            ]);
          }
          return Response.json({ id: "999999999999999998" });
        }
        return new Response(null, { status: 204 });
      },
    );
    const adapter = new DiscordSelectionPoolAdapter({
      token: "token",
      apiBaseUrl: "https://discord.test",
      fetch: fetcher as typeof fetch,
    });
    const projection = {
      poolId,
      poolVersion: 3,
      poolStatus: "SELECTION",
      orderId,
      orderPublicId: "P-M11",
      orderStatus: "PENDING_DISPATCH",
      orderVersion: 1,
      guildId: "999999999999999999",
      orderChannelId: "111111111111111110",
      voiceChannelId: null,
      customerUserId: "00000000-0000-0000-0000-000000011001",
      customerDiscordUserId: "111111111111111111",
      dispatchChannelId: "222222222222222220",
      staffTaskChannelId: "555555555555555555",
      privateOrderCategoryId: null,
      staffRoleIds: ["444444444444444444"],
      applicants: Array.from({ length: 9 }, (_, index) => ({
        applicationId:
          index === 0
            ? applicationId
            : `00000000-0000-0000-0000-${String(11060 + index).padStart(12, "0")}`,
        discordUserId: String(222222222222222222n + BigInt(index)),
        displayName: `候选${index + 1}`,
        status: "APPLIED",
        applicationVersion: 1,
        requirementId,
      })),
      selectedPlayers: [],
      selectedDiscordUserIds: [],
      requirements: [],
    };
    const voice = await adapter.sync(
      projection,
      "SELECTION",
      "2026-08-04T12:00:00Z",
    );
    expect(voice).toBe("666666666666666666");
    const create = calls.find(
      (call) =>
        call.url.endsWith("/guilds/999999999999999999/channels") &&
        call.method === "POST",
    )!;
    expect(create.body).toMatchObject({ user_limit: 0 });
    expect(JSON.stringify(create.body)).toContain("222222222222222230");
    await expect(
      adapter.sync(projection, "SELECTION", "2026-08-04T12:00:00Z"),
    ).resolves.toBe(voice);
    expect(
      calls.filter(
        (call) =>
          call.url.endsWith("/guilds/999999999999999999/channels") &&
          call.method === "POST",
      ),
    ).toHaveLength(1);
    const selectedPlayers = projection.applicants.slice(0, 3).map((item) => ({
      discordUserId: item.discordUserId,
      displayName: item.displayName,
    }));
    await adapter.sync(
      {
        ...projection,
        poolStatus: "FINALIZED",
        voiceChannelId: voice,
        selectedPlayers,
        selectedDiscordUserIds: selectedPlayers.map((item) => item.discordUserId),
      },
      "FINALIZED",
      "2026-08-04T12:01:00Z",
    );
    expect(
      calls.filter((call) => call.url.includes("/permissions/") && call.method === "PUT"),
    ).toHaveLength(6);
    expect(
      calls.filter((call) => call.url.includes("/members/") && call.method === "PATCH"),
    ).toHaveLength(6);
    expect(JSON.stringify(calls)).toContain("入选陪玩：候选1、候选2、候选3");
  });

  test("retires first-wins and manual availability from runtime interaction paths", async () => {
    const [handler, center, worker] = await Promise.all([
      readFile(
        "apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts",
        "utf8",
      ),
      readFile("apps/bot/src/service-center.ts", "utf8"),
      readFile("apps/api/src/worker.ts", "utf8"),
    ]);
    expect(handler).toContain("applyToSelectionPool");
    expect(handler).not.toContain("acceptOrder(");
    expect(center).not.toContain("setPlayerAvailability(");
    expect(center).not.toContain("设为可接单");
    expect(worker).not.toContain("auto_dispatch_enabled");
    expect(worker).toContain("createSelectionPoolCloseHandler");
    expect(worker).toContain("createSelectionPoolSyncHandler");
  });
});

function job(
  type: "SELECTION_POOL_CLOSE" | "SELECTION_POOL_SYNC",
  payload: Record<string, unknown>,
) {
  return {
    id: "00000000-0000-0000-0000-000000011099",
    type,
    status: "PROCESSING" as const,
    payload,
    aggregateType: "selection_pool",
    aggregateId: poolId,
    dedupeKey: `m11:${type}`,
    attempts: 1,
    maxAttempts: 8,
    runAfter: "2026-08-04T12:03:00.000Z",
    lockedAt: "2026-08-04T12:03:00.000Z",
    lockedBy: "worker",
    lastError: null,
    version: 2,
    createdAt: "2026-08-04T12:00:00.000Z",
    updatedAt: "2026-08-04T12:03:00.000Z",
  };
}
