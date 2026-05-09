import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { registerSecureReadRoute, registerSecureWriteRoute, type ActorContext } from './security.js';

export type PlayerEarningStatus = 'PENDING' | 'CONFIRMED' | 'PAID' | 'REVERSED';
export type PlayerEarningAdjustmentType = 'REVERSAL_DEBIT' | 'CORRECTION_DEBIT' | 'CORRECTION_CREDIT';

export interface PlayerEarningAdjustmentRecord {
  id: string;
  playerEarningId: string;
  type: PlayerEarningAdjustmentType;
  sourceRefundId: string | null;
  sourceResolutionId: string | null;
  amountMinor: number;
  currency: string;
  reason: string;
  idempotencyKey: string;
  createdByStaffId: string | null;
  createdAt: string;
}

export interface PlayerEarningRecord {
  id: string;
  playerId: string;
  orderId: string;
  baseUnits: number;
  unitPayoutMinor: number;
  amountMinor: number;
  currency: string;
  status: PlayerEarningStatus;
  version: number;
  confirmedByStaffId: string | null;
  confirmedAt: string | null;
  paidAt: string | null;
  adjustments: PlayerEarningAdjustmentRecord[];
  netAmountMinor: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerEarningMutationInput {
  earningId: string;
  expectedVersion: number;
  action: 'CONFIRM' | 'MARK_PAID' | 'CREATE_REVERSAL';
  reversalAmount?: { amountMinor: number; currency: string };
  reason: string;
  idempotencyKey: string;
  actorStaffId: string;
  now: Date;
}

export interface PlayerEarningStore {
  resolvePlayerUserId(input: { guildId: string; discordUserId: string }): Promise<string | null> | string | null;
  list(input: { playerId?: string; status?: PlayerEarningStatus; limit: number }): Promise<PlayerEarningRecord[]> | PlayerEarningRecord[];
  mutate(input: PlayerEarningMutationInput): Promise<{ resultType: 'STATE_UPDATED' | 'ADJUSTMENT_CREATED'; playerEarning: PlayerEarningRecord; adjustment: PlayerEarningAdjustmentRecord | null }> |
    { resultType: 'STATE_UPDATED' | 'ADJUSTMENT_CREATED'; playerEarning: PlayerEarningRecord; adjustment: PlayerEarningAdjustmentRecord | null };
}

export class PlayerEarningError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PERMISSION_DENIED' | 'VALIDATION_ERROR' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'PlayerEarningError';
  }
}

export class InMemoryPlayerEarningStore implements PlayerEarningStore {
  readonly earnings: PlayerEarningRecord[];
  private readonly playerBindings: Record<string, string>;

  constructor(input: { earnings?: PlayerEarningRecord[]; playerBindings?: Record<string, string> } = {}) {
    this.earnings = clone(input.earnings ?? []);
    this.playerBindings = clone(input.playerBindings ?? {});
  }

  resolvePlayerUserId(input: { guildId: string; discordUserId: string }): string | null {
    return this.playerBindings[`${input.guildId}:${input.discordUserId}`] ?? null;
  }

  list(input: { playerId?: string; status?: PlayerEarningStatus; limit: number }): PlayerEarningRecord[] {
    return clone(this.earnings.filter((earning) => (!input.playerId || earning.playerId === input.playerId)
      && (!input.status || earning.status === input.status)).slice(0, input.limit));
  }

  mutate(input: PlayerEarningMutationInput) {
    const earning = this.earnings.find((candidate) => candidate.id === input.earningId);
    if (!earning) throw new PlayerEarningError('NOT_FOUND', 'Player earning was not found.');
    if (earning.version !== input.expectedVersion) throw new PlayerEarningError('CONFLICT', 'Player earning version is stale.');
    if (input.action === 'CONFIRM') {
      if (earning.status !== 'PENDING') throw new PlayerEarningError('CONFLICT', 'Only pending earnings can be confirmed.');
      Object.assign(earning, { status: 'CONFIRMED', version: earning.version + 1,
        confirmedByStaffId: input.actorStaffId, confirmedAt: input.now.toISOString(), updatedAt: input.now.toISOString() });
      return { resultType: 'STATE_UPDATED' as const, playerEarning: clone(earning), adjustment: null };
    }
    if (input.action === 'MARK_PAID') {
      if (earning.status !== 'CONFIRMED') throw new PlayerEarningError('CONFLICT', 'Only confirmed earnings can be marked paid.');
      Object.assign(earning, { status: 'PAID', version: earning.version + 1,
        paidAt: input.now.toISOString(), updatedAt: input.now.toISOString() });
      return { resultType: 'STATE_UPDATED' as const, playerEarning: clone(earning), adjustment: null };
    }
    const amount = requireReversal(input, earning);
    const existing = earning.adjustments.find((adjustment) => adjustment.idempotencyKey === input.idempotencyKey);
    if (existing) return { resultType: 'ADJUSTMENT_CREATED' as const, playerEarning: clone(earning), adjustment: clone(existing) };
    if (amount.amountMinor > earning.netAmountMinor) throw new PlayerEarningError('VALIDATION_ERROR', 'Reversal exceeds net earning.');
    const adjustment: PlayerEarningAdjustmentRecord = { id: deterministicUuid(`earning-adjustment:${input.idempotencyKey}`),
      playerEarningId: earning.id, type: 'REVERSAL_DEBIT', sourceRefundId: null, sourceResolutionId: null,
      amountMinor: amount.amountMinor, currency: amount.currency, reason: input.reason,
      idempotencyKey: input.idempotencyKey, createdByStaffId: input.actorStaffId, createdAt: input.now.toISOString() };
    earning.adjustments.push(adjustment);
    earning.netAmountMinor -= amount.amountMinor;
    earning.version += 1;
    earning.updatedAt = input.now.toISOString();
    return { resultType: 'ADJUSTMENT_CREATED' as const, playerEarning: clone(earning), adjustment: clone(adjustment) };
  }
}

