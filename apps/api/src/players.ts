import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
} from "./security.js";
import type { BusinessTagStore } from "./business-tags.js";
import { buildOrderAvailableActions } from "./order-actions.js";

export type PlayerReviewStatus =
  "PENDING_REVIEW" | "ACTIVE" | "REJECTED" | "PAUSED" | "SUSPENDED";
export type PlayerAvailability = "AVAILABLE" | "BUSY" | "OFFLINE";
export type DiscordPresenceStatus =
  "ONLINE" | "IDLE" | "DND" | "OFFLINE" | "UNKNOWN";
export type PlayerUserStatus = "ACTIVE" | "PAUSED" | "SUSPENDED" | "DISABLED";

export interface PlayerProfileRecord {
  playerId: string;
  userId: string;
  guildId: string;
  discordUserId: string;
  userStatus: PlayerUserStatus;
  reviewStatus: PlayerReviewStatus;
  availability: PlayerAvailability;
  discordPresence: DiscordPresenceStatus;
  presenceObservedAt: string | null;
  gameTags: string[];
  serviceTags: string[];
  activeOrderId: string | null;
  approvedByStaffId: string | null;
  approvedAt: string | null;
  pausedAt: string | null;
  suspendedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerProfileApi {
  playerId: string;
  reviewStatus: PlayerReviewStatus;
  availability: PlayerAvailability;
  discordPresence: DiscordPresenceStatus;
  gameTags: string[];
  serviceTags: string[];
  activeOrderId: string | null;
  version: number;
}

export interface PlayerWorkbenchOrder {
  id: string;
  publicId: string;
  status: string;
  version: number;
  game: string | null;
  gameDisplayName: string | null;
  service: string | null;
  serviceDisplayName: string | null;
  region: string | null;
  regionDisplayName: string | null;
  durationMinutes: number | null;
  playerEarningMinor: number;
  currency: string;
  requirements: string[];
  voiceChannelId: string | null;
}

export interface PlayerWorkbenchData {
  currentOrder: PlayerWorkbenchOrder | null;
  matchingOrders: Array<{
    dispatchAttemptId: string;
    acceptBy: string;
    secondsRemaining: number;
    order: PlayerWorkbenchOrder;
  }>;
  earningsSummary: {
    pendingMinor: number;
    confirmedMinor: number;
    paidMinor: number;
    currency: string;
    calculatedAt: string;
  };
}

export interface PlayerStore {
  findByDiscord(input: {
    guildId: string;
    discordUserId: string;
  }): Promise<PlayerProfileRecord | null> | PlayerProfileRecord | null;
  findById(
    playerId: string,
  ): Promise<PlayerProfileRecord | null> | PlayerProfileRecord | null;
  updatePresence(input: {
    guildId: string;
    discordUserId: string;
    presence: DiscordPresenceStatus;
    observedAt: string;
    now: Date;
  }): Promise<PlayerProfileRecord | null> | PlayerProfileRecord | null;
  approvePlayer(input: {
    playerId: string;
    expectedVersion: number;
    gameTags: string[];
    serviceTags: string[];
    languageTags?: string[];
    approvedByStaffId: string;
    now: Date;
  }): Promise<PlayerProfileRecord> | PlayerProfileRecord;
  rejectPlayer(input: {
    playerId: string;
    expectedVersion: number;
    reasonCode: string;
    note: string;
    rejectedByStaffId: string;
    now: Date;
  }): Promise<PlayerProfileRecord> | PlayerProfileRecord;
  updateOperationalStatus(input: {
    playerId: string;
    expectedVersion: number;
    reviewStatus: Exclude<PlayerReviewStatus, "PENDING_REVIEW">;
    now: Date;
  }): Promise<PlayerProfileRecord> | PlayerProfileRecord;
  updateTags(input: {
    playerId: string;
    expectedVersion: number;
    gameTags: string[];
    serviceTags: string[];
    languageTags?: string[];
    now: Date;
  }): Promise<PlayerProfileRecord> | PlayerProfileRecord;
  getWorkbenchData(input: {
    profile: PlayerProfileRecord;
    now: Date;
  }): Promise<PlayerWorkbenchData> | PlayerWorkbenchData;
}

export class PlayerError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlayerError";
    this.code = code;
  }
}

const activePlayerOrderStatuses = [
  "ACCEPTED",
  "IN_SERVICE",
  "PENDING_CONFIRMATION",
] as const;

export class InMemoryPlayerStore implements PlayerStore {
  readonly profiles: PlayerProfileRecord[];
  readonly workbenches: Record<string, PlayerWorkbenchData>;

  constructor(
    input: {
      profiles?: PlayerProfileRecord[];
      workbenches?: Record<string, PlayerWorkbenchData>;
    } = {},
  ) {
    this.profiles = input.profiles ?? [];
    this.workbenches = input.workbenches ?? {};
  }

  findByDiscord(input: {
    guildId: string;
    discordUserId: string;
  }): PlayerProfileRecord | null {
    return (
      this.profiles.find((profile) => {
        return (
          profile.guildId === input.guildId &&
          profile.discordUserId === input.discordUserId
        );
      }) ?? null
    );
  }

  findById(playerId: string): PlayerProfileRecord | null {
    return (
      this.profiles.find((profile) => profile.playerId === playerId) ?? null
    );
  }

  updatePresence(input: {
    guildId: string;
    discordUserId: string;
    presence: DiscordPresenceStatus;
    observedAt: string;
    now: Date;
  }): PlayerProfileRecord | null {
    const profile = this.findByDiscord(input);
    if (!profile) {
      return null;
    }
    return this.replace(profile.playerId, {
      ...profile,
      discordPresence: input.presence,
      presenceObservedAt: input.observedAt,
      version: profile.version + 1,
      updatedAt: input.now.toISOString(),
    });
  }

