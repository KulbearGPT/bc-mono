import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { OutboxJob } from './outbox.js';
import { enqueueTerminalChannelArchive } from './order-channel-cleanup.js';
import { registerSecureWriteRoute } from './security.js';
import { calculateReferralCommissionMinor, createEligibleReferralCommission } from './referrals.js';

export type LifecycleOrderStatus = 'ACCEPTED' | 'IN_SERVICE' | 'PENDING_CONFIRMATION' | 'COMPLETED' | 'CANCELLED' | 'EXCEPTION';
export type ReadinessValue = 'READY' | 'NOT_READY';
export type OrderParticipantRole = 'CUSTOMER' | 'PLAYER';

export interface ServiceLifecycleOrderRecord {
  id: string;
  publicId: string;
  customerId: string;
  playerId: string;
  status: LifecycleOrderStatus;
  version: number;
  currency: string;
  amountMinor: number;
  playerEarningMinor: number;
  unitCount?: number | null;
  playerUnitPayoutMinor?: number | null;
  channelId: string;
  panelMessageId: string;
  voiceChannelId: string | null;
  readinessDueAt: string | null;
  customerReadyAt: string | null;
  playerReadyAt: string | null;
  serviceStartedAt: string | null;
  completionRequestedAt: string | null;
  confirmationDueAt: string | null;
  automationState?: 'RUNNING' | 'PAUSED';
  automationScope?: 'ALL' | 'DISPATCH' | 'LIFECYCLE' | 'CANCELLATION' | null;
  updatedAt: string;
  participants?: ServiceLifecycleParticipant[];
}
export interface ServiceLifecycleParticipant {
  id: string;
  playerId: string;
  displayName: string;
  readyAt: string | null;
  unitCount: number;
  expectedEarningMinor: number;
  customerUnitPriceMinor: number;
  linePriceMinor: number;
  version: number;
}

export interface ServiceLifecycleDiscordAccount {
  guildId: string;
  discordUserId: string;
  userId: string;
}

export interface OrderReadinessResult {
  orderId: string;
  publicId: string;
  status: LifecycleOrderStatus;
  version: number;
  actorRole: OrderParticipantRole;
  readiness: {
    participants: Array<{ participantId: string; playerId: string; displayName: string; readiness: ReadinessValue }>;
    allActivePlayersReady: boolean;
    readyDeadlineAt: string | null;
    startedAt: string | null;
    staffTaskId: string | null;
  };
}

export interface CompletionRequestResult {
  orderId: string;
  publicId: string;
  status: 'PENDING_CONFIRMATION';
  version: number;
  actorRole: 'PLAYER';
  confirmationDueAt: string;
}

export interface ServiceLifecycleStaffTask {
  id: string;
  publicId: string;
  type: 'ORDER_ASSIST' | 'COMPLETION_REVIEW';
  reasonCode: 'READINESS_TIMEOUT' | 'COMPLETION_CONFIRMATION_TIMEOUT';
  status: 'OPEN' | 'CLAIMED' | 'VERIFIED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'RESOLVED' | 'CANCELLED';
}

export interface ServiceLifecycleReferralAttribution {
  id: string;
  beneficiaryUserId: string;
  referredUserId: string;
  programType: 'PROMOTER_FIRST_PURCHASE' | 'PLAYER_LIFETIME';
  programVersion: number;
  awardMode: 'FIXED_MINOR' | 'NET_SPEND_BPS';
  fixedAmountMinor: number | null;
  rateBps: number | null;
  currency: string;
  eligibleOrderSpend: boolean;
}

export interface CompletionTimeoutResult {
  orderId: string;
  status: 'PENDING_CONFIRMATION';
  version: number;
  staffTask: ServiceLifecycleStaffTask;
}

export type ReadinessTimeoutResult =
  | {
    outcome: 'ESCALATED';
    orderId: string;
    status: 'ACCEPTED';
    version: number;
    readiness: {
      customer: ReadinessValue;
      player: ReadinessValue;
      participants: Array<{ participantId: string; displayName: string; readiness: ReadinessValue }>;
      allActivePlayersReady: boolean;
    };
    staffTask: ServiceLifecycleStaffTask;
  }
  | {
    outcome: 'SKIPPED';
    orderId: string;
    status: LifecycleOrderStatus;
    version: number;
    staffTask: null;
  };

export interface OrderCompletionResult {
  orderId: string;
  publicId: string;
  status: 'COMPLETED';
  version: number;
  capturedMinor: number;
  playerEarningMinor: number;
  currency: string;
}

export interface ServiceLifecycleStore {
  getOrder(orderId: string): Promise<ServiceLifecycleOrderRecord | null> | ServiceLifecycleOrderRecord | null;
  resolveDiscordUser(input: { guildId: string; discordUserId: string }): Promise<string | null> | string | null;
  commitReadiness(input: {
    orderId: string;
    expectedVersion: number;
    actorUserId: string;
    readiness: ReadinessValue;
    now: Date;
  }): Promise<OrderReadinessResult> | OrderReadinessResult;
  commitCompletionRequest(input: {
    orderId: string;
    expectedVersion: number;
    actorUserId: string;
    now: Date;
  }): Promise<CompletionRequestResult> | CompletionRequestResult;
  commitOrderConfirmation(input: {
    orderId: string;
    expectedVersion: number;
    confirmation: 'CONFIRM_COMPLETED';
    actorUserId: string;
    idempotencyKey: string;
    referralsEnabled?: boolean;
    now: Date;
  }): Promise<OrderCompletionResult> | OrderCompletionResult;
  commitCompletionTimeout(input: {
    orderId: string;
    now: Date;
  }): Promise<CompletionTimeoutResult> | CompletionTimeoutResult;
  commitReadinessTimeout(input: { orderId: string; now: Date }): Promise<ReadinessTimeoutResult> | ReadinessTimeoutResult;
}

export interface ServiceLifecycleQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export interface ServiceLifecycleTransactionClient extends ServiceLifecycleQueryClient {
  release(): void;
}

export interface ServiceLifecyclePool extends ServiceLifecycleQueryClient {
  connect(): Promise<ServiceLifecycleTransactionClient>;
}

export class ServiceLifecycleError extends Error {
  readonly code: 'CONFLICT' | 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR';

  constructor(code: ServiceLifecycleError['code'], message: string) {
    super(message);
    this.name = 'ServiceLifecycleError';
    this.code = code;
  }
}

export class InMemoryServiceLifecycleStore implements ServiceLifecycleStore {
  readonly orders: ServiceLifecycleOrderRecord[];
  readonly consumptionEntries: Array<{ orderId: string; amountMinor: number; currency: string }> = [];
  readonly playerEarnings: Array<{
    orderId: string;
    orderParticipantId?: string;
    playerUserId: string;
    amountMinor: number;
    currency: string;
  }> = [];
  readonly staffTasks: ServiceLifecycleStaffTask[] = [];
  readonly commissions: Array<{
    orderId: string;
    referralAttributionId: string;
    beneficiaryUserId: string;
    baseAmountMinor: number;
    amountMinor: number;
    currency: string;
    status: 'PENDING';
  }> = [];
  private readonly discordAccounts: ServiceLifecycleDiscordAccount[];
  private readonly referralAttributions: ServiceLifecycleReferralAttribution[];

  constructor(input: {
    orders: ServiceLifecycleOrderRecord[];
    discordAccounts: ServiceLifecycleDiscordAccount[];
    referralAttributions?: ServiceLifecycleReferralAttribution[];
  }) {
    this.orders = input.orders.map(clone);
    this.discordAccounts = input.discordAccounts.map(clone);
    this.referralAttributions = (input.referralAttributions ?? []).map(clone);
  }

  getOrder(orderId: string): ServiceLifecycleOrderRecord | null {
    const order = this.orders.find((candidate) => candidate.id === orderId);
    return order ? clone(order) : null;
  }

  resolveDiscordUser(input: { guildId: string; discordUserId: string }): string | null {
    return this.discordAccounts.find((account) => {
      return account.guildId === input.guildId && account.discordUserId === input.discordUserId;
    })?.userId ?? null;
  }