export class PostgresPlayerEarningStore implements PlayerEarningStore {
  constructor(private readonly pool: Pool) {}

  async resolvePlayerUserId(input: { guildId: string; discordUserId: string }): Promise<string | null> {
    const result = await this.pool.query<{ user_id: string }>(`SELECT da.user_id FROM discord_accounts da
      WHERE da.guild_id = $1 AND da.discord_user_id = $2
      AND EXISTS (SELECT 1 FROM player_earnings pe WHERE pe.player_user_id = da.user_id)`, [input.guildId, input.discordUserId]);
    return result.rows[0]?.user_id ?? null;
  }

  async list(input: { playerId?: string; status?: PlayerEarningStatus; limit: number }): Promise<PlayerEarningRecord[]> {
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM player_earnings
      WHERE ($1::uuid IS NULL OR player_user_id = $1) AND ($2::text IS NULL OR status::text = $2)
      ORDER BY created_at DESC, id DESC LIMIT $3`, [input.playerId ?? null, input.status ?? null, input.limit]);
    return Promise.all(result.rows.map((row) => loadPlayerEarning(this.pool, row.id)));
  }

  async mutate(input: PlayerEarningMutationInput) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (input.action === 'CREATE_REVERSAL') {
        const replay = await client.query<{ player_earning_id: string }>(
          `SELECT player_earning_id FROM player_earning_adjustments WHERE idempotency_key = $1`, [input.idempotencyKey]);
        if (replay.rows[0]) {
          const earning = await loadPlayerEarning(client, replay.rows[0].player_earning_id, true);
          const adjustment = earning.adjustments.find((candidate) => candidate.idempotencyKey === input.idempotencyKey)!;
          await client.query('COMMIT');
          return { resultType: 'ADJUSTMENT_CREATED' as const, playerEarning: earning, adjustment };
        }
      }
      const earning = await loadPlayerEarning(client, input.earningId, true);
      if (earning.version !== input.expectedVersion) throw new PlayerEarningError('CONFLICT', 'Player earning version is stale.');
      if (input.action === 'CONFIRM') {
        if (earning.status !== 'PENDING') throw new PlayerEarningError('CONFLICT', 'Only pending earnings can be confirmed.');
        await client.query(`UPDATE player_earnings SET status='CONFIRMED', row_version=row_version+1,
          confirmed_by_staff_id=$2, confirmed_at=$3, updated_at=$3 WHERE id=$1`, [earning.id, input.actorStaffId, input.now]);
        const updated = await loadPlayerEarning(client, earning.id);
        await client.query('COMMIT');
        return { resultType: 'STATE_UPDATED' as const, playerEarning: updated, adjustment: null };
      }
      if (input.action === 'MARK_PAID') {
        if (earning.status !== 'CONFIRMED') throw new PlayerEarningError('CONFLICT', 'Only confirmed earnings can be marked paid.');
        await client.query(`UPDATE player_earnings SET status='PAID', row_version=row_version+1,
          paid_at=$2, updated_at=$2 WHERE id=$1`, [earning.id, input.now]);
        const updated = await loadPlayerEarning(client, earning.id);
        await client.query('COMMIT');
        return { resultType: 'STATE_UPDATED' as const, playerEarning: updated, adjustment: null };
      }
      const amount = requireReversal(input, earning);
      if (amount.amountMinor > earning.netAmountMinor) throw new PlayerEarningError('VALIDATION_ERROR', 'Reversal exceeds net earning.');
      const adjustmentId = deterministicUuid(`earning-adjustment:${input.idempotencyKey}`);
      await client.query(`INSERT INTO player_earning_adjustments (
        id,player_earning_id,type,source_refund_id,source_resolution_id,amount_minor,currency,reason,
        idempotency_key,created_by_staff_id,created_at
      ) VALUES ($1,$2,'REVERSAL_DEBIT',NULL,NULL,$3,$4,$5,$6,$7,$8)`, [adjustmentId, earning.id,
        amount.amountMinor, amount.currency, input.reason, input.idempotencyKey, input.actorStaffId, input.now]);
      await client.query(`UPDATE player_earnings SET row_version=row_version+1, updated_at=$2 WHERE id=$1`, [earning.id, input.now]);
      const updated = await loadPlayerEarning(client, earning.id);
      const adjustment = updated.adjustments.find((candidate) => candidate.id === adjustmentId)!;
      await client.query('COMMIT');
      return { resultType: 'ADJUSTMENT_CREATED' as const, playerEarning: updated, adjustment };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}

async function loadPlayerEarning(client: Pick<Pool, 'query'> | PoolClient, id: string, forUpdate = false): Promise<PlayerEarningRecord> {
  const result = await client.query<PlayerEarningRow>(`SELECT id,order_id,player_user_id,base_units,unit_payout_minor,
    amount_minor,currency,status,row_version,confirmed_by_staff_id,confirmed_at,paid_at,created_at,updated_at
    FROM player_earnings WHERE id=$1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const row = result.rows[0];
  if (!row) throw new PlayerEarningError('NOT_FOUND', 'Player earning was not found.');
  const adjustments = await client.query<PlayerEarningAdjustmentRow>(`SELECT id,player_earning_id,type,source_refund_id,
    source_resolution_id,amount_minor,currency,reason,idempotency_key,created_by_staff_id,created_at
    FROM player_earning_adjustments WHERE player_earning_id=$1 ORDER BY created_at,id`, [id]);
  const mapped = adjustments.rows.map(mapAdjustment);
  const net = mapped.reduce((value, adjustment) => adjustment.type === 'CORRECTION_CREDIT'
    ? value + adjustment.amountMinor : value - adjustment.amountMinor, Number(row.amount_minor));
  return { id: row.id, playerId: row.player_user_id, orderId: row.order_id, baseUnits: row.base_units,
    unitPayoutMinor: Number(row.unit_payout_minor), amountMinor: Number(row.amount_minor), currency: row.currency,
    status: row.status, version: row.row_version, confirmedByStaffId: row.confirmed_by_staff_id,
    confirmedAt: nullableIso(row.confirmed_at), paidAt: nullableIso(row.paid_at), adjustments: mapped,
    netAmountMinor: Math.max(0, net), createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at) };
}

