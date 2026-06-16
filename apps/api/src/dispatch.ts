import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import type { PolicyReader } from './operations.js';
import { resolveBotConfigString, type BotConfigStore } from './bot-config.js';
import { registerSecureReadRoute, registerSecureWriteRoute } from './security.js';
import type { OutboxJob } from './outbox.js';
import type { OrderDispatchRequirement, OrderRecord, OrderStatus, OrderStore } from './orders.js';
import { calculatePlayerCompensation,type PlayerCompensationStore } from './player-compensation.js';
import {
  selectEligibleDispatchCandidates,
  type DiscordPresenceStatus,
  type PlayerAvailability,
  type PlayerProfileRecord,
  type PlayerReviewStatus,
  type PlayerUserStatus
} from './players.js';

export type DispatchStatus = 'PENDING' | 'ACTIVE' | 'ACCEPTED' | 'TIMED_OUT' | 'CANCELLED' | 'FAILED';
export type DispatchCandidateStatus = 'NOTIFIED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'LOST_RACE';
export type DispatchTrigger = 'ORDER_SUBMITTED' | 'MANUAL_RETRY' | 'TIMEOUT_RETRY';

export interface DispatchAttemptRecord {
  id: string;
  orderId: string;
  orderRequirementId?: string | null;
  round: number;
  status: DispatchStatus;
  dispatchChannelId: string;
  dispatchMessageId: string | null;
  candidateCriteria: {
    game: string;
    service: string;
    guildId: string | null;
    trigger: DispatchTrigger;
  };
  acceptedPlayerId: string | null;
  startedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchCandidateRecord {
  dispatchAttemptId: string;
  playerUserId: string;
  status: DispatchCandidateStatus;
  notifiedAt: string | null;
  respondedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DispatchResult {
  dispatchAttemptId: string;
  orderId: string;
  status: 'OPEN';
  candidateCount: number;
  expiresAt: string;
}

export interface DispatchTimeoutResult {
  dispatchAttemptId: string;
  orderId: string;
  status: 'DISPATCH_TIMEOUT' | 'AUTOMATION_PAUSED';
  orderStatus: OrderStatus;
}

export interface AcceptedOrderResult {
  id: string;
  publicId: string;
  status: 'PENDING_DISPATCH' | 'ACCEPTED';
  version: number;
  playerId: string;
  channelSpec: OrderRecord['channelSpec'];
}

export interface DispatchStore {
  nextRound(orderId: string): Promise<number> | number;
  findAttempt(dispatchAttemptId: string): Promise<DispatchAttemptRecord | null> | DispatchAttemptRecord | null;
  commitDispatch(input: {
    attempt: DispatchAttemptRecord;
    candidates: DispatchCandidateRecord[];
    outboxJobs: OutboxJob[];
  }): Promise<void> | void;
  commitAcceptance(input: {
    orderStore: OrderStore;
    order: OrderRecord;
    expectedVersion: number;
    dispatchAttemptId: string;
    orderRequirement: OrderDispatchRequirement | null;
    player: PlayerProfileRecord;
    outboxJobs: OutboxJob[];
    now: Date;
  }): Promise<void> | void;
  declineCandidate(input: {
    orderId: string;
    expectedVersion: number;
    player: PlayerProfileRecord;
    now: Date;
  }): Promise<void> | void;
  markTimedOut(input: { dispatchAttemptId: string; now: Date }): Promise<DispatchAttemptRecord> | DispatchAttemptRecord;
}

export interface DispatchPlayerPool {
  listProfiles(input: { guildId: string | null }): Promise<PlayerProfileRecord[]> | PlayerProfileRecord[];
}

export interface DispatchQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export interface DispatchTransactionClient extends DispatchQueryClient {
  release(): void;
}

export interface DispatchPool extends DispatchQueryClient {
  connect(): Promise<DispatchTransactionClient>;
}

export class DispatchError extends Error {
  public readonly code: 'AUTOMATION_PAUSED' | 'CONFLICT' | 'NOT_FOUND' | 'PLAYER_NOT_ELIGIBLE' | 'VALIDATION_ERROR';

  constructor(code: DispatchError['code'], message: string) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
  }
}

export class InMemoryDispatchStore implements DispatchStore {
  public readonly attempts: DispatchAttemptRecord[] = [];
  public readonly candidates: DispatchCandidateRecord[] = [];
  public readonly outboxJobs: OutboxJob[] = [];

  nextRound(orderId: string): number {
    return this.attempts.reduce((max, attempt) => {
      return attempt.orderId === orderId ? Math.max(max, attempt.round) : max;
    }, 0) + 1;
  }

  findAttempt(dispatchAttemptId: string): DispatchAttemptRecord | null {
    const attempt = this.attempts.find((candidate) => candidate.id === dispatchAttemptId);
    return attempt ? clone(attempt) : null;
  }

  commitDispatch(input: {
    attempt: DispatchAttemptRecord;
    candidates: DispatchCandidateRecord[];
    outboxJobs: OutboxJob[];
  }): void {
    const activeAttempt = this.attempts.find((attempt) => {
      return attempt.orderId === input.attempt.orderId && attempt.status === 'ACTIVE';
    });
    if (activeAttempt) {
      throw new DispatchError('CONFLICT', 'An active dispatch attempt already exists for this order.');
    }
    this.attempts.push(clone(input.attempt));
    this.candidates.push(...input.candidates.map(clone));
    this.outboxJobs.push(...input.outboxJobs.map(clone));
  }

  commitAcceptance(input: {
    orderStore: OrderStore;
    order: OrderRecord;
    expectedVersion: number;
    dispatchAttemptId: string;
    orderRequirement: OrderDispatchRequirement | null;
    player: PlayerProfileRecord;
    outboxJobs: OutboxJob[];
    now: Date;
  }): void {
    const orders = mutableOrderList(input.orderStore);
    const orderIndex = orders.findIndex((order) => order.id === input.order.id);
    const currentOrder = orderIndex === -1 ? null : orders[orderIndex];
    if (
      !currentOrder ||
      currentOrder.status !== 'PENDING_DISPATCH' ||
      currentOrder.version !== input.expectedVersion ||
      currentOrder.playerId
    ) {
      throw new DispatchError('CONFLICT', 'Order has already been accepted.');
    }
    const attemptIndex = this.attempts.findIndex((attempt) => attempt.id === input.dispatchAttemptId);
    const attempt = attemptIndex === -1 ? null : this.attempts[attemptIndex];
    if (!attempt || attempt.orderId !== input.order.id || attempt.status !== 'ACTIVE') {
      throw new DispatchError('CONFLICT', 'Dispatch attempt is not active.');
    }
    const candidate = this.candidates.find((candidate) => {
      return candidate.dispatchAttemptId === input.dispatchAttemptId && candidate.playerUserId === input.player.userId;
    });
    if (!candidate || candidate.status !== 'NOTIFIED') {
      throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'Player is not an active candidate for this dispatch attempt.');
    }
    orders[orderIndex] = {
      ...input.order,
      status: 'ACCEPTED',
      playerId: input.player.userId,
      version: input.order.version + 1,
      updatedAt: input.now.toISOString()
    };
    this.attempts[attemptIndex] = {
      ...attempt,
      status: 'ACCEPTED',
      acceptedPlayerId: input.player.userId,
      acceptedAt: input.now.toISOString(),
      finishedAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    for (const dispatchCandidate of this.candidates) {
      if (dispatchCandidate.dispatchAttemptId !== input.dispatchAttemptId) {
        continue;
      }
      dispatchCandidate.status = dispatchCandidate.playerUserId === input.player.userId ? 'ACCEPTED' : 'LOST_RACE';
      dispatchCandidate.respondedAt = input.now.toISOString();
      dispatchCandidate.updatedAt = input.now.toISOString();
    }
    this.outboxJobs.push(...input.outboxJobs.map(clone));
  }