  approvePlayer(input: {
    playerId: string;
    expectedVersion: number;
    gameTags: string[];
    serviceTags: string[];
    approvedByStaffId: string;
    now: Date;
  }): PlayerProfileRecord {
    const profile = this.requireProfile(input.playerId);
    this.assertVersion(profile, input.expectedVersion);
    return this.replace(profile.playerId, {
      ...profile,
      reviewStatus: "ACTIVE",
      gameTags: normalizeTags(input.gameTags),
      serviceTags: normalizeTags(input.serviceTags),
      approvedByStaffId: input.approvedByStaffId,
      approvedAt: input.now.toISOString(),
      pausedAt: null,
      suspendedAt: null,
      version: profile.version + 1,
      updatedAt: input.now.toISOString(),
    });
  }

  rejectPlayer(input: {
    playerId: string;
    expectedVersion: number;
    reasonCode: string;
    note: string;
    rejectedByStaffId: string;
    now: Date;
  }): PlayerProfileRecord {
    const profile = this.requireProfile(input.playerId);
    this.assertVersion(profile, input.expectedVersion);
    if (profile.reviewStatus !== "PENDING_REVIEW")
      throw new PlayerError(
        "CONFLICT",
        "Only pending companion applications can be rejected.",
      );
    return this.replace(profile.playerId, {
      ...profile,
      reviewStatus: "REJECTED",
      availability: "OFFLINE",
      version: profile.version + 1,
      updatedAt: input.now.toISOString(),
    });
  }

  updateOperationalStatus(input: {
    playerId: string;
    expectedVersion: number;
    reviewStatus: Exclude<PlayerReviewStatus, "PENDING_REVIEW">;
    now: Date;
  }): PlayerProfileRecord {
    const profile = this.requireProfile(input.playerId);
    this.assertVersion(profile, input.expectedVersion);
    return this.replace(profile.playerId, {
      ...profile,
      reviewStatus: input.reviewStatus,
      pausedAt:
        input.reviewStatus === "PAUSED"
          ? input.now.toISOString()
          : profile.pausedAt,
      suspendedAt:
        input.reviewStatus === "SUSPENDED"
          ? input.now.toISOString()
          : profile.suspendedAt,
      version: profile.version + 1,
      updatedAt: input.now.toISOString(),
    });
  }

  updateTags(input: {
    playerId: string;
    expectedVersion: number;
    gameTags: string[];
    serviceTags: string[];
    now: Date;
  }): PlayerProfileRecord {
    const profile = this.requireProfile(input.playerId);
    this.assertVersion(profile, input.expectedVersion);
    return this.replace(profile.playerId, {
      ...profile,
      gameTags: normalizeTags(input.gameTags),
      serviceTags: normalizeTags(input.serviceTags),
      version: profile.version + 1,
      updatedAt: input.now.toISOString(),
    });
  }

  getWorkbenchData(input: {
    profile: PlayerProfileRecord;
    now: Date;
  }): PlayerWorkbenchData {
    return (
      this.workbenches[input.profile.userId] ?? emptyWorkbenchData(input.now)
    );
  }

  private requireProfile(playerId: string): PlayerProfileRecord {
    const profile = this.findById(playerId);
    if (!profile) {
      throw new PlayerError("NOT_FOUND", "Player profile was not found.");
    }
    return profile;
  }

  private assertVersion(
    profile: PlayerProfileRecord,
    expectedVersion: number,
  ): void {
    if (profile.version !== expectedVersion) {
      throw new PlayerError("CONFLICT", "Player profile version is stale.");
    }
  }

  private replace(
    playerId: string,
    next: PlayerProfileRecord,
  ): PlayerProfileRecord {
    const index = this.profiles.findIndex(
      (profile) => profile.playerId === playerId,
    );
    this.profiles[index] = next;
    return next;
  }
}

export interface PlayerQueryClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export class PostgresPlayerStore implements PlayerStore {
  private readonly client: PlayerQueryClient;
  private readonly pool: Pool | null;

  constructor(input: { pool?: Pool; client?: PlayerQueryClient }) {
    const client = input.client ?? input.pool;
    if (!client) {
      throw new Error("PostgresPlayerStore requires a pool or client.");
    }
    this.client = client;
    this.pool = input.pool ?? null;
  }

  async findByDiscord(input: {
    guildId: string;
    discordUserId: string;
  }): Promise<PlayerProfileRecord | null> {
    const result = await this.client.query<PlayerProfileRow>(
      playerProfileSelectSql({
        whereClause: `
WHERE discord.guild_id = $1
  AND discord.discord_user_id = $2
      `,
        activeStatusesParam: 3,
      }),
      [input.guildId, input.discordUserId, activePlayerOrderStatuses],
    );
    return result.rows[0] ? mapPlayerProfileRow(result.rows[0]) : null;
  }

  async findById(playerId: string): Promise<PlayerProfileRecord | null> {
    const result = await this.client.query<PlayerProfileRow>(
      playerProfileSelectSql({
        whereClause: `
WHERE profile.id = $1
      `,
        activeStatusesParam: 2,
      }),
      [playerId, activePlayerOrderStatuses],
    );
    return result.rows[0] ? mapPlayerProfileRow(result.rows[0]) : null;
  }