function mapAdjustment(row: PlayerEarningAdjustmentRow): PlayerEarningAdjustmentRecord {
  return { id: row.id, playerEarningId: row.player_earning_id, type: row.type,
    sourceRefundId: row.source_refund_id, sourceResolutionId: row.source_resolution_id,
    amountMinor: Number(row.amount_minor), currency: row.currency, reason: row.reason,
    idempotencyKey: row.idempotency_key, createdByStaffId: row.created_by_staff_id, createdAt: toIso(row.created_at) };
}

export function registerPlayerEarningRoutes(server: FastifyInstance, options: { store: PlayerEarningStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Player earning routes require security options.');
  const security = server.securityOptions;
  const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/players/me/earnings',
    permission: 'player.workspace.read', action: 'LIST_MY_PLAYER_EARNINGS', targetType: 'player_earning',
    acceptedSources: ['DISCORD_BOT', 'DASHBOARD'], handler: async (request, actor) => {
      const playerId = await resolveSelf(options.store, actor);
      return { items: await options.store.list({ playerId, limit: pageLimit(request) }), nextCursor: null };
    }, mapError: mapEarningError });
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/player-earnings',
    permission: 'earnings.read', action: 'LIST_PLAYER_EARNINGS', targetType: 'player_earning',
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], handler: (request) => {
      const query = request.query as { playerId?: string; status?: PlayerEarningStatus };
      return Promise.resolve(options.store.list({ playerId: query.playerId, status: parseStatus(query.status), limit: pageLimit(request) }))
        .then((items) => ({ items, nextCursor: null }));
    }, mapError: mapEarningError });
  registerSecureWriteRoute(server, security, { method: 'PATCH', url: '/api/v1/admin/player-earnings/:playerEarningId',
    permission: 'earnings.manage', action: 'UPDATE_PLAYER_EARNING', targetType: 'player_earning', targetId: earningIdParam,
    acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true,
    handler: (request, actor) => {
      if (!actor.actorStaffId) throw new PlayerEarningError('PERMISSION_DENIED', 'A staff actor is required.');
      const body = parseMutation(request.body);
      return options.store.mutate({ ...body, earningId: earningIdParam(request), actorStaffId: actor.actorStaffId,
        idempotencyKey: request.headers['idempotency-key'] as string, now: now() });
    }, fingerprintBody: (request) => parseMutation(request.body),
    successReason: (request) => parseMutation(request.body).reason, mapError: mapEarningError });
}