  commitReadiness(input: {
    orderId: string;
    expectedVersion: number;
    actorUserId: string;
    readiness: ReadinessValue;
    now: Date;
  }): OrderReadinessResult {
    const index = this.orders.findIndex((candidate) => candidate.id === input.orderId);
    const order = index === -1 ? null : this.orders[index];
    if (!order) {
      throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
    }
    if (order.status !== 'ACCEPTED') {
      throw new ServiceLifecycleError('CONFLICT', 'Readiness can only be changed before service starts.');
    }
    if (order.version !== input.expectedVersion) {
      throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
    }
    const actorRole = requireParticipantRole(order, input.actorUserId);
    if (actorRole !== 'PLAYER') {
      throw new ServiceLifecycleError('PERMISSION_DENIED', 'Customers do not submit readiness.');
    }
    const readyAt = input.readiness === 'READY' ? input.now.toISOString() : null;
    const participant = order.participants?.find((item) => item.playerId === input.actorUserId);
    if (order.participants?.length && !participant) {
      throw new ServiceLifecycleError('PERMISSION_DENIED', 'Actor is not an active player on this order.');
    }
    const participants = order.participants?.map((item) => item.id === participant?.id
      ? { ...item, readyAt, version: item.version + 1 }
      : item);
    const allPlayersReady = participants?.every((item) => Boolean(item.readyAt)) ?? false;
    const updated: ServiceLifecycleOrderRecord = {
      ...order,
      version: order.version + 1,
      customerReadyAt: participants?.length
        ? (allPlayersReady ? order.customerReadyAt ?? input.now.toISOString() : order.customerReadyAt)
        : readyAt,
      playerReadyAt: participants?.length
        ? (allPlayersReady ? input.now.toISOString() : null)
        : readyAt,
      participants,
      updatedAt: input.now.toISOString()
    };
    if (participants?.length ? allPlayersReady : updated.customerReadyAt && updated.playerReadyAt) {
      updated.status = 'IN_SERVICE';
      updated.serviceStartedAt = input.now.toISOString();
    }
    this.orders[index] = updated;
    return toReadinessResult(updated, actorRole);
  }

  commitCompletionRequest(input: {
    orderId: string;
    expectedVersion: number;
    actorUserId: string;
    now: Date;
  }): CompletionRequestResult {
    const index = this.orders.findIndex((candidate) => candidate.id === input.orderId);
    const order = index === -1 ? null : this.orders[index];
    if (!order) {
      throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
    }
    if (order.status !== 'IN_SERVICE') {
      throw new ServiceLifecycleError('CONFLICT', 'Completion can only be requested while service is in progress.');
    }
    if (order.version !== input.expectedVersion) {
      throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
    }
    const actorRole = requireParticipantRole(order, input.actorUserId);
    if (actorRole !== 'PLAYER') {
      throw new ServiceLifecycleError('PERMISSION_DENIED', 'Only the assigned player can request completion.');
    }
    const confirmationDueAt = new Date(input.now.getTime() + 30 * 60_000).toISOString();
    const updated: ServiceLifecycleOrderRecord = {
      ...order,
      status: 'PENDING_CONFIRMATION',
      version: order.version + 1,
      completionRequestedAt: input.now.toISOString(),
      confirmationDueAt,
      updatedAt: input.now.toISOString()
    };
    this.orders[index] = updated;
    return {
      orderId: updated.id,
      publicId: updated.publicId,
      status: 'PENDING_CONFIRMATION',
      version: updated.version,
      actorRole,
      confirmationDueAt
    };
  }

  commitOrderConfirmation(input: {
    orderId: string;
    expectedVersion: number;
    confirmation: 'CONFIRM_COMPLETED';
    actorUserId: string;
    idempotencyKey: string;
    referralsEnabled?: boolean;
    now: Date;
  }): OrderCompletionResult {
    const index = this.orders.findIndex((candidate) => candidate.id === input.orderId);
    const order = index === -1 ? null : this.orders[index];
    if (!order) {
      throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
    }
    if (order.status !== 'PENDING_CONFIRMATION') {
      throw new ServiceLifecycleError('CONFLICT', 'Order is not waiting for completion confirmation.');
    }
    if (order.version !== input.expectedVersion) {
      throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
    }
    const actorRole = requireParticipantRole(order, input.actorUserId);
    if (actorRole !== 'CUSTOMER') {
      throw new ServiceLifecycleError('PERMISSION_DENIED', 'Only the customer can confirm completion.');
    }
    if (order.participants?.some((participant) => !participant.readyAt)) {
      throw new ServiceLifecycleError('CONFLICT', 'Every active player must be ready before completion can be captured.');
    }
    const updated: ServiceLifecycleOrderRecord = {
      ...order,
      status: 'COMPLETED',
      version: order.version + 1,
      updatedAt: input.now.toISOString()
    };
    this.orders[index] = updated;
    this.consumptionEntries.push({ orderId: order.id, amountMinor: order.amountMinor, currency: order.currency });
    if (order.participants?.length) {
      for (const participant of order.participants) {
        this.playerEarnings.push({
          orderId: order.id,
          orderParticipantId: participant.id,
          playerUserId: participant.playerId,
          amountMinor: participant.expectedEarningMinor,
          currency: order.currency
        });
      }
    } else {
      this.playerEarnings.push({
        orderId: order.id,
        playerUserId: order.playerId,
        amountMinor: order.playerEarningMinor,
        currency: order.currency
      });
    }
    for (const attribution of (input.referralsEnabled !== false ? this.referralAttributions : []).filter((candidate) => {
      return candidate.referredUserId === order.customerId
        && candidate.currency === order.currency
        && candidate.eligibleOrderSpend;
    })) {
      const amountMinor = calculateReferralCommissionMinor({
        baseAmountMinor: order.amountMinor,
        fixedAmountMinor: attribution.fixedAmountMinor,
        rateBps: attribution.rateBps,
        awardMode: attribution.awardMode
      });
      if (amountMinor > 0) {
        this.commissions.push({
          orderId: order.id,
          referralAttributionId: attribution.id,
          beneficiaryUserId: attribution.beneficiaryUserId,
          baseAmountMinor: order.amountMinor,
          amountMinor,
          currency: order.currency,
          status: 'PENDING'
        });
      }
    }
    return {
      orderId: updated.id,
      publicId: updated.publicId,
      status: 'COMPLETED',
      version: updated.version,
      capturedMinor: order.amountMinor,
      playerEarningMinor: order.playerEarningMinor,
      currency: order.currency
    };
  }

  commitCompletionTimeout(input: { orderId: string; now: Date }): CompletionTimeoutResult {
    const order = this.orders.find((candidate) => candidate.id === input.orderId);
    if (!order) {
      throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
    }
    if (isLifecycleAutomationPaused(order)) {
      throw new ServiceLifecycleError('CONFLICT', 'Order automation is paused for staff takeover.');
    }
    if (order.status !== 'PENDING_CONFIRMATION') {
      throw new ServiceLifecycleError('CONFLICT', 'Order is not waiting for completion confirmation.');
    }
    if (!order.confirmationDueAt || Date.parse(order.confirmationDueAt) > input.now.getTime()) {
      throw new ServiceLifecycleError('CONFLICT', 'Completion confirmation is not overdue.');
    }
    const existing = this.staffTasks.find((task) => {
      return task.type === 'COMPLETION_REVIEW' && task.reasonCode === 'COMPLETION_CONFIRMATION_TIMEOUT';
    });
    const staffTask = existing ?? {
      id: `staff-task:${order.id}:completion-timeout`,
      publicId: `TASK-${order.publicId}-COMP`,
      type: 'COMPLETION_REVIEW' as const,
      reasonCode: 'COMPLETION_CONFIRMATION_TIMEOUT' as const,
      status: 'OPEN' as const
    };
    if (!existing) {
      this.staffTasks.push(staffTask);
    }
    return {
      orderId: order.id,
      status: 'PENDING_CONFIRMATION',
      version: order.version,
      staffTask
    };
  }

  commitReadinessTimeout(input: { orderId: string; now: Date }): ReadinessTimeoutResult {
    const index = this.orders.findIndex((candidate) => candidate.id === input.orderId);
    const order = index === -1 ? null : this.orders[index];
    if (!order) {
      throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
    }
    if (isLifecycleAutomationPaused(order)) {
      return { outcome: 'SKIPPED', orderId: order.id, status: order.status, version: order.version, staffTask: null };
    }
    if (order.status !== 'ACCEPTED') {
      return { outcome: 'SKIPPED', orderId: order.id, status: order.status, version: order.version, staffTask: null };
    }
    if (!order.readinessDueAt || Date.parse(order.readinessDueAt) > input.now.getTime()) {
      throw new ServiceLifecycleError('CONFLICT', 'Readiness is not overdue.');
    }
    const participants = order.participants ?? [];
    const allActivePlayersReady = participants.length > 0
      ? participants.every((participant) => Boolean(participant.readyAt))
      : Boolean(order.customerReadyAt && order.playerReadyAt);
    if (allActivePlayersReady) {
      return { outcome: 'SKIPPED', orderId: order.id, status: order.status, version: order.version, staffTask: null };
    }
    const taskId = `staff-task:${order.id}:readiness-timeout`;
    const existing = this.staffTasks.find((task) => task.id === taskId);
    const staffTask = existing ?? {
      id: taskId,
      publicId: `TASK-${order.publicId}-READY`,
      type: 'ORDER_ASSIST' as const,
      reasonCode: 'READINESS_TIMEOUT' as const,
      status: 'OPEN' as const
    };
    if (!existing) {
      this.staffTasks.push(staffTask);
      this.orders[index] = { ...order, version: order.version + 1, updatedAt: input.now.toISOString() };
    }
    const current = this.orders[index]!;
    return {
      outcome: 'ESCALATED',
      orderId: current.id,
      status: 'ACCEPTED',
      version: current.version,
      readiness: {
        customer: current.customerReadyAt ? 'READY' : 'NOT_READY',
        player: current.playerReadyAt ? 'READY' : 'NOT_READY',
        participants: participants.map((participant) => ({
          participantId: participant.id,
          displayName: participant.displayName,
          readiness: participant.readyAt ? 'READY' : 'NOT_READY'
        })),
        allActivePlayersReady
      },
      staffTask
    };
  }
}