  declineCandidate(input: {
    orderId: string;
    expectedVersion: number;
    player: PlayerProfileRecord;
    now: Date;
  }): void {
    const attempt = this.attempts.find((candidate) => candidate.orderId === input.orderId && candidate.status === 'ACTIVE');
    if (!attempt) {
      throw new DispatchError('CONFLICT', 'No active dispatch attempt exists for this order.');
    }
    const candidate = this.candidates.find((candidate) => {
      return candidate.dispatchAttemptId === attempt.id && candidate.playerUserId === input.player.userId;
    });
    if (!candidate || candidate.status !== 'NOTIFIED') {
      throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'Player is not an active candidate for this dispatch attempt.');
    }
    candidate.status = 'DECLINED';
    candidate.respondedAt = input.now.toISOString();
    candidate.updatedAt = input.now.toISOString();
  }

  markTimedOut(input: { dispatchAttemptId: string; now: Date }): DispatchAttemptRecord {
    const index = this.attempts.findIndex((attempt) => attempt.id === input.dispatchAttemptId);
    const attempt = index === -1 ? null : this.attempts[index];
    if (!attempt) {
      throw new DispatchError('NOT_FOUND', 'Dispatch attempt was not found.');
    }
    if (attempt.status !== 'ACTIVE') {
      throw new DispatchError('CONFLICT', 'Only active dispatch attempts can time out.');
    }
    if (Date.parse(attempt.expiresAt) > input.now.getTime()) {
      throw new DispatchError('CONFLICT', 'Dispatch attempt has not expired yet.');
    }
    const timedOut: DispatchAttemptRecord = {
      ...attempt,
      status: 'TIMED_OUT',
      finishedAt: input.now.toISOString(),
      updatedAt: input.now.toISOString()
    };
    this.attempts[index] = timedOut;
    for (const candidate of this.candidates) {
      if (candidate.dispatchAttemptId === input.dispatchAttemptId && candidate.status === 'NOTIFIED') {
        candidate.status = 'EXPIRED';
        candidate.updatedAt = input.now.toISOString();
      }
    }
    return clone(timedOut);
  }
}

export class InMemoryDispatchPlayerPool implements DispatchPlayerPool {
  private readonly profiles: PlayerProfileRecord[];

  constructor(input: { profiles: PlayerProfileRecord[] }) {
    this.profiles = input.profiles.map(clone);
  }

  listProfiles(input: { guildId: string | null }): PlayerProfileRecord[] {
    return this.profiles
      .filter((profile) => !input.guildId || profile.guildId === input.guildId)
      .map(clone);
  }
}

export class PostgresDispatchStore implements DispatchStore {
  private readonly client: DispatchQueryClient;
  private readonly pool: DispatchPool | null;

  constructor(input: { pool?: Pool; client?: DispatchQueryClient }) {
    const client = input.pool ?? input.client;
    if (!client) {
      throw new DispatchError('VALIDATION_ERROR', 'PostgresDispatchStore requires a pool or client.');
    }
    this.client = client;
    this.pool = input.pool ?? null;
  }

  async nextRound(orderId: string): Promise<number> {
    const result = await this.client.query<{ next_round: string }>(
      `
SELECT (COALESCE(MAX(round), 0) + 1)::text AS next_round
FROM dispatch_attempts
WHERE order_id = $1
      `,
      [orderId]
    );
    return Number(result.rows[0]?.next_round ?? 1);
  }

  async findAttempt(dispatchAttemptId: string): Promise<DispatchAttemptRecord | null> {
    const result = await this.client.query<DispatchAttemptRow>(
      `
SELECT *
FROM dispatch_attempts
WHERE id = $1
LIMIT 1
      `,
      [dispatchAttemptId]
    );
    return result.rows[0] ? mapDispatchAttemptRow(result.rows[0]) : null;
  }