  async updatePresence(input: {
    guildId: string;
    discordUserId: string;
    presence: DiscordPresenceStatus;
    observedAt: string;
    now: Date;
  }): Promise<PlayerProfileRecord | null> {
    const current = await this.findByDiscord(input);
    if (!current) {
      return null;
    }
    await this.client.query(
      `
UPDATE player_profiles
SET discord_presence = $2::"DiscordPresenceStatus",
    presence_observed_at = $3,
    row_version = row_version + 1,
    updated_at = $4
WHERE id = $1
      `,
      [
        current.playerId,
        input.presence,
        input.observedAt,
        input.now.toISOString(),
      ],
    );
    return this.findById(current.playerId);
  }

  async approvePlayer(input: {
    playerId: string;
    expectedVersion: number;
    gameTags: string[];
    serviceTags: string[];
    languageTags?: string[];
    approvedByStaffId: string;
    now: Date;
  }): Promise<PlayerProfileRecord> {
    if (this.pool) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await new PostgresPlayerStore({ client }).approvePlayer(
          input,
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    const current = await this.requireProfile(input.playerId);
    this.assertVersion(current, input.expectedVersion);
    if (current.reviewStatus !== "PENDING_REVIEW")
      throw new PlayerError(
        "CONFLICT",
        "Only pending companion applications can be approved.",
      );
    const roles = await this.productRoles(current.guildId);
    if (!roles.companionRoleId)
      throw new PlayerError("CONFIGURATION_ERROR", "已批准陪玩角色尚未配置。");
    await this.client.query(
      `
UPDATE player_profiles
SET review_status = 'ACTIVE',
    approved_by_staff_id = $2,
    approved_at = $3,
    paused_at = NULL,
    suspended_at = NULL,
    row_version = row_version + 1,
    updated_at = $3
WHERE id = $1
      `,
      [input.playerId, input.approvedByStaffId, input.now.toISOString()],
    );
    await this.replaceSkills(
      input.playerId,
      input.gameTags,
      input.serviceTags,
      input.now,
      input.languageTags,
    );
    await this.client.query(
      `INSERT INTO companion_review_events(id,player_profile_id,from_status,to_status,actor_staff_id,reason_code,note,idempotency_key,created_at)
      VALUES ($1,$2,'PENDING_REVIEW','ACTIVE',$3,'APPROVED',NULL,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.playerId,
        input.approvedByStaffId,
        `companion-approve:${input.playerId}:v${input.expectedVersion}`,
        input.now,
      ],
    );
    if (roles.applicantRoleId)
      await this.queueProductRole(
        current,
        roles.applicantRoleId,
        "REMOVE",
        "approve-remove-applicant",
        input.now,
      );
    await this.queueProductRole(
      current,
      roles.companionRoleId,
      "ADD",
      "approve-add-companion",
      input.now,
    );
    return this.requireProfile(input.playerId);
  }

  async rejectPlayer(input: {
    playerId: string;
    expectedVersion: number;
    reasonCode: string;
    note: string;
    rejectedByStaffId: string;
    now: Date;
  }): Promise<PlayerProfileRecord> {
    const current = await this.requireProfile(input.playerId);
    this.assertVersion(current, input.expectedVersion);
    if (current.reviewStatus !== "PENDING_REVIEW")
      throw new PlayerError(
        "CONFLICT",
        "Only pending companion applications can be rejected.",
      );
    await this.client.query(
      `UPDATE player_profiles SET review_status='REJECTED',availability='OFFLINE',rejected_at=$2,rejection_reason_code=$3,rejection_note=$4,row_version=row_version+1,updated_at=$2 WHERE id=$1`,
      [input.playerId, input.now, input.reasonCode, input.note],
    );
    await this.client.query(
      `INSERT INTO companion_review_events(id,player_profile_id,from_status,to_status,actor_staff_id,reason_code,note,idempotency_key,created_at)
      VALUES ($1,$2,'PENDING_REVIEW','REJECTED',$3,$4,$5,$6,$7) ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.playerId,
        input.rejectedByStaffId,
        input.reasonCode,
        input.note,
        `companion-reject:${input.playerId}:v${input.expectedVersion}`,
        input.now,
      ],
    );
    const roles = await this.productRoles(current.guildId);
    if (roles.applicantRoleId)
      await this.queueProductRole(
        current,
        roles.applicantRoleId,
        "REMOVE",
        "reject-remove-applicant",
        input.now,
      );
    return this.requireProfile(input.playerId);
  }

  async updateOperationalStatus(input: {
    playerId: string;
    expectedVersion: number;
    reviewStatus: Exclude<PlayerReviewStatus, "PENDING_REVIEW">;
    now: Date;
  }): Promise<PlayerProfileRecord> {
    const current = await this.requireProfile(input.playerId);
    this.assertVersion(current, input.expectedVersion);
    await this.client.query(
      `
UPDATE player_profiles
SET review_status = $2::"PlayerReviewStatus",
    paused_at = CASE WHEN $2::"PlayerReviewStatus" = 'PAUSED' THEN $3 ELSE paused_at END,
    suspended_at = CASE WHEN $2::"PlayerReviewStatus" = 'SUSPENDED' THEN $3 ELSE suspended_at END,
    row_version = row_version + 1,
    updated_at = $3
WHERE id = $1
      `,
      [input.playerId, input.reviewStatus, input.now.toISOString()],
    );
    return this.requireProfile(input.playerId);
  }

  async updateTags(input: {
    playerId: string;
    expectedVersion: number;
    gameTags: string[];
    serviceTags: string[];
    languageTags?: string[];
    now: Date;
  }): Promise<PlayerProfileRecord> {
    const current = await this.requireProfile(input.playerId);
    this.assertVersion(current, input.expectedVersion);
    await this.replaceSkills(
      input.playerId,
      input.gameTags,
      input.serviceTags,
      input.now,
      input.languageTags,
    );
    await this.client.query(
      `
UPDATE player_profiles
SET row_version = row_version + 1,
    updated_at = $2
WHERE id = $1
      `,
      [input.playerId, input.now.toISOString()],
    );
    return this.requireProfile(input.playerId);
  }

