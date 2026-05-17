import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type SettlementBatchStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'EXPORTED'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'VOIDED';
export type SettlementItemPaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';
export type SettlementBatchSource = 'SCHEDULED' | 'MANUAL';
export type SettlementEntryType = 'PLAYER_EARNING' | 'EARNING_ADJUSTMENT';
export type SettlementAdjustmentType = 'REVERSAL_DEBIT' | 'CORRECTION_DEBIT' | 'CORRECTION_CREDIT';

export interface SettlementCandidateAdjustment {
  id: string;
  playerEarningId: string;
  type: SettlementAdjustmentType;
  amountMinor: number;
  currency: string;
  createdAt: string;
}

export interface SettlementCandidateEarning {
  id: string;
  orderId: string;
  playerUserId: string;
  amountMinor: number;
  currency: string;
  status: 'PENDING' | 'CONFIRMED' | 'PAID' | 'REVERSED';
  confirmedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  adjustments: SettlementCandidateAdjustment[];
}

export interface SettlementCreateInput {
  source: SettlementBatchSource;
  scheduleKey: string | null;
  periodStart: string;
  periodEnd: string;
  cutoffAt: string;
  timeZone: string;
  currency: string;
  playerUserIds: string[] | null;
  createdByStaffId: string | null;
  replacementForBatchId?: string | null;
}

export interface SettlementEntryRecord {
  id: string;
  entryType: SettlementEntryType;
  playerEarningId: string | null;
  playerEarningAdjustmentId: string | null;
  amountMinor: number;
  currency: string;
  occurredAt: string;
}

export interface SettlementItemRecord {
  id: string;
  playerUserId: string;
  grossAmountMinor: number;
  adjustmentAmountMinor: number;
  netAmountMinor: number;
  currency: string;
  paymentStatus: SettlementItemPaymentStatus;
  version: number;
  entries: SettlementEntryRecord[];
}

export interface SettlementPreview {
  periodStart: string;
  periodEnd: string;
  cutoffAt: string;
  timeZone: string;
  currency: string;
  grossAmountMinor: number;
  adjustmentAmountMinor: number;
  netAmountMinor: number;
  deferredAdjustmentMinor: number;
  items: SettlementItemRecord[];
}

export interface SettlementBatchRecord extends Omit<SettlementPreview, 'deferredAdjustmentMinor'> {
  id: string;
  publicId: string;
  source: SettlementBatchSource;
  scheduleKey: string | null;
  status: SettlementBatchStatus;
  version: number;
  createdByStaffId: string | null;
  replacementBatchId: string | null;
  createdAt: string;
}

export interface SettlementStore {
  preview(input: SettlementCreateInput): Promise<SettlementPreview> | SettlementPreview;
  create(input: SettlementCreateInput): Promise<SettlementBatchRecord> | SettlementBatchRecord;
}

export class SettlementError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_CURRENCY' | 'VALIDATION_ERROR' | 'NO_ELIGIBLE_SOURCES' | 'SOURCE_ALREADY_BATCHED' | 'CONFLICT',
    message: string
  ) {
    super(message);
    this.name = 'SettlementError';
  }
}

export async function previewSettlement(input: { store: SettlementStore; input: SettlementCreateInput }): Promise<SettlementPreview> {
  validateInput(input.input);
  return clone(await input.store.preview(input.input));
}

export async function createSettlementBatch(input: { store: SettlementStore; input: SettlementCreateInput }): Promise<SettlementBatchRecord> {
  validateInput(input.input);
  return clone(await input.store.create(input.input));
}

export class InMemorySettlementStore implements SettlementStore {
  readonly earnings: SettlementCandidateEarning[];
  readonly batches: SettlementBatchRecord[];

  constructor(input: { earnings?: SettlementCandidateEarning[]; batches?: SettlementBatchRecord[] } = {}) {
    this.earnings = clone(input.earnings ?? []);
    this.batches = clone(input.batches ?? []);
  }

  preview(input: SettlementCreateInput): SettlementPreview {
    return buildPreview(input, this.earnings, this.batches);
  }