  async commitDispatch(input: {
    attempt: DispatchAttemptRecord;
    candidates: DispatchCandidateRecord[];
    outboxJobs: OutboxJob[];
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      await transactionClient.query(
        `
INSERT INTO dispatch_attempts (
  id, order_id, order_requirement_id, round, status, dispatch_channel_id, dispatch_message_id,
  candidate_criteria, accepted_player_id, started_at, expires_at,
  accepted_at, finished_at, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5::"DispatchStatus", $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
        `,
        [
          input.attempt.id,
          input.attempt.orderId,
          input.attempt.orderRequirementId,
          input.attempt.round,
          input.attempt.status,
          input.attempt.dispatchChannelId,
          input.attempt.dispatchMessageId,
          JSON.stringify(input.attempt.candidateCriteria),
          input.attempt.acceptedPlayerId,
          input.attempt.startedAt,
          input.attempt.expiresAt,
          input.attempt.acceptedAt,
          input.attempt.finishedAt,
          input.attempt.createdAt,
          input.attempt.updatedAt
        ]
      );
      for (const candidate of input.candidates) {
        await transactionClient.query(
          `
INSERT INTO dispatch_candidates (
  dispatch_attempt_id, player_user_id, status, notified_at,
  responded_at, created_at, updated_at
)
VALUES ($1, $2, $3::"DispatchCandidateStatus", $4, $5, $6, $7)
          `,
          [
            candidate.dispatchAttemptId,
            candidate.playerUserId,
            candidate.status,
            candidate.notifiedAt,
            candidate.respondedAt,
            candidate.createdAt,
            candidate.updatedAt
          ]
        );
      }
      for (const job of input.outboxJobs) {
        await transactionClient.query(
          `
INSERT INTO outbox_events (
  id, event_type, aggregate_type, aggregate_id, order_id, dispatch_attempt_id,
  dedupe_key, payload, status, row_version, attempt_count, max_attempts,
  available_at, locked_at, locked_by, completed_at, last_error, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::"OutboxStatus", $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
          `,
          [
            job.id,
            job.type,
            job.aggregateType,
            job.aggregateId,
            input.attempt.orderId,
            input.attempt.id,
            job.dedupeKey,
            JSON.stringify(job.payload),
            job.status,
            job.version,
            job.attempts,
            job.maxAttempts,
            job.runAfter,
            job.lockedAt,
            job.lockedBy,
            job.completedAt,
            job.lastError,
            job.createdAt,
            job.updatedAt
          ]
        );
      }
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async commitAcceptance(input: {
    orderStore: OrderStore;
    order: OrderRecord;
    expectedVersion: number;
    dispatchAttemptId: string;
    orderRequirement: OrderDispatchRequirement | null;
    player: PlayerProfileRecord;
    outboxJobs: OutboxJob[];
    now: Date;
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const attempt = await transactionClient.query<DispatchAttemptRow>(
        `
SELECT *
FROM dispatch_attempts
WHERE id = $1
  AND order_id = $2
FOR UPDATE
        `,
        [input.dispatchAttemptId, input.order.id]
      );
      const attemptRow = attempt.rows[0];
      if (!attemptRow || attemptRow.status !== 'ACTIVE') {
        throw new DispatchError('CONFLICT', 'Dispatch attempt is not active.');
      }

      const candidate = await transactionClient.query(
        `
UPDATE dispatch_candidates
SET status = 'ACCEPTED',
    responded_at = $3,
    updated_at = $3
WHERE dispatch_attempt_id = $1
  AND player_user_id = $2
  AND status = 'NOTIFIED'
RETURNING player_user_id
        `,
        [input.dispatchAttemptId, input.player.userId, input.now.toISOString()]
      );
      if ((candidate.rowCount ?? 0) !== 1) {
        throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'Player is not an active candidate for this dispatch attempt.');
      }

      let allRequirementsFilled = true;
      if (input.orderRequirement) {
        if (attemptRow.order_requirement_id !== input.orderRequirement.id) {
          throw new DispatchError('CONFLICT', 'Dispatch attempt does not match the selected requirement.');
        }
        const requirement = await transactionClient.query<{
          id:string;service_catalog_version_id:string;requested_player_count:number;unit_count:number;
          customer_unit_price_minor_snapshot:string;game_code_snapshot:string;game_display_name_snapshot:string;
          service_code_snapshot:string;service_display_name_snapshot:string;region_code_snapshot:string|null;
          region_display_name_snapshot:string|null;billing_unit_minutes_snapshot:number;default_player_payout_bps:number;
          service_offering_id:string;display_name:string;compensation_type:'PERCENT_BPS'|'FIXED_MINOR'|null;compensation_value:string|null;
        }>(`SELECT requirement.*,version.default_player_payout_bps,version.service_offering_id,users.display_name,
          rule.type::text compensation_type,rule.value::text compensation_value
          FROM order_requirements requirement
          JOIN service_catalog_versions version ON version.id=requirement.service_catalog_version_id
          JOIN users ON users.id=$3
          JOIN player_profiles profile ON profile.user_id=users.id
          LEFT JOIN player_service_compensation_rules rule ON rule.player_id=profile.id AND rule.service_offering_id=version.service_offering_id
          WHERE requirement.id=$1 AND requirement.order_id=$2 AND requirement.status='ACTIVE' FOR UPDATE OF requirement`,
        [input.orderRequirement.id,input.order.id,input.player.userId]);
        const facts=requirement.rows[0];if(!facts)throw new DispatchError('CONFLICT','Order requirement is no longer active.');
        const occupied=await transactionClient.query<{count:string}>(`SELECT COUNT(*)::text count FROM order_participants WHERE order_requirement_id=$1 AND status='ACTIVE'`,[facts.id]);
        if(Number(occupied.rows[0]?.count??0)>=facts.requested_player_count)throw new DispatchError('CONFLICT','Order requirement slot is already filled.');
        const linePrice=Number(facts.customer_unit_price_minor_snapshot)*facts.unit_count;
        const compensationType=facts.compensation_type??'PERCENT_BPS';
        const compensationValue=Number(facts.compensation_value??facts.default_player_payout_bps);
        const expectedEarning=compensationType==='PERCENT_BPS'?Math.floor(linePrice*compensationValue/10000):compensationValue*facts.unit_count;
        if (!Number.isSafeInteger(expectedEarning) || expectedEarning < 0 || expectedEarning > linePrice) {
          throw new DispatchError('VALIDATION_ERROR', 'Player compensation must be a non-negative amount no greater than the requirement line price.');
        }
        const participantId=crypto.randomUUID();
        await transactionClient.query(`INSERT INTO order_participants (
          id,order_id,order_requirement_id,player_id,service_catalog_version_id,status,row_version,player_display_name_snapshot,
          game_code_snapshot,game_display_name_snapshot,service_code_snapshot,service_display_name_snapshot,region_code_snapshot,
          region_display_name_snapshot,billing_unit_minutes_snapshot,unit_count,customer_unit_price_minor_snapshot,line_price_minor,
          compensation_type_snapshot,compensation_value_snapshot,compensation_source,expected_earning_minor,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)`,
        [participantId,input.order.id,facts.id,input.player.userId,facts.service_catalog_version_id,facts.display_name,facts.game_code_snapshot,
          facts.game_display_name_snapshot,facts.service_code_snapshot,facts.service_display_name_snapshot,facts.region_code_snapshot,
          facts.region_display_name_snapshot,facts.billing_unit_minutes_snapshot,facts.unit_count,Number(facts.customer_unit_price_minor_snapshot),linePrice,
          compensationType,compensationValue,facts.compensation_type?'PLAYER_OVERRIDE':'CATALOG_DEFAULT',expectedEarning,input.now.toISOString()]);
        await transactionClient.query(`INSERT INTO order_participant_events (
          id,order_participant_id,sequence,event_type,participant_version,order_version,actor_user_id,snapshot,idempotency_key,created_at
        ) VALUES (gen_random_uuid(),$1,1,'ADDED',1,$2,$3,$4::jsonb,$5,$6)`,
        [participantId,input.expectedVersion+1,input.player.userId,JSON.stringify({orderRequirementId:facts.id,source:'DISPATCH_ACCEPTANCE'}),`dispatch:participant:${input.dispatchAttemptId}`,input.now.toISOString()]);
        const open=await transactionClient.query<{count:string}>(`SELECT COUNT(*)::text count FROM order_requirements requirement WHERE requirement.order_id=$1 AND requirement.status='ACTIVE' AND
          (SELECT COUNT(*) FROM order_participants participant WHERE participant.order_requirement_id=requirement.id AND participant.status='ACTIVE')<requirement.requested_player_count`,[input.order.id]);
        allRequirementsFilled=Number(open.rows[0]?.count??0)===0;
        await transactionClient.query("SELECT set_config('app.order_acceptance_payout_update', 'approved', true)");
        const order=await transactionClient.query(`UPDATE orders SET status=CASE WHEN $4 THEN 'ACCEPTED'::"OrderStatus" ELSE status END,
          player_id=COALESCE(player_id,$3),active_player_slot_id=CASE WHEN $4 THEN COALESCE(player_id,$3) ELSE active_player_slot_id END,
          row_version=row_version+1,accepted_at=CASE WHEN $4 THEN $5 ELSE accepted_at END,
          readiness_due_at=CASE WHEN $4 THEN $6 ELSE readiness_due_at END,updated_at=$5
          WHERE id=$1 AND status='PENDING_DISPATCH' AND row_version=$2 RETURNING id`,
        [input.order.id,input.expectedVersion,input.player.userId,allRequirementsFilled,input.now.toISOString(),new Date(input.now.getTime()+10*60_000).toISOString()]);
        if((order.rowCount??0)!==1)throw new DispatchError('CONFLICT','Order version is stale.');
      } else {
        await transactionClient.query("SELECT set_config('app.order_acceptance_payout_update', 'approved', true)");
        const order = await transactionClient.query(
        `
UPDATE orders
SET status = 'ACCEPTED',
    player_id = $4,
    active_player_slot_id = $4,
    player_unit_payout_minor = $7,
    expected_player_earning_minor = $8,
    row_version = row_version + 1,
    accepted_at = $5,
    readiness_due_at = $6,
    updated_at = $5
WHERE id = $1
  AND status = 'PENDING_DISPATCH'
  AND row_version = $2
  AND player_id IS NULL
  AND active_player_slot_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM dispatch_attempts
    WHERE id = $3
      AND order_id = orders.id
      AND status = 'ACTIVE'
  )
RETURNING id
        `,
        [
          input.order.id,
          input.expectedVersion,
          input.dispatchAttemptId,
          input.player.userId,
          input.now.toISOString(),
          new Date(input.now.getTime() + 10 * 60_000).toISOString()
          ,input.order.playerUnitPayoutMinor,
          input.order.playerEarningMinor
        ]
      );
      if ((order.rowCount ?? 0) !== 1) {
        throw new DispatchError('CONFLICT', 'Order has already been accepted.');
      }
      }

      await transactionClient.query(
        `
UPDATE dispatch_candidates
SET status = 'LOST_RACE',
    responded_at = $2,
    updated_at = $2
WHERE dispatch_attempt_id = $1
  AND player_user_id <> $3
  AND status = 'NOTIFIED'
        `,
        [input.dispatchAttemptId, input.now.toISOString(), input.player.userId]
      );
      await transactionClient.query(
        `
UPDATE dispatch_attempts
SET status = 'ACCEPTED',
    accepted_player_id = $2,
    accepted_at = $3,
    finished_at = $3,
    updated_at = $3
WHERE id = $1
        `,
        [input.dispatchAttemptId, input.player.userId, input.now.toISOString()]
      );
      for (const job of input.outboxJobs.filter((job) => allRequirementsFilled || job.type !== 'READINESS_TIMEOUT')) {
        await insertOutboxJob(transactionClient, job, {
          orderId: input.order.id,
          dispatchAttemptId: input.dispatchAttemptId
        });
      }
      if (input.orderRequirement && !allRequirementsFilled) {
        await insertOutboxJob(transactionClient, buildOutboxJob({
          type: 'DISPATCH_START',
          aggregateId: input.order.id,
          dedupeKey: `requirement-slot-next:${input.dispatchAttemptId}`,
          payload: { orderId: input.order.id, expectedVersion: input.expectedVersion + 1, trigger: 'ORDER_SUBMITTED' },
          runAfter: input.now.toISOString(),
          now: input.now
        }), { orderId: input.order.id, dispatchAttemptId: input.dispatchAttemptId });
      }
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresDispatchError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async declineCandidate(input: {
    orderId: string;
    expectedVersion: number;
    player: PlayerProfileRecord;
    now: Date;
  }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const candidate = await transactionClient.query(
        `
WITH active_attempt AS (
  SELECT attempt.id
  FROM dispatch_attempts AS attempt
  JOIN orders ON orders.id = attempt.order_id
  WHERE attempt.order_id = $1
    AND attempt.status = 'ACTIVE'
    AND orders.status = 'PENDING_DISPATCH'
    AND orders.row_version = $2
  ORDER BY attempt.round DESC
  LIMIT 1
  FOR UPDATE OF attempt
)
UPDATE dispatch_candidates
SET status = 'DECLINED',
    responded_at = $4,
    updated_at = $4
WHERE dispatch_attempt_id = (SELECT id FROM active_attempt)
  AND player_user_id = $3
  AND status = 'NOTIFIED'
RETURNING player_user_id
        `,
        [input.orderId, input.expectedVersion, input.player.userId, input.now.toISOString()]
      );
      if ((candidate.rowCount ?? 0) !== 1) {
        throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'Player is not an active candidate for this dispatch attempt.');
      }
      await transactionClient.query('COMMIT');
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw mapPostgresDispatchError(error);
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }

  async markTimedOut(input: { dispatchAttemptId: string; now: Date }): Promise<DispatchAttemptRecord> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      const result = await transactionClient.query<DispatchAttemptRow>(
        `
UPDATE dispatch_attempts
SET status = 'TIMED_OUT',
    finished_at = $2,
    updated_at = $2
WHERE id = $1
  AND status = 'ACTIVE'
  AND expires_at <= $2
RETURNING *
        `,
        [input.dispatchAttemptId, input.now.toISOString()]
      );
      const row = result.rows[0];
      if (!row) {
        throw new DispatchError('CONFLICT', 'Dispatch attempt is not active or not expired.');
      }
      await transactionClient.query(
        `
UPDATE dispatch_candidates
SET status = 'EXPIRED',
    updated_at = $2
WHERE dispatch_attempt_id = $1
  AND status = 'NOTIFIED'
        `,
        [input.dispatchAttemptId, input.now.toISOString()]
      );
      await transactionClient.query('COMMIT');
      return mapDispatchAttemptRow(row);
    } catch (error) {
      await transactionClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if ('release' in transactionClient && typeof transactionClient.release === 'function') {
        transactionClient.release();
      }
    }
  }
}

