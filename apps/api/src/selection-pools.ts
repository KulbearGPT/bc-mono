import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink,
} from "./security.js";

export type SelectionPoolStatus =
  "COLLECTING" | "SELECTION" | "FINALIZED" | "CANCELLED";
export type SelectionPoolCloseReason =
  "TIME_ELAPSED" | "CUSTOMER_EARLY_CLOSE" | "ORDER_CANCELLED";
export type SelectionApplicationStatus =
  "APPLIED" | "WITHDRAWN" | "SELECTED" | "NOT_SELECTED" | "INVALIDATED";

export interface SelectionPoolRecord {
  id: string;
  orderId: string;
  round: number;
  status: SelectionPoolStatus;
  version: number;
  waitMinutes: number;
  openedAt: string;
  closesAt: string;
  closedAt: string | null;
  closeReason: SelectionPoolCloseReason | null;
  applicationCount: number;
}

export interface SelectionApplicationRecord {
  id: string;
  selectionPoolId: string;
  orderRequirementId: string;
  playerId: string;
  playerDisplayName: string;
  publicGameTags: string[];
  publicServiceTags: string[];
  status: SelectionApplicationStatus;
  version: number;
  appliedAt: string;
  decidedAt: string | null;
}

export interface SelectionOrder {
  id: string;
  guildId: string;
  customerDiscordUserId: string;
  status: string;
  version: number;
  reservationId: string | null;
}

export interface SelectionRequirement {
  id: string;
  orderId: string;
  status: "ACTIVE" | "REMOVED";
  serviceCatalogVersionId: string;
  requestedPlayerCount: number;
  filledPlayerCount: number;
  game: string;
  gameDisplayName: string;
  service: string;
  serviceDisplayName: string;
  region: string | null;
  regionDisplayName: string | null;
  billingUnitMinutes: number;
  unitCount: number;
  customerUnitPriceMinor: number;
  linePriceMinor: number;
}

export interface SelectionPlayer {
  id: string;
  guildId: string;
  discordUserId: string;
  displayName: string;
  reviewStatus: "PENDING_REVIEW" | "ACTIVE" | "PAUSED" | "SUSPENDED";
  matchingCatalogIds: string[];
  publicGameTags?: string[];
  publicServiceTags?: string[];
  presence?: string;
  legacyAvailability?: string;
  activeOrderId: string | null;
  compensationType: "PERCENT_BPS" | "FIXED_MINOR";
  compensationValue: number;
}

export interface SelectedParticipant {
  id: string;
  orderId: string;
  orderRequirementId: string;
  playerId: string;
  playerDisplayName: string;
  serviceCatalogVersionId: string;
  linePriceMinor: number;
  expectedEarningMinor: number;
  createdAt: string;
}

interface CustomerScope {
  orderId: string;
  actorGuildId: string;
  actorDiscordUserId: string;
}
interface PoolScope extends CustomerScope {
  selectionPoolId: string;
}
interface PlayerScope {
  orderId: string;
  selectionPoolId: string;
  actorGuildId: string;
  actorDiscordUserId: string;
}

export interface CreateSelectionPoolInput extends CustomerScope {
  expectedOrderVersion: number;
  waitMinutes: number;
  idempotencyKey: string;
  now: Date;
}
export interface ApplySelectionPoolInput extends PlayerScope {
  orderRequirementId: string;
  expectedPoolVersion: number;
  idempotencyKey: string;
  now: Date;
}
export interface WithdrawSelectionApplicationInput extends PlayerScope {
  applicationId: string;
  expectedPoolVersion: number;
  expectedApplicationVersion: number;
  idempotencyKey: string;
  now: Date;
}
export interface CloseSelectionPoolInput extends PoolScope {
  expectedPoolVersion: number;
  reason: "TIME_ELAPSED" | "CUSTOMER_EARLY_CLOSE";
  idempotencyKey: string;
  now: Date;
}
export interface FinalizeSelectionPoolInput extends PoolScope {
  expectedOrderVersion: number;
  expectedPoolVersion: number;
  applicationIds: string[];
  idempotencyKey: string;
  now: Date;
}
export interface ListSelectionApplicationsInput extends PoolScope {
  actorStaffId?: string | null;
  cursor: string | null;
  limit: number;
}

export interface SelectionPoolResult {
  pool: SelectionPoolRecord;
}
export interface SelectionApplicationResult {
  pool: SelectionPoolRecord;
  application: SelectionApplicationRecord;
}
export interface SelectionApplicationPage {
  pool: SelectionPoolRecord;
  items: SelectionApplicationRecord[];
  nextCursor: string | null;
}
export interface SelectionFinalizeResult {
  orderId: string;
  orderStatus: string;
  orderVersion: number;
  pool: SelectionPoolRecord;
  selectedParticipantIds: string[];
  selectedDisplayNames: string[];
  remainingSlotCount: number;
}

interface StagedWrite<T> {
  data: T;
  commit(audit: AuditRecord): Promise<void> | void;
}

export interface SelectionPoolStore {
  getCurrentPool(
    input: CustomerScope,
  ): Promise<SelectionPoolResult> | SelectionPoolResult;
  createPool(
    input: CreateSelectionPoolInput,
  ):
    | Promise<StagedWrite<SelectionPoolResult>>
    | StagedWrite<SelectionPoolResult>;
  apply(
    input: ApplySelectionPoolInput,
  ):
    | Promise<StagedWrite<SelectionApplicationResult>>
    | StagedWrite<SelectionApplicationResult>;
  withdraw(
    input: WithdrawSelectionApplicationInput,
  ):
    | Promise<StagedWrite<SelectionApplicationResult>>
    | StagedWrite<SelectionApplicationResult>;
  closePool(
    input: CloseSelectionPoolInput,
  ):
    | Promise<StagedWrite<SelectionPoolResult>>
    | StagedWrite<SelectionPoolResult>;
  listApplications(
    input: ListSelectionApplicationsInput,
  ): Promise<SelectionApplicationPage> | SelectionApplicationPage;
  finalize(
    input: FinalizeSelectionPoolInput,
  ):
    | Promise<StagedWrite<SelectionFinalizeResult>>
    | StagedWrite<SelectionFinalizeResult>;
}

export class SelectionPoolError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "PERMISSION_DENIED"
      | "VALIDATION_ERROR"
      | "CONFLICT"
      | "BUSINESS_RULE_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "SelectionPoolError";
  }
}

export class InMemorySelectionPoolStore implements SelectionPoolStore {
  readonly orders: SelectionOrder[];
  readonly requirements: SelectionRequirement[];
  readonly players: SelectionPlayer[];
  readonly pools: SelectionPoolRecord[];
  readonly applications: SelectionApplicationRecord[];
  readonly participants: SelectedParticipant[];
  private readonly auditSink: AuditSink;
  private readonly eventKeys = new Set<string>();

  constructor(input: {
    orders: SelectionOrder[];
    requirements: SelectionRequirement[];
    players: SelectionPlayer[];
    pools?: SelectionPoolRecord[];
    applications?: SelectionApplicationRecord[];
    participants?: SelectedParticipant[];
    auditSink?: AuditSink;
  }) {
    this.orders = clone(input.orders);
    this.requirements = clone(input.requirements);
    this.players = clone(input.players);
    this.pools = clone(input.pools ?? []);
    this.applications = clone(input.applications ?? []);
    this.participants = clone(input.participants ?? []);
    this.auditSink = input.auditSink ?? new InMemoryAuditSink();
  }