export class PostgresServiceLifecycleStore implements ServiceLifecycleStore {
  private readonly client: ServiceLifecycleQueryClient;
  private readonly pool: ServiceLifecyclePool | null;

  constructor(input: { pool?: Pool; client?: ServiceLifecycleQueryClient }) {
    const client = input.pool ?? input.client;
    if (!client) {
      throw new ServiceLifecycleError('VALIDATION_ERROR', 'PostgresServiceLifecycleStore requires a pool or client.');
    }
    this.client = client;
    this.pool = input.pool ?? null;
  }

  async getOrder(orderId: string): Promise<ServiceLifecycleOrderRecord | null> {
    const result = await this.client.query<ServiceLifecycleOrderRow>(
      `
SELECT *
FROM orders
WHERE id = $1
LIMIT 1
      `,
      [orderId]
    );
    if (!result.rows[0]) {
      return null;
    }
    const order = mapOrderRow(result.rows[0]);
    order.participants = await loadActiveLifecycleParticipants(this.client, orderId);
    return order;
  }

  async resolveDiscordUser(input: { guildId: string; discordUserId: string }): Promise<string | null> {
    const result = await this.client.query<{ user_id: string }>(
      `
SELECT user_id
FROM discord_accounts
WHERE guild_id = $1
  AND discord_user_id = $2
LIMIT 1
      `,
      [input.guildId, input.discordUserId]
    );
    return result.rows[0]?.user_id ?? null;
  }