  async getWorkbenchData(input: {
    profile: PlayerProfileRecord;
    now: Date;
  }): Promise<PlayerWorkbenchData> {
    const currentResult = await this.client.query<PlayerWorkbenchOrderRow>(
      `${playerWorkbenchOrderSelectSql}
WHERE orders.active_player_slot_id = $1
  AND orders.status = ANY(ARRAY['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION']::"OrderStatus"[])
ORDER BY orders.created_at DESC
LIMIT 1`,
      [input.profile.userId],
    );
    const matchingResult = await this.client.query<PlayerWorkbenchMatchRow>(
      `${playerWorkbenchMatchSelectSql}
WHERE candidate.player_user_id = $1
  AND candidate.status = 'NOTIFIED'
  AND attempt.status = 'ACTIVE'
  AND attempt.expires_at > $2
  AND orders.status = 'PENDING_DISPATCH'
ORDER BY attempt.expires_at ASC`,
      [input.profile.userId, input.now.toISOString()],
    );
    const earningsResult = await this.client.query<PlayerEarningsSummaryRow>(
      `
SELECT
  COALESCE(SUM(net_amount) FILTER (WHERE status = 'PENDING'), 0)::text AS pending_minor,
  COALESCE(SUM(net_amount) FILTER (WHERE status = 'CONFIRMED'), 0)::text AS confirmed_minor,
  COALESCE(SUM(net_amount) FILTER (WHERE status = 'PAID'), 0)::text AS paid_minor,
  COALESCE(MAX(currency), 'CAT') AS currency
FROM (
  SELECT earning.status,
         earning.currency,
         GREATEST(0, earning.amount_minor
           + COALESCE(SUM(CASE WHEN adjustment.type = 'CORRECTION_CREDIT' THEN adjustment.amount_minor ELSE -adjustment.amount_minor END), 0)
         ) AS net_amount
  FROM player_earnings AS earning
  LEFT JOIN player_earning_adjustments AS adjustment ON adjustment.player_earning_id = earning.id
  WHERE earning.player_user_id = $1
    AND earning.status <> 'REVERSED'
  GROUP BY earning.id
) AS own_earnings
      `,
      [input.profile.userId],
    );
    const summary = earningsResult.rows[0];
    return {
      currentOrder: currentResult.rows[0]
        ? mapWorkbenchOrder(currentResult.rows[0])
        : null,
      matchingOrders: matchingResult.rows.map((row) => ({
        dispatchAttemptId: row.dispatch_attempt_id,
        acceptBy: new Date(row.expires_at).toISOString(),
        secondsRemaining: Math.max(
          0,
          Math.floor(
            (new Date(row.expires_at).getTime() - input.now.getTime()) / 1000,
          ),
        ),
        order: mapWorkbenchOrder(row),
      })),
      earningsSummary: {
        pendingMinor: Number(summary?.pending_minor ?? 0),
        confirmedMinor: Number(summary?.confirmed_minor ?? 0),
        paidMinor: Number(summary?.paid_minor ?? 0),
        currency: summary?.currency ?? "CAT",
        calculatedAt: input.now.toISOString(),
      },
    };
  }

  private async replaceSkills(
    playerId: string,
    gameTags: string[],
    serviceTags: string[],
    now: Date,
    languageTags: string[] = [],
  ): Promise<void> {
    await this.client.query(
      "DELETE FROM player_skills WHERE player_profile_id = $1",
      [playerId],
    );
    for (const [type, values] of [
      ["GAME", gameTags],
      ["SERVICE", serviceTags],
      ["LANGUAGE", languageTags],
    ] as const) {
      for (const tag of normalizeTags(values)) {
        const skillTagId = await this.ensureSkillTag(type, tag, now);
        await this.client.query(
          `
INSERT INTO player_skills (player_profile_id, skill_tag_id, created_at)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING
          `,
          [playerId, skillTagId, now.toISOString()],
        );
      }
    }
  }

  private async productRoles(guildId: string) {
    const result = await this.client.query<{
      applicant_role_id: string | null;
      companion_role_id: string | null;
    }>(
      `SELECT config_json->>'companion_applicant_role_id' applicant_role_id,config_json->>'companion_role_id' companion_role_id FROM guild_bot_configs WHERE guild_id=$1`,
      [guildId],
    );
    return {
      applicantRoleId: result.rows[0]?.applicant_role_id ?? null,
      companionRoleId: result.rows[0]?.companion_role_id ?? null,
    };
  }
  private async queueProductRole(
    profile: PlayerProfileRecord,
    roleId: string,
    action: "ADD" | "REMOVE",
    purpose: string,
    now: Date,
  ) {
    const dedupe = `product-role:${profile.guildId}:${profile.discordUserId}:${roleId}:${action}:${purpose}:v${profile.version}`;
    await this.client.query(
      `INSERT INTO discord_product_role_tasks(id,guild_id,user_id,discord_user_id,role_id,action,status,dedupe_key,attempt_count,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'PENDING',$7,0,$8,$8) ON CONFLICT(dedupe_key) DO NOTHING`,
      [
        randomUUID(),
        profile.guildId,
        profile.userId,
        profile.discordUserId,
        roleId,
        action,
        dedupe,
        now,
      ],
    );
  }

