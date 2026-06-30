import { describe, expect, test } from "vitest";
import { buildApiServer } from "@blackcat/api/server";
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
} from "@blackcat/api/security";
import { InMemorySupportRatingStore } from "@blackcat/api/support-response-rating";

const now = new Date("2026-08-05T16:00:00.000Z");
const guildId = "999999999999999999";
const customerDiscordId = "111111111111111111";
const otherDiscordId = "222222222222222222";
const orderId = "00000000-0000-0000-0000-000000012401";
const customerId = "00000000-0000-0000-0000-000000012402";
const staffId = "00000000-0000-0000-0000-000000012403";

describe("M12-US-04 support rating API", () => {
  test("accepts one eligible rating and attributes the real first responder", async () => {
    const store = new InMemorySupportRatingStore({
      orders: [eligibleOrder()],
    });
    const server = testServer(store);

    const response = await server.inject({
      method: "POST",
      url: `/api/v1/orders/${orderId}/support-rating`,
      headers: headers("rating-valid"),
      payload: { score: 5 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      orderId,
      score: 5,
      attributedStaffId: staffId,
    });
    expect(store.ratings).toHaveLength(1);

    const duplicate = await server.inject({
      method: "POST",
      url: `/api/v1/orders/${orderId}/support-rating`,
      headers: headers("rating-duplicate"),
      payload: { score: 4 },
    });
    expect(duplicate.statusCode).toBe(409);
  });

  test("validates low-score reasons and OTHER comments", async () => {
    const server = testServer(
      new InMemorySupportRatingStore({ orders: [eligibleOrder()] }),
    );

    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/orders/${orderId}/support-rating`,
          headers: headers("rating-low-no-reason"),
          payload: { score: 2 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/orders/${orderId}/support-rating`,
          headers: headers("rating-other-no-comment"),
          payload: { score: 1, reason: "OTHER" },
        })
      ).statusCode,
    ).toBe(400);
  });

  test("rejects another customer, missing first response, and expired window", async () => {
    const noResponseId = "00000000-0000-0000-0000-000000012411";
    const expiredId = "00000000-0000-0000-0000-000000012412";
    const server = testServer(
      new InMemorySupportRatingStore({
        orders: [
          eligibleOrder(),
          { ...eligibleOrder(), id: noResponseId, respondedStaffId: null },
          {
            ...eligibleOrder(),
            id: expiredId,
            completedAt: "2026-08-04T15:59:59.999Z",
          },
        ],
      }),
    );

    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/orders/${orderId}/support-rating`,
          headers: headers("rating-wrong-customer", otherDiscordId),
          payload: { score: 5 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/orders/${noResponseId}/support-rating`,
          headers: headers("rating-no-response"),
          payload: { score: 5 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/v1/orders/${expiredId}/support-rating`,
          headers: headers("rating-expired"),
          payload: { score: 5 },
        })
      ).statusCode,
    ).toBe(409);
  });
});

function eligibleOrder() {
  return {
    id: orderId,
    guildId,
    customerId,
    customerDiscordId,
    status: "COMPLETED",
    completedAt: now.toISOString(),
    respondedStaffId: staffId,
  };
}

function testServer(store: InMemorySupportRatingStore) {
  return buildApiServer({
    env: {
      NODE_ENV: "development",
      DATABASE_URL: "",
      API_PORT: "0",
      API_BASE_URL: "http://localhost:3000",
      BOT_SERVICE_TOKEN: "valid-bot-token",
    },
    security: {
      auditSink: new InMemoryAuditSink(),
      idempotencyStore: new InMemoryIdempotencyStore(),
    },
    supportRatings: { store, now: () => now },
  });
}

function headers(key: string, discordUserId = customerDiscordId) {
  return {
    authorization: "Bearer valid-bot-token",
    "x-client-source": "DISCORD_BOT",
    "x-actor-discord-user-id": discordUserId,
    "x-actor-guild-id": guildId,
    "idempotency-key": `m12-support-${key}`,
  };
}