  async commitReadiness(input: {
    orderId: string;
    expectedVersion: number;
    actorUserId: string;
    readiness: ReadinessValue;
    now: Date;
  }): Promise<OrderReadinessResult> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const current = await lockOrder(transactionClient, input.orderId);
      if (!current) {
        throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
      }
      if (isLifecycleAutomationPaused(current)) {
        throw new ServiceLifecycleError('CONFLICT', 'Order automation is paused for staff takeover.');
      }
      if (current.status !== 'ACCEPTED') {
        throw new ServiceLifecycleError('CONFLICT', 'Readiness can only be changed before service starts.');
      }
      if (current.version !== input.expectedVersion) {
        throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
      }
      const participants = await loadActiveLifecycleParticipants(transactionClient, input.orderId, true);
      if (participants.length > 0) {
        const participant = participants.find((candidate) => candidate.playerId === input.actorUserId);
        if (!participant) {
          throw new ServiceLifecycleError('PERMISSION_DENIED', 'Only an active player on this order can confirm readiness.');
        }
        const readyAt = readinessTimestamp(input.readiness, input.now);
        const updatedParticipant = await transactionClient.query<{ row_version: number }>(
          `UPDATE order_participants
           SET ready_at=$3,row_version=row_version+1,updated_at=$4
           WHERE id=$1 AND row_version=$2 AND status='ACTIVE'
           RETURNING row_version`,
          [participant.id, participant.version, readyAt, input.now.toISOString()]
        );
        if (!updatedParticipant.rows[0]) {
          throw new ServiceLifecycleError('CONFLICT', 'Order participant version is stale.');
        }
        participant.readyAt = readyAt;
        participant.version = updatedParticipant.rows[0].row_version;
        await insertOrderParticipantReadinessEvent(transactionClient, {
          orderId: input.orderId,
          orderParticipantId: participant.id,
          participantVersion: participant.version,
          orderVersion: current.version + 1,
          actorUserId: input.actorUserId,
          readiness: input.readiness,
          now: input.now
        });
        const shouldStart = participants.every((candidate) => Boolean(candidate.readyAt));
        const sequence = await nextOrderEventSequence(transactionClient, input.orderId);
        await insertOrderEvent(transactionClient, {
          orderId: input.orderId,
          sequence,
          eventType: 'PLAYER_READY_CONFIRMED',
          fromStatus: current.status,
          toStatus: current.status,
          actorUserId: input.actorUserId,
          now: input.now,
          payload: { readiness: input.readiness, actorRole: 'PLAYER', orderParticipantId: participant.id }
        });
        if (shouldStart) {
          await insertOrderEvent(transactionClient, {
            orderId: input.orderId,
            sequence: sequence + 1,
            eventType: 'SERVICE_STARTED',
            fromStatus: 'ACCEPTED',
            toStatus: 'IN_SERVICE',
            actorUserId: input.actorUserId,
            now: input.now,
            payload: { activeParticipantIds: participants.map((candidate) => candidate.id) }
          });
        }
        const updated = await transactionClient.query<ServiceLifecycleOrderRow>(
          `UPDATE orders
           SET status=CASE WHEN $4 THEN 'IN_SERVICE'::"OrderStatus" ELSE status END,
               row_version=row_version+1,
               customer_ready_at=CASE WHEN $4 THEN COALESCE(customer_ready_at,$3) ELSE customer_ready_at END,
               player_ready_at=CASE WHEN $4 THEN $3 ELSE NULL END,
               service_started_at=CASE WHEN $4 THEN COALESCE(service_started_at,$3) ELSE service_started_at END,
               updated_at=$3
           WHERE id=$1 AND status='ACCEPTED' AND row_version=$2
           RETURNING *`,
          [input.orderId, input.expectedVersion, input.now.toISOString(), shouldStart]
        );
        const row = updated.rows[0];
        if (!row) {
          throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
        }
        await insertLifecyclePanelSync(transactionClient, {
          orderId: input.orderId, version: row.row_version, kind: 'ORDER_READINESS_CHANNEL_SYNC', now: input.now
        });
        await transactionClient.query('COMMIT');
        return toReadinessResult({ ...mapOrderRow(row), participants }, 'PLAYER', participants);
      }
      const actorRole = requireParticipantRole(current, input.actorUserId);
      if (actorRole !== 'PLAYER') {
        throw new ServiceLifecycleError('PERMISSION_DENIED', 'Customers do not submit readiness.');
      }
      const nextPlayerReadyAt = readinessTimestamp(input.readiness, input.now);
      const nextCustomerReadyAt = nextPlayerReadyAt;
      const shouldStart = Boolean(nextPlayerReadyAt);
      const readyEventType = 'PLAYER_READY_CONFIRMED';
      const readySequence = await nextOrderEventSequence(transactionClient, input.orderId);
      await insertOrderEvent(transactionClient, {
        orderId: input.orderId,
        sequence: readySequence,
        eventType: readyEventType,
        fromStatus: current.status,
        toStatus: current.status,
        actorUserId: input.actorUserId,
        now: input.now,
        payload: { readiness: input.readiness, actorRole }
      });
      if (shouldStart) {
        await insertOrderEvent(transactionClient, {
          orderId: input.orderId,
          sequence: readySequence + 1,
          eventType: 'SERVICE_STARTED',
          fromStatus: 'ACCEPTED',
          toStatus: 'IN_SERVICE',
          actorUserId: input.actorUserId,
          now: input.now,
          payload: {
            customerReadyAt: nextCustomerReadyAt,
            playerReadyAt: nextPlayerReadyAt
          }
        });
      }
      const updated = await transactionClient.query<ServiceLifecycleOrderRow>(
        `
UPDATE orders
SET status = CASE WHEN $6 THEN 'IN_SERVICE'::"OrderStatus" ELSE status END,
    row_version = row_version + 1,
    customer_ready_at = $3,
    player_ready_at = $4,
    service_started_at = CASE WHEN $6 THEN COALESCE(service_started_at, $5) ELSE service_started_at END,
    updated_at = $5
WHERE id = $1
  AND status = 'ACCEPTED'
  AND row_version = $2
RETURNING *
        `,
        [
          input.orderId,
          input.expectedVersion,
          nextCustomerReadyAt,
          nextPlayerReadyAt,
          input.now.toISOString(),
          shouldStart
        ]
      );
      const row = updated.rows[0];
      if (!row) {
        throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
      }
      await insertLifecyclePanelSync(transactionClient, {
        orderId: input.orderId, version: row.row_version, kind: 'ORDER_READINESS_CHANNEL_SYNC', now: input.now
      });
      await transactionClient.query('COMMIT');
      return toReadinessResult(mapOrderRow(row), actorRole);
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresLifecycleError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitCompletionRequest(input: {
    orderId: string;
    expectedVersion: number;
    actorUserId: string;
    now: Date;
  }): Promise<CompletionRequestResult> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const current = await lockOrder(transactionClient, input.orderId);
      if (!current) {
        throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
      }
      if (isLifecycleAutomationPaused(current)) {
        throw new ServiceLifecycleError('CONFLICT', 'Order automation is paused for staff takeover.');
      }
      if (current.status !== 'IN_SERVICE') {
        throw new ServiceLifecycleError('CONFLICT', 'Completion can only be requested while service is in progress.');
      }
      if (current.version !== input.expectedVersion) {
        throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
      }
      current.participants = await loadActiveLifecycleParticipants(transactionClient, input.orderId, true);
      const actorRole = requireParticipantRole(current, input.actorUserId);
      if (actorRole !== 'PLAYER') {
        throw new ServiceLifecycleError('PERMISSION_DENIED', 'Only the assigned player can request completion.');
      }
      const confirmationDueAt = new Date(input.now.getTime() + 30 * 60_000).toISOString();
      await insertOrderEvent(transactionClient, {
        orderId: input.orderId,
        sequence: await nextOrderEventSequence(transactionClient, input.orderId),
        eventType: 'COMPLETION_REQUESTED',
        fromStatus: 'IN_SERVICE',
        toStatus: 'PENDING_CONFIRMATION',
        actorUserId: input.actorUserId,
        now: input.now,
        payload: { confirmationDueAt }
      });
      const updated = await transactionClient.query<ServiceLifecycleOrderRow>(
        `
UPDATE orders
SET status = 'PENDING_CONFIRMATION',
    row_version = row_version + 1,
    completion_requested_at = $3,
    confirmation_due_at = $4,
    updated_at = $3
WHERE id = $1
  AND status = 'IN_SERVICE'
  AND row_version = $2
RETURNING *
        `,
        [input.orderId, input.expectedVersion, input.now.toISOString(), confirmationDueAt]
      );
      const row = updated.rows[0];
      if (!row) {
        throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
      }
      await transactionClient.query(
        `INSERT INTO outbox_events (
           id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,
           row_version,attempt_count,max_attempts,available_at,created_at,updated_at
         ) VALUES (
           gen_random_uuid(),'PANEL_SYNC','order',$1,$1,$2,$3::jsonb,'PENDING',1,0,8,$4,$4,$4
         ) ON CONFLICT DO NOTHING`,
        [input.orderId, `completion-request:${input.orderId}:v${row.row_version}:panel`, JSON.stringify({
          kind: 'ORDER_COMPLETION_REQUESTED_CHANNEL_SYNC', orderId: input.orderId
        }), input.now.toISOString()]
      );
      await transactionClient.query('COMMIT');
      return {
        orderId: row.id,
        publicId: row.public_id,
        status: 'PENDING_CONFIRMATION',
        version: row.row_version,
        actorRole,
        confirmationDueAt
      };
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresLifecycleError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitOrderConfirmation(input: {
    orderId: string;
    expectedVersion: number;
    confirmation: 'CONFIRM_COMPLETED';
    actorUserId: string;
    idempotencyKey: string;
    referralsEnabled?: boolean;
    now: Date;
  }): Promise<OrderCompletionResult> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const current = await lockOrder(transactionClient, input.orderId);
      if (!current) {
        throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
      }
      if (current.status !== 'PENDING_CONFIRMATION') {
        throw new ServiceLifecycleError('CONFLICT', 'Order is not waiting for completion confirmation.');
      }
      if (current.version !== input.expectedVersion) {
        throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
      }
      current.participants = await loadActiveLifecycleParticipants(transactionClient, input.orderId, true);
      const actorRole = requireParticipantRole(current, input.actorUserId);
      if (actorRole !== 'CUSTOMER') {
        throw new ServiceLifecycleError('PERMISSION_DENIED', 'Only the customer can confirm completion.');
      }
      if (current.participants.some((participant) => !participant.readyAt)) {
        throw new ServiceLifecycleError('CONFLICT', 'Every active player must be ready before completion can be captured.');
      }
      const reservation = await requireActiveOrderReservation(transactionClient, input.orderId);
      await insertOrderWalletCapture(transactionClient, { reservation, idempotencyKey: `${input.idempotencyKey}:wallet`, now: input.now });
      await insertFundReservationCaptureEvent(transactionClient, {
        reservation,
        sequence: await nextReservationEventSequence(transactionClient, reservation.id),
        actorUserId: input.actorUserId,
        idempotencyKey: `${input.idempotencyKey}:capture`,
        now: input.now
      });
      const externalTransactionId = await insertExternalTransaction(transactionClient, {
        order: current,
        reservation,
        idempotencyKey: `${input.idempotencyKey}:external`,
        now: input.now
      });
      const consumptionEntryId = await insertConsumptionEntry(transactionClient, {
        order: current,
        externalTransactionId,
        idempotencyKey: `${input.idempotencyKey}:consumption`,
        now: input.now
      });
      if (current.participants.length > 0) {
        for (const participant of current.participants) {
          await insertParticipantPlayerEarning(transactionClient, { order: current, participant, now: input.now });
        }
      } else {
        await insertPlayerEarning(transactionClient, { order: current, now: input.now });
      }
      if (input.referralsEnabled !== false) {
        await insertEligibleReferralCommission(transactionClient, {
          order: current,
          consumptionEntryId,
          now: input.now
        });
      }
      await insertOrderEvent(transactionClient, {
        orderId: input.orderId,
        sequence: await nextOrderEventSequence(transactionClient, input.orderId),
        eventType: 'COMPLETED',
        fromStatus: 'PENDING_CONFIRMATION',
        toStatus: 'COMPLETED',
        actorUserId: input.actorUserId,
        now: input.now,
        payload: {
          consumptionEntryId,
          fundReservationId: reservation.id,
          capturedMinor: reservation.amount_minor
        }
      });
      const updated = await transactionClient.query<ServiceLifecycleOrderRow>(
        `
UPDATE orders
SET status = 'COMPLETED',
    row_version = row_version + 1,
    active_customer_slot_id = NULL,
    active_player_slot_id = NULL,
    completed_at = $3,
    updated_at = $3
WHERE id = $1
  AND status = 'PENDING_CONFIRMATION'
  AND row_version = $2
RETURNING *
        `,
        [input.orderId, input.expectedVersion, input.now.toISOString()]
      );
      const row = updated.rows[0];
      if (!row) {
        throw new ServiceLifecycleError('CONFLICT', 'Order version is stale.');
      }
      await transactionClient.query(
        `INSERT INTO outbox_events (
           id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,
           row_version,attempt_count,max_attempts,available_at,created_at,updated_at
         ) VALUES (
           gen_random_uuid(),'PANEL_SYNC','order',$1,$1,$2,$3::jsonb,'PENDING',1,0,8,$4,$4,$4
         ) ON CONFLICT DO NOTHING`,
        [input.orderId, `order-completed:${input.orderId}:v${row.row_version}:panel`, JSON.stringify({
          kind: 'ORDER_COMPLETED_CHANNEL_SYNC', orderId: input.orderId
        }), input.now.toISOString()]
      );
      await enqueueTerminalChannelArchive(transactionClient, {
        orderId: input.orderId,
        orderVersion: row.row_version,
        now: input.now
      });
      await transactionClient.query('COMMIT');
      return {
        orderId: row.id,
        publicId: row.public_id,
        status: 'COMPLETED',
        version: row.row_version,
        capturedMinor: Number(reservation.amount_minor),
        playerEarningMinor: current.playerEarningMinor,
        currency: current.currency
      };
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresLifecycleError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitCompletionTimeout(input: { orderId: string; now: Date }): Promise<CompletionTimeoutResult> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const current = await lockOrder(transactionClient, input.orderId);
      if (!current) {
        throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
      }
      if (isLifecycleAutomationPaused(current)) {
        throw new ServiceLifecycleError('CONFLICT', 'Order automation is paused for staff takeover.');
      }
      if (current.status !== 'PENDING_CONFIRMATION') {
        throw new ServiceLifecycleError('CONFLICT', 'Order is not waiting for completion confirmation.');
      }
      if (!current.confirmationDueAt || Date.parse(current.confirmationDueAt) > input.now.getTime()) {
        throw new ServiceLifecycleError('CONFLICT', 'Completion confirmation is not overdue.');
      }
      const staffTask = await insertOrGetCompletionReviewTask(transactionClient, { order: current, now: input.now });
      await insertLifecyclePanelSync(transactionClient, {
        orderId: current.id, version: current.version, kind: 'ORDER_COMPLETION_TIMEOUT_CHANNEL_SYNC', now: input.now
      });
      await transactionClient.query('COMMIT');
      return {
        orderId: current.id,
        status: 'PENDING_CONFIRMATION',
        version: current.version,
        staffTask
      };
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresLifecycleError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitReadinessTimeout(input: { orderId: string; now: Date }): Promise<ReadinessTimeoutResult> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const current = await lockOrder(transactionClient, input.orderId);
      if (!current) {
        throw new ServiceLifecycleError('NOT_FOUND', 'Order was not found.');
      }
      if (isLifecycleAutomationPaused(current)) {
        await transactionClient.query('COMMIT');
        return { outcome: 'SKIPPED', orderId: current.id, status: current.status, version: current.version, staffTask: null };
      }
      if (current.status !== 'ACCEPTED') {
        await transactionClient.query('COMMIT');
        return { outcome: 'SKIPPED', orderId: current.id, status: current.status, version: current.version, staffTask: null };
      }
      if (!current.readinessDueAt || Date.parse(current.readinessDueAt) > input.now.getTime()) {
        throw new ServiceLifecycleError('CONFLICT', 'Readiness is not overdue.');
      }
      const participants = await loadActiveLifecycleParticipants(transactionClient, current.id, true);
      const allActivePlayersReady = participants.length > 0
        ? participants.every((participant) => Boolean(participant.readyAt))
        : Boolean(current.customerReadyAt && current.playerReadyAt);
      if (allActivePlayersReady) {
        await transactionClient.query('COMMIT');
        return { outcome: 'SKIPPED', orderId: current.id, status: current.status, version: current.version, staffTask: null };
      }
      const existingEvent = await transactionClient.query<{ id: string }>(
        `SELECT id FROM order_events WHERE order_id = $1 AND event_type = 'READINESS_TIMED_OUT' LIMIT 1`,
        [current.id]
      );
      const staffTask = await insertOrGetReadinessTask(transactionClient, { order: current, participants, now: input.now });
      let version = current.version;
      if (!existingEvent.rows[0]) {
        await insertOrderEvent(transactionClient, {
          orderId: current.id,
          sequence: await nextOrderEventSequence(transactionClient, current.id),
          eventType: 'READINESS_TIMED_OUT',
          fromStatus: 'ACCEPTED',
          toStatus: 'ACCEPTED',
          actorUserId: null,
          actorSource: 'SYSTEM_JOB',
          now: input.now,
          payload: {
            readinessDueAt: current.readinessDueAt,
            customerReady: Boolean(current.customerReadyAt),
            playerReady: Boolean(current.playerReadyAt),
            readinessParticipants: participants.map((participant) => ({
              participantId: participant.id,
              displayName: participant.displayName,
              readiness: participant.readyAt ? 'READY' : 'NOT_READY'
            })),
            staffTaskId: staffTask.id
          }
        });
        const updated = await transactionClient.query<{ row_version: number }>(
          `UPDATE orders SET row_version = row_version + 1, updated_at = $2 WHERE id = $1 AND status = 'ACCEPTED' RETURNING row_version`,
          [current.id, input.now.toISOString()]
        );
        version = updated.rows[0]?.row_version ?? current.version;
      }
      await insertLifecyclePanelSync(transactionClient, {
        orderId: current.id, version, kind: 'ORDER_READINESS_TIMEOUT_CHANNEL_SYNC', now: input.now
      });
      await transactionClient.query('COMMIT');
      return {
        outcome: 'ESCALATED',
        orderId: current.id,
        status: 'ACCEPTED',
        version,
        readiness: {
          customer: current.customerReadyAt ? 'READY' : 'NOT_READY',
          player: current.playerReadyAt ? 'READY' : 'NOT_READY',
          participants: participants.map((participant) => ({
            participantId: participant.id,
            displayName: participant.displayName,
            readiness: participant.readyAt ? 'READY' : 'NOT_READY'
          })),
          allActivePlayersReady
        },
        staffTask
      };
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresLifecycleError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }
}