export class PostgresDispatchPlayerPool implements DispatchPlayerPool {
  private readonly client: DispatchQueryClient;

  constructor(input: { pool?: Pool; client?: DispatchQueryClient }) {
    const client = input.pool ?? input.client;
    if (!client) {
      throw new DispatchError('VALIDATION_ERROR', 'PostgresDispatchPlayerPool requires a pool or client.');
    }
    this.client = client;
  }

  async listProfiles(input: { guildId: string | null }): Promise<PlayerProfileRecord[]> {
    const values: unknown[] = [activePlayerOrderStatuses];
    const guildPredicate = input.guildId ? 'WHERE discord.guild_id = $2' : '';
    if (input.guildId) {
      values.push(input.guildId);
    }
    const result = await this.client.query<PlayerProfileRow>(
      `
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
         WHERE (active_order.active_player_slot_id = profile.user_id OR EXISTS (
             SELECT 1 FROM order_participants active_participant
             WHERE active_participant.order_id=active_order.id
               AND active_participant.player_id=profile.user_id
               AND active_participant.status='ACTIVE'
           ))
           AND active_order.status = ANY($1::"OrderStatus"[])
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
${guildPredicate}
GROUP BY profile.id, discord.guild_id, discord.discord_user_id, users.status
      `,
      values
    );
    return result.rows.map(mapPlayerProfileRow);
  }
}

