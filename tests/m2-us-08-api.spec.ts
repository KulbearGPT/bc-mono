import { describe, expect, test } from "vitest";
import { buildApiServer } from "@blackcat/api/server";
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
} from "@blackcat/api/security";
import {
  InMemoryPlayerStore,
  registerPlayerRoutes,
  type PlayerProfileRecord,
  type PlayerWorkbenchData,
} from "@blackcat/api/players";

const now = new Date("2026-07-18T00:00:00.000Z");
const guildId = "999999999999999999";
const playerUserId = "00000000-0000-0000-0000-00000000a101";

const profile: PlayerProfileRecord = {
  playerId: "00000000-0000-0000-0000-00000000a001",
  userId: playerUserId,
  guildId,
  discordUserId: "111111111111111111",
  userStatus: "ACTIVE",
  reviewStatus: "ACTIVE",
  availability: "AVAILABLE",
  discordPresence: "ONLINE",
  presenceObservedAt: now.toISOString(),
  gameTags: ["VALORANT"],
  serviceTags: ["ENTERTAINMENT"],
  activeOrderId: null,
  approvedByStaffId: null,
  approvedAt: now.toISOString(),
  pausedAt: null,
  suspendedAt: null,
  version: 3,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

const workbench: PlayerWorkbenchData = {
  currentOrder: null,
  matchingOrders: [
    {
      dispatchAttemptId: "00000000-0000-0000-0000-00000000d001",
      acceptBy: "2026-07-18T00:02:00.000Z",
      secondsRemaining: 120,
      order: {
        id: "00000000-0000-0000-0000-00000000b001",
        publicId: "P-1042",
        status: "PENDING_DISPATCH",
        version: 5,
        game: "VALORANT",
        service: "ENTERTAINMENT",
        region: "NA",
        durationMinutes: 120,
        playerEarningMinor: 8_000,
        currency: "CAT",
        requirements: ["中文交流", "轻松娱乐"],
        voiceChannelId: "120000000000000003",
      },
    },
  ],
  earningsSummary: {
    pendingMinor: 8_000,
    confirmedMinor: 3_000,
    paidMinor: 20_000,
    currency: "CAT",
    calculatedAt: now.toISOString(),
  },
};

function headers() {
  return {
    authorization: "Bearer valid-bot-token",
    "x-client-source": "DISCORD_BOT",
    "x-actor-discord-user-id": profile.discordUserId,
    "x-actor-guild-id": guildId,
    "x-discord-interaction-id": "777777777777777777",
  };
}

describe("M2-US-08 player workbench API", () => {
  test("returns qualification, separate presence and availability, matching requirements, countdown, own earnings and API capabilities", async () => {
    const store = new InMemoryPlayerStore({
      profiles: [profile],
      workbenches: { [playerUserId]: workbench },
    });
    const server = buildApiServer({
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
    });
    registerPlayerRoutes(server, { store, now: () => now });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/players/me/workbench",
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        profile: { availability: "AVAILABLE", discordPresence: "ONLINE" },
        eligibility: { eligible: true },
        currentOrder: null,
        matchingOrders: [],
        earningsSummary: {
          pendingMinor: 8_000,
          confirmedMinor: 3_000,
          paidMinor: 20_000,
        },
        nextActions: [],
      },
    });
    expect(JSON.stringify(response.json())).not.toMatch(
      /customerId|customerNote|externalAccount|phone|email/i,
    );
  });

  test("does not offer dispatch actions when the player is unavailable", async () => {
    const store = new InMemoryPlayerStore({
      profiles: [{ ...profile, availability: "BUSY" }],
      workbenches: { [playerUserId]: workbench },
    });
    const server = buildApiServer({
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
    });
    registerPlayerRoutes(server, { store, now: () => now });

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/players/me/workbench",
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.matchingOrders).toEqual([]);
    expect(response.json().data.nextActions).toEqual([]);
  });
});