async function insertOrderWalletCapture(client: ServiceLifecycleQueryClient, input: {
  reservation: ServiceLifecycleReservationRow; idempotencyKey: string; now: Date;
}): Promise<void> {
  const wallet=await client.query<{id:string}>('SELECT id FROM wallet_accounts WHERE user_id=$1 FOR UPDATE',[input.reservation.user_id]);
  if(!wallet.rows[0])throw new ServiceLifecycleError('CONFLICT','Customer wallet was not found.');
  await client.query(`INSERT INTO wallet_entries
    (id,wallet_account_id,entry_type,direction,amount_minor,currency,source_type,source_id,idempotency_key,occurred_at,created_at)
    VALUES (gen_random_uuid(),$1,'ORDER_CAPTURE_DEBIT','DEBIT',$2,'CAT','FUND_RESERVATION',$3,$4,$5,$5)`,
    [wallet.rows[0].id,input.reservation.amount_minor,input.reservation.id,input.idempotencyKey,input.now]);
  await client.query('UPDATE wallet_accounts SET row_version=row_version+1,updated_at=$2 WHERE id=$1',[wallet.rows[0].id,input.now]);
}

export async function setOrderReadiness(input: {
  store: ServiceLifecycleStore;
  orderId: string;
  expectedVersion: number;
  readiness: ReadinessValue;
  actor: { guildId: string; discordUserId: string };
  now: Date;
}): Promise<OrderReadinessResult> {
  const actorUserId = await requireActorUser(input.store, input.actor);
  return input.store.commitReadiness({
    orderId: input.orderId,
    expectedVersion: input.expectedVersion,
    actorUserId,
    readiness: input.readiness,
    now: input.now
  });
}

export async function requestOrderCompletion(input: {
  store: ServiceLifecycleStore;
  orderId: string;
  expectedVersion: number;
  actor: { guildId: string; discordUserId: string };
  now: Date;
}): Promise<CompletionRequestResult> {
  const actorUserId = await requireActorUser(input.store, input.actor);
  return input.store.commitCompletionRequest({
    orderId: input.orderId,
    expectedVersion: input.expectedVersion,
    actorUserId,
    now: input.now
  });
}

export async function confirmOrder(input: {
  store: ServiceLifecycleStore;
  orderId: string;
  expectedVersion: number;
  confirmation: 'CONFIRM_COMPLETED';
  actor: { guildId: string; discordUserId: string };
  idempotencyKey: string;
  referralsEnabled?: boolean;
  now: Date;
}): Promise<OrderCompletionResult> {
  const actorUserId = await requireActorUser(input.store, input.actor);
  return input.store.commitOrderConfirmation({
    orderId: input.orderId,
    expectedVersion: input.expectedVersion,
    confirmation: input.confirmation,
    actorUserId,
    idempotencyKey: input.idempotencyKey,
    referralsEnabled: input.referralsEnabled ?? true,
    now: input.now
  });
}

export async function expireOrderCompletionConfirmation(input: {
  store: ServiceLifecycleStore;
  orderId: string;
  now: Date;
}): Promise<CompletionTimeoutResult> {
  return input.store.commitCompletionTimeout({
    orderId: input.orderId,
    now: input.now
  });
}

export async function expireOrderReadiness(input: {
  store: ServiceLifecycleStore;
  orderId: string;
  now: Date;
}): Promise<ReadinessTimeoutResult> {
  return input.store.commitReadinessTimeout({ orderId: input.orderId, now: input.now });
}

export async function handleReadinessTimeoutJob(input: {
  job: OutboxJob;
  store: ServiceLifecycleStore;
  now: Date;
}): Promise<ReadinessTimeoutResult> {
  if (input.job.type !== 'READINESS_TIMEOUT') {
    throw new ServiceLifecycleError('VALIDATION_ERROR', 'Expected a READINESS_TIMEOUT job.');
  }
  const payload = input.job.payload as { orderId?: unknown; readinessDueAt?: unknown };
  if (!payload || typeof payload.orderId !== 'string' || typeof payload.readinessDueAt !== 'string') {
    throw new ServiceLifecycleError('VALIDATION_ERROR', 'Readiness timeout payload is invalid.');
  }
  if (payload.orderId !== input.job.aggregateId) {
    throw new ServiceLifecycleError('VALIDATION_ERROR', 'Readiness timeout aggregate does not match payload.');
  }
  return expireOrderReadiness({ store: input.store, orderId: payload.orderId, now: input.now });
}

export async function rejectLegacyStartService(input: {
  store: ServiceLifecycleStore;
  orderId: string;
  actor: { guildId: string; discordUserId: string };
}): Promise<never> {
  await requireActorUser(input.store, input.actor);
  throw new ServiceLifecycleError('PERMISSION_DENIED', 'Single-party service start is disabled; use readiness instead.');
}