async function resolveSelf(store: PlayerEarningStore, actor: ActorContext): Promise<string> {
  if (!actor.guildId || !actor.discordUserId) throw new PlayerEarningError('PERMISSION_DENIED', 'A player account is required.');
  const playerId = await store.resolvePlayerUserId({ guildId: actor.guildId, discordUserId: actor.discordUserId });
  if (!playerId) throw new PlayerEarningError('PERMISSION_DENIED', 'A player account is required.');
  return playerId;
}

function parseMutation(value: unknown) {
  const body = value as Record<string, unknown>;
  const reason = [body?.reasonCode, body?.note].filter((item): item is string => typeof item === 'string').join(': ');
  if (!body || !Number.isInteger(body.expectedVersion) || !['CONFIRM', 'MARK_PAID', 'CREATE_REVERSAL'].includes(String(body.action)) || reason.length < 3) {
    throw new PlayerEarningError('VALIDATION_ERROR', 'expectedVersion, action, and reasonCode are required.');
  }
  const money = body.reversalAmount as Record<string, unknown> | undefined;
  const reversalAmount = money && Number.isInteger(money.amountMinor) && typeof money.currency === 'string'
    ? { amountMinor: money.amountMinor as number, currency: money.currency } : undefined;
  return { expectedVersion: body.expectedVersion as number, action: body.action as PlayerEarningMutationInput['action'], reversalAmount, reason };
}

function requireReversal(input: PlayerEarningMutationInput, earning: PlayerEarningRecord) {
  const amount = input.reversalAmount;
  if (!amount || amount.amountMinor < 1 || amount.currency !== earning.currency) {
    throw new PlayerEarningError('VALIDATION_ERROR', 'A positive reversalAmount in the earning currency is required.');
  }
  return amount;
}

function pageLimit(request: FastifyRequest): number {
  const raw = Number((request.query as { limit?: unknown }).limit ?? 50);
  if (!Number.isInteger(raw) || raw < 1 || raw > 100) throw new PlayerEarningError('VALIDATION_ERROR', 'limit must be between 1 and 100.');
  return raw;
}

function parseStatus(value: unknown): PlayerEarningStatus | undefined {
  if (value === undefined) return undefined;
  if (!['PENDING', 'CONFIRMED', 'PAID', 'REVERSED'].includes(String(value))) throw new PlayerEarningError('VALIDATION_ERROR', 'status is invalid.');
  return value as PlayerEarningStatus;
}

function earningIdParam(request: FastifyRequest): string {
  const id = (request.params as { playerEarningId?: unknown }).playerEarningId;
  if (typeof id !== 'string') throw new PlayerEarningError('VALIDATION_ERROR', 'playerEarningId is required.');
  return id;
}

function mapEarningError(error: unknown) {
  if (!(error instanceof PlayerEarningError)) return null;
  return { statusCode: error.code === 'NOT_FOUND' ? 404 : error.code === 'PERMISSION_DENIED' ? 403 : error.code === 'VALIDATION_ERROR' ? 400 : 409,
    code: error.code, message: error.message };
}

function deterministicUuid(seed: string): string {
  const bytes = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return `${bytes.subarray(0, 4).toString('hex')}-${bytes.subarray(4, 6).toString('hex')}-${bytes.subarray(6, 8).toString('hex')}-${bytes.subarray(8, 10).toString('hex')}-${bytes.subarray(10).toString('hex')}`;
}

function toIso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function nullableIso(value: Date | string | null): string | null { return value ? toIso(value) : null; }

interface PlayerEarningRow {
  id: string; order_id: string; player_user_id: string; base_units: number;
  unit_payout_minor: string | number | bigint; amount_minor: string | number | bigint; currency: string;
  status: PlayerEarningStatus; row_version: number; confirmed_by_staff_id: string | null;
  confirmed_at: Date | string | null; paid_at: Date | string | null; created_at: Date | string; updated_at: Date | string;
}

interface PlayerEarningAdjustmentRow {
  id: string; player_earning_id: string; type: PlayerEarningAdjustmentType; source_refund_id: string | null;
  source_resolution_id: string | null; amount_minor: string | number | bigint; currency: string; reason: string;
  idempotency_key: string; created_by_staff_id: string | null; created_at: Date | string;
}

function clone<T>(value: T): T { return structuredClone(value); }