  private async ensureSkillTag(
    type: "GAME" | "SERVICE" | "LANGUAGE",
    code: string,
    now: Date,
  ): Promise<string> {
    const existing = await this.client.query<{ id: string }>(
      'SELECT id FROM skill_tags WHERE type = $1::"SkillTagType" AND code = $2 LIMIT 1',
      [type, code],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    const inserted = await this.client.query<{ id: string }>(
      `
INSERT INTO skill_tags (id, type, code, display_name, enabled, created_at, updated_at)
VALUES ($1, $2::"SkillTagType", $3, $3, true, $4, $4)
RETURNING id
      `,
      [randomUUID(), type, code, now.toISOString()],
    );
    return inserted.rows[0]?.id ?? "";
  }

  private async requireProfile(playerId: string): Promise<PlayerProfileRecord> {
    const profile = await this.findById(playerId);
    if (!profile) {
      throw new PlayerError("NOT_FOUND", "Player profile was not found.");
    }
    return profile;
  }

  private assertVersion(
    profile: PlayerProfileRecord,
    expectedVersion: number,
  ): void {
    if (profile.version !== expectedVersion) {
      throw new PlayerError("CONFLICT", "Player profile version is stale.");
    }
  }
}

export function selectEligibleDispatchCandidates(
  profiles: PlayerProfileRecord[],
  requirement: { game: string; service: string },
): PlayerProfileRecord[] {
  return profiles.filter((profile) => {
    return (
      profile.userStatus === "ACTIVE" &&
      profile.reviewStatus === "ACTIVE" &&
      profile.availability === "AVAILABLE" &&
      profile.discordPresence === "ONLINE" &&
      profile.gameTags.includes(requirement.game) &&
      profile.serviceTags.includes(requirement.service) &&
      !profile.activeOrderId
    );
  });
}

export function registerPlayerRoutes(
  server: FastifyInstance,
  options: {
    store: PlayerStore;
    businessTags?: BusinessTagStore;
    now?: () => Date;
  },
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error("Player routes require buildApiServer({ security })");
  }
  const now = options.now ?? (() => new Date());

  registerSecureReadRoute(server, security, {
    method: "GET",
    url: "/api/v1/players/me/workbench",
    permission: "player.workspace.read",
    action: "GET_PLAYER_WORKBENCH",
    targetType: "player_profile",
    acceptedSources: ["DISCORD_BOT", "DASHBOARD"],
    handler: async (_request, actor) => {
      const profile = await currentPlayer(options.store, actor);
      const evaluatedAt = now();
      const workbench = await options.store.getWorkbenchData({
        profile,
        now: evaluatedAt,
      });
      const matchingOrders: typeof workbench.matchingOrders = [];
      return {
        profile: toApiProfile(profile),
        eligibility: buildEligibility(profile, evaluatedAt, null),
        currentOrder: workbench.currentOrder,
        matchingOrders: matchingOrders.map((match) => ({
          ...match,
          nextAction: "ACCEPT_OR_DECLINE" as const,
        })),
        earningsSummary: workbench.earningsSummary,
        availableActions: workbench.currentOrder
          ? buildOrderAvailableActions({ status: workbench.currentOrder.status, role: "PLAYER" })
          : [],
        nextActions: buildWorkbenchActions(
          profile,
          workbench.currentOrder,
          matchingOrders.length > 0,
        ),
      };
    },
    mapError: mapPlayerError,
  });

  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/admin/players/:playerId/reject",
    permission: "player.approve",
    action: "REJECT_PLAYER",
    targetType: "player_profile",
    targetId: (request) => playerIdParam(request),
    acceptedSources: ["DASHBOARD"],
    mapError: mapPlayerError,
    handler: async (request, actor) => {
      if (!actor.actorStaffId)
        throw new PlayerError("PERMISSION_DENIED", "Staff actor is required.");
      const body = parseRejectBody(request.body);
      return toApiProfile(
        await options.store.rejectPlayer({
          playerId: playerIdParam(request),
          expectedVersion: body.expectedVersion,
          reasonCode: body.reasonCode,
          note: body.note,
          rejectedByStaffId: actor.actorStaffId,
          now: now(),
        }),
      );
    },
    fingerprintBody: (request) => parseRejectBody(request.body),
  });

  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/internal/discord/presence",
    permission: "presence.sync",
    action: "SYNC_DISCORD_PRESENCE",
    targetType: "player_profile",
    acceptedSources: ["DISCORD_BOT"],
    targetId: (request) => {
      const body = request.body as { discordUserId?: string };
      return body.discordUserId ?? "000000000000000000";
    },
    handler: async (request) => {
      const body = parsePresenceBody(request.body);
      const updated = await options.store.updatePresence({
        guildId: body.guildId,
        discordUserId: body.discordUserId,
        presence: body.presence,
        observedAt: body.observedAt,
        now: now(),
      });
      return {
        discordUserId: body.discordUserId,
        presence: body.presence,
        observedAt: body.observedAt,
        dispatchEligible: updated
          ? isGenerallyDispatchEligible(updated)
          : false,
      };
    },
    mapError: mapPlayerError,
    fingerprintBody: (request) => parsePresenceBody(request.body),
  });

  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/admin/players/:playerId/approve",
    permission: "player.approve",
    action: "APPROVE_PLAYER",
    targetType: "player_profile",
    targetId: (request) => playerIdParam(request),
    acceptedSources: ["DASHBOARD", "DISCORD_BOT"],
    handler: async (request, actor) => {
      if (!actor.actorStaffId) {
        throw new PlayerError("PERMISSION_DENIED", "Staff actor is required.");
      }
      const body = await parseApprovalSelection(
        request.body,
        options.businessTags,
      );
      return toApiProfile(
        await options.store.approvePlayer({
          playerId: playerIdParam(request),
          expectedVersion: body.expectedVersion,
          gameTags: body.gameTags,
          serviceTags: body.serviceTags,
          languageTags: body.languageTags,
          approvedByStaffId: actor.actorStaffId,
          now: now(),
        }),
      );
    },
    mapError: mapPlayerError,
    fingerprintBody: (request) => request.body,
  });

  registerSecureWriteRoute(server, security, {
    method: "PUT",
    url: "/api/v1/admin/players/:playerId/operational-status",
    permission: "player.status.manage",
    action: "SET_PLAYER_OPERATIONAL_STATUS",
    targetType: "player_profile",
    targetId: (request) => playerIdParam(request),
    acceptedSources: ["DASHBOARD", "DISCORD_BOT"],
    handler: async (request) => {
      const body = parseStatusBody(request.body);
      return toApiProfile(
        await options.store.updateOperationalStatus({
          playerId: playerIdParam(request),
          expectedVersion: body.expectedVersion,
          reviewStatus: body.reviewStatus,
          now: now(),
        }),
      );
    },
    mapError: mapPlayerError,
    fingerprintBody: (request) => parseStatusBody(request.body),
  });

  registerSecureWriteRoute(server, security, {
    method: "PUT",
    url: "/api/v1/admin/players/:playerId/tags",
    permission: "player.tags.manage",
    action: "UPDATE_PLAYER_OPERATIONAL_TAGS",
    targetType: "player_profile",
    targetId: (request) => playerIdParam(request),
    acceptedSources: ["DASHBOARD", "DISCORD_BOT"],
    handler: async (request) => {
      const body = await parseApprovalSelection(
        request.body,
        options.businessTags,
      );
      return toApiProfile(
        await options.store.updateTags({
          playerId: playerIdParam(request),
          expectedVersion: body.expectedVersion,
          gameTags: body.gameTags,
          serviceTags: body.serviceTags,
          languageTags: body.languageTags,
          now: now(),
        }),
      );
    },
    mapError: mapPlayerError,
    fingerprintBody: (request) => request.body,
  });
}