export async function dispatchOrder(input: {
  orderStore: OrderStore;
  dispatchStore: DispatchStore;
  playerPool: DispatchPlayerPool;
  orderId: string;
  expectedVersion: number;
  trigger: DispatchTrigger;
  dispatchChannelId: string;
  botConfigStore?: BotConfigStore;
  idempotencyKey: string;
  now: Date;
  timeoutMinutes?: number;
  manualTargetDiscordUserIds?: string[];
  requireManualCandidates?: boolean;
}): Promise<DispatchResult> {
  const order = await requireDispatchableOrder(input.orderStore, input.orderId, input.expectedVersion);
  const dispatchChannelId=await resolveBotConfigString(input.botConfigStore,order.guildId,'dispatch_channel_id',input.dispatchChannelId);
  const openRequirement = await input.orderStore.getNextOpenRequirement?.(order.id) ?? null;
  const requirement = openRequirement ? { game: openRequirement.game, service: openRequirement.service } : requireOrderRequirement(order);
  const pool = await input.playerPool.listProfiles({ guildId: order.guildId ?? null });
  const assignedPlayerIds=new Set(await input.orderStore.getActiveParticipantPlayerIds?.(order.id)??[]);
  const eligibleCandidates = selectEligibleDispatchCandidates(pool, requirement).filter((candidate)=>!assignedPlayerIds.has(candidate.userId));
  const candidates = input.trigger === 'MANUAL_RETRY'
    ? selectManualDispatchCandidates(eligibleCandidates, input.manualTargetDiscordUserIds ?? [])
    : prioritizeDispatchCandidates(eligibleCandidates, order.preferredPlayerDiscordUserIds ?? [], input.trigger);
  if (input.requireManualCandidates && candidates.length === 0) throw new DispatchError('VALIDATION_ERROR', 'No eligible players are currently available for manual dispatch.');
  const round = await input.dispatchStore.nextRound(order.id);
  const attemptId = crypto.randomUUID();
  const expiresAt = new Date(input.now.getTime() + (input.timeoutMinutes ?? 5) * 60_000).toISOString();
  const attempt: DispatchAttemptRecord = {
    id: attemptId,
    orderId: order.id,
    orderRequirementId: openRequirement?.id ?? null,
    round,
    status: 'ACTIVE',
    dispatchChannelId,
    dispatchMessageId: null,
    candidateCriteria: {
      ...requirement,
      guildId: order.guildId ?? null,
      trigger: input.trigger
    },
    acceptedPlayerId: null,
    startedAt: input.now.toISOString(),
    expiresAt,
    acceptedAt: null,
    finishedAt: null,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString()
  };
  const candidateRecords = candidates.map((candidate) => ({
    dispatchAttemptId: attemptId,
    playerUserId: candidate.userId,
    status: 'NOTIFIED' as const,
    notifiedAt: input.now.toISOString(),
    respondedAt: null,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString()
  }));
  const outboxJobs = buildDispatchOutboxJobs({
    attempt,
    order,
    orderRequirement: openRequirement,
    candidatePlayerUserIds: candidateRecords.map((candidate) => candidate.playerUserId),
    idempotencyKey: input.idempotencyKey,
    now: input.now
  });
  await input.dispatchStore.commitDispatch({ attempt, candidates: candidateRecords, outboxJobs });
  return {
    dispatchAttemptId: attempt.id,
    orderId: order.id,
    status: 'OPEN',
    candidateCount: candidateRecords.length,
    expiresAt
  };
}

export function selectManualDispatchCandidates(
  eligibleCandidates: PlayerProfileRecord[],
  targetDiscordUserIds: string[]
): PlayerProfileRecord[] {
  if (targetDiscordUserIds.length === 0) return eligibleCandidates;
  if (targetDiscordUserIds.length > 3) throw new DispatchError('VALIDATION_ERROR', 'Manual dispatch supports at most three selected players.');
  if (new Set(targetDiscordUserIds).size !== targetDiscordUserIds.length) throw new DispatchError('VALIDATION_ERROR', 'Manual dispatch contains a duplicate selected player.');
  const byDiscordId = new Map(eligibleCandidates.map((candidate) => [candidate.discordUserId, candidate]));
  const selected = targetDiscordUserIds.map((discordUserId) => byDiscordId.get(discordUserId));
  if (selected.some((candidate) => !candidate)) throw new DispatchError('VALIDATION_ERROR', 'A selected player is no longer eligible.');
  return selected as PlayerProfileRecord[];
}

export async function listManualDispatchCandidates(input: {
  orderStore: OrderStore;
  playerPool: DispatchPlayerPool;
  orderId: string;
}): Promise<{ items: Array<{ playerId: string; discordUserId: string; gameTags: string[]; serviceTags: string[] }> }> {
  const order = await input.orderStore.findById(input.orderId);
  if (!order) throw new DispatchError('NOT_FOUND', 'Order was not found.');
  if (order.status !== 'PENDING_DISPATCH' || order.playerId) throw new DispatchError('CONFLICT', 'Order cannot be dispatched from its current state.');
  const requirement = requireOrderRequirement(order);
  const pool = await input.playerPool.listProfiles({ guildId: order.guildId ?? null });
  const items = selectEligibleDispatchCandidates(pool, requirement).map((candidate) => ({
    playerId: candidate.playerId,
    discordUserId: candidate.discordUserId,
    gameTags: candidate.gameTags,
    serviceTags: candidate.serviceTags
  }));
  return { items };
}

export function prioritizeDispatchCandidates(
  eligibleCandidates: PlayerProfileRecord[],
  preferredDiscordUserIds: string[],
  trigger: DispatchTrigger
): PlayerProfileRecord[] {
  if (trigger !== 'ORDER_SUBMITTED' || preferredDiscordUserIds.length === 0) return eligibleCandidates;
  const byDiscordId = new Map(eligibleCandidates.map((candidate) => [candidate.discordUserId, candidate]));
  const preferred = preferredDiscordUserIds
    .slice(0, 3)
    .map((discordUserId) => byDiscordId.get(discordUserId))
    .filter((candidate): candidate is PlayerProfileRecord => Boolean(candidate));
  return preferred.length > 0 ? preferred : eligibleCandidates;
}

export async function expireDispatchAttempt(input: {
  orderStore: OrderStore;
  dispatchStore: DispatchStore;
  dispatchAttemptId: string;
  now: Date;
}): Promise<DispatchTimeoutResult> {
  const current = await input.dispatchStore.findAttempt(input.dispatchAttemptId);
  if (!current) {
    throw new DispatchError('NOT_FOUND', 'Dispatch attempt was not found.');
  }
  const order = await input.orderStore.findById(current.orderId);
  if (!order) {
    throw new DispatchError('NOT_FOUND', 'Order was not found.');
  }
  if (isDispatchAutomationPaused(order)) {
    return {
      dispatchAttemptId: current.id,
      orderId: order.id,
      status: 'AUTOMATION_PAUSED',
      orderStatus: order.status
    };
  }
  const timedOut = await input.dispatchStore.markTimedOut({
    dispatchAttemptId: input.dispatchAttemptId,
    now: input.now
  });
  return {
    dispatchAttemptId: timedOut.id,
    orderId: timedOut.orderId,
    status: 'DISPATCH_TIMEOUT',
    orderStatus: order.status
  };
}

