import { describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  HttpBotApiClient,
  buildDispatchOfferMessage,
  buildDiscordIdempotencyKey,
  type BotActorContext,
  type DispatchOfferSummary,
} from "@blackcat/bot/service-center";
import { discoverSapphirePieces } from "@blackcat/bot/piece-manifest";

const guildId = "999999999999999999";
const dispatchAttemptId = "00000000-0000-0000-0000-00000000d201";
const orderId = "00000000-0000-0000-0000-00000000b001";

function actor(): BotActorContext {
  return {
    guildId,
    discordUserId: "222222222222222222",
    interactionId: "888888888888888888",
    clientSource: "DISCORD_BOT",
  };
}

function offer(
  overrides: Partial<DispatchOfferSummary> = {},
): DispatchOfferSummary {
  return {
    dispatchAttemptId,
    orderId,
    orderPublicId: "P-2001",
    orderVersion: 3,
    game: "瓦洛兰特",
    service: "娱乐陪玩",
    region: "北美",
    durationLabel: "2 小时",
    playerEarningMinor: 8400,
    currency: "CAT",
    notes: "中文交流",
    expiresAt: "2026-07-18T01:05:00.000Z",
    voiceChannelId: "666666666666666666",
    ...overrides,
  };
}

describe("M2-US-02 Bot dispatch card", () => {
  test("renders a concentrated dispatch offer card with accept and decline actions", () => {
    const message = buildDispatchOfferMessage(offer());

    expect(message.visibility).toBe("PRIVATE_CHANNEL");
    expect(message.title).toBe("新订单 #P-2001");
    expect(message.body).toContain("瓦洛兰特 · 娱乐陪玩");
    expect(message.body).not.toContain("VALORANT · ENTERTAINMENT");
    expect(message.body).toContain("预计收益：840.0 CAT");
    expect(message.body).toContain("语音频道：666666666666666666");
    expect(message.body).not.toMatch(/余额|用户账户|内部定价/);
    expect(message.components[0]?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "BUTTON",
          customId: `bc:dispatch:${dispatchAttemptId}:accept:${orderId}:v3`,
          label: "确认接单",
        }),
        expect.objectContaining({
          type: "BUTTON",
          customId: `bc:dispatch:${dispatchAttemptId}:decline:${orderId}:v3`,
          label: "暂不接单",
        }),
      ]),
    );
  });

  test("HttpBotApiClient accepts and declines dispatch offers through the unified API", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: orderId, status: "ACCEPTED", version: 4 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: orderId, status: "PENDING_DISPATCH", version: 3 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpBotApiClient({
      apiBaseUrl: "https://api.example.test",
      botServiceToken: "bot-token",
    });

    await client.acceptOrder(
      orderId,
      { expectedVersion: 3, dispatchAttemptId },
      actor(),
      buildDiscordIdempotencyKey("dispatch:accept", "888888888888888888"),
    );
    await client.declineOrderOffer(
      orderId,
      { expectedVersion: 3 },
      actor(),
      buildDiscordIdempotencyKey("dispatch:decline", "888888888888888888"),
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.example.test/api/v1/orders/${orderId}/accept`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.example.test/api/v1/orders/${orderId}/decline`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("registers a Sapphire dispatch interaction handler", async () => {
    const manifest = await discoverSapphirePieces();
    const source = await readFile(
      "apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts",
      "utf8",
    );

    expect(manifest.pieces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "interaction-handlers",
          name: "dispatch-buttons",
        }),
      ]),
    );
    expect(source).toContain("applyToSelectionPool");
    expect(source).toContain("withdrawSelectionApplication");
    expect(source).not.toContain("acceptOrder(");
    expect(source).toContain("buildDiscordIdempotencyKey");
  });
});