function toApiProfile(profile: PlayerProfileRecord): PlayerProfileApi {
  return {
    playerId: profile.playerId,
    reviewStatus: profile.reviewStatus,
    availability: profile.availability,
    discordPresence: profile.discordPresence,
    gameTags: [...profile.gameTags],
    serviceTags: [...profile.serviceTags],
    activeOrderId: profile.activeOrderId,
    version: profile.version,
  };
}

async function currentPlayer(
  store: PlayerStore,
  actor: ActorContext,
): Promise<PlayerProfileRecord> {
  if (!actor.guildId || !actor.discordUserId) {
    throw new PlayerError(
      "AUTH_REQUIRED",
      "Discord actor context is required.",
    );
  }
  const profile = await store.findByDiscord({
    guildId: actor.guildId,
    discordUserId: actor.discordUserId,
  });
  if (!profile) {
    throw new PlayerError(
      "PLAYER_NOT_ELIGIBLE",
      "No player profile is bound to this actor.",
    );
  }
  return profile;
}

function buildEligibility(
  profile: PlayerProfileRecord,
  now: Date,
  requirement: { game: string; service: string } | null,
) {
  const checks = [
    {
      code: "ACTIVE_REVIEW_STATUS",
      passed: profile.reviewStatus === "ACTIVE",
      reason:
        profile.reviewStatus === "ACTIVE"
          ? null
          : `reviewStatus is ${profile.reviewStatus}`,
    },
    {
      code: "MATCHING_TAGS",
      passed: requirement
        ? profile.gameTags.includes(requirement.game) &&
          profile.serviceTags.includes(requirement.service)
        : true,
      reason: requirement ? "Required game and service tags must match." : null,
    },
  ];
  return {
    eligible: checks.every((check) => check.passed),
    evaluatedAt: now.toISOString(),
    checks,
  };
}

function isGenerallyDispatchEligible(profile: PlayerProfileRecord): boolean {
  return profile.userStatus === "ACTIVE" && profile.reviewStatus === "ACTIVE";
}

function buildWorkbenchActions(
  profile: PlayerProfileRecord,
  currentOrder: PlayerWorkbenchOrder | null,
  hasMatchingOrders: boolean,
): string[] {
  if (profile.reviewStatus !== "ACTIVE") {
    return [];
  }
  if (currentOrder) {
    if (currentOrder.status === "ACCEPTED") {
      return ["SET_READINESS", "CONTACT_SUPPORT"];
    }
    if (currentOrder.status === "IN_SERVICE") {
      return ["REQUEST_COMPLETION", "CONTACT_SUPPORT"];
    }
    if (currentOrder.status === "PENDING_CONFIRMATION") {
      return ["WAIT_FOR_CUSTOMER", "CONTACT_SUPPORT"];
    }
  }
  void hasMatchingOrders;
  return [];
}

function emptyWorkbenchData(now: Date): PlayerWorkbenchData {
  return {
    currentOrder: null,
    matchingOrders: [],
    earningsSummary: {
      pendingMinor: 0,
      confirmedMinor: 0,
      paidMinor: 0,
      currency: "CAT",
      calculatedAt: now.toISOString(),
    },
  };
}

function parsePresenceBody(body: unknown): {
  guildId: string;
  discordUserId: string;
  presence: DiscordPresenceStatus;
  observedAt: string;
  sourceEventId: string;
} {
  const input = objectBody(body);
  return {
    guildId: stringValue(input.guildId, "guildId"),
    discordUserId: stringValue(input.discordUserId, "discordUserId"),
    presence: enumValue(
      input.presence,
      ["ONLINE", "IDLE", "DND", "OFFLINE", "UNKNOWN"],
      "presence",
    ),
    observedAt: stringValue(input.observedAt, "observedAt"),
    sourceEventId: stringValue(input.sourceEventId, "sourceEventId"),
  };
}

