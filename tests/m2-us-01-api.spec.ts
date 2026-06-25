import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { buildApiServer } from "@blackcat/api/server";
import {
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  type StaffDirectory,
} from "@blackcat/api/security";
import {
  InMemoryPlayerStore,
  registerPlayerRoutes,
  selectEligibleDispatchCandidates,
  type PlayerProfileRecord,
} from "@blackcat/api/players";

const env = {
  NODE_ENV: "development",
  DATABASE_URL: "",
  API_PORT: "0",
  API_BASE_URL: "http://localhost:3000",
  BOT_SERVICE_TOKEN: "valid-bot-token",
};

const now = new Date("2026-07-18T00:00:00.000Z");
const guildId = "999999999999999999";

const staffDirectory: StaffDirectory = {
  resolveByDiscord({ discordUserId, guildId: incomingGuildId }) {
    if (incomingGuildId !== guildId) {
      return null;
    }
    if (discordUserId === "222222222222222222") {
      return {
        staffId: "00000000-0000-0000-0000-000000000222",
        userId: "00000000-0000-0000-0000-000000000022",
        level: "L2_SUPERVISOR",
        permissionsVersion: 2,
        status: "ACTIVE",
      };
    }
    if (discordUserId === "333333333333333333") {
      return {
        staffId: "00000000-0000-0000-0000-000000000333",
        userId: "00000000-0000-0000-0000-000000000033",
        level: "L3_OPERATIONS",
        permissionsVersion: 3,
        status: "ACTIVE",
      };
    }
    return null;
  },
};