export async function acceptOrder(input: {
  orderStore: OrderStore;
  dispatchStore: DispatchStore;
  playerPool: DispatchPlayerPool;
  orderId: string;
  expectedVersion: number;
  dispatchAttemptId: string;
  orderRequirementId?: string | null;
  actor: { guildId: string; discordUserId: string };
  idempotencyKey: string;
  now: Date;
  compensationStore?: PlayerCompensationStore;
}): Promise<AcceptedOrderResult> {
  const order = await requireDispatchableOrder(input.orderStore, input.orderId, input.expectedVersion);
  const attempt = await input.dispatchStore.findAttempt(input.dispatchAttemptId);
  if (!attempt || attempt.orderId !== order.id || (input.orderRequirementId && attempt.orderRequirementId !== input.orderRequirementId)) {
    throw new DispatchError('CONFLICT', 'Dispatch attempt does not match the selected requirement.');
  }
  const selectedRequirementId = input.orderRequirementId ?? attempt.orderRequirementId ?? null;
  const orderRequirement = selectedRequirementId
    ? await input.orderStore.getDispatchRequirement?.(order.id, selectedRequirementId) ?? null
    : null;
  if (attempt.orderRequirementId && (!orderRequirement || orderRequirement.filledPlayerCount >= orderRequirement.requestedPlayerCount)) {
    throw new DispatchError('CONFLICT', 'The selected requirement has no open player slot.');
  }
  const player = await requireActorPlayer(input.playerPool, input.actor);
  if (orderRequirement
    ? selectEligibleDispatchCandidates([player], { game: orderRequirement.game, service: orderRequirement.service }).length !== 1
    : !isPlayerEligibleForOrder(player, order)) {
    throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'Player is not eligible for this order.');
  }
  let acceptedOrder=order;
  if(input.compensationStore?.findForCatalog&&order.serviceCatalogId&&order.customerUnitPriceMinor&&order.playerUnitPayoutMinor&&order.unitCount){const rule=await input.compensationStore.findForCatalog(player.playerId,order.serviceCatalogId);const defaultPayoutBps=Math.floor(order.playerUnitPayoutMinor*10000/order.customerUnitPriceMinor);const compensation=calculatePlayerCompensation({customerUnitPriceMinor:order.customerUnitPriceMinor,unitCount:order.unitCount,defaultPayoutBps,rule});acceptedOrder={...order,playerUnitPayoutMinor:compensation.unitPayoutMinor,playerEarningMinor:compensation.totalPayoutMinor};}
  await input.dispatchStore.commitAcceptance({
    orderStore: input.orderStore,
    order:acceptedOrder,
    expectedVersion: input.expectedVersion,
    dispatchAttemptId: input.dispatchAttemptId,
    orderRequirement,
    player,
    outboxJobs: [
      buildAcceptedOrderOutboxJob({
        order:acceptedOrder,
        player,
        dispatchAttemptId: input.dispatchAttemptId,
        idempotencyKey: input.idempotencyKey,
        now: input.now
      }),
      buildReadinessTimeoutJob({ order, idempotencyKey: input.idempotencyKey, now: input.now })
    ],
    now: input.now
  });
  const allFilled = !orderRequirement || orderRequirement.filledPlayerCount + 1 >= orderRequirement.requestedPlayerCount
    && !(await input.orderStore.getNextOpenRequirement?.(order.id));
  return {
    id: order.id,
    publicId: order.publicId,
    status: allFilled ? 'ACCEPTED' : 'PENDING_DISPATCH',
    version: order.version + 1,
    playerId: player.userId,
    channelSpec: order.channelSpec
  };
}

export async function declineOrderOffer(input: {
  orderStore: OrderStore;
  dispatchStore: DispatchStore;
  playerPool: DispatchPlayerPool;
  orderId: string;
  expectedVersion: number;
  actor: { guildId: string; discordUserId: string };
  now: Date;
}): Promise<OrderRecord> {
  const order = await requireDispatchableOrder(input.orderStore, input.orderId, input.expectedVersion);
  const player = await requireActorPlayer(input.playerPool, input.actor);
  await input.dispatchStore.declineCandidate({
    orderId: order.id,
    expectedVersion: input.expectedVersion,
    player,
    now: input.now
  });
  return order;
}

export function registerDispatchRoutes(
  server: FastifyInstance,
  options: {
    orderStore: OrderStore;
    dispatchStore: DispatchStore;
    playerPool: DispatchPlayerPool;
    dispatchChannelId: string;
    now?: () => Date;
    policyReader?: PolicyReader;
    botConfigStore?: BotConfigStore;
    compensationStore?: PlayerCompensationStore;
  }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Dispatch routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());
  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/dispatch',
    permission: 'dispatch.execute',
    action: 'DISPATCH_ORDER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['SYSTEM_JOB'],
    handler: async (request) => {
      const body = parseDispatchOrderBody(request.body);
      const timeoutMinutes = await options.policyReader?.getPolicyInteger('DISPATCH_TIMEOUT_MINUTES', 5) ?? 5;
      return dispatchOrder({
        orderStore: options.orderStore,
        dispatchStore: options.dispatchStore,
        playerPool: options.playerPool,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        trigger: body.trigger,
        dispatchChannelId: options.dispatchChannelId,
        botConfigStore:options.botConfigStore,
        idempotencyKey: idempotencyKey(request),
        now: now(),
        timeoutMinutes
      });
    },
    mapError: mapDispatchError,
    fingerprintBody: (request) => parseDispatchOrderBody(request.body)
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/orders/:orderId/dispatch-candidates',
    permission: 'dispatch.manual',
    action: 'LIST_MANUAL_DISPATCH_CANDIDATES',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DASHBOARD'],
    handler: (request) => listManualDispatchCandidates({ orderStore: options.orderStore, playerPool: options.playerPool, orderId: orderIdParam(request) }),
    mapError: mapDispatchError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/orders/:orderId/manual-dispatch',
    permission: 'dispatch.manual',
    action: 'MANUAL_DISPATCH_ORDER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DASHBOARD'],
    handler: async (request) => {
      const body = parseManualDispatchBody(request.body);
      return dispatchOrder({
        orderStore: options.orderStore, dispatchStore: options.dispatchStore, playerPool: options.playerPool,
        orderId: orderIdParam(request), expectedVersion: body.expectedVersion, trigger: 'MANUAL_RETRY',
        dispatchChannelId: options.dispatchChannelId, botConfigStore: options.botConfigStore,
        idempotencyKey: idempotencyKey(request), now: now(), timeoutMinutes: 1.5,
        manualTargetDiscordUserIds: body.targetDiscordUserIds
        ,requireManualCandidates: true
      });
    },
    mapError: mapDispatchError,
    fingerprintBody: (request) => parseManualDispatchBody(request.body)
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/accept',
    permission: 'order.accept',
    action: 'ACCEPT_ORDER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DISCORD_BOT'],
    handler: async (request, actor) => {
      const body = parseAcceptOrderBody(request.body);
      if (!actor.guildId || !actor.discordUserId) {
        throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'Discord actor context is required.');
      }
      return acceptOrder({
        orderStore: options.orderStore,
        dispatchStore: options.dispatchStore,
        playerPool: options.playerPool,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        dispatchAttemptId: body.dispatchAttemptId,
        orderRequirementId: body.orderRequirementId,
        actor: { guildId: actor.guildId, discordUserId: actor.discordUserId },
        idempotencyKey: idempotencyKey(request),
        now: now()
        ,compensationStore:options.compensationStore
      });
    },
    mapError: mapDispatchError,
    fingerprintBody: (request) => parseAcceptOrderBody(request.body)
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/orders/:orderId/decline',
    permission: 'order.accept',
    action: 'DECLINE_ORDER_OFFER',
    targetType: 'order',
    targetId: (request) => orderIdParam(request),
    acceptedSources: ['DISCORD_BOT'],
    handler: async (request, actor) => {
      const body = parseOrderVersionBody(request.body);
      if (!actor.guildId || !actor.discordUserId) {
        throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'Discord actor context is required.');
      }
      return declineOrderOffer({
        orderStore: options.orderStore,
        dispatchStore: options.dispatchStore,
        playerPool: options.playerPool,
        orderId: orderIdParam(request),
        expectedVersion: body.expectedVersion,
        actor: { guildId: actor.guildId, discordUserId: actor.discordUserId },
        now: now()
      });
    },
    mapError: mapDispatchError,
    fingerprintBody: (request) => parseOrderVersionBody(request.body)
  });
}