function parseApproveBody(body: unknown): {
  expectedVersion: number;
  gameTags: string[];
  serviceTags: string[];
  reasonCode: string;
} {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, "expectedVersion"),
    gameTags: tags(input.gameTags, "gameTags"),
    serviceTags: tags(input.serviceTags, "serviceTags"),
    reasonCode: stringValue(input.reasonCode, "reasonCode"),
  };
}

async function parseApprovalSelection(
  body: unknown,
  businessTags?: BusinessTagStore,
): Promise<{
  expectedVersion: number;
  gameTags: string[];
  serviceTags: string[];
  languageTags: string[];
  reasonCode: string;
}> {
  if (!businessTags) return { ...parseApproveBody(body), languageTags: [] };
  const input = objectBody(body);
  const resolve = async (
    field: string,
    type: "GAME" | "SERVICE" | "LANGUAGE",
    required = false,
  ) => {
    const ids = tags(input[field], field);
    if (required && ids.length === 0)
      throw new PlayerError(
        "VALIDATION_ERROR",
        `${field} requires at least one business tag.`,
      );
    try {
      return (await businessTags.resolveEnabled(ids, [type])).map(
        (tag) => tag.code,
      );
    } catch {
      throw new PlayerError(
        "VALIDATION_ERROR",
        `${field} contains a missing, disabled, or wrong-type business tag.`,
      );
    }
  };
  return {
    expectedVersion: positiveInteger(input.expectedVersion, "expectedVersion"),
    gameTags: await resolve("gameTagIds", "GAME", true),
    serviceTags: await resolve("serviceTagIds", "SERVICE", true),
    languageTags: await resolve("languageTagIds", "LANGUAGE"),
    reasonCode: stringValue(input.reasonCode, "reasonCode"),
  };
}
function parseRejectBody(body: unknown) {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, "expectedVersion"),
    reasonCode: stringValue(input.reasonCode, "reasonCode"),
    note: stringValue(input.note, "note"),
  };
}

function parseStatusBody(body: unknown): {
  expectedVersion: number;
  reviewStatus: Exclude<PlayerReviewStatus, "PENDING_REVIEW">;
  reasonCode: string;
  note?: string | null;
} {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, "expectedVersion"),
    reviewStatus: enumValue(
      input.reviewStatus,
      ["ACTIVE", "PAUSED", "SUSPENDED"],
      "reviewStatus",
    ),
    reasonCode: stringValue(input.reasonCode, "reasonCode"),
    note: typeof input.note === "string" ? input.note : null,
  };
}

function parseTagsBody(body: unknown): {
  expectedVersion: number;
  gameTags: string[];
  serviceTags: string[];
  reasonCode: string;
} {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, "expectedVersion"),
    gameTags: tags(input.gameTags, "gameTags"),
    serviceTags: tags(input.serviceTags, "serviceTags"),
    reasonCode: stringValue(input.reasonCode, "reasonCode"),
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PlayerError(
      "VALIDATION_ERROR",
      "Request body must be an object.",
    );
  }
  return body as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new PlayerError(
      "VALIDATION_ERROR",
      `${field} must be a positive integer.`,
    );
  }
  return value as number;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PlayerError(
      "VALIDATION_ERROR",
      `${field} must be a non-empty string.`,
    );
  }
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new PlayerError("VALIDATION_ERROR", `${field} is invalid.`);
  }
  return value as T;
}

function tags(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new PlayerError(
      "VALIDATION_ERROR",
      `${field} must contain at least one tag.`,
    );
  }
  return normalizeTags(value as string[]);
}

function normalizeTags(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  );
}

function playerIdParam(request: FastifyRequest): string {
  const params = request.params as { playerId?: string };
  return params.playerId ?? "";
}

function mapPlayerError(
  error: unknown,
): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof PlayerError)) {
    return null;
  }
  if (error.code === "PLAYER_NOT_ELIGIBLE") {
    return { statusCode: 422, code: error.code, message: error.message };
  }
  if (error.code === "CONFLICT") {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  if (error.code === "NOT_FOUND") {
    return { statusCode: 404, code: error.code, message: error.message };
  }
  if (error.code === "PERMISSION_DENIED") {
    return { statusCode: 403, code: error.code, message: error.message };
  }
  if (error.code === "AUTH_REQUIRED") {
    return { statusCode: 401, code: error.code, message: error.message };
  }
  return { statusCode: 400, code: error.code, message: error.message };
}

function playerProfileSelectSql(input: {
  whereClause: string;
  activeStatusesParam: number;
}): string {
  return `
SELECT profile.id AS player_id,
       profile.user_id,
       discord.guild_id,
       discord.discord_user_id,
       users.status AS user_status,
       profile.review_status,
       profile.availability,
       profile.discord_presence,
       profile.presence_observed_at,
       profile.approved_by_staff_id,
       profile.approved_at,
       profile.paused_at,
       profile.suspended_at,
       profile.row_version,
       profile.created_at,
       profile.updated_at,
       (
         SELECT active_order.id
         FROM orders AS active_order
         WHERE active_order.active_player_slot_id = profile.user_id
           AND active_order.status = ANY($${input.activeStatusesParam}::"OrderStatus"[])
         ORDER BY active_order.created_at DESC
         LIMIT 1
       ) AS active_order_id,
       COALESCE(
         array_agg(DISTINCT skill.code) FILTER (WHERE skill.type = 'GAME' AND skill.code IS NOT NULL),
         ARRAY[]::text[]
       ) AS game_tags,
       COALESCE(
         array_agg(DISTINCT skill.code) FILTER (WHERE skill.type = 'SERVICE' AND skill.code IS NOT NULL),
         ARRAY[]::text[]
       ) AS service_tags
FROM player_profiles AS profile
JOIN users ON users.id = profile.user_id
JOIN discord_accounts AS discord ON discord.user_id = profile.user_id
LEFT JOIN player_skills AS player_skill ON player_skill.player_profile_id = profile.id
LEFT JOIN skill_tags AS skill ON skill.id = player_skill.skill_tag_id AND skill.enabled = true
${input.whereClause}
GROUP BY profile.id, discord.guild_id, discord.discord_user_id, users.status
LIMIT 1
  `;
}