  create(input: SettlementCreateInput): SettlementBatchRecord {
    const scheduleIdentity = automaticIdentity(input);
    if (scheduleIdentity) {
      const existing = this.batches.find((batch) => automaticIdentity(batch) === scheduleIdentity);
      if (existing) return clone(existing);
    }
    assertInMemoryReplacementAvailable(input, this.batches);

    const preview = buildPreview(input, this.earnings, this.batches);
    if (preview.items.length === 0) {
      if (hasBlockedEarning(input, this.earnings, this.batches)) {
        throw new SettlementError('SOURCE_ALREADY_BATCHED', 'An eligible earning is already linked to a non-void settlement batch.');
      }
      throw new SettlementError('NO_ELIGIBLE_SOURCES', 'No eligible settlement sources were found.');
    }

    const identity = scheduleIdentity ?? [input.periodStart, input.periodEnd, input.currency, this.batches.length + 1].join(':');
    const id = deterministicUuid(`settlement-batch:${identity}`);
    const items = materializeItemIds(preview.items, id);
    const batch: SettlementBatchRecord = {
      periodStart: preview.periodStart,
      periodEnd: preview.periodEnd,
      cutoffAt: preview.cutoffAt,
      timeZone: preview.timeZone,
      currency: preview.currency,
      grossAmountMinor: preview.grossAmountMinor,
      adjustmentAmountMinor: preview.adjustmentAmountMinor,
      netAmountMinor: preview.netAmountMinor,
      items,
      id,
      publicId: `SET-${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      source: input.source,
      scheduleKey: input.scheduleKey,
      status: 'DRAFT',
      version: 1,
      createdByStaffId: input.createdByStaffId,
      replacementBatchId: null,
      createdAt: new Date().toISOString()
    };
    this.batches.push(clone(batch));
    if (input.replacementForBatchId) {
      const replaced = this.batches.find((candidate) => candidate.id === input.replacementForBatchId);
      if (!replaced || replaced.status !== 'VOIDED' || replaced.replacementBatchId) {
        this.batches.pop();
        throw new SettlementError('CONFLICT', 'Replacement requires a voided batch without an existing replacement.');
      }
      replaced.replacementBatchId = batch.id;
    }
    return clone(batch);
  }
}

export interface SettlementDatabaseClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export class PostgresSettlementStore implements SettlementStore {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async preview(input: SettlementCreateInput): Promise<SettlementPreview> {
    const earnings = await loadPostgresCandidates(this.pool, input, false);
    const batches = await loadPostgresMemberships(this.pool);
    return buildPreview(input, earnings, batches);
  }

  async create(input: SettlementCreateInput): Promise<SettlementBatchRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const replay = await findScheduledBatch(client, input);
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }
      await assertPostgresReplacementAvailable(client, input);
      await lockSettlementSources(client, input);
      const replayAfterSourceLock = await findScheduledBatch(client, input);
      if (replayAfterSourceLock) {
        await client.query('COMMIT');
        return replayAfterSourceLock;
      }
      const earnings = await loadPostgresCandidates(client, input, true);
      const batches = await loadPostgresMemberships(client);
      const preview = buildPreview(input, earnings, batches);
      if (preview.items.length === 0) {
        if (hasBlockedEarning(input, earnings, batches)) {
          throw new SettlementError('SOURCE_ALREADY_BATCHED', 'An eligible earning is already linked to a non-void settlement batch.');
        }
        throw new SettlementError('NO_ELIGIBLE_SOURCES', 'No eligible settlement sources were found.');
      }
      const batch = await insertPostgresBatch(client, input, preview);
      await client.query('COMMIT');
      return batch;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isPostgresConflict(error)) throw new SettlementError('SOURCE_ALREADY_BATCHED', 'A settlement source was claimed concurrently.');
      throw error;
    } finally {
      client.release();
    }
  }
}

function validateInput(input: SettlementCreateInput): void {
  if (input.currency !== 'CNY') throw new SettlementError('UNSUPPORTED_CURRENCY', 'P0 settlements support CNY only.');
  if (input.source === 'SCHEDULED' && !input.scheduleKey) {
    throw new SettlementError('VALIDATION_ERROR', 'Scheduled settlements require scheduleKey.');
  }
  if (input.source === 'MANUAL' && input.scheduleKey) {
    throw new SettlementError('VALIDATION_ERROR', 'Manual settlements cannot use scheduleKey.');
  }
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);
  const cutoff = Date.parse(input.cutoffAt);
  if (![start, end, cutoff].every(Number.isFinite) || start >= end || cutoff < end) {
    throw new SettlementError('VALIDATION_ERROR', 'Settlement period and cutoff are invalid.');
  }
}

function buildPreview(
  input: SettlementCreateInput,
  earnings: SettlementCandidateEarning[],
  batches: SettlementBatchRecord[]
): SettlementPreview {
  const activeEarnings = activeSourceIds(batches, 'PLAYER_EARNING');
  const activeAdjustments = activeSourceIds(batches, 'EARNING_ADJUSTMENT');
  const selectedPlayers = input.playerUserIds ? new Set(input.playerUserIds) : null;
  const byPlayer = new Map<string, SettlementEntryRecord[]>();

  for (const earning of earnings) {
    if (earning.currency !== input.currency || (selectedPlayers && !selectedPlayers.has(earning.playerUserId))) continue;
    const earningEligible = earning.status === 'CONFIRMED'
      && earning.confirmedAt !== null
      && Date.parse(earning.confirmedAt) <= Date.parse(input.cutoffAt)
      && !activeEarnings.has(earning.id);
    if (earningEligible) {
      addEntry(byPlayer, earning.playerUserId, {
        id: deterministicUuid(`settlement-entry:earning:${earning.id}`),
        entryType: 'PLAYER_EARNING',
        playerEarningId: earning.id,
        playerEarningAdjustmentId: null,
        amountMinor: earning.amountMinor,
        currency: earning.currency,
        occurredAt: earning.confirmedAt!
      });
    }

    const earningWasSettled = activeEarnings.has(earning.id) || earning.status === 'PAID';
    if (!earningEligible && !earningWasSettled) continue;
    for (const adjustment of earning.adjustments) {
      if (adjustment.currency !== input.currency
        || Date.parse(adjustment.createdAt) > Date.parse(input.cutoffAt)
        || activeAdjustments.has(adjustment.id)) continue;
      addEntry(byPlayer, earning.playerUserId, {
        id: deterministicUuid(`settlement-entry:adjustment:${adjustment.id}`),
        entryType: 'EARNING_ADJUSTMENT',
        playerEarningId: null,
        playerEarningAdjustmentId: adjustment.id,
        amountMinor: adjustmentSign(adjustment.type) * adjustment.amountMinor,
        currency: adjustment.currency,
        occurredAt: adjustment.createdAt
      });
    }
  }

  const candidateItems = [...byPlayer.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([playerUserId, entries]) => {
    entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    const grossAmountMinor = sum(entries.filter((entry) => entry.entryType === 'PLAYER_EARNING').map((entry) => entry.amountMinor));
    const adjustmentAmountMinor = sum(entries.filter((entry) => entry.entryType === 'EARNING_ADJUSTMENT').map((entry) => entry.amountMinor));
    return {
      id: deterministicUuid(`settlement-item:${input.periodStart}:${input.periodEnd}:${input.currency}:${playerUserId}`),
      playerUserId,
      grossAmountMinor,
      adjustmentAmountMinor,
      netAmountMinor: sum([grossAmountMinor, adjustmentAmountMinor]),
      currency: input.currency,
      paymentStatus: 'PENDING' as const,
      version: 1,
      entries
    };
  });
  const deferredAdjustmentMinor = sum(candidateItems
    .filter((item) => item.netAmountMinor <= 0)
    .map((item) => item.adjustmentAmountMinor));
  const items = candidateItems.filter((item) => item.netAmountMinor > 0);
  const grossAmountMinor = sum(items.map((item) => item.grossAmountMinor));
  const adjustmentAmountMinor = sum(items.map((item) => item.adjustmentAmountMinor));
  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    cutoffAt: input.cutoffAt,
    timeZone: input.timeZone,
    currency: input.currency,
    grossAmountMinor,
    adjustmentAmountMinor,
    netAmountMinor: sum([grossAmountMinor, adjustmentAmountMinor]),
    deferredAdjustmentMinor,
    items
  };
}

function hasBlockedEarning(input: SettlementCreateInput, earnings: SettlementCandidateEarning[], batches: SettlementBatchRecord[]): boolean {
  const activeEarnings = activeSourceIds(batches, 'PLAYER_EARNING');
  const players = input.playerUserIds ? new Set(input.playerUserIds) : null;
  return earnings.some((earning) => earning.status === 'CONFIRMED'
    && earning.currency === input.currency
    && earning.confirmedAt !== null
    && Date.parse(earning.confirmedAt) <= Date.parse(input.cutoffAt)
    && (!players || players.has(earning.playerUserId))
    && activeEarnings.has(earning.id));
}

function activeSourceIds(batches: SettlementBatchRecord[], type: SettlementEntryType): Set<string> {
  return new Set(batches.filter((batch) => batch.status !== 'VOIDED').flatMap((batch) => batch.items).flatMap((item) => item.entries)
    .filter((entry) => entry.entryType === type)
    .map((entry) => type === 'PLAYER_EARNING' ? entry.playerEarningId! : entry.playerEarningAdjustmentId!));
}

function addEntry(target: Map<string, SettlementEntryRecord[]>, playerUserId: string, entry: SettlementEntryRecord): void {
  const entries = target.get(playerUserId) ?? [];
  entries.push(entry);
  target.set(playerUserId, entries);
}

function adjustmentSign(type: SettlementAdjustmentType): 1 | -1 {
  return type === 'CORRECTION_CREDIT' ? 1 : -1;
}

function assertInMemoryReplacementAvailable(input: SettlementCreateInput, batches: SettlementBatchRecord[]): void {
  if (!input.replacementForBatchId) return;
  const replaced = batches.find((batch) => batch.id === input.replacementForBatchId);
  if (!replaced || replaced.status !== 'VOIDED' || replaced.replacementBatchId) {
    throw new SettlementError('CONFLICT', 'Replacement requires a voided batch without an existing replacement.');
  }
}

async function assertPostgresReplacementAvailable(client: SettlementDatabaseClient, input: SettlementCreateInput): Promise<void> {
  if (!input.replacementForBatchId) return;
  const result = await client.query<{ status: SettlementBatchStatus; replacement_batch_id: string | null }>(
    'SELECT status,replacement_batch_id FROM settlement_batches WHERE id=$1 FOR UPDATE',
    [input.replacementForBatchId]
  );
  const replaced = result.rows[0];
  if (!replaced || replaced.status !== 'VOIDED' || replaced.replacement_batch_id) {
    throw new SettlementError('CONFLICT', 'Replacement requires a voided batch without an existing replacement.');
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(next)) {
      throw new SettlementError('VALIDATION_ERROR', 'Settlement amount exceeds the supported safe integer range.');
    }
    return next;
  }, 0);
}

function toSafeMinor(value: string, field: string): number {
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new SettlementError('VALIDATION_ERROR', `${field} exceeds the supported safe integer range.`);
  }
  return Number(parsed);
}

function automaticIdentity(input: Pick<SettlementCreateInput | SettlementBatchRecord, 'source' | 'scheduleKey' | 'periodStart' | 'periodEnd' | 'currency'>): string | null {
  return input.source === 'SCHEDULED'
    ? [input.scheduleKey, input.periodStart, input.periodEnd, input.currency].join(':')
    : null;
}

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function lockSettlementSources(client: PoolClient, input: SettlementCreateInput): Promise<void> {
  await client.query(
    `SELECT pe.id FROM player_earnings pe
     WHERE pe.currency=$1 AND pe.created_at <= $2::timestamptz
       AND ($3::uuid[] IS NULL OR pe.player_user_id = ANY($3::uuid[]))
     ORDER BY pe.id FOR UPDATE`,
    [input.currency, input.cutoffAt, input.playerUserIds]
  );
  await client.query(
    `SELECT pea.id FROM player_earning_adjustments pea
     JOIN player_earnings pe ON pe.id=pea.player_earning_id
     WHERE pea.currency=$1 AND pea.created_at <= $2::timestamptz
       AND ($3::uuid[] IS NULL OR pe.player_user_id = ANY($3::uuid[]))
     ORDER BY pea.id FOR UPDATE OF pea`,
    [input.currency, input.cutoffAt, input.playerUserIds]
  );
}

async function loadPostgresCandidates(client: SettlementDatabaseClient, input: SettlementCreateInput, _locked: boolean): Promise<SettlementCandidateEarning[]> {
  const rows = await client.query<PostgresCandidateRow>(
    `SELECT pe.id,pe.order_id,pe.player_user_id,pe.amount_minor::text,pe.currency,pe.status,
       pe.confirmed_at,pe.paid_at,pe.created_at,
       COALESCE(jsonb_agg(jsonb_build_object('id',pea.id,'playerEarningId',pea.player_earning_id,
         'type',pea.type,'amountMinor',pea.amount_minor::text,'currency',pea.currency,'createdAt',pea.created_at)
         ORDER BY pea.created_at,pea.id) FILTER (WHERE pea.id IS NOT NULL),'[]'::jsonb) adjustments
     FROM player_earnings pe LEFT JOIN player_earning_adjustments pea ON pea.player_earning_id=pe.id
     WHERE pe.currency=$1 AND pe.created_at <= $2::timestamptz
       AND ($3::uuid[] IS NULL OR pe.player_user_id = ANY($3::uuid[]))
     GROUP BY pe.id ORDER BY pe.id`,
    [input.currency, input.cutoffAt, input.playerUserIds]
  );
  return rows.rows.map((row) => ({
    id: row.id, orderId: row.order_id, playerUserId: row.player_user_id, amountMinor: toSafeMinor(row.amount_minor, 'earning amount'),
    currency: row.currency, status: row.status, confirmedAt: iso(row.confirmed_at), paidAt: iso(row.paid_at),
    createdAt: iso(row.created_at)!, adjustments: row.adjustments.map((adjustment) => ({
      ...adjustment, amountMinor: toSafeMinor(adjustment.amountMinor, 'adjustment amount'), createdAt: iso(adjustment.createdAt)!
    }))
  }));
}

async function loadPostgresMemberships(client: SettlementDatabaseClient): Promise<SettlementBatchRecord[]> {
  const rows = await client.query<PostgresMembershipRow>(
    `SELECT sb.id,sb.status,sie.entry_type,sie.player_earning_id,sie.player_earning_adjustment_id
     FROM settlement_item_entries sie JOIN settlement_items si ON si.id=sie.settlement_item_id
     JOIN settlement_batches sb ON sb.id=si.settlement_batch_id
     WHERE sb.status<>'VOIDED'`
  );
  const grouped = new Map<string, SettlementBatchRecord>();
  for (const row of rows.rows) {
    const batch = grouped.get(row.id) ?? emptyMembershipBatch(row.id, row.status);
    batch.items[0]!.entries.push({
      id: `${row.id}:${batch.items[0]!.entries.length}`, entryType: row.entry_type,
      playerEarningId: row.player_earning_id, playerEarningAdjustmentId: row.player_earning_adjustment_id,
      amountMinor: 0, currency: 'CNY', occurredAt: ''
    });
    grouped.set(row.id, batch);
  }
  return [...grouped.values()];
}

async function findScheduledBatch(client: SettlementDatabaseClient, input: SettlementCreateInput): Promise<SettlementBatchRecord | null> {
  if (input.source !== 'SCHEDULED') return null;
  const result = await client.query<{ id: string }>(
    `SELECT id FROM settlement_batches WHERE schedule_key=$1 AND period_start=$2::timestamptz
       AND period_end=$3::timestamptz AND currency=$4`,
    [input.scheduleKey, input.periodStart, input.periodEnd, input.currency]
  );
  return result.rows[0] ? loadPostgresBatch(client, result.rows[0].id) : null;
}

async function insertPostgresBatch(client: PoolClient, input: SettlementCreateInput, preview: SettlementPreview): Promise<SettlementBatchRecord> {
  const identity = automaticIdentity(input) ?? `${input.periodStart}:${input.periodEnd}:${input.currency}:${Date.now()}:${Math.random()}`;
  const batchId = deterministicUuid(`settlement-batch:${identity}`);
  const publicId = `SET-${batchId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const items = materializeItemIds(preview.items, batchId);
  await client.query(
    `INSERT INTO settlement_batches (id,public_id,source,schedule_key,period_start,period_end,cutoff_at,time_zone,currency,
       gross_amount_minor,adjustment_amount_minor,net_amount_minor,status,row_version,created_by_staff_id,replacement_batch_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT',1,$13,NULL,now(),now())`,
    [batchId, publicId, input.source, input.scheduleKey, input.periodStart, input.periodEnd, input.cutoffAt,
      input.timeZone, input.currency, preview.grossAmountMinor, preview.adjustmentAmountMinor,
      preview.netAmountMinor, input.createdByStaffId]
  );
  for (const item of items) {
    await client.query(
      `INSERT INTO settlement_items (id,settlement_batch_id,player_user_id,gross_amount_minor,adjustment_amount_minor,
         net_amount_minor,currency,payment_status,row_version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',1,now(),now())`,
      [item.id, batchId, item.playerUserId, item.grossAmountMinor, item.adjustmentAmountMinor, item.netAmountMinor, item.currency]
    );
    for (const entry of item.entries) {
      await client.query(
        `INSERT INTO settlement_item_entries (id,settlement_item_id,entry_type,player_earning_id,
           player_earning_adjustment_id,amount_minor,currency,occurred_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
        [entry.id, item.id, entry.entryType, entry.playerEarningId, entry.playerEarningAdjustmentId,
          entry.amountMinor, entry.currency, entry.occurredAt]
      );
    }
  }
  await client.query('UPDATE settlement_batches SET snapshot_finalized_at=now(),updated_at=now() WHERE id=$1', [batchId]);
  if (input.replacementForBatchId) {
    const update = await client.query(
      `UPDATE settlement_batches SET replacement_batch_id=$1,row_version=row_version+1,updated_at=$2
       WHERE id=$3 AND status='VOIDED' AND replacement_batch_id IS NULL`,
      [batchId, new Date().toISOString(), input.replacementForBatchId]
    );
    if (update.rowCount !== 1) throw new SettlementError('CONFLICT', 'Replacement requires a voided batch without an existing replacement.');
  }
  return loadPostgresBatch(client, batchId);
}

function materializeItemIds(items: SettlementItemRecord[], batchId: string): SettlementItemRecord[] {
  return items.map((item) => ({
    ...item,
    id: deterministicUuid(`settlement-item:${batchId}:${item.playerUserId}`),
    entries: item.entries.map((entry) => ({
      ...entry,
      id: deterministicUuid(`settlement-entry:${batchId}:${entry.entryType}:${entry.playerEarningId ?? entry.playerEarningAdjustmentId}`)
    }))
  }));
}

async function loadPostgresBatch(client: SettlementDatabaseClient, id: string): Promise<SettlementBatchRecord> {
  const batchResult = await client.query<PostgresBatchRow>('SELECT * FROM settlement_batches WHERE id=$1', [id]);
  const batch = batchResult.rows[0];
  if (!batch) throw new SettlementError('CONFLICT', 'Settlement batch was not found.');
  const itemResult = await client.query<PostgresItemRow>('SELECT * FROM settlement_items WHERE settlement_batch_id=$1 ORDER BY player_user_id', [id]);
  const items: SettlementItemRecord[] = [];
  for (const item of itemResult.rows) {
    const entries = await client.query<PostgresEntryRow>('SELECT * FROM settlement_item_entries WHERE settlement_item_id=$1 ORDER BY occurred_at,id', [item.id]);
    items.push({ id: item.id, playerUserId: item.player_user_id,
      grossAmountMinor: toSafeMinor(item.gross_amount_minor, 'item gross amount'),
      adjustmentAmountMinor: toSafeMinor(item.adjustment_amount_minor, 'item adjustment amount'),
      netAmountMinor: toSafeMinor(item.net_amount_minor, 'item net amount'),
      currency: item.currency, paymentStatus: item.payment_status, version: item.row_version,
      entries: entries.rows.map((entry) => ({ id: entry.id, entryType: entry.entry_type,
        playerEarningId: entry.player_earning_id, playerEarningAdjustmentId: entry.player_earning_adjustment_id,
        amountMinor: toSafeMinor(entry.amount_minor, 'entry amount'), currency: entry.currency, occurredAt: iso(entry.occurred_at)! })) });
  }
  return { id: batch.id, publicId: batch.public_id, source: batch.source, scheduleKey: batch.schedule_key,
    periodStart: iso(batch.period_start)!, periodEnd: iso(batch.period_end)!, cutoffAt: iso(batch.cutoff_at)!, timeZone: batch.time_zone,
    currency: batch.currency, grossAmountMinor: toSafeMinor(batch.gross_amount_minor, 'batch gross amount'),
    adjustmentAmountMinor: toSafeMinor(batch.adjustment_amount_minor, 'batch adjustment amount'),
    netAmountMinor: toSafeMinor(batch.net_amount_minor, 'batch net amount'),
    status: batch.status, version: batch.row_version, createdByStaffId: batch.created_by_staff_id,
    replacementBatchId: batch.replacement_batch_id, createdAt: iso(batch.created_at)!, items };
}

function emptyMembershipBatch(id: string, status: SettlementBatchStatus): SettlementBatchRecord {
  return { id, publicId: '', source: 'MANUAL', scheduleKey: null, periodStart: '', periodEnd: '', cutoffAt: '', timeZone: '', currency: 'CNY',
    grossAmountMinor: 0, adjustmentAmountMinor: 0, netAmountMinor: 0, status, version: 1, createdByStaffId: null,
    replacementBatchId: null, createdAt: '', items: [{ id: '', playerUserId: '', grossAmountMinor: 0,
      adjustmentAmountMinor: 0, netAmountMinor: 0, currency: 'CNY', paymentStatus: 'PENDING', version: 1, entries: [] }] };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

function isPostgresConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'message' in error
    && /settlement source already belongs to an active settlement batch/i.test(String(error.message));
}

interface PostgresAdjustmentJson { id: string; playerEarningId: string; type: SettlementAdjustmentType; amountMinor: string; currency: string; createdAt: Date | string; }
interface PostgresCandidateRow extends Record<string, unknown> { id: string; order_id: string; player_user_id: string; amount_minor: string; currency: string; status: SettlementCandidateEarning['status']; confirmed_at: Date | null; paid_at: Date | null; created_at: Date; adjustments: PostgresAdjustmentJson[]; }
interface PostgresMembershipRow extends Record<string, unknown> { id: string; status: SettlementBatchStatus; entry_type: SettlementEntryType; player_earning_id: string | null; player_earning_adjustment_id: string | null; }
interface PostgresBatchRow extends Record<string, unknown> { id: string; public_id: string; source: SettlementBatchSource; schedule_key: string | null; period_start: Date; period_end: Date; cutoff_at: Date; time_zone: string; currency: string; gross_amount_minor: string; adjustment_amount_minor: string; net_amount_minor: string; status: SettlementBatchStatus; row_version: number; created_by_staff_id: string | null; replacement_batch_id: string | null; created_at: Date; }
interface PostgresItemRow extends Record<string, unknown> { id: string; player_user_id: string; gross_amount_minor: string; adjustment_amount_minor: string; net_amount_minor: string; currency: string; payment_status: SettlementItemPaymentStatus; row_version: number; }
interface PostgresEntryRow extends Record<string, unknown> { id: string; entry_type: SettlementEntryType; player_earning_id: string | null; player_earning_adjustment_id: string | null; amount_minor: string; currency: string; occurred_at: Date; }