export function registerServiceLifecycleRoutes(
  server: FastifyInstance,
  options: { store: ServiceLifecycleStore; now?: () => Date }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Service lifecycle routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());
  registerSecureWriteRoute(server, security, {
    method: 'PUT',
    url: '/api/v1/orders/:orderId/readiness',
    permission: 'order.readiness.confirm',
    action: 'SET_ORDER_READINESS',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    handler: async (request, actor) => {
      const body = parseReadinessBody(request.body);
      if (!actor.guildId || !actor.discordUserId) {
        throw new ServiceLifecycleError('PERMISSION_DENIED', 'Discord actor context is required.');
      }
      const result = await setOrderReadiness({
        store: options.store,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        readiness: body.readiness,
        actor: { guildId: actor.guildId, discordUserId: actor.discordUserId },
        now: now()
      });
      return { ...result, enabledFeatures: enabledPilotFeatures(security.pilotFeaturePolicy?.enabledFeatures) };
    },
    mapError: mapLifecycleError,
    fingerprintBody: (request) => parseReadinessBody(request.body)
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/request-completion',
    permission: 'order.request_completion',
    action: 'REQUEST_ORDER_COMPLETION',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    handler: async (request, actor) => {
      const body = parseOrderVersionBody(request.body);
      if (!actor.guildId || !actor.discordUserId) {
        throw new ServiceLifecycleError('PERMISSION_DENIED', 'Discord actor context is required.');
      }
      return requestOrderCompletion({
        store: options.store,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        actor: { guildId: actor.guildId, discordUserId: actor.discordUserId },
        now: now()
      });
    },
    mapError: mapLifecycleError,
    fingerprintBody: (request) => parseOrderVersionBody(request.body)
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/confirm',
    permission: 'order.confirm',
    action: 'CONFIRM_ORDER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    handler: async (request, actor) => {
      const body = parseConfirmOrderBody(request.body);
      if (!actor.guildId || !actor.discordUserId) {
        throw new ServiceLifecycleError('PERMISSION_DENIED', 'Discord actor context is required.');
      }
      return confirmOrder({
        store: options.store,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        confirmation: body.confirmation,
        actor: { guildId: actor.guildId, discordUserId: actor.discordUserId },
        idempotencyKey: idempotencyKey(request),
        referralsEnabled: security.pilotFeaturePolicy?.isEnabled('REFERRALS') ?? true,
        now: now()
      });
    },
    mapError: mapLifecycleError,
    fingerprintBody: (request) => parseConfirmOrderBody(request.body)
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/start',
    permission: 'order.legacy_start.reject',
    action: 'REJECT_LEGACY_START_SERVICE',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'],
    handler: async (request, actor) => {
      parseOrderVersionBody(request.body);
      if (!actor.guildId || !actor.discordUserId) {
        throw new ServiceLifecycleError('PERMISSION_DENIED', 'Discord actor context is required.');
      }
      return rejectLegacyStartService({
        store: options.store,
        orderId: orderIdParam(request),
        actor: { guildId: actor.guildId, discordUserId: actor.discordUserId }
      });
    },
    mapError: mapLifecycleError,
    fingerprintBody: (request) => parseOrderVersionBody(request.body)
  });
}

async function requireActorUser(store: ServiceLifecycleStore, actor: { guildId: string; discordUserId: string }): Promise<string> {
  const actorUserId = await store.resolveDiscordUser(actor);
  if (!actorUserId) {
    throw new ServiceLifecycleError('PERMISSION_DENIED', 'Actor is not bound to an order participant.');
  }
  return actorUserId;
}

function requireParticipantRole(order: ServiceLifecycleOrderRecord, actorUserId: string): OrderParticipantRole {
  if (actorUserId === order.customerId) {
    return 'CUSTOMER';
  }
  if (actorUserId === order.playerId || order.participants?.some((participant)=>participant.playerId===actorUserId)) {
    return 'PLAYER';
  }
  throw new ServiceLifecycleError('PERMISSION_DENIED', 'Actor is not a participant of this order.');
}

function toReadinessResult(order: ServiceLifecycleOrderRecord, actorRole: OrderParticipantRole,participants:ServiceLifecycleParticipant[]=order.participants??[]): OrderReadinessResult {
  return {
    orderId: order.id,
    publicId: order.publicId,
    status: order.status,
    version: order.version,
    actorRole,
    readiness: {
      participants:participants.map((participant)=>({participantId:participant.id,playerId:participant.playerId,displayName:participant.displayName,readiness:participant.readyAt?'READY':'NOT_READY'})),
      allActivePlayersReady:participants.length>0?participants.every((participant)=>Boolean(participant.readyAt)):Boolean(order.customerReadyAt&&order.playerReadyAt),
      readyDeadlineAt: order.readinessDueAt,
      startedAt: order.serviceStartedAt,
      staffTaskId: null
    }
  };
}

function enabledPilotFeatures(
  configured: readonly ('CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6')[] | undefined
): Array<'CORE_ORDER' | 'GIFTS' | 'REFERRALS' | 'M6'> {
  return [...(configured ?? ['CORE_ORDER', 'GIFTS', 'REFERRALS', 'M6'])];
}

function parseReadinessBody(body: unknown): { expectedVersion: number; readiness: ReadinessValue } {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    readiness: enumValue(input.readiness, ['READY', 'NOT_READY'], 'readiness')
  };
}

function parseOrderVersionBody(body: unknown): { expectedVersion: number } {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion')
  };
}

function parseConfirmOrderBody(body: unknown): { expectedVersion: number; confirmation: 'CONFIRM_COMPLETED' } {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    confirmation: enumValue(input.confirmation, ['CONFIRM_COMPLETED'], 'confirmation')
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ServiceLifecycleError('VALIDATION_ERROR', 'Request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ServiceLifecycleError('VALIDATION_ERROR', `${field} must be a positive integer.`);
  }
  return value as number;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ServiceLifecycleError('VALIDATION_ERROR', `${field} is invalid.`);
  }
  return value as T;
}

function orderIdParam(request: FastifyRequest): string {
  const params = request.params as { orderId?: string };
  return params.orderId ?? '';
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function mapLifecycleError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof ServiceLifecycleError)) {
    return null;
  }
  if (error.code === 'NOT_FOUND') {
    return { statusCode: 404, code: error.code, message: error.message };
  }
  if (error.code === 'CONFLICT') {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  if (error.code === 'PERMISSION_DENIED') {
    return { statusCode: 403, code: error.code, message: error.message };
  }
  return { statusCode: 422, code: error.code, message: error.message };
}

async function insertLifecyclePanelSync(client: ServiceLifecycleQueryClient, input: {
  orderId: string; version: number; kind: string; now: Date;
}): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (
       id,event_type,aggregate_type,aggregate_id,order_id,dedupe_key,payload,status,
       row_version,attempt_count,max_attempts,available_at,created_at,updated_at
     ) VALUES (
       gen_random_uuid(),'PANEL_SYNC','order',$1,$1,$2,$3::jsonb,'PENDING',1,0,8,$4,$4,$4
     ) ON CONFLICT DO NOTHING`,
    [input.orderId, `order-panel:${input.kind}:${input.orderId}:v${input.version}`, JSON.stringify({
      kind: input.kind, orderId: input.orderId
    }), input.now.toISOString()]
  );
}

async function lockOrder(client: ServiceLifecycleQueryClient, orderId: string): Promise<ServiceLifecycleOrderRecord | null> {
  const result = await client.query<ServiceLifecycleOrderRow>(
    `