function mapPlayerProfileRow(row: PlayerProfileRow): PlayerProfileRecord {
  return {
    playerId: row.player_id,
    userId: row.user_id,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    userStatus: row.user_status,
    reviewStatus: row.review_status,
    availability: row.availability,
    discordPresence: row.discord_presence,
    presenceObservedAt: row.presence_observed_at
      ? new Date(row.presence_observed_at).toISOString()
      : null,
    gameTags: [...row.game_tags].sort(),
    serviceTags: [...row.service_tags].sort(),
    activeOrderId: row.active_order_id,
    approvedByStaffId: row.approved_by_staff_id,
    approvedAt: row.approved_at
      ? new Date(row.approved_at).toISOString()
      : null,
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    suspendedAt: row.suspended_at
      ? new Date(row.suspended_at).toISOString()
      : null,
    version: row.row_version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

interface PlayerProfileRow {
  player_id: string;
  user_id: string;
  guild_id: string;
  discord_user_id: string;
  user_status: PlayerUserStatus;
  review_status: PlayerReviewStatus;
  availability: PlayerAvailability;
  discord_presence: DiscordPresenceStatus;
  presence_observed_at: Date | string | null;
  approved_by_staff_id: string | null;
  approved_at: Date | string | null;
  paused_at: Date | string | null;
  suspended_at: Date | string | null;
  row_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  active_order_id: string | null;
  game_tags: string[];
  service_tags: string[];
}

interface PlayerWorkbenchOrderRow {
  order_id: string;
  public_id: string;
  status: string;
  row_version: number;
  game_code: string | null;
  game_name: string | null;
  service_code: string | null;
  service_name: string | null;
  region_code: string | null;
  region_name: string | null;
  billing_unit_minutes: number | null;
  unit_count: number | null;
  player_earning_minor: string | number | null;
  currency: string | null;
  requirement_snapshot: unknown;
  voice_channel_id: string | null;
}

interface PlayerWorkbenchMatchRow extends PlayerWorkbenchOrderRow {
  dispatch_attempt_id: string;
  expires_at: Date | string;
}

interface PlayerEarningsSummaryRow {
  pending_minor: string | number;
  confirmed_minor: string | number;
  paid_minor: string | number;
  currency: string;
}

const playerWorkbenchOrderSelectSql = `
SELECT orders.id AS order_id,
       orders.public_id,
       orders.status,
       orders.row_version,
       orders.game_code_snapshot AS game_code,
       orders.game_name_snapshot AS game_name,
       orders.service_code_snapshot AS service_code,
       orders.service_name_snapshot AS service_name,
       orders.region_code_snapshot AS region_code,
       orders.region_name_snapshot AS region_name,
       orders.billing_unit_minutes,
       orders.unit_count,
       orders.expected_player_earning_minor AS player_earning_minor,
       orders.currency,
       orders.requirement_snapshot,
       orders.voice_channel_id
FROM orders
`;

const playerWorkbenchMatchSelectSql = `
SELECT attempt.id AS dispatch_attempt_id,
       attempt.expires_at,
       orders.id AS order_id,
       orders.public_id,
       orders.status,
       orders.row_version,
       orders.game_code_snapshot AS game_code,
       orders.game_name_snapshot AS game_name,
       orders.service_code_snapshot AS service_code,
       orders.service_name_snapshot AS service_name,
       orders.region_code_snapshot AS region_code,
       orders.region_name_snapshot AS region_name,
       orders.billing_unit_minutes,
       orders.unit_count,
       orders.expected_player_earning_minor AS player_earning_minor,
       orders.currency,
       orders.requirement_snapshot,
       orders.voice_channel_id
FROM dispatch_candidates AS candidate
JOIN dispatch_attempts AS attempt ON attempt.id = candidate.dispatch_attempt_id
JOIN orders ON orders.id = attempt.order_id
`;

function mapWorkbenchOrder(row: PlayerWorkbenchOrderRow): PlayerWorkbenchOrder {
  return {
    id: row.order_id,
    publicId: row.public_id,
    status: row.status,
    version: row.row_version,
    game: row.game_code,
    gameDisplayName: row.game_name ?? row.game_code,
    service: row.service_code,
    serviceDisplayName: row.service_name ?? row.service_code,
    region: row.region_code,
    regionDisplayName: row.region_name ?? row.region_code,
    durationMinutes:
      row.billing_unit_minutes && row.unit_count
        ? row.billing_unit_minutes * row.unit_count
        : null,
    playerEarningMinor: Number(row.player_earning_minor ?? 0),
    currency: row.currency ?? "CAT",
    requirements: requirementLabels(row.requirement_snapshot),
    voiceChannelId: row.voice_channel_id,
  };
}

function requirementLabels(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return [];
  }
  return Object.values(snapshot)
    .flatMap((value) => {
      if (typeof value === "string" && value.trim()) {
        return [value.trim()];
      }
      if (Array.isArray(value)) {
        return value.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        );
      }
      return [];
    })
    .slice(0, 8);
}