function player(
  overrides: Partial<PlayerProfileRecord> = {},
): PlayerProfileRecord {
  return {
    playerId: "00000000-0000-0000-0000-00000000p001".replace("p", "a"),
    userId: "00000000-0000-0000-0000-00000000a101",
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
    approvedByStaffId: "00000000-0000-0000-0000-000000000333",
    approvedAt: now.toISOString(),
    pausedAt: null,
    suspendedAt: null,
    version: 5,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function buildPlayerServer(records: PlayerProfileRecord[] = [player()]) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const store = new InMemoryPlayerStore({ profiles: records });
  const server = buildApiServer({
    env,
    security: { auditSink, idempotencyStore, staffDirectory },
  });

  registerPlayerRoutes(server, { store, now: () => now });

  return { server, store, auditSink };
}

function buildPlayerServerThroughApiOptions(
  records: PlayerProfileRecord[] = [player()],
) {
  const auditSink = new InMemoryAuditSink();
  const idempotencyStore = new InMemoryIdempotencyStore();
  const store = new InMemoryPlayerStore({ profiles: records });
  const server = buildApiServer({
    env,
    security: { auditSink, idempotencyStore, staffDirectory },
    player: { store, now: () => now },
  });

  return { server, store, auditSink };
}

function botHeaders(discordUserId: string, extra: Record<string, string> = {}) {
  return {
    authorization: "Bearer valid-bot-token",
    "x-client-source": "DISCORD_BOT",
    "x-actor-discord-user-id": discordUserId,
    "x-actor-guild-id": guildId,
    "x-discord-interaction-id": "777777777777777777",
    ...extra,
  };
}

function dashboardHeaders(
  discordUserId: string,
  extra: Record<string, string> = {},
) {
  return {
    ...botHeaders(discordUserId, extra),
    "x-client-source": "DASHBOARD",
  };
}

describe("M2-US-01 player eligibility domain", () => {
  test("candidate selection requires active review, availability, online presence, matching tags, active user and no active order", () => {
    const eligible = player({
      playerId: "00000000-0000-0000-0000-00000000a001",
      userId: "00000000-0000-0000-0000-00000000u001".replace("u", "a"),
    });
    const candidates = selectEligibleDispatchCandidates(
      [
        eligible,
        player({
          playerId: "00000000-0000-0000-0000-00000000a002",
          reviewStatus: "PENDING_REVIEW",
        }),
        player({
          playerId: "00000000-0000-0000-0000-00000000a003",
          availability: "BUSY",
        }),
        player({
          playerId: "00000000-0000-0000-0000-00000000a004",
          discordPresence: "IDLE",
        }),
        player({
          playerId: "00000000-0000-0000-0000-00000000a005",
          serviceTags: ["RANKED"],
        }),
        player({
          playerId: "00000000-0000-0000-0000-00000000a006",
          userStatus: "PAUSED",
        }),
        player({
          playerId: "00000000-0000-0000-0000-00000000a007",
          activeOrderId: "00000000-0000-0000-0000-00000000b777",
        }),
      ],
      { game: "VALORANT", service: "ENTERTAINMENT" },
    );

    expect(candidates.map((candidate) => candidate.playerId)).toEqual([
      "00000000-0000-0000-0000-00000000a001",
    ]);
  });
});

describe("M2-US-01 player API contract", () => {
  test("buildApiServer retires the legacy player availability route", async () => {
    const { server } = buildPlayerServerThroughApiOptions();

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/players/me/availability",
      headers: botHeaders("111111111111111111", {
        "idempotency-key": "discord:player:availability:mounted",
      }),
      payload: { expectedVersion: 5, availability: "BUSY" },
    });

    expect(response.statusCode).toBe(404);
  });

  test("runtime API entrypoint wires PostgresPlayerStore into the unified API server", async () => {
    const source = await readFile("apps/api/src/index.ts", "utf8");

    expect(source).toContain(
      "import { PostgresPlayerStore } from './players.js';",
    );
    expect(source).toContain(
      "const playerStore = new PostgresPlayerStore({ pool: databasePool });",
    );
    expect(source).toMatch(
      /player:\s*{\s*store:\s*playerStore,\s*businessTags:\s*businessTagStore\s*}/s,
    );
  });

  test("legacy availability writes are unavailable and leave the stored profile unchanged", async () => {
    const { server, store, auditSink } = buildPlayerServer();

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/players/me/availability",
      headers: botHeaders("111111111111111111", {
        "idempotency-key": "discord:player:availability:busy",
      }),
      payload: { expectedVersion: 5, availability: "BUSY" },
    });

    expect(response.statusCode).toBe(404);
    expect(store.profiles[0]).toMatchObject({
      availability: "AVAILABLE",
      discordPresence: "ONLINE",
      version: 5,
    });
    expect(auditSink.records).toEqual([]);
  });

  test("legacy availability route stays retired for non-active players too", async () => {
    const { server } = buildPlayerServer([player({ reviewStatus: "PAUSED" })]);

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/players/me/availability",
      headers: botHeaders("111111111111111111", {
        "idempotency-key": "discord:player:availability:paused",
      }),
      payload: { expectedVersion: 5, availability: "AVAILABLE" },
    });

    expect(response.statusCode).toBe(404);
  });

  test("syncDiscordPresence records the presence signal without changing business availability", async () => {
    const { server, store } = buildPlayerServer([
      player({ availability: "BUSY", discordPresence: "OFFLINE" }),
    ]);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/internal/discord/presence",
      headers: botHeaders("999999999999999999", {
        "idempotency-key": "discord:presence:111-online",
      }),
      payload: {
        guildId,
        discordUserId: "111111111111111111",
        presence: "ONLINE",
        observedAt: now.toISOString(),
        sourceEventId: "presence:111111111111111111:1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        discordUserId: "111111111111111111",
        presence: "ONLINE",
        observedAt: now.toISOString(),
        dispatchEligible: true,
      },
    });
    expect(store.profiles[0]).toMatchObject({
      availability: "BUSY",
      discordPresence: "ONLINE",
    });
  });

  test("admin player approval requires L3 while L2 can update tags after approval", async () => {
    const { server, store } = buildPlayerServer([
      player({
        reviewStatus: "PENDING_REVIEW",
        availability: "OFFLINE",
        gameTags: [],
        serviceTags: [],
        version: 1,
      }),
    ]);

    const denied = await server.inject({
      method: "POST",
      url: "/api/v1/admin/players/00000000-0000-0000-0000-00000000a001/approve",
      headers: dashboardHeaders("222222222222222222", {
        "idempotency-key": "dashboard:player:approve:l2-denied",
      }),
      payload: {
        expectedVersion: 1,
        gameTags: ["VALORANT"],
        serviceTags: ["ENTERTAINMENT"],
        reasonCode: "REVIEW_PASSED",
      },
    });
    const approved = await server.inject({
      method: "POST",
      url: "/api/v1/admin/players/00000000-0000-0000-0000-00000000a001/approve",
      headers: dashboardHeaders("333333333333333333", {
        "idempotency-key": "dashboard:player:approve:l3",
      }),
      payload: {
        expectedVersion: 1,
        gameTags: ["VALORANT"],
        serviceTags: ["ENTERTAINMENT"],
        reasonCode: "REVIEW_PASSED",
      },
    });
    const tagged = await server.inject({
      method: "PUT",
      url: "/api/v1/admin/players/00000000-0000-0000-0000-00000000a001/tags",
      headers: dashboardHeaders("222222222222222222", {
        "idempotency-key": "dashboard:player:tags:l2",
      }),
      payload: {
        expectedVersion: 2,
        gameTags: ["VALORANT"],
        serviceTags: ["ENTERTAINMENT", "COACHING"],
        reasonCode: "SKILL_REVIEW_UPDATED",
      },
    });

    expect(denied.statusCode).toBe(403);
    expect(approved.statusCode).toBe(200);
    expect(tagged.statusCode).toBe(200);
    expect(tagged.json()).toMatchObject({
      data: {
        reviewStatus: "ACTIVE",
        gameTags: ["VALORANT"],
        serviceTags: ["ENTERTAINMENT", "COACHING"],
        version: 3,
      },
    });
    expect(store.profiles[0]).toMatchObject({
      reviewStatus: "ACTIVE",
      version: 3,
    });
  });

  test("setPlayerOperationalStatus pauses a player without changing Discord presence or self availability", async () => {
    const { server, store } = buildPlayerServer();

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/admin/players/00000000-0000-0000-0000-00000000a001/operational-status",
      headers: dashboardHeaders("333333333333333333", {
        "idempotency-key": "dashboard:player:pause:l3",
      }),
      payload: {
        expectedVersion: 5,
        reviewStatus: "PAUSED",
        reasonCode: "PLAYER_REQUEST",
        note: "temporary pause",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        reviewStatus: "PAUSED",
        availability: "AVAILABLE",
        discordPresence: "ONLINE",
        version: 6,
      },
    });
    expect(store.profiles[0]).toMatchObject({
      reviewStatus: "PAUSED",
      availability: "AVAILABLE",
      discordPresence: "ONLINE",
    });
  });
});