SELECT *
FROM orders
WHERE id = $1
FOR UPDATE
    `,
    [orderId]
  );
  return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
}

interface ServiceLifecycleParticipantRow {
  id: string;
  player_id: string;
  player_display_name_snapshot: string;
  ready_at: Date | string | null;
  unit_count: number;
  expected_earning_minor: number | string | bigint;
  customer_unit_price_minor_snapshot: number | string | bigint;
  line_price_minor: number | string | bigint;
  row_version: number;
}

async function loadActiveLifecycleParticipants(
  client: ServiceLifecycleQueryClient,
  orderId: string,
  lock = false
): Promise<ServiceLifecycleParticipant[]> {
  const result = await client.query<ServiceLifecycleParticipantRow>(
    `SELECT id,player_id,player_display_name_snapshot,ready_at,unit_count,
            expected_earning_minor,customer_unit_price_minor_snapshot,line_price_minor,row_version
     FROM order_participants
     WHERE order_id=$1 AND status='ACTIVE'
     ORDER BY created_at,id
     ${lock ? 'FOR UPDATE' : ''}`,
    [orderId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    playerId: row.player_id,
    displayName: row.player_display_name_snapshot,
    readyAt: toIsoOrNull(row.ready_at),
    unitCount: row.unit_count,
    expectedEarningMinor: Number(row.expected_earning_minor),
    customerUnitPriceMinor: Number(row.customer_unit_price_minor_snapshot),
    linePriceMinor: Number(row.line_price_minor),
    version: row.row_version
  }));
}

async function insertOrderParticipantReadinessEvent(
  client: ServiceLifecycleQueryClient,
  input: {
    orderId: string;
    orderParticipantId: string;
    participantVersion: number;
    orderVersion: number;
    actorUserId: string;
    readiness: ReadinessValue;
    now: Date;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO order_participant_events (
       id,order_participant_id,sequence,event_type,participant_version,order_version,
       actor_staff_id,actor_user_id,reason_code,snapshot,idempotency_key,created_at
     ) VALUES (
       gen_random_uuid(),$1,
       (SELECT COALESCE(MAX(sequence),0)+1 FROM order_participant_events WHERE order_participant_id=$1),
       'READY_CONFIRMED',$2,$3,NULL,$4,NULL,$5::jsonb,$6,$7
     )`,
    [
      input.orderParticipantId,
      input.participantVersion,
      input.orderVersion,
      input.actorUserId,
      JSON.stringify({ readiness: input.readiness, orderId: input.orderId }),
      `participant-readiness:${input.orderParticipantId}:v${input.participantVersion}`,
      input.now.toISOString()
    ]
  );
}

function readinessTimestamp(readiness: ReadinessValue, now: Date): string | null {
  return readiness === 'READY' ? now.toISOString() : null;
}

function isLifecycleAutomationPaused(order: ServiceLifecycleOrderRecord): boolean {
  return order.automationState === 'PAUSED'
    && (!order.automationScope || order.automationScope === 'ALL' || order.automationScope === 'LIFECYCLE');
}

function mapPostgresLifecycleError(error: unknown): unknown {
  if (error instanceof ServiceLifecycleError) {
    return error;
  }
  return error;
}

async function nextOrderEventSequence(client: ServiceLifecycleQueryClient, orderId: string): Promise<number> {
  const result = await client.query<{ next_sequence: string }>(
    `
SELECT (COALESCE(MAX(sequence), 0) + 1)::text AS next_sequence
FROM order_events
WHERE order_id = $1
    `,
    [orderId]
  );
  return Number(result.rows[0]?.next_sequence ?? 1);
}

async function insertOrderEvent(
  client: ServiceLifecycleQueryClient,
  input: {
    orderId: string;
    sequence: number;
    eventType: 'CUSTOMER_READY_CONFIRMED' | 'PLAYER_READY_CONFIRMED' | 'READINESS_TIMED_OUT' | 'SERVICE_STARTED' | 'COMPLETION_REQUESTED' | 'COMPLETED';
    fromStatus: LifecycleOrderStatus;
    toStatus: LifecycleOrderStatus;
    actorUserId: string | null;
    actorSource?: 'DISCORD_BOT' | 'SYSTEM_JOB';
    now: Date;
    payload: unknown;
  }
): Promise<void> {
  await client.query(
    `
INSERT INTO order_events (
  id, order_id, sequence, event_type, from_status, to_status,
  actor_user_id, actor_staff_id, actor_source, interaction_id, payload, created_at
)
VALUES (
  gen_random_uuid(), $1, $2, $3::"OrderEventType", $4::"OrderStatus", $5::"OrderStatus",
  $6, NULL, $9::"ActorSource", NULL, $7::jsonb, $8
)
    `,
    [
      input.orderId,
      input.sequence,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.actorUserId,
      JSON.stringify(input.payload),
      input.now.toISOString(),
      input.actorSource ?? 'DISCORD_BOT'
    ]
  );
}

