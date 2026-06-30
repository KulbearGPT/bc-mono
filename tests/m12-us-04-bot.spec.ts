import { describe, expect, test, vi } from "vitest";
import {
  buildLowRatingReasonMessage,
  buildSupportRatingMessage,
  handleSupportRatingAction,
  parseServiceCenterCustomId,
  type BotApiClient,
} from "@blackcat/bot/service-center";
import { DiscordRestWorkerAdapter } from "@blackcat/api/worker-adapters";

const orderId = "00000000-0000-0000-0000-000000012451";
const actor = {
  guildId: "999999999999999999",
  discordUserId: "111111111111111111",
  interactionId: "888888888888888888",
  clientSource: "DISCORD_BOT" as const,
};

describe("M12-US-04 Discord support rating flow", () => {
  test("completed order panel exposes the rating entry only when eligible", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "777777777777777777" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const adapter = new DiscordRestWorkerAdapter({ token: "token", fetch });
    await adapter.upsertOrderPanel(
      {
        orderId,
        publicId: "P-M12-RATING",
        status: "COMPLETED",
        version: 10,
        channelId: "777777777777777777",
        panelMessageId: "666666666666666666",
        customerDiscordUserId: actor.discordUserId,
        playerDiscordUserId: null,
        amountMinor: 100,
        currency: "CAT",
        supportRatingEligible: true,
      },
      "2026-08-05T16:00:00.000Z",
    );
    const body = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.stringify(body)).toContain(
      `bc:support-rating:${orderId}:start`,
    );
  });

  test("renders five scores and parses their routes", () => {
    const message = buildSupportRatingMessage(orderId);
    expect(message.components[0]!.components).toHaveLength(5);
    expect(
      parseServiceCenterCustomId(`bc:support-rating:${orderId}:s2`),
    ).toMatchObject({
      area: "support-rating",
      orderId,
      score: 2,
      reason: null,
    });
  });

  test("low scores request a controlled reason and OTHER opens a comment modal", async () => {
    const api = {} as BotApiClient;
    const result = await handleSupportRatingAction({
      api,
      actor,
      orderId,
      score: 1,
      reason: null,
      idempotencyKey: "rating-low",
    });
    expect(result).toEqual({
      kind: "SHOW_SUPPORT_RATING",
      message: buildLowRatingReasonMessage(orderId, 1),
    });

    const other = await handleSupportRatingAction({
      api,
      actor,
      orderId,
      score: 1,
      reason: "OTHER",
      idempotencyKey: "rating-other",
    });
    expect(other).toMatchObject({
      kind: "SHOW_MODAL",
      modal: { components: [{ required: true, maxLength: 500 }] },
    });
  });

  test("scores 3-5 submit through the API exactly once", async () => {
    const submitSupportRating = vi.fn().mockResolvedValue({});
    const api = { submitSupportRating } as unknown as BotApiClient;
    const result = await handleSupportRatingAction({
      api,
      actor,
      orderId,
      score: 5,
      reason: null,
      idempotencyKey: "rating-high",
    });

    expect(result).toEqual({
      kind: "EPHEMERAL_MESSAGE",
      message: "感谢评价，已记录。",
    });
    expect(submitSupportRating).toHaveBeenCalledOnce();
  });
});