  getCurrentPool(input: CustomerScope): SelectionPoolResult {
    const order = this.requireCustomerOrder(input);
    const pool = this.pools
      .filter(
        (item) =>
          item.orderId === order.id &&
          (item.status === "COLLECTING" || item.status === "SELECTION"),
      )
      .sort((left, right) => right.round - left.round)[0];
    if (!pool)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Active selection pool was not found.",
      );
    return { pool: clone(pool) };
  }

  createPool(
    input: CreateSelectionPoolInput,
  ): StagedWrite<SelectionPoolResult> {
    wholeNumber(input.waitMinutes, "waitMinutes", 1, 30);
    const order = this.requireCustomerOrder(input);
    if (order.version !== input.expectedOrderVersion)
      throw new SelectionPoolError("CONFLICT", "Order version is stale.");
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "Only a pending order can open a selection pool.",
      );
    if (this.remainingSlots(order.id) < 1)
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "The order has no remaining player slots.",
      );
    const activePool = this.pools.find(
      (pool) =>
        pool.orderId === order.id &&
        (pool.status === "COLLECTING" || pool.status === "SELECTION"),
    );
    if (
      activePool &&
      (activePool.status !== "SELECTION" ||
        this.applications.some(
          (application) =>
            application.selectionPoolId === activePool.id &&
            application.status === "APPLIED",
        ))
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "The order already has an active selection pool.",
      );
    const round =
      Math.max(
        0,
        ...this.pools
          .filter((pool) => pool.orderId === order.id)
          .map((pool) => pool.round),
      ) + 1;
    const openedAt = input.now.toISOString();
    const pool: SelectionPoolRecord = {
      id: crypto.randomUUID(),
      orderId: order.id,
      round,
      status: "COLLECTING",
      version: 1,
      waitMinutes: input.waitMinutes,
      openedAt,
      closesAt: new Date(
        input.now.getTime() + input.waitMinutes * 60_000,
      ).toISOString(),
      closedAt: null,
      closeReason: null,
      applicationCount: 0,
    };
    return this.stage(input.idempotencyKey, { pool: clone(pool) }, async () => {
      this.requireCustomerOrder(input);
      const current = this.pools.find(
        (item) =>
          item.orderId === order.id &&
          (item.status === "COLLECTING" || item.status === "SELECTION"),
      );
      if (current) {
        if (
          current.status !== "SELECTION" ||
          this.applications.some(
            (application) =>
              application.selectionPoolId === current.id &&
              application.status === "APPLIED",
          )
        )
          throw new SelectionPoolError(
            "CONFLICT",
            "The order already has an active selection pool.",
          );
        current.status = "FINALIZED";
        current.version += 1;
      }
      this.pools.push(clone(pool));
    });
  }

  apply(
    input: ApplySelectionPoolInput,
  ): StagedWrite<SelectionApplicationResult> {
    const { pool, requirement, player } = this.requireApplicationFacts(input);
    if (pool.version !== input.expectedPoolVersion)
      throw new SelectionPoolError(
        "CONFLICT",
        "Selection pool version is stale.",
      );
    if (
      this.applications.some(
        (application) =>
          application.selectionPoolId === pool.id &&
          application.orderRequirementId === requirement.id &&
          application.playerId === player.id &&
          application.status === "APPLIED",
      )
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "Player already applied to this requirement.",
      );
    const application: SelectionApplicationRecord = {
      id: crypto.randomUUID(),
      selectionPoolId: pool.id,
      orderRequirementId: requirement.id,
      playerId: player.id,
      playerDisplayName: player.displayName,
      publicGameTags: [...(player.publicGameTags ?? [])],
      publicServiceTags: [...(player.publicServiceTags ?? [])],
      status: "APPLIED",
      version: 1,
      appliedAt: input.now.toISOString(),
      decidedAt: null,
    };
    const nextPool = {
      ...clone(pool),
      applicationCount: pool.applicationCount + 1,
    };
    return this.stage(
      input.idempotencyKey,
      { pool: nextPool, application: clone(application) },
      async () => {
        const current = this.requireApplicationFacts(input);
        if (current.pool.version !== input.expectedPoolVersion)
          throw new SelectionPoolError(
            "CONFLICT",
            "Selection pool version is stale.",
          );
        if (
          this.applications.some(
            (item) =>
              item.selectionPoolId === pool.id &&
              item.orderRequirementId === requirement.id &&
              item.playerId === player.id &&
              item.status === "APPLIED",
          )
        )
          throw new SelectionPoolError(
            "CONFLICT",
            "Player already applied to this requirement.",
          );
        this.applications.push(clone(application));
        Object.assign(current.pool, clone(nextPool));
      },
    );
  }

  withdraw(
    input: WithdrawSelectionApplicationInput,
  ): StagedWrite<SelectionApplicationResult> {
    const { order, pool, player } = this.requirePlayerPool(input);
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting selection changes.");
    const application = this.applications.find(
      (item) =>
        item.id === input.applicationId && item.selectionPoolId === pool.id,
    );
    if (!application)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Selection application was not found.",
      );
    if (application.playerId !== player.id)
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Only the applicant can withdraw.",
      );
    if (
      pool.version !== input.expectedPoolVersion ||
      application.version !== input.expectedApplicationVersion
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "Selection pool or application version is stale.",
      );
    if (pool.status !== "COLLECTING" || application.status !== "APPLIED")
      throw new SelectionPoolError(
        "CONFLICT",
        "Only an active collecting application can be withdrawn.",
      );
    if (input.now.getTime() >= Date.parse(pool.closesAt))
      throw new SelectionPoolError("CONFLICT", "Selection pool deadline has elapsed.");
    const nextApplication = {
      ...clone(application),
      status: "WITHDRAWN" as const,
      version: application.version + 1,
      decidedAt: input.now.toISOString(),
    };
    const nextPool = {
      ...clone(pool),
      applicationCount: Math.max(0, pool.applicationCount - 1),
    };
    return this.stage(
      input.idempotencyKey,
      { pool: nextPool, application: nextApplication },
      async () => {
        Object.assign(application, clone(nextApplication));
        Object.assign(pool, clone(nextPool));
      },
    );
  }

  closePool(input: CloseSelectionPoolInput): StagedWrite<SelectionPoolResult> {
    const order = this.requireCustomerOrder(input);
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting selection changes.");
    const pool = this.requirePool(input.orderId, input.selectionPoolId);
    if (pool.version !== input.expectedPoolVersion)
      throw new SelectionPoolError(
        "CONFLICT",
        "Selection pool version is stale.",
      );
    if (pool.status !== "COLLECTING")
      throw new SelectionPoolError(
        "CONFLICT",
        "Only a collecting selection pool can be closed.",
      );
    if (
      input.reason === "TIME_ELAPSED" &&
      input.now.getTime() < Date.parse(pool.closesAt)
    )
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "Selection pool deadline has not elapsed.",
      );
    if (
      input.reason === "CUSTOMER_EARLY_CLOSE" &&
      order.customerDiscordUserId !== input.actorDiscordUserId
    )
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Only the order owner can close early.",
      );
    const next = {
      ...clone(pool),
      status: "SELECTION" as const,
      version: pool.version + 1,
      closedAt: input.now.toISOString(),
      closeReason: input.reason,
    };
    return this.stage(input.idempotencyKey, { pool: next }, async () => {
      Object.assign(pool, clone(next));
    });
  }

  listApplications(
    input: ListSelectionApplicationsInput,
  ): SelectionApplicationPage {
    const order = this.orders.find(
      (item) =>
        item.id === input.orderId && item.guildId === input.actorGuildId,
    );
    if (!order)
      throw new SelectionPoolError("NOT_FOUND", "Order was not found.");
    if (
      order.customerDiscordUserId !== input.actorDiscordUserId &&
      !input.actorStaffId
    )
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Applicant pool is private.",
      );
    const pool = this.requirePool(order.id, input.selectionPoolId);
    const offset = decodeCursor(input.cursor);
    const all = this.applications
      .filter(
        (item) =>
          item.selectionPoolId === pool.id && item.status !== "WITHDRAWN",
      )
      .sort(
        (a, b) =>
          a.appliedAt.localeCompare(b.appliedAt) || a.id.localeCompare(b.id),
      );
    return {
      pool: clone(pool),
      items: clone(all.slice(offset, offset + input.limit)),
      nextCursor:
        offset + input.limit < all.length
          ? encodeCursor(offset + input.limit)
          : null,
    };
  }

  finalize(
    input: FinalizeSelectionPoolInput,
  ): StagedWrite<SelectionFinalizeResult> {
    const preview = this.previewFinalize(input);
    return this.stage(input.idempotencyKey, clone(preview.result), async () => {
      const current = this.previewFinalize(input);
      for (const entry of current.selected) {
        const participant = buildParticipant(
          entry.application,
          entry.requirement,
          entry.player,
          input.now,
        );
        this.participants.push(participant);
        entry.requirement.filledPlayerCount += 1;
        entry.player.activeOrderId = input.orderId;
        entry.application.status = "SELECTED";
        entry.application.version += 1;
        entry.application.decidedAt = input.now.toISOString();
        for (const other of this.applications) {
          if (
            other.playerId === entry.player.id &&
            other.id !== entry.application.id &&
            other.status === "APPLIED"
          ) {
            other.status = "INVALIDATED";
            other.version += 1;
            other.decidedAt = input.now.toISOString();
          }
        }
      }
      for (const application of this.applications) {
        if (
          application.selectionPoolId === current.pool.id &&
          application.status === "APPLIED"
        ) {
          application.status = "NOT_SELECTED";
          application.version += 1;
          application.decidedAt = input.now.toISOString();
        }
      }
      current.pool.status = "FINALIZED";
      current.pool.version += 1;
      current.order.version += 1;
      current.order.status =
        this.remainingSlots(current.order.id) === 0
          ? "ACCEPTED"
          : "PENDING_DISPATCH";
      current.result.orderStatus = current.order.status;
      current.result.orderVersion = current.order.version;
      current.result.pool = clone(current.pool);
      current.result.selectedParticipantIds = this.participants
        .slice(-current.selected.length)
        .map((item) => item.id);
      current.result.remainingSlotCount = this.remainingSlots(current.order.id);
      Object.assign(preview.result, clone(current.result));
    });
  }

  private previewFinalize(input: FinalizeSelectionPoolInput) {
    const order = this.requireCustomerOrder(input);
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting selection changes.");
    const pool = this.requirePool(order.id, input.selectionPoolId);
    if (
      order.version !== input.expectedOrderVersion ||
      pool.version !== input.expectedPoolVersion
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "Order or selection pool version is stale.",
      );
    if (pool.status !== "SELECTION")
      throw new SelectionPoolError(
        "CONFLICT",
        "Selection pool is not in selection stage.",
      );
    if (
      !Array.isArray(input.applicationIds) ||
      input.applicationIds.length < 1 ||
      new Set(input.applicationIds).size !== input.applicationIds.length
    )
      throw new SelectionPoolError(
        "VALIDATION_ERROR",
        "applicationIds must contain unique values.",
      );
    const selected = input.applicationIds.map((id) => {
      const application = this.applications.find(
        (item) =>
          item.id === id &&
          item.selectionPoolId === pool.id &&
          item.status === "APPLIED",
      );
      if (!application)
        throw new SelectionPoolError(
          "CONFLICT",
          "A selected application is no longer active.",
        );
      const requirement = this.requirements.find(
        (item) =>
          item.id === application.orderRequirementId &&
          item.orderId === order.id &&
          item.status === "ACTIVE",
      );
      const player = this.players.find(
        (item) =>
          item.id === application.playerId &&
          item.guildId === order.guildId &&
          item.reviewStatus === "ACTIVE",
      );
      if (
        !requirement ||
        !player ||
        !player.matchingCatalogIds.includes(requirement.serviceCatalogVersionId)
      )
        throw new SelectionPoolError(
          "BUSINESS_RULE_ERROR",
          "A selected player is no longer eligible.",
        );
      if (player.activeOrderId && player.activeOrderId !== order.id)
        throw new SelectionPoolError(
          "CONFLICT",
          "A selected player already has another active order.",
        );
      return { application, requirement, player };
    });
    if (
      new Set(selected.map((item) => item.player.id)).size !== selected.length
    )
      throw new SelectionPoolError(
        "VALIDATION_ERROR",
        "A player can only be selected once.",
      );
    const counts = new Map<string, number>();
    for (const item of selected)
      counts.set(
        item.requirement.id,
        (counts.get(item.requirement.id) ?? 0) + 1,
      );
    for (const [id, count] of counts) {
      const requirement = selected.find(
        (item) => item.requirement.id === id,
      )!.requirement;
      if (
        requirement.filledPlayerCount + count >
        requirement.requestedPlayerCount
      )
        throw new SelectionPoolError(
          "CONFLICT",
          "Selected applicants exceed requirement capacity.",
        );
    }
    const result: SelectionFinalizeResult = {
      orderId: order.id,
      orderStatus: order.status,
      orderVersion: order.version + 1,
      pool: { ...clone(pool), status: "FINALIZED", version: pool.version + 1 },
      selectedParticipantIds: selected.map(() => ""),
      selectedDisplayNames: selected.map((item) => item.player.displayName),
      remainingSlotCount: Math.max(
        0,
        this.remainingSlots(order.id) - selected.length,
      ),
    };
    return { order, pool, selected, result };
  }

  private requireCustomerOrder(input: CustomerScope): SelectionOrder {
    const order = this.orders.find(
      (item) =>
        item.id === input.orderId && item.guildId === input.actorGuildId,
    );
    if (!order)
      throw new SelectionPoolError("NOT_FOUND", "Order was not found.");
    if (order.customerDiscordUserId !== input.actorDiscordUserId)
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Only the order owner can manage the selection pool.",
      );
    return order;
  }
  private requirePool(orderId: string, poolId: string): SelectionPoolRecord {
    const pool = this.pools.find(
      (item) => item.id === poolId && item.orderId === orderId,
    );
    if (!pool)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Selection pool was not found.",
      );
    return pool;
  }
  private requirePlayerPool(input: PlayerScope) {
    const pool = this.requirePool(input.orderId, input.selectionPoolId);
    const order = this.orders.find(
      (item) =>
        item.id === input.orderId && item.guildId === input.actorGuildId,
    );
    const player = this.players.find(
      (item) =>
        item.guildId === input.actorGuildId &&
        item.discordUserId === input.actorDiscordUserId,
    );
    if (!order || !player)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Selection pool was not found.",
      );
    return { order, pool, player };
  }
  private requireApplicationFacts(input: ApplySelectionPoolInput) {
    const facts = this.requirePlayerPool(input);
    const requirement = this.requirements.find(
      (item) =>
        item.id === input.orderRequirementId &&
        item.orderId === input.orderId &&
        item.status === "ACTIVE" &&
        item.filledPlayerCount < item.requestedPlayerCount,
    );
    if (facts.order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting applications.");
    if (facts.pool.status !== "COLLECTING")
      throw new SelectionPoolError("CONFLICT", "Selection pool is closed.");
    if (input.now.getTime() >= Date.parse(facts.pool.closesAt))
      throw new SelectionPoolError("CONFLICT", "Selection pool deadline has elapsed.");
    if (
      !requirement ||
      facts.player.reviewStatus !== "ACTIVE" ||
      !facts.player.matchingCatalogIds.includes(
        requirement.serviceCatalogVersionId,
      )
    )
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "Player is not eligible for this requirement.",
      );
    return { ...facts, requirement };
  }
  private remainingSlots(orderId: string) {
    return this.requirements
      .filter((item) => item.orderId === orderId && item.status === "ACTIVE")
      .reduce(
        (sum, item) =>
          sum + Math.max(0, item.requestedPlayerCount - item.filledPlayerCount),
        0,
      );
  }
  private assertNoActivePool(orderId: string) {
    if (
      this.pools.some(
        (pool) =>
          pool.orderId === orderId &&
          (pool.status === "COLLECTING" || pool.status === "SELECTION"),
      )
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "The order already has an active selection pool.",
      );
  }
  private stage<T>(
    key: string,
    data: T,
    mutation: () => Promise<void> | void,
  ): StagedWrite<T> {
    return {
      data,
      commit: async (audit) => {
        if (this.eventKeys.has(key)) return;
        await this.auditSink.append(audit);
        await mutation();
        this.eventKeys.add(key);
      },
    };
  }
}