async function requireActiveOrderReservation(
  client: ServiceLifecycleQueryClient,
  orderId: string
): Promise<ServiceLifecycleReservationRow> {
  const result = await client.query<ServiceLifecycleReservationRow>(
    `
SELECT *
FROM fund_reservations
WHERE order_id = $1
  AND source_type = 'ORDER'
  AND status = 'ACTIVE'
FOR UPDATE
    `,
    [orderId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new ServiceLifecycleError('CONFLICT', 'Order does not have an active reservation to capture.');
  }
  return row;
}

async function nextReservationEventSequence(client: ServiceLifecycleQueryClient, reservationId: string): Promise<number> {
  const result = await client.query<{ next_sequence: string }>(
    `
SELECT (COALESCE(MAX(sequence), 0) + 1)::text AS next_sequence
FROM fund_reservation_events
WHERE fund_reservation_id = $1
    `,
    [reservationId]
  );
  return Number(result.rows[0]?.next_sequence ?? 1);
}

async function insertFundReservationCaptureEvent(
  client: ServiceLifecycleQueryClient,
  input: {
    reservation: ServiceLifecycleReservationRow;
    sequence: number;
    actorUserId: string;
    idempotencyKey: string;
    now: Date;
  }
): Promise<void> {
  await client.query(
    `
INSERT INTO fund_reservation_events (
  id, fund_reservation_id, sequence, event_type, from_status, to_status,
  amount_minor, reservation_version, idempotency_key,
  actor_user_id, actor_staff_id, actor_source, reason_code, created_at
)
VALUES (
  gen_random_uuid(), $1, $2, 'CAPTURED', 'ACTIVE', 'CAPTURED',
  $3, $4, $5,
  $6, NULL, 'DISCORD_BOT', NULL, $7
)
    `,
    [
      input.reservation.id,
      input.sequence,
      input.reservation.amount_minor,
      input.reservation.row_version + 1,
      input.idempotencyKey,
      input.actorUserId,
      input.now.toISOString()
    ]
  );
}

async function insertExternalTransaction(
  client: ServiceLifecycleQueryClient,
  input: {
    order: ServiceLifecycleOrderRecord;
    reservation: ServiceLifecycleReservationRow;
    idempotencyKey: string;
    now: Date;
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
INSERT INTO external_transactions (
  id, provider, type, user_id, order_id, gift_request_id, fund_reservation_id,
  external_ref, idempotency_key, amount_minor, currency, status,
  initiated_at, settled_at, created_at, updated_at
)
VALUES (
  gen_random_uuid(), $1, 'ORDER_CHARGE', $2, $3, NULL, $4,
  $5, $6, $7, $8, 'SUCCEEDED',
  $9, $9, $9, $9
)
RETURNING id
    `,
    [
      input.reservation.provider ?? 'mock-provider',
      input.order.customerId,
      input.order.id,
      input.reservation.id,
      `order:${input.order.id}`,
      input.idempotencyKey,
      input.order.amountMinor,
      input.order.currency,
      input.now.toISOString()
    ]
  );
  return result.rows[0]!.id;
}

async function insertConsumptionEntry(
  client: ServiceLifecycleQueryClient,
  input: {
    order: ServiceLifecycleOrderRecord;
    externalTransactionId: string;
    idempotencyKey: string;
    now: Date;
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
INSERT INTO consumption_entries (
  id, user_id, entry_type, direction, order_id, gift_request_id,
  external_transaction_id, refund_id, reversal_of_entry_id, amount_minor,
  currency, source_type, source_id, idempotency_key, occurred_at, created_at
)
VALUES (
  gen_random_uuid(), $1, 'ORDER_CHARGE', 'DEBIT', $2, NULL,
  $3, NULL, NULL, $4,
  $5, 'ORDER', $2, $6, $7, $7
)
RETURNING id
    `,
    [
      input.order.customerId,
      input.order.id,
      input.externalTransactionId,
      input.order.amountMinor,
      input.order.currency,
      input.idempotencyKey,
      input.now.toISOString()
    ]
  );
  return result.rows[0]!.id;
}

async function insertPlayerEarning(
  client: ServiceLifecycleQueryClient,
  input: {
    order: ServiceLifecycleOrderRecord;
    now: Date;
  }
): Promise<void> {
  await client.query(
    `
INSERT INTO player_earnings (
  id, order_id, player_user_id, base_units, unit_payout_minor, amount_minor,
  currency, status, row_version, confirmed_by_staff_id, confirmed_at, paid_at,
  created_at, updated_at
)
VALUES (
  gen_random_uuid(), $1, $2, $3, $4, $5,
  $6, 'PENDING', 1, NULL, NULL, NULL,
  $7, $7
)
    `,
    [
      input.order.id,
      input.order.playerId,
      input.order.unitCount ?? 1,
      input.order.playerUnitPayoutMinor ?? input.order.playerEarningMinor,
      input.order.playerEarningMinor,
      input.order.currency,
      input.now.toISOString()
    ]
  );
}

async function insertParticipantPlayerEarning(
  client: ServiceLifecycleQueryClient,
  input: { order: ServiceLifecycleOrderRecord; participant: ServiceLifecycleParticipant; now: Date }
): Promise<void> {
  await client.query(
    `INSERT INTO player_earnings (
       id,order_id,order_participant_id,player_user_id,base_units,unit_payout_minor,amount_minor,
       currency,status,row_version,confirmed_by_staff_id,confirmed_at,paid_at,created_at,updated_at
     ) VALUES (
       gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'PENDING',1,NULL,NULL,NULL,$8,$8
     )`,
    [
      input.order.id,
      input.participant.id,
      input.participant.playerId,
      input.participant.unitCount,
      Math.floor(input.participant.expectedEarningMinor / input.participant.unitCount),
      input.participant.expectedEarningMinor,
      input.order.currency,
      input.now.toISOString()
    ]
  );
}

async function insertEligibleReferralCommission(
  client: ServiceLifecycleQueryClient,
  input: {
    order: ServiceLifecycleOrderRecord;
    consumptionEntryId: string;
    now: Date;
  }
): Promise<void> {
  await createEligibleReferralCommission(client,{referredUserId:input.order.customerId,
    sourceConsumptionEntryId:input.consumptionEntryId,baseAmountMinor:input.order.amountMinor,
    currency:input.order.currency,source:'ORDER',now:input.now});
}

async function insertOrGetCompletionReviewTask(
  client: ServiceLifecycleQueryClient,
  input: { order: ServiceLifecycleOrderRecord; now: Date }
): Promise<ServiceLifecycleStaffTask> {
  const publicId = `TASK-${input.order.publicId}-COMP`;
  const contextSnapshot = {
    orderId: input.order.id,
    publicId: input.order.publicId,
    status: input.order.status,
    customerId: input.order.customerId,
    playerId: input.order.playerId,
    channelId: input.order.channelId,
    voiceChannelId: input.order.voiceChannelId,
    completionRequestedAt: input.order.completionRequestedAt,
    confirmationDueAt: input.order.confirmationDueAt
  };
  const inserted = await client.query<ServiceLifecycleStaffTaskRow>(
    `
INSERT INTO staff_tasks (
  id, public_id, type, reason_code, status, row_version,
  order_id, gift_request_id, created_by_staff_id, claimed_by_staff_id,
  resolved_by_staff_id, voice_channel_id, staff_channel_message_id,
  context_snapshot, claimed_at, verified_at, resolved_at, created_at, updated_at
)
VALUES (
  gen_random_uuid(), $1, 'COMPLETION_REVIEW', 'COMPLETION_CONFIRMATION_TIMEOUT', 'OPEN', 1,
  $2, NULL, NULL, NULL,
  NULL, $3, NULL,
  $4::jsonb, NULL, NULL, NULL, $5, $5
)
ON CONFLICT (public_id) DO NOTHING
RETURNING id, public_id, type, reason_code, status
    `,
    [
      publicId,
      input.order.id,
      input.order.voiceChannelId,
      JSON.stringify(contextSnapshot),
      input.now.toISOString()
    ]
  );
  const row = inserted.rows[0] ?? (await client.query<ServiceLifecycleStaffTaskRow>(
    `
SELECT id, public_id, type, reason_code, status
FROM staff_tasks
WHERE public_id = $1
LIMIT 1
    `,
    [publicId]
  )).rows[0];
  if (!row) {
    throw new ServiceLifecycleError('CONFLICT', 'Could not create completion review task.');
  }
  return mapStaffTaskRow(row);
}

async function insertOrGetReadinessTask(
  client: ServiceLifecycleQueryClient,
  input: { order: ServiceLifecycleOrderRecord; participants: ServiceLifecycleParticipant[]; now: Date }
): Promise<ServiceLifecycleStaffTask> {
  const publicId = `TASK-${input.order.publicId}-READY`;
  const contextSnapshot = {
    orderId: input.order.id,
    publicId: input.order.publicId,
    status: input.order.status,
    channelId: input.order.channelId,
    voiceChannelId: input.order.voiceChannelId,
    readinessDueAt: input.order.readinessDueAt,
    customerReady: Boolean(input.order.customerReadyAt),
    playerReady: Boolean(input.order.playerReadyAt),
    readinessParticipants: input.participants.map((participant) => ({
      participantId: participant.id,
      displayName: participant.displayName,
      readiness: participant.readyAt ? 'READY' : 'NOT_READY'
    }))
  };
  const inserted = await client.query<ServiceLifecycleStaffTaskRow>(
    `
INSERT INTO staff_tasks (
  id, public_id, type, reason_code, status, row_version,
  order_id, gift_request_id, created_by_staff_id, claimed_by_staff_id,
  resolved_by_staff_id, voice_channel_id, staff_channel_message_id,
  context_snapshot, claimed_at, verified_at, resolved_at, created_at, updated_at
)
VALUES (
  gen_random_uuid(), $1, 'ORDER_ASSIST', 'READINESS_TIMEOUT', 'OPEN', 1,
  $2, NULL, NULL, NULL,
  NULL, $3, NULL,
  $4::jsonb, NULL, NULL, NULL, $5, $5
)
ON CONFLICT (public_id) DO NOTHING
RETURNING id, public_id, type, reason_code, status
    `,
    [
      publicId,
      input.order.id,
      input.order.voiceChannelId,
      JSON.stringify(contextSnapshot),
      input.now.toISOString()
    ]
  );
  const row = inserted.rows[0] ?? (await client.query<ServiceLifecycleStaffTaskRow>(
    `SELECT id, public_id, type, reason_code, status FROM staff_tasks WHERE public_id = $1 LIMIT 1`,
    [publicId]
  )).rows[0];
  if (!row) {
    throw new ServiceLifecycleError('CONFLICT', 'Could not create readiness support task.');
  }
  return mapStaffTaskRow(row);
}

function mapOrderRow(row: ServiceLifecycleOrderRow): ServiceLifecycleOrderRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    customerId: row.customer_id,
    playerId: row.player_id ?? '',
    status: row.status,
    version: row.row_version,
    currency: row.currency ?? 'CAT',
    amountMinor: Number(row.amount_minor ?? 0),
    playerEarningMinor: Number(row.expected_player_earning_minor ?? 0),
    unitCount: row.unit_count,
    playerUnitPayoutMinor: toNullableNumber(row.player_unit_payout_minor),
    channelId: row.channel_id ?? '',
    panelMessageId: row.panel_message_id ?? '',
    voiceChannelId: row.voice_channel_id,
    readinessDueAt: toIsoOrNull(row.readiness_due_at),
    customerReadyAt: toIsoOrNull(row.customer_ready_at),
    playerReadyAt: toIsoOrNull(row.player_ready_at),
    serviceStartedAt: toIsoOrNull(row.service_started_at),
    completionRequestedAt: toIsoOrNull(row.completion_requested_at),
    confirmationDueAt: toIsoOrNull(row.confirmation_due_at),
    automationState: row.automation_state,
    automationScope: row.automation_scope,
    updatedAt: toIso(row.updated_at)
  };
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value ? toIso(value) : null;
}

function toIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toNullableNumber(value: number | string | bigint | null): number | null {
  return value === null ? null : Number(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface ServiceLifecycleOrderRow {
  id: string;
  public_id: string;
  customer_id: string;
  player_id: string | null;
  status: LifecycleOrderStatus;
  row_version: number;
  automation_state: 'RUNNING' | 'PAUSED';
  automation_scope: 'ALL' | 'DISPATCH' | 'LIFECYCLE' | 'CANCELLATION' | null;
  amount_minor: number | string | bigint | null;
  expected_player_earning_minor: number | string | bigint | null;
  unit_count: number | null;
  player_unit_payout_minor: number | string | bigint | null;
  currency: string | null;
  channel_id: string | null;
  panel_message_id: string | null;
  voice_channel_id: string | null;
  readiness_due_at: Date | string | null;
  customer_ready_at: Date | string | null;
  player_ready_at: Date | string | null;
  service_started_at: Date | string | null;
  completion_requested_at: Date | string | null;
  confirmation_due_at: Date | string | null;
  updated_at: Date | string;
}

interface ServiceLifecycleReservationRow {
  id: string;
  user_id: string;
  order_id: string;
  provider: string | null;
  amount_minor: number;
  currency: string;
  status: 'ACTIVE';
  row_version: number;
}


interface ServiceLifecycleStaffTaskRow {
  id: string;
  public_id: string;
  type: 'COMPLETION_REVIEW';
  reason_code: 'COMPLETION_CONFIRMATION_TIMEOUT';
  status: ServiceLifecycleStaffTask['status'];
}

function mapStaffTaskRow(row: ServiceLifecycleStaffTaskRow): ServiceLifecycleStaffTask {
  return {
    id: row.id,
    publicId: row.public_id,
    type: row.type,
    reasonCode: row.reason_code,
    status: row.status
  };
}