function buildDispatchOutboxJobs(input: {
  attempt: DispatchAttemptRecord;
  order: OrderRecord;
  orderRequirement: OrderDispatchRequirement | null;
  candidatePlayerUserIds: string[];
  idempotencyKey: string;
  now: Date;
}): OutboxJob[] {
  const basePayload = {
    dispatchAttemptId: input.attempt.id,
    dispatchChannelId: input.attempt.dispatchChannelId,
    orderId: input.order.id,
    orderPublicId: input.order.publicId,
    orderVersion: input.order.version,
    orderRequirementId: input.orderRequirement?.id ?? null,
    game: input.orderRequirement?.game ?? input.order.gameDisplayName ?? input.order.game,
    service: input.orderRequirement?.service ?? input.order.serviceDisplayName ?? input.order.service,
    region: input.orderRequirement?.region ?? input.order.regionDisplayName ?? input.order.region,
    durationLabel: input.orderRequirement ? `${input.orderRequirement.billingUnitMinutes * input.orderRequirement.unitCount} 分钟` : formatDuration(input.order),
    playerEarningMinor: input.order.playerEarningMinor,
    currency: input.order.currency,
    notes: input.order.notes,
    expiresAt: input.attempt.expiresAt,
    voiceChannelId: input.order.channelSpec.voiceChannelId,
    candidatePlayerUserIds: input.candidatePlayerUserIds
  };
  return [
    buildOutboxJob({
      type: 'DISPATCH_MESSAGE',
      aggregateId: input.attempt.id,
      dedupeKey: `${input.idempotencyKey}:message`,
      payload: basePayload,
      runAfter: input.now.toISOString(),
      now: input.now
    }),
    buildOutboxJob({
      type: 'DISPATCH_TIMEOUT',
      aggregateId: input.attempt.id,
      dedupeKey: `${input.idempotencyKey}:timeout`,
      payload: { dispatchAttemptId: input.attempt.id, orderId: input.order.id },
      runAfter: input.attempt.expiresAt,
      now: input.now
    })
  ];
}

function buildOutboxJob(input: {
  type: 'DISPATCH_MESSAGE' | 'DISPATCH_TIMEOUT' | 'DISPATCH_START';
  aggregateId: string;
  dedupeKey: string;
  payload: unknown;
  runAfter: string;
  now: Date;
}): OutboxJob {
  return {
    id: crypto.randomUUID(),
    type: input.type,
    status: 'PENDING',
    payload: input.payload,
    aggregateType: 'dispatch_attempt',
    aggregateId: input.aggregateId,
    dedupeKey: input.dedupeKey,
    attempts: 0,
    maxAttempts: input.type === 'DISPATCH_TIMEOUT' ? 1 : 8,
    runAfter: input.runAfter,
    lockedAt: null,
    lockedBy: null,
    completedAt: null,
    lastError: null,
    version: 1,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString()
  };
}

function buildAcceptedOrderOutboxJob(input: {
  order: OrderRecord;
  player: PlayerProfileRecord;
  dispatchAttemptId: string;
  idempotencyKey: string;
  now: Date;
}): OutboxJob {
  return {
    id: crypto.randomUUID(),
    type: 'PANEL_SYNC',
    status: 'PENDING',
    payload: {
      kind: 'ORDER_ACCEPTED_CHANNEL_SYNC',
      orderId: input.order.id,
      dispatchAttemptId: input.dispatchAttemptId,
      acceptedPlayerUserId: input.player.userId,
      acceptedPlayerDiscordUserId: input.player.discordUserId,
      channelId: input.order.channelSpec.channelId,
      panelMessageId: input.order.channelSpec.panelMessageId
    },
    aggregateType: 'order',
    aggregateId: input.order.id,
    dedupeKey: `${input.idempotencyKey}:channel-sync`,
    attempts: 0,
    maxAttempts: 8,
    runAfter: input.now.toISOString(),
    lockedAt: null,
    lockedBy: null,
    completedAt: null,
    lastError: null,
    version: 1,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString()
  };
}

function buildReadinessTimeoutJob(input: {
  order: OrderRecord;
  idempotencyKey: string;
  now: Date;
}): OutboxJob {
  const readinessDueAt = new Date(input.now.getTime() + 10 * 60_000).toISOString();
  return {
    id: crypto.randomUUID(),
    type: 'READINESS_TIMEOUT',
    status: 'PENDING',
    payload: { orderId: input.order.id, readinessDueAt },
    aggregateType: 'order',
    aggregateId: input.order.id,
    dedupeKey: `${input.idempotencyKey}:readiness-timeout`,
    attempts: 0,
    maxAttempts: 3,
    runAfter: readinessDueAt,
    lockedAt: null,
    lockedBy: null,
    completedAt: null,
    lastError: null,
    version: 1,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString()
  };
}

async function requireDispatchableOrder(
  orderStore: OrderStore,
  orderId: string,
  expectedVersion: number
): Promise<OrderRecord> {
  const order = await orderStore.findById(orderId);
  if (!order) {
    throw new DispatchError('NOT_FOUND', 'Order was not found.');
  }
  const hasOpenMultiRequirement = orderStore.getNextOpenRequirement
    ? Boolean(await orderStore.getNextOpenRequirement(order.id))
    : false;
  if (order.status !== 'PENDING_DISPATCH' || order.version !== expectedVersion || (order.playerId && !hasOpenMultiRequirement)) {
    throw new DispatchError('CONFLICT', 'Order cannot be dispatched from its current state.');
  }
  if (isDispatchAutomationPaused(order)) {
    throw new DispatchError('AUTOMATION_PAUSED', 'Order automation is paused for staff takeover.');
  }
  return order;
}

function isDispatchAutomationPaused(order: OrderRecord): boolean {
  return order.automationState === 'PAUSED'
    && (!order.automationScope || order.automationScope === 'ALL' || order.automationScope === 'DISPATCH');
}

function requireOrderRequirement(order: OrderRecord): { game: string; service: string } {
  if (!order.game || !order.service) {
    throw new DispatchError('VALIDATION_ERROR', 'Order is missing game or service requirements.');
  }
  return { game: order.game, service: order.service };
}