export class PostgresSelectionPoolStore implements SelectionPoolStore {
  constructor(private readonly pool: Pool) {}
  async getCurrentPool(input: CustomerScope): Promise<SelectionPoolResult> {
    const order = await this.order(this.pool, input, false);
    this.owner(order, input.actorDiscordUserId);
    const row = (
      await this.pool.query<SelectionPoolRow>(
        `${selectionPoolSelect} WHERE pool.order_id=$1 AND pool.status IN ('COLLECTING','SELECTION') ORDER BY pool.round DESC LIMIT 1`,
        [input.orderId],
      )
    ).rows[0];
    if (!row)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Active selection pool was not found.",
      );
    return { pool: mapSelectionPool(row) };
  }
  createPool(input: CreateSelectionPoolInput) {
    return this.prepare((client) => this.mutateCreate(client, input));
  }
  apply(input: ApplySelectionPoolInput) {
    return this.prepare((client) => this.mutateApply(client, input));
  }
  withdraw(input: WithdrawSelectionApplicationInput) {
    return this.prepare((client) => this.mutateWithdraw(client, input));
  }
  closePool(input: CloseSelectionPoolInput) {
    return this.prepare((client) => this.mutateClose(client, input));
  }
  finalize(input: FinalizeSelectionPoolInput) {
    return this.prepare((client) => this.mutateFinalize(client, input));
  }

  async listApplications(
    input: ListSelectionApplicationsInput,
  ): Promise<SelectionApplicationPage> {
    const order = await this.order(this.pool, input, false);
    if (
      order.customer_discord_user_id !== input.actorDiscordUserId &&
      !input.actorStaffId
    )
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Applicant pool is private.",
      );
    const pool = await this.selectionPool(
      this.pool,
      input.orderId,
      input.selectionPoolId,
      false,
    );
    const offset = decodeCursor(input.cursor);
    const result = await this.pool.query<SelectionApplicationRow>(
      `${selectionApplicationSelect} WHERE application.selection_pool_id=$1 AND application.status<>'WITHDRAWN' ORDER BY application.applied_at,application.id OFFSET $2 LIMIT $3`,
      [pool.id, offset, input.limit + 1],
    );
    return {
      pool,
      items: result.rows.slice(0, input.limit).map(mapSelectionApplication),
      nextCursor:
        result.rows.length > input.limit
          ? encodeCursor(offset + input.limit)
          : null,
    };
  }

  private async prepare<T>(
    mutate: (client: PoolClient) => Promise<T>,
  ): Promise<StagedWrite<T>> {
    const preview = await this.pool.connect();
    try {
      await preview.query("BEGIN");
      const data = await mutate(preview);
      await preview.query("ROLLBACK");
      return {
        data,
        commit: async (audit) => {
          const tx = await this.pool.connect();
          try {
            await tx.query("BEGIN");
            const committed = await mutate(tx);
            await insertPostgresAuditRecord(tx, audit);
            await tx.query("COMMIT");
            Object.assign(data as object, committed as object);
          } catch (error) {
            await tx.query("ROLLBACK").catch(() => undefined);
            throw normalizeSelectionPgError(error);
          } finally {
            tx.release();
          }
        },
      };
    } catch (error) {
      await preview.query("ROLLBACK").catch(() => undefined);
      throw normalizeSelectionPgError(error);
    } finally {
      preview.release();
    }
  }

  private async mutateCreate(
    client: PoolClient,
    input: CreateSelectionPoolInput,
  ): Promise<SelectionPoolResult> {
    wholeNumber(input.waitMinutes, "waitMinutes", 1, 30);
    const order = await this.order(client, input, true);
    this.owner(order, input.actorDiscordUserId);
    if (order.row_version !== input.expectedOrderVersion)
      throw new SelectionPoolError("CONFLICT", "Order version is stale.");
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "Only a pending order can open a selection pool.",
      );
    if ((await this.remaining(client, input.orderId)) < 1)
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "The order has no remaining player slots.",
      );
    const active = (
      await client.query<{
        id: string;
        status: SelectionPoolStatus;
        application_count: string;
      }>(
        `SELECT pool.id,pool.status::text,(SELECT count(*) FROM selection_applications application WHERE application.selection_pool_id=pool.id AND application.status='APPLIED')::text application_count FROM selection_pools pool WHERE pool.order_id=$1 AND pool.status IN ('COLLECTING','SELECTION') FOR UPDATE OF pool`,
        [input.orderId],
      )
    ).rows[0];
    if (
      active &&
      (active.status !== "SELECTION" || Number(active.application_count) > 0)
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "The order already has an active selection pool.",
      );
    if (active) {
      await client.query(
        `UPDATE selection_pools SET status='FINALIZED',row_version=row_version+1,finalized_at=$2,updated_at=$2 WHERE id=$1`,
        [active.id, input.now],
      );
      const prior = await this.selectionPool(
        client,
        input.orderId,
        active.id,
        false,
      );
      await this.poolEvent(
        client,
        prior,
        order.row_version,
        order.customer_user_id,
        "FINALIZED",
        `${input.idempotencyKey}:prior-empty-finalized`,
        input.now,
      );
    }
    const round = Number(
      (
        await client.query<{ value: string }>(
          `SELECT (COALESCE(MAX(round),0)+1)::text value FROM selection_pools WHERE order_id=$1`,
          [input.orderId],
        )
      ).rows[0]?.value ?? 1,
    );
    const id = crypto.randomUUID();
    const closesAt = new Date(input.now.getTime() + input.waitMinutes * 60_000);
    await client.query(
      `INSERT INTO selection_pools(id,order_id,round,status,row_version,wait_minutes,opened_at,closes_at,created_at,updated_at) VALUES($1,$2,$3,'COLLECTING',1,$4,$5,$6,$5,$5)`,
      [id, input.orderId, round, input.waitMinutes, input.now, closesAt],
    );
    const pool = await this.selectionPool(client, input.orderId, id, false);
    await this.poolEvent(
      client,
      pool,
      order.row_version,
      order.customer_user_id,
      "CREATED",
      input.idempotencyKey,
      input.now,
    );
    await this.outbox(
      client,
      pool,
      "SELECTION_POOL_SYNC",
      { orderId: input.orderId, selectionPoolId: id, phase: "COLLECTING" },
      `${input.idempotencyKey}:publish`,
      input.now,
      input.now,
    );
    await this.outbox(
      client,
      pool,
      "SELECTION_POOL_CLOSE",
      { orderId: input.orderId, selectionPoolId: id },
      `${input.idempotencyKey}:close`,
      closesAt,
      input.now,
    );
    return { pool };
  }

  private async mutateApply(
    client: PoolClient,
    input: ApplySelectionPoolInput,
  ): Promise<SelectionApplicationResult> {
    const order = await this.order(client, input, false);
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting applications.");
    const pool = await this.selectionPool(
      client,
      input.orderId,
      input.selectionPoolId,
      true,
    );
    if (
      pool.status !== "COLLECTING" ||
      pool.version !== input.expectedPoolVersion ||
      input.now.getTime() >= Date.parse(pool.closesAt)
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "Selection pool is closed or stale.",
      );
    const facts = await client.query<PlayerRequirementRow>(
      `${playerRequirementSelect} WHERE requirement.id=$1 AND requirement.order_id=$2 AND account.guild_id=$3 AND account.discord_user_id=$4 AND requirement.status='ACTIVE' AND profile.review_status='ACTIVE' AND version.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM service_version_skill_requirements needed WHERE needed.service_catalog_version_id=version.id AND NOT EXISTS(SELECT 1 FROM player_skills skill WHERE skill.player_profile_id=profile.id AND skill.skill_tag_id=needed.skill_tag_id))`,
      [
        input.orderRequirementId,
        input.orderId,
        input.actorGuildId,
        input.actorDiscordUserId,
      ],
    );
    const fact = facts.rows[0];
    if (!fact)
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "Player is not eligible for this requirement.",
      );
    if (
      (await this.filled(client, input.orderRequirementId)) >=
      fact.requested_player_count
    )
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "Requirement has no remaining player slots.",
      );
    const id = crypto.randomUUID();
    const snapshot = {
      playerDisplayName: fact.display_name,
      publicGameTags: fact.public_game_tags ?? [],
      publicServiceTags: fact.public_service_tags ?? [],
      serviceCatalogVersionId: fact.service_catalog_version_id,
    };
    await client.query(
      `INSERT INTO selection_applications(id,selection_pool_id,order_requirement_id,player_user_id,status,row_version,eligibility_snapshot,applied_at,created_at,updated_at) VALUES($1,$2,$3,$4,'APPLIED',1,$5,$6,$6,$6)`,
      [
        id,
        pool.id,
        input.orderRequirementId,
        fact.player_user_id,
        snapshot,
        input.now,
      ],
    );
    const application = await this.application(client, id);
    await this.applicationEvent(
      client,
      application,
      fact.player_user_id,
      "APPLIED",
      input.idempotencyKey,
      input.now,
    );
    await this.panelOutbox(
      client,
      input.orderId,
      "ORDER_SELECTION_APPLICATION_CHANNEL_SYNC",
      `${input.idempotencyKey}:panel-sync`,
      input.now,
    );
    return {
      pool: await this.selectionPool(client, input.orderId, pool.id, false),
      application,
    };
  }

  private async mutateWithdraw(
    client: PoolClient,
    input: WithdrawSelectionApplicationInput,
  ): Promise<SelectionApplicationResult> {
    const order = await this.order(client, input, false);
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting selection changes.");
    const pool = await this.selectionPool(
      client,
      input.orderId,
      input.selectionPoolId,
      true,
    );
    const row = (
      await client.query<SelectionApplicationRow>(
        `${selectionApplicationSelect} WHERE application.id=$1 AND application.selection_pool_id=$2 FOR UPDATE OF application`,
        [input.applicationId, pool.id],
      )
    ).rows[0];
    if (!row)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Selection application was not found.",
      );
    const application = mapSelectionApplication(row);
    if (row.actor_discord_user_id !== input.actorDiscordUserId)
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Only the applicant can withdraw.",
      );
    if (
      pool.status !== "COLLECTING" ||
      pool.version !== input.expectedPoolVersion ||
      input.now.getTime() >= Date.parse(pool.closesAt) ||
      application.status !== "APPLIED" ||
      application.version !== input.expectedApplicationVersion
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "Selection pool or application is stale.",
      );
    await client.query(
      `UPDATE selection_applications SET status='WITHDRAWN',row_version=row_version+1,withdrawn_at=$3,decided_at=$3,updated_at=$3 WHERE id=$1 AND row_version=$2`,
      [application.id, application.version, input.now],
    );
    const updated = await this.application(client, application.id);
    await this.applicationEvent(
      client,
      updated,
      row.player_user_id,
      "WITHDRAWN",
      input.idempotencyKey,
      input.now,
    );
    await this.panelOutbox(
      client,
      input.orderId,
      "ORDER_SELECTION_WITHDRAWN_CHANNEL_SYNC",
      `${input.idempotencyKey}:panel-sync`,
      input.now,
    );
    return {
      pool: await this.selectionPool(client, input.orderId, pool.id, false),
      application: updated,
    };
  }

  private async mutateClose(
    client: PoolClient,
    input: CloseSelectionPoolInput,
  ): Promise<SelectionPoolResult> {
    const order = await this.order(client, input, true);
    this.owner(order, input.actorDiscordUserId);
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting selection changes.");
    const pool = await this.selectionPool(
      client,
      input.orderId,
      input.selectionPoolId,
      true,
    );
    if (
      pool.status !== "COLLECTING" ||
      pool.version !== input.expectedPoolVersion
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "Only a current collecting selection pool can be closed.",
      );
    if (
      input.reason === "TIME_ELAPSED" &&
      input.now.getTime() < Date.parse(pool.closesAt)
    )
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "Selection pool deadline has not elapsed.",
      );
    await client.query(
      `UPDATE selection_pools SET status='SELECTION',row_version=row_version+1,closed_at=$3,close_reason=$4,updated_at=$3 WHERE id=$1 AND row_version=$2`,
      [pool.id, pool.version, input.now, input.reason],
    );
    const updated = await this.selectionPool(
      client,
      input.orderId,
      pool.id,
      false,
    );
    await this.poolEvent(
      client,
      updated,
      order.row_version,
      order.customer_user_id,
      "CLOSED",
      input.idempotencyKey,
      input.now,
    );
    await this.outbox(
      client,
      updated,
      "SELECTION_POOL_SYNC",
      { orderId: input.orderId, selectionPoolId: pool.id, phase: "SELECTION" },
      `${input.idempotencyKey}:voice-sync`,
      input.now,
      input.now,
    );
    await this.panelOutbox(
      client,
      input.orderId,
      "ORDER_SELECTION_CLOSED_CHANNEL_SYNC",
      `${input.idempotencyKey}:panel-sync`,
      input.now,
    );
    return { pool: updated };
  }

  private async mutateFinalize(
    client: PoolClient,
    input: FinalizeSelectionPoolInput,
  ): Promise<SelectionFinalizeResult> {
    if (
      !input.applicationIds.length ||
      new Set(input.applicationIds).size !== input.applicationIds.length
    )
      throw new SelectionPoolError(
        "VALIDATION_ERROR",
        "applicationIds must contain unique values.",
      );
    const order = await this.order(client, input, true);
    this.owner(order, input.actorDiscordUserId);
    if (order.status !== "PENDING_DISPATCH")
      throw new SelectionPoolError("CONFLICT", "Order is not accepting selection changes.");
    const pool = await this.selectionPool(
      client,
      input.orderId,
      input.selectionPoolId,
      true,
    );
    if (
      order.row_version !== input.expectedOrderVersion ||
      pool.version !== input.expectedPoolVersion
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "Order or selection pool version is stale.",
      );
    if (pool.status !== "SELECTION")
      throw new SelectionPoolError(
        "CONFLICT",
        "Selection pool is not in selection stage.",
      );
    const initial = (
      await client.query<FinalizeFactRow>(
        `${finalizeFactSelect} WHERE application.id=ANY($1::uuid[]) AND application.selection_pool_id=$2 ORDER BY application.player_user_id,application.id`,
        [input.applicationIds, pool.id],
      )
    ).rows;
    if (initial.length !== input.applicationIds.length)
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "A selected player is no longer eligible.",
      );
    const initialPlayerIds = initial.map((row) => row.player_user_id);
    if (new Set(initialPlayerIds).size !== initialPlayerIds.length)
      throw new SelectionPoolError(
        "VALIDATION_ERROR",
        "A player can only be selected once.",
      );
    for (const id of [...initialPlayerIds].sort())
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
        [id],
      );
    const selected = (
      await client.query<FinalizeFactRow>(
        `${finalizeFactSelect} WHERE application.id=ANY($1::uuid[]) AND application.selection_pool_id=$2 ORDER BY application.player_user_id,application.id FOR UPDATE OF application,requirement,profile`,
        [input.applicationIds, pool.id],
      )
    ).rows;
    if (
      selected.length !== input.applicationIds.length ||
      selected.some(
        (row) =>
          row.application_status !== "APPLIED" ||
          row.requirement_status !== "ACTIVE" ||
          row.review_status !== "ACTIVE" ||
          row.catalog_status !== "ACTIVE" ||
          !row.skills_match,
      )
    )
      throw new SelectionPoolError(
        "BUSINESS_RULE_ERROR",
        "A selected player is no longer eligible.",
      );
    const playerIds = selected.map((row) => row.player_user_id);
    if (
      (
        await client.query(
          `SELECT 1 FROM order_participants participant JOIN orders active_order ON active_order.id=participant.order_id WHERE participant.player_id=ANY($1::uuid[]) AND participant.status='ACTIVE' AND active_order.id<>$2 AND active_order.status IN ('PENDING_DISPATCH','ACCEPTED','IN_SERVICE','PENDING_CONFIRMATION','EXCEPTION') LIMIT 1`,
          [playerIds, input.orderId],
        )
      ).rows[0]
    )
      throw new SelectionPoolError(
        "CONFLICT",
        "A selected player already has another active order.",
      );
    const counts = new Map<string, number>();
    for (const row of selected)
      counts.set(row.requirement_id, (counts.get(row.requirement_id) ?? 0) + 1);
    for (const [id, count] of counts) {
      const row = selected.find((item) => item.requirement_id === id)!;
      if ((await this.filled(client, id)) + count > row.requested_player_count)
        throw new SelectionPoolError(
          "CONFLICT",
          "Selected applicants exceed requirement capacity.",
        );
    }
    const participantIds: string[] = [];
    const names: string[] = [];
    for (const row of selected) {
      const participant = finalParticipant(row, input.orderId, input.now);
      participantIds.push(participant.id);
      names.push(row.display_name);
      await client.query(participantInsertSql, participant.values);
      await client.query(
        `UPDATE selection_applications SET status='SELECTED',row_version=row_version+1,decided_at=$2,updated_at=$2 WHERE id=$1`,
        [row.application_id, input.now],
      );
      await this.applicationEvent(
        client,
        {
          ...mapFinalizeApplication(row),
          status: "SELECTED",
          version: row.application_version + 1,
          decidedAt: input.now.toISOString(),
        },
        order.customer_user_id,
        "SELECTED",
        `${input.idempotencyKey}:selected:${row.application_id}`,
        input.now,
      );
    }
    const notSelected = (
      await client.query<SelectionApplicationRow>(
        `${selectionApplicationSelect} WHERE application.selection_pool_id=$1 AND application.status='APPLIED' FOR UPDATE OF application`,
        [pool.id],
      )
    ).rows;
    for (const row of notSelected) {
      const current = mapSelectionApplication(row);
      await client.query(
        `UPDATE selection_applications SET status='NOT_SELECTED',row_version=row_version+1,decided_at=$2,updated_at=$2 WHERE id=$1`,
        [current.id, input.now],
      );
      await this.applicationEvent(
        client,
        {
          ...current,
          status: "NOT_SELECTED",
          version: current.version + 1,
          decidedAt: input.now.toISOString(),
        },
        order.customer_user_id,
        "NOT_SELECTED",
        `${input.idempotencyKey}:not-selected:${current.id}`,
        input.now,
      );
    }
    const invalidated = (
      await client.query<SelectionApplicationRow>(
        `${selectionApplicationSelect} WHERE application.player_user_id=ANY($1::uuid[]) AND application.selection_pool_id<>$2 AND application.status='APPLIED' FOR UPDATE OF application`,
        [playerIds, pool.id],
      )
    ).rows;
    for (const row of invalidated) {
      const current = mapSelectionApplication(row);
      await client.query(
        `UPDATE selection_applications SET status='INVALIDATED',row_version=row_version+1,decided_at=$2,updated_at=$2 WHERE id=$1`,
        [current.id, input.now],
      );
      await this.applicationEvent(
        client,
        {
          ...current,
          status: "INVALIDATED",
          version: current.version + 1,
          decidedAt: input.now.toISOString(),
        },
        order.customer_user_id,
        "INVALIDATED",
        `${input.idempotencyKey}:invalidated:${current.id}`,
        input.now,
      );
    }
    const remaining = await this.remaining(client, input.orderId);
    const status = remaining === 0 ? "ACCEPTED" : "PENDING_DISPATCH";
    const readinessDueAt =
      status === "ACCEPTED"
        ? new Date(input.now.getTime() + 10 * 60_000)
        : null;
    const orderUpdate = await client.query<{ row_version: number }>(
      `UPDATE orders SET status=$3::"OrderStatus",row_version=row_version+1,accepted_at=CASE WHEN $3='ACCEPTED' THEN $4 ELSE accepted_at END,readiness_due_at=CASE WHEN $3='ACCEPTED' THEN $5 ELSE readiness_due_at END,updated_at=$4 WHERE id=$1 AND row_version=$2 RETURNING row_version`,
      [input.orderId, order.row_version, status, input.now, readinessDueAt],
    );
    if (!orderUpdate.rows[0])
      throw new SelectionPoolError("CONFLICT", "Order version is stale.");
    await client.query(
      `UPDATE selection_pools SET status='FINALIZED',row_version=row_version+1,finalized_at=$3,updated_at=$3 WHERE id=$1 AND row_version=$2`,
      [pool.id, pool.version, input.now],
    );
    const updatedPool = await this.selectionPool(
      client,
      input.orderId,
      pool.id,
      false,
    );
    await this.poolEvent(
      client,
      updatedPool,
      orderUpdate.rows[0].row_version,
      order.customer_user_id,
      "FINALIZED",
      input.idempotencyKey,
      input.now,
    );
    for (const participantId of participantIds)
      await client.query(
        `INSERT INTO order_participant_events(id,order_participant_id,sequence,event_type,participant_version,order_version,actor_user_id,reason_code,snapshot,idempotency_key,created_at) SELECT $1,$2,1,'ADDED',1,$3,$4,'CUSTOMER_SELECTION',to_jsonb(participant),$5,$6 FROM order_participants participant WHERE participant.id=$2`,
        [
          crypto.randomUUID(),
          participantId,
          orderUpdate.rows[0].row_version,
          order.customer_user_id,
          `${input.idempotencyKey}:participant:${participantId}`,
          input.now,
        ],
      );
    await this.outbox(
      client,
      updatedPool,
      "SELECTION_POOL_SYNC",
      { orderId: input.orderId, selectionPoolId: pool.id, phase: "FINALIZED" },
      `${input.idempotencyKey}:voice-sync`,
      input.now,
      input.now,
    );
    await client.query(
      `INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at) VALUES($1,'PANEL_SYNC','order',$2,$2,$3,$4,'PENDING',1,0,8,$5,$5,$5)`,
      [
        crypto.randomUUID(),
        input.orderId,
        `${input.idempotencyKey}:panel-sync`,
        {
          kind: "ORDER_SELECTION_FINALIZED_CHANNEL_SYNC",
          orderId: input.orderId,
        },
        input.now,
      ],
    );
    if (readinessDueAt) {
      await client.query(
        `INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at) VALUES($1,'READINESS_TIMEOUT','order',$2,$2,$3,$4,'PENDING',1,0,3,$5,$6,$6)`,
        [
          crypto.randomUUID(),
          input.orderId,
          `${input.idempotencyKey}:readiness-timeout`,
          { orderId: input.orderId, readinessDueAt: readinessDueAt.toISOString() },
          readinessDueAt,
          input.now,
        ],
      );
    }
    return {
      orderId: input.orderId,
      orderStatus: status,
      orderVersion: orderUpdate.rows[0].row_version,
      pool: updatedPool,
      selectedParticipantIds: participantIds,
      selectedDisplayNames: names,
      remainingSlotCount: remaining,
    };
  }

  private async order(
    client: Pick<Pool, "query"> | PoolClient,
    input: CustomerScope,
    lock: boolean,
  ) {
    const row = (
      await client.query<SelectionOrderRow>(
        `SELECT orders.id,orders.status::text,orders.row_version,orders.customer_id customer_user_id,account.discord_user_id customer_discord_user_id FROM orders JOIN discord_accounts account ON account.user_id=orders.customer_id AND account.guild_id=orders.guild_id WHERE orders.id=$1 AND orders.guild_id=$2 ${lock ? "FOR UPDATE OF orders" : ""}`,
        [input.orderId, input.actorGuildId],
      )
    ).rows[0];
    if (!row) throw new SelectionPoolError("NOT_FOUND", "Order was not found.");
    return row;
  }
  private owner(order: SelectionOrderRow, discordId: string) {
    if (order.customer_discord_user_id !== discordId)
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Only the order owner can manage the selection pool.",
      );
  }
  private async selectionPool(
    client: Pick<Pool, "query"> | PoolClient,
    orderId: string,
    poolId: string,
    lock: boolean,
  ) {
    const row = (
      await client.query<SelectionPoolRow>(
        `${selectionPoolSelect} WHERE pool.id=$1 AND pool.order_id=$2 ${lock ? "FOR UPDATE OF pool" : ""}`,
        [poolId, orderId],
      )
    ).rows[0];
    if (!row)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Selection pool was not found.",
      );
    return mapSelectionPool(row);
  }
  private async application(
    client: Pick<Pool, "query"> | PoolClient,
    id: string,
  ) {
    const row = (
      await client.query<SelectionApplicationRow>(
        `${selectionApplicationSelect} WHERE application.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new SelectionPoolError(
        "NOT_FOUND",
        "Selection application was not found.",
      );
    return mapSelectionApplication(row);
  }
  private async filled(client: Pick<Pool, "query"> | PoolClient, id: string) {
    return Number(
      (
        await client.query<{ value: string }>(
          `SELECT count(*)::text value FROM order_participants WHERE order_requirement_id=$1 AND status='ACTIVE'`,
          [id],
        )
      ).rows[0]?.value ?? 0,
    );
  }
  private async remaining(
    client: Pick<Pool, "query"> | PoolClient,
    id: string,
  ) {
    return Number(
      (
        await client.query<{ value: string }>(
          `SELECT COALESCE(SUM(GREATEST(requirement.requested_player_count-COALESCE(filled.count,0),0)),0)::text value FROM order_requirements requirement LEFT JOIN(SELECT order_requirement_id,count(*) count FROM order_participants WHERE status='ACTIVE' GROUP BY order_requirement_id) filled ON filled.order_requirement_id=requirement.id WHERE requirement.order_id=$1 AND requirement.status='ACTIVE'`,
          [id],
        )
      ).rows[0]?.value ?? 0,
    );
  }
  private async poolEvent(
    client: PoolClient,
    pool: SelectionPoolRecord,
    orderVersion: number,
    actorUserId: string,
    eventType: string,
    key: string,
    now: Date,
  ) {
    const seq = Number(
      (
        await client.query<{ value: string }>(
          `SELECT (COALESCE(MAX(sequence),0)+1)::text value FROM selection_pool_events WHERE selection_pool_id=$1`,
          [pool.id],
        )
      ).rows[0]?.value ?? 1,
    );
    await client.query(
      `INSERT INTO selection_pool_events(id,selection_pool_id,sequence,event_type,pool_version,order_version,actor_user_id,snapshot,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        crypto.randomUUID(),
        pool.id,
        seq,
        eventType,
        pool.version,
        orderVersion,
        actorUserId,
        pool,
        key,
        now,
      ],
    );
  }
  private async applicationEvent(
    client: PoolClient,
    application: SelectionApplicationRecord,
    actorUserId: string,
    eventType: string,
    key: string,
    now: Date,
  ) {
    const seq = Number(
      (
        await client.query<{ value: string }>(
          `SELECT (COALESCE(MAX(sequence),0)+1)::text value FROM selection_application_events WHERE selection_application_id=$1`,
          [application.id],
        )
      ).rows[0]?.value ?? 1,
    );
    await client.query(
      `INSERT INTO selection_application_events(id,selection_application_id,sequence,event_type,application_version,actor_user_id,snapshot,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        crypto.randomUUID(),
        application.id,
        seq,
        eventType,
        application.version,
        actorUserId,
        application,
        key,
        now,
      ],
    );
  }
  private async outbox(
    client: PoolClient,
    pool: SelectionPoolRecord,
    type: "SELECTION_POOL_CLOSE" | "SELECTION_POOL_SYNC",
    payload: Record<string, unknown>,
    key: string,
    availableAt: Date,
    createdAt: Date,
  ) {
    await client.query(
      `INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,order_id,selection_pool_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at) VALUES($1,$2,'selection_pool',$3,$4,$3,$5,$6,'PENDING',1,0,8,$7,$8,$8)`,
      [
        crypto.randomUUID(),
        type,
        pool.id,
        pool.orderId,
        key,
        payload,
        availableAt,
        createdAt,
      ],
    );
  }
  private async panelOutbox(
    client: PoolClient,
    orderId: string,
    kind:
      | "ORDER_SELECTION_APPLICATION_CHANNEL_SYNC"
      | "ORDER_SELECTION_WITHDRAWN_CHANNEL_SYNC"
      | "ORDER_SELECTION_CLOSED_CHANNEL_SYNC",
    key: string,
    now: Date,
  ) {
    await client.query(
      `INSERT INTO outbox_events(id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,row_version,attempt_count,max_attempts,available_at,created_at,updated_at) VALUES($1,'PANEL_SYNC','order',$2,$2,$3,$4,'PENDING',1,0,8,$5,$5,$5)`,
      [crypto.randomUUID(), orderId, key, { orderId, kind }, now],
    );
  }
}

interface SelectionOrderRow {
  id: string;
  status: string;
  row_version: number;
  customer_user_id: string;
  customer_discord_user_id: string;
}
interface SelectionPoolRow {
  id: string;
  order_id: string;
  round: number;
  status: SelectionPoolStatus;
  row_version: number;
  wait_minutes: number;
  opened_at: Date | string;
  closes_at: Date | string;
  closed_at: Date | string | null;
  close_reason: SelectionPoolCloseReason | null;
  application_count: string;
}
interface SelectionApplicationRow {
  id: string;
  selection_pool_id: string;
  order_requirement_id: string;
  player_user_id: string;
  actor_discord_user_id: string;
  display_name: string;
  status: SelectionApplicationStatus;
  row_version: number;
  eligibility_snapshot: {
    publicGameTags?: string[];
    publicServiceTags?: string[];
  };
  applied_at: Date | string;
  decided_at: Date | string | null;
}
interface PlayerRequirementRow {
  player_user_id: string;
  display_name: string;
  service_catalog_version_id: string;
  requested_player_count: number;
  public_game_tags: string[] | null;
  public_service_tags: string[] | null;
}
interface FinalizeFactRow {
  application_id: string;
  application_status: SelectionApplicationStatus;
  application_version: number;
  applied_at: Date | string;
  eligibility_snapshot: {
    publicGameTags?: string[];
    publicServiceTags?: string[];
  };
  requirement_id: string;
  requirement_status: string;
  requested_player_count: number;
  player_user_id: string;
  display_name: string;
  review_status: string;
  catalog_status: string;
  skills_match: boolean;
  service_catalog_version_id: string;
  game_code_snapshot: string;
  game_display_name_snapshot: string;
  service_code_snapshot: string;
  service_display_name_snapshot: string;
  region_code_snapshot: string | null;
  region_display_name_snapshot: string | null;
  billing_unit_minutes_snapshot: number;
  unit_count: number;
  customer_unit_price_minor_snapshot: string | number;
  default_player_payout_bps: number;
  compensation_type: "PERCENT_BPS" | "FIXED_MINOR" | null;
  compensation_value: string | number | null;
}

const selectionPoolSelect = `SELECT pool.id,pool.order_id,pool.round,pool.status::text,pool.row_version,pool.wait_minutes,pool.opened_at,pool.closes_at,pool.closed_at,pool.close_reason::text,(SELECT count(*) FROM selection_applications application WHERE application.selection_pool_id=pool.id AND application.status='APPLIED')::text application_count FROM selection_pools pool`;
const selectionApplicationSelect = `SELECT application.id,application.selection_pool_id,application.order_requirement_id,application.player_user_id,account.discord_user_id actor_discord_user_id,users.display_name,application.status::text,application.row_version,application.eligibility_snapshot,application.applied_at,application.decided_at FROM selection_applications application JOIN users ON users.id=application.player_user_id JOIN selection_pools pool ON pool.id=application.selection_pool_id JOIN orders ON orders.id=pool.order_id JOIN discord_accounts account ON account.user_id=application.player_user_id AND account.guild_id=orders.guild_id`;
const playerRequirementSelect = `SELECT users.id player_user_id,users.display_name,requirement.service_catalog_version_id,requirement.requested_player_count,ARRAY(SELECT DISTINCT tag.display_name FROM player_skills skill JOIN skill_tags tag ON tag.id=skill.skill_tag_id WHERE skill.player_profile_id=profile.id AND tag.type='GAME' ORDER BY tag.display_name) public_game_tags,ARRAY(SELECT DISTINCT tag.display_name FROM player_skills skill JOIN skill_tags tag ON tag.id=skill.skill_tag_id WHERE skill.player_profile_id=profile.id AND tag.type='SERVICE' ORDER BY tag.display_name) public_service_tags FROM order_requirements requirement JOIN service_catalog_versions version ON version.id=requirement.service_catalog_version_id JOIN discord_accounts account ON true JOIN users ON users.id=account.user_id JOIN player_profiles profile ON profile.user_id=users.id`;
const finalizeFactSelect = `SELECT application.id application_id,application.status::text application_status,application.row_version application_version,application.applied_at,application.eligibility_snapshot,requirement.id requirement_id,requirement.status::text requirement_status,requirement.requested_player_count,application.player_user_id,users.display_name,profile.review_status::text,version.status::text catalog_status,NOT EXISTS(SELECT 1 FROM service_version_skill_requirements needed WHERE needed.service_catalog_version_id=version.id AND NOT EXISTS(SELECT 1 FROM player_skills skill WHERE skill.player_profile_id=profile.id AND skill.skill_tag_id=needed.skill_tag_id)) skills_match,requirement.service_catalog_version_id,requirement.game_code_snapshot,requirement.game_display_name_snapshot,requirement.service_code_snapshot,requirement.service_display_name_snapshot,requirement.region_code_snapshot,requirement.region_display_name_snapshot,requirement.billing_unit_minutes_snapshot,requirement.unit_count,requirement.customer_unit_price_minor_snapshot,version.default_player_payout_bps,rule.type::text compensation_type,rule.value compensation_value FROM selection_applications application JOIN order_requirements requirement ON requirement.id=application.order_requirement_id JOIN users ON users.id=application.player_user_id JOIN player_profiles profile ON profile.user_id=users.id JOIN service_catalog_versions version ON version.id=requirement.service_catalog_version_id JOIN service_offerings offering ON offering.id=version.service_offering_id LEFT JOIN player_service_compensation_rules rule ON rule.player_id=profile.id AND rule.service_offering_id=offering.id`;
const participantInsertSql = `INSERT INTO order_participants(id,order_id,order_requirement_id,player_id,service_catalog_version_id,status,row_version,player_display_name_snapshot,game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,compensation_type_snapshot,compensation_value_snapshot,compensation_source,expected_earning_minor,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'ACTIVE',1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`;

function mapSelectionPool(row: SelectionPoolRow): SelectionPoolRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    round: Number(row.round),
    status: row.status,
    version: Number(row.row_version),
    waitMinutes: Number(row.wait_minutes),
    openedAt: new Date(row.opened_at).toISOString(),
    closesAt: new Date(row.closes_at).toISOString(),
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    closeReason: row.close_reason,
    applicationCount: Number(row.application_count),
  };
}
function mapSelectionApplication(
  row: SelectionApplicationRow,
): SelectionApplicationRecord {
  return {
    id: row.id,
    selectionPoolId: row.selection_pool_id,
    orderRequirementId: row.order_requirement_id,
    playerId: row.player_user_id,
    playerDisplayName: row.display_name,
    publicGameTags: row.eligibility_snapshot.publicGameTags ?? [],
    publicServiceTags: row.eligibility_snapshot.publicServiceTags ?? [],
    status: row.status,
    version: Number(row.row_version),
    appliedAt: new Date(row.applied_at).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
  };
}
function mapFinalizeApplication(
  row: FinalizeFactRow,
): SelectionApplicationRecord {
  return {
    id: row.application_id,
    selectionPoolId: "",
    orderRequirementId: row.requirement_id,
    playerId: row.player_user_id,
    playerDisplayName: row.display_name,
    publicGameTags: row.eligibility_snapshot.publicGameTags ?? [],
    publicServiceTags: row.eligibility_snapshot.publicServiceTags ?? [],
    status: row.application_status,
    version: Number(row.application_version),
    appliedAt: new Date(row.applied_at).toISOString(),
    decidedAt: null,
  };
}
function finalParticipant(row: FinalizeFactRow, orderId: string, now: Date) {
  const unitPrice = safeSelectionMinor(row.customer_unit_price_minor_snapshot);
  const linePrice = unitPrice * Number(row.unit_count);
  if (!Number.isSafeInteger(linePrice))
    throw new SelectionPoolError(
      "BUSINESS_RULE_ERROR",
      "Participant price is outside the supported range.",
    );
  const type = row.compensation_type ?? "PERCENT_BPS";
  const value =
    row.compensation_value === null
      ? safeSelectionMinor(row.default_player_payout_bps)
      : safeSelectionMinor(row.compensation_value);
  const earning =
    type === "PERCENT_BPS"
      ? Math.floor((linePrice * value) / 10_000)
      : value * Number(row.unit_count);
  if (!Number.isSafeInteger(earning) || earning < 0 || earning > linePrice)
    throw new SelectionPoolError(
      "BUSINESS_RULE_ERROR",
      "Player compensation exceeds the line price.",
    );
  const id = crypto.randomUUID();
  return {
    id,
    values: [
      id,
      orderId,
      row.requirement_id,
      row.player_user_id,
      row.service_catalog_version_id,
      row.display_name,
      row.game_code_snapshot,
      row.game_display_name_snapshot,
      row.service_code_snapshot,
      row.service_display_name_snapshot,
      row.region_code_snapshot,
      row.region_display_name_snapshot,
      Number(row.billing_unit_minutes_snapshot),
      Number(row.unit_count),
      unitPrice,
      linePrice,
      type,
      value,
      row.compensation_type ? "PLAYER_OVERRIDE" : "CATALOG_DEFAULT",
      earning,
      now,
    ],
  };
}
function safeSelectionMinor(value: string | number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new SelectionPoolError(
      "BUSINESS_RULE_ERROR",
      "Stored money is invalid.",
    );
  return parsed;
}
function normalizeSelectionPgError(error: unknown) {
  if (error instanceof SelectionPoolError) return error;
  const code = (error as { code?: string })?.code;
  if (code === "23505" || code === "40001" || code === "40P01")
    return new SelectionPoolError(
      "CONFLICT",
      "Selection pool changed concurrently.",
    );
  if (code === "23503" || code === "23514" || code === "22P02")
    return new SelectionPoolError(
      "BUSINESS_RULE_ERROR",
      "Selection pool data is no longer valid.",
    );
  return error;
}

export function registerSelectionPoolRoutes(
  server: FastifyInstance,
  options: { store: SelectionPoolStore; now?: () => Date },
): void {
  if (!server.securityOptions)
    throw new Error("Selection pool routes require security options.");
  const security = server.securityOptions;
  const now = options.now ?? (() => new Date());
  const actorScope = (request: FastifyRequest, actor: ActorContext) => {
    if (!actor.guildId || !actor.discordUserId)
      throw new SelectionPoolError(
        "PERMISSION_DENIED",
        "Discord actor context is required.",
      );
    return {
      orderId: parameter(request, "orderId"),
      actorGuildId: actor.guildId,
      actorDiscordUserId: actor.discordUserId,
    };
  };
  const poolScope = (request: FastifyRequest, actor: ActorContext) => ({
    ...actorScope(request, actor),
    selectionPoolId: parameter(request, "selectionPoolId"),
  });
  registerSecureReadRoute(server, security, {
    method: "GET",
    url: "/api/v1/orders/:orderId/selection-pools/current",
    permission: "order.selection_pool.read",
    action: "GET_CURRENT_ORDER_SELECTION_POOL",
    targetType: "selection_pool",
    acceptedSources: ["DISCORD_BOT"],
    handler: (request, actor) =>
      options.store.getCurrentPool(actorScope(request, actor)),
    mapError,
  });
  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/orders/:orderId/selection-pools",
    permission: "order.selection_pool.create",
    action: "CREATE_ORDER_SELECTION_POOL",
    targetType: "selection_pool",
    successStatusCode: 201,
    acceptedSources: ["DISCORD_BOT"],
    handler: (request, actor) =>
      options.store.createPool({
        ...actorScope(request, actor),
        ...parseCreate(request.body),
        idempotencyKey: idempotencyKey(request),
        now: now(),
      }),
    mapError,
  });
  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/orders/:orderId/selection-pools/:selectionPoolId/applications",
    permission: "order.selection_pool.apply",
    action: "APPLY_ORDER_SELECTION_POOL",
    targetType: "selection_application",
    successStatusCode: 201,
    acceptedSources: ["DISCORD_BOT"],
    handler: (request, actor) =>
      options.store.apply({
        ...poolScope(request, actor),
        ...parseApply(request.body),
        idempotencyKey: idempotencyKey(request),
        now: now(),
      }),
    mapError,
  });
  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/orders/:orderId/selection-pools/:selectionPoolId/applications/:applicationId/withdraw",
    permission: "order.selection_pool.apply",
    action: "WITHDRAW_ORDER_SELECTION_APPLICATION",
    targetType: "selection_application",
    targetId: (request) => parameter(request, "applicationId"),
    acceptedSources: ["DISCORD_BOT"],
    handler: (request, actor) =>
      options.store.withdraw({
        ...poolScope(request, actor),
        applicationId: parameter(request, "applicationId"),
        ...parseVersionPair(request.body),
        idempotencyKey: idempotencyKey(request),
        now: now(),
      }),
    mapError,
  });
  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/orders/:orderId/selection-pools/:selectionPoolId/close",
    permission: "order.selection_pool.close",
    action: "CLOSE_ORDER_SELECTION_POOL",
    targetType: "selection_pool",
    targetId: (request) => parameter(request, "selectionPoolId"),
    acceptedSources: ["DISCORD_BOT"],
    handler: (request, actor) =>
      options.store.closePool({
        ...poolScope(request, actor),
        ...parseClose(request.body),
        idempotencyKey: idempotencyKey(request),
        now: now(),
      }),
    mapError,
  });
  registerSecureReadRoute(server, security, {
    method: "GET",
    url: "/api/v1/orders/:orderId/selection-pools/:selectionPoolId/applications",
    permission: "order.selection_pool.read",
    action: "LIST_ORDER_SELECTION_APPLICATIONS",
    targetType: "selection_pool",
    acceptedSources: ["DISCORD_BOT", "DASHBOARD"],
    handler: (request, actor) =>
      options.store.listApplications({
        ...poolScope(request, actor),
        actorStaffId: actor.actorStaffId,
        ...page(request),
      }),
    mapError,
  });
  registerSecureWriteRoute(server, security, {
    method: "POST",
    url: "/api/v1/orders/:orderId/selection-pools/:selectionPoolId/finalize",
    permission: "order.selection_pool.finalize",
    action: "FINALIZE_ORDER_SELECTION_POOL",
    targetType: "selection_pool",
    targetId: (request) => parameter(request, "selectionPoolId"),
    acceptedSources: ["DISCORD_BOT"],
    handler: (request, actor) =>
      options.store.finalize({
        ...poolScope(request, actor),
        ...parseFinalize(request.body),
        idempotencyKey: idempotencyKey(request),
        now: now(),
      }),
    mapError,
  });
}

function buildParticipant(
  application: SelectionApplicationRecord,
  requirement: SelectionRequirement,
  player: SelectionPlayer,
  now: Date,
): SelectedParticipant {
  const earning =
    player.compensationType === "PERCENT_BPS"
      ? Math.floor(
          (requirement.linePriceMinor * player.compensationValue) / 10_000,
        )
      : player.compensationValue * requirement.unitCount;
  if (
    !Number.isSafeInteger(earning) ||
    earning < 0 ||
    earning > requirement.linePriceMinor
  )
    throw new SelectionPoolError(
      "BUSINESS_RULE_ERROR",
      "Player compensation exceeds the line price.",
    );
  return {
    id: crypto.randomUUID(),
    orderId: requirement.orderId,
    orderRequirementId: requirement.id,
    playerId: player.id,
    playerDisplayName: application.playerDisplayName,
    serviceCatalogVersionId: requirement.serviceCatalogVersionId,
    linePriceMinor: requirement.linePriceMinor,
    expectedEarningMinor: earning,
    createdAt: now.toISOString(),
  };
}
function parseCreate(value: unknown) {
  const body = strict(value, ["expectedOrderVersion", "waitMinutes"]);
  return {
    expectedOrderVersion: version(
      body.expectedOrderVersion,
      "expectedOrderVersion",
    ),
    waitMinutes: wholeNumber(body.waitMinutes, "waitMinutes", 1, 30),
  };
}
function parseApply(value: unknown) {
  const body = strict(value, ["expectedPoolVersion", "orderRequirementId"]);
  return {
    expectedPoolVersion: version(
      body.expectedPoolVersion,
      "expectedPoolVersion",
    ),
    orderRequirementId: uuid(body.orderRequirementId, "orderRequirementId"),
  };
}
function parseVersionPair(value: unknown) {
  const body = strict(value, [
    "expectedPoolVersion",
    "expectedApplicationVersion",
  ]);
  return {
    expectedPoolVersion: version(
      body.expectedPoolVersion,
      "expectedPoolVersion",
    ),
    expectedApplicationVersion: version(
      body.expectedApplicationVersion,
      "expectedApplicationVersion",
    ),
  };
}
function parseClose(
  value: unknown,
): Pick<CloseSelectionPoolInput, "expectedPoolVersion" | "reason"> {
  const body = strict(value, ["expectedPoolVersion", "reason"]);
  if (body.reason !== "TIME_ELAPSED" && body.reason !== "CUSTOMER_EARLY_CLOSE")
    throw new SelectionPoolError("VALIDATION_ERROR", "reason is invalid.");
  return {
    expectedPoolVersion: version(
      body.expectedPoolVersion,
      "expectedPoolVersion",
    ),
    reason: body.reason,
  };
}
function parseFinalize(value: unknown) {
  const body = strict(value, [
    "expectedOrderVersion",
    "expectedPoolVersion",
    "applicationIds",
  ]);
  if (
    !Array.isArray(body.applicationIds) ||
    body.applicationIds.length < 1 ||
    new Set(body.applicationIds).size !== body.applicationIds.length
  )
    throw new SelectionPoolError(
      "VALIDATION_ERROR",
      "applicationIds must contain unique values.",
    );
  return {
    expectedOrderVersion: version(
      body.expectedOrderVersion,
      "expectedOrderVersion",
    ),
    expectedPoolVersion: version(
      body.expectedPoolVersion,
      "expectedPoolVersion",
    ),
    applicationIds: body.applicationIds.map((item) =>
      uuid(item, "applicationIds"),
    ),
  };
}
function strict(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SelectionPoolError(
      "VALIDATION_ERROR",
      "Object payload is required.",
    );
  const body = value as Record<string, unknown>;
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new SelectionPoolError(
      "VALIDATION_ERROR",
      `Unexpected fields: ${extra.join(", ")}.`,
    );
  return body;
}
function version(value: unknown, field: string) {
  return wholeNumber(value, field, 1, Number.MAX_SAFE_INTEGER);
}
function wholeNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new SelectionPoolError("VALIDATION_ERROR", `${field} is invalid.`);
  return Number(value);
}
function uuid(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw new SelectionPoolError("VALIDATION_ERROR", `${field} is invalid.`);
  return value;
}
function parameter(request: FastifyRequest, name: string) {
  return uuid((request.params as Record<string, unknown>)[name], name);
}
function idempotencyKey(request: FastifyRequest) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 200)
    throw new SelectionPoolError(
      "VALIDATION_ERROR",
      "Idempotency-Key is invalid.",
    );
  return value;
}
function page(request: FastifyRequest) {
  const query = request.query as Record<string, unknown>;
  const limit =
    query.limit === undefined
      ? 25
      : wholeNumber(Number(query.limit), "limit", 1, 100);
  return {
    cursor:
      typeof query.cursor === "string" && query.cursor ? query.cursor : null,
    limit,
  };
}
function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ v: 1, offset })).toString("base64url");
}
function decodeCursor(cursor: string | null) {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      v?: unknown;
      offset?: unknown;
    };
    if (
      value.v !== 1 ||
      !Number.isSafeInteger(value.offset) ||
      Number(value.offset) < 0
    )
      throw new Error();
    return Number(value.offset);
  } catch {
    throw new SelectionPoolError("VALIDATION_ERROR", "Cursor is invalid.");
  }
}
function mapError(error: unknown) {
  if (!(error instanceof SelectionPoolError)) return null;
  return {
    statusCode:
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "PERMISSION_DENIED"
          ? 403
          : error.code === "CONFLICT"
            ? 409
            : error.code === "BUSINESS_RULE_ERROR"
              ? 422
              : 400,
    code: error.code,
    message: error.message,
  };
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