function parseDispatchOrderBody(body: unknown): { expectedVersion: number; trigger: DispatchTrigger } {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    trigger: enumValue(input.trigger, ['ORDER_SUBMITTED', 'MANUAL_RETRY', 'TIMEOUT_RETRY'], 'trigger')
  };
}

function parseManualDispatchBody(body: unknown): { expectedVersion: number; targetDiscordUserIds: string[] } {
  const input = objectBody(body);
  const values = input.targetDiscordUserIds === undefined ? [] : stringArray(input.targetDiscordUserIds, 'targetDiscordUserIds');
  if (values.length > 3) throw new DispatchError('VALIDATION_ERROR', 'Manual dispatch supports at most three selected players.');
  if (new Set(values).size !== values.length) throw new DispatchError('VALIDATION_ERROR', 'Manual dispatch contains duplicate players.');
  if (values.some((value) => !/^\d{17,20}$/.test(value))) throw new DispatchError('VALIDATION_ERROR', 'Manual dispatch player IDs must be Discord Snowflakes.');
  return { expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'), targetDiscordUserIds: values };
}

function parseAcceptOrderBody(body: unknown): { expectedVersion: number; dispatchAttemptId: string; orderRequirementId: string | null } {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion'),
    dispatchAttemptId: stringValue(input.dispatchAttemptId, 'dispatchAttemptId'),
    orderRequirementId: input.orderRequirementId === undefined || input.orderRequirementId === null
      ? null
      : stringValue(input.orderRequirementId, 'orderRequirementId')
  };
}

function parseOrderVersionBody(body: unknown): { expectedVersion: number } {
  const input = objectBody(body);
  return {
    expectedVersion: positiveInteger(input.expectedVersion, 'expectedVersion')
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DispatchError('VALIDATION_ERROR', 'Request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new DispatchError('VALIDATION_ERROR', `${field} must be a positive integer.`);
  }
  return value as number;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DispatchError('VALIDATION_ERROR', `${field} is invalid.`);
  }
  return value as T;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DispatchError('VALIDATION_ERROR', `${field} must be a non-empty string.`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new DispatchError('VALIDATION_ERROR', `${field} must be an array of strings.`);
  }
  return value.map((item) => item.trim());
}

function orderIdParam(request: FastifyRequest): string {
  const params = request.params as { orderId?: string };
  return params.orderId ?? '';
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

async function requireActorPlayer(
  playerPool: DispatchPlayerPool,
  actor: { guildId: string; discordUserId: string }
): Promise<PlayerProfileRecord> {
  const players = await playerPool.listProfiles({ guildId: actor.guildId });
  const player = players.find((candidate) => {
    return candidate.guildId === actor.guildId && candidate.discordUserId === actor.discordUserId;
  });
  if (!player) {
    throw new DispatchError('PLAYER_NOT_ELIGIBLE', 'No player profile is bound to this actor.');
  }
  return player;
}

function isPlayerEligibleForOrder(player: PlayerProfileRecord, order: OrderRecord): boolean {
  return selectEligibleDispatchCandidates([player], requireOrderRequirement(order)).length === 1;
}

function mutableOrderList(orderStore: OrderStore): OrderRecord[] {
  const candidate = orderStore as { orders?: OrderRecord[] };
  if (!Array.isArray(candidate.orders)) {
    throw new DispatchError('VALIDATION_ERROR', 'Order store does not support in-memory acceptance.');
  }
  return candidate.orders;
}

function mapDispatchError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof DispatchError)) {
    return null;
  }
  if (error.code === 'NOT_FOUND') {
    return { statusCode: 404, code: error.code, message: error.message };
  }
  if (error.code === 'CONFLICT') {
    return { statusCode: 409, code: error.code, message: error.message };
  }
  if (error.code === 'PLAYER_NOT_ELIGIBLE') {
    return { statusCode: 422, code: error.code, message: error.message };
  }
  return { statusCode: 422, code: error.code, message: error.message };
}

async function insertOutboxJob(
  client: DispatchQueryClient,
  job: OutboxJob,
  refs: { orderId: string | null; dispatchAttemptId: string | null }
): Promise<void> {
  await client.query(
    `
INSERT INTO outbox_events (
  id, event_type, aggregate_type, aggregate_id, order_id, dispatch_attempt_id,
  dedupe_key, payload, status, row_version, attempt_count, max_attempts,
  available_at, locked_at, locked_by, completed_at, last_error, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::"OutboxStatus", $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
    `,
    [
      job.id,
      job.type,
      job.aggregateType,
      job.aggregateId,
      refs.orderId,
      refs.dispatchAttemptId,
      job.dedupeKey,
      JSON.stringify(job.payload),
      job.status,
      job.version,
      job.attempts,
      job.maxAttempts,
      job.runAfter,
      job.lockedAt,
      job.lockedBy,
      job.completedAt,
      job.lastError,
      job.createdAt,
      job.updatedAt
    ]
  );
}

function mapPostgresDispatchError(error: unknown): unknown {
  if (error instanceof DispatchError) {
    return error;
  }
  if (isDatabaseError(error) && error.code === '23505') {
    if (String(error.constraint ?? '') === 'orders_active_player_slot_id_key') {
      return new DispatchError('PLAYER_NOT_ELIGIBLE', 'Player already has an active order.');
    }
    return new DispatchError('CONFLICT', 'Dispatch write conflicts with an existing record.');
  }
  return error;
}

function isDatabaseError(error: unknown): error is { code?: string; constraint?: string } {
  return Boolean(error && typeof error === 'object' && 'code' in error);
}

function formatDuration(order: OrderRecord): string {
  if (!order.billingUnitMinutes || !order.unitCount) {
    return '未填写';
  }
  const totalMinutes = order.billingUnitMinutes * order.unitCount;
  if (totalMinutes % 60 === 0) {
    return `${totalMinutes / 60} 小时`;
  }
  return `${totalMinutes} 分钟`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const activePlayerOrderStatuses = ['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'] as const;

function mapDispatchAttemptRow(row: DispatchAttemptRow): DispatchAttemptRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    orderRequirementId: row.order_requirement_id,
    round: row.round,
    status: row.status,
    dispatchChannelId: row.dispatch_channel_id,
    dispatchMessageId: row.dispatch_message_id,
    candidateCriteria: row.candidate_criteria,
    acceptedPlayerId: row.accepted_player_id,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    finishedAt: row.finished_at ? new Date(row.finished_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
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
    presenceObservedAt: row.presence_observed_at ? new Date(row.presence_observed_at).toISOString() : null,
    gameTags: [...row.game_tags].sort(),
    serviceTags: [...row.service_tags].sort(),
    activeOrderId: row.active_order_id,
    approvedByStaffId: row.approved_by_staff_id,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
    suspendedAt: row.suspended_at ? new Date(row.suspended_at).toISOString() : null,
    version: row.row_version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

interface DispatchAttemptRow {
  id: string;
  order_id: string;
  order_requirement_id: string | null;
  round: number;
  status: DispatchStatus;
  dispatch_channel_id: string;
  dispatch_message_id: string | null;
  candidate_criteria: DispatchAttemptRecord['candidateCriteria'];
  accepted_player_id: string | null;
  started_at: Date | string | null;
  expires_at: Date | string;
  accepted_at: Date | string | null;
  finished_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
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
