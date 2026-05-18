import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import {
  InMemoryAuditSink,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink
} from './security.js';
import { AdapterError, type FundingAdapter, type MaybePromise } from './payment-adapter.js';
import { CustomerProfileError, consumptionGuildPredicate, type CustomerProfileStore, type CustomerStatistics } from './customer-profiles.js';
import { decodeKeysetCursor, encodeKeysetCursor, type CursorScope } from './signed-cursor.js';

type UserStatus = 'ACTIVE' | 'PAUSED' | 'SUSPENDED' | 'DISABLED';
type ExternalAccountStatus = 'ACTIVE' | 'REVOKED';
type ProviderAccountStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'UNKNOWN';
type ReservationStatus = 'PENDING' | 'ACTIVE' | 'DISPUTED' | 'PARTIALLY_SETTLED' | 'CAPTURED' | 'RELEASED' | 'EXPIRED' | 'FAILED';

export interface AccountBindingRecord {
  userId: string;
  displayName: string;
  userStatus: UserStatus;
  userVersion: number;
  discordAccountId: string;
  guildId: string;
  discordUserId: string;
  externalAccountId: string;
  provider: string;
  externalUserId: string;
  externalUserDisplay: string;
  externalAccountStatus: ExternalAccountStatus;
  boundAt: string;
}

export interface FundReservationBalanceRecord {
  id: string;
  userId: string;
  amountMinor: number;
  currency: string;
  status: ReservationStatus;
}

export interface BindingResult {
  userId: string;
  externalAccountId: string;
  externalUserDisplay: string;
  accountStatus: ProviderAccountStatus;
  boundAt: string;
}

export interface CurrentUserResult {
  user: {
    id: string;
    displayName: string;
    status: UserStatus;
    externalAccountDisplay: string | null;
    activeOrderId: string | null;
    riskFlags: string[];
    version: number;
  };
  activeOrderId: string | null;
  consumptionSummary: { totalMinor: number; currency: string };
  commissionSummary: { pendingMinor: number; confirmedMinor: number; paidMinor: number; currency: string };
}

export interface BalanceResult {
  providerBalanceMinor: number;
  reservedMinor: number;
  availableMinor: number;
  currency: string;
  fetchedAt: string;
}

export interface CurrentUserProfileResult {
  user: { userId: string; discordUserId: string; displayName: string; status: string };
  balance: {
    providerBalanceMinor: number | null; reservedMinor: number | null; availableMinor: number | null;
    currency: string | null; fetchedAt: string | null; stale: boolean;
    providerError: { code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT'; retryable: boolean; requestId: string } | null;
  };
  statistics: CustomerStatistics;
  activeReservationCount: number;
  rechargeUrl: string;
}

export interface ConsumptionPageResult {
  items: ConsumptionRecord[];
  nextCursor: string | null;
}

export interface CurrentCommissionPageResult {
  summary: { pendingMinor: number; confirmedMinor: number; paidMinor: number; currency: string };
  items: BeneficiaryCommissionRecord[];
  nextCursor: string | null;
}

export interface ConsumptionRecord {
  id: string; type: 'ORDER' | 'GIFT' | 'REVERSAL'; sourceId: string; amountMinor: number; currency: string;
  status: 'SUCCEEDED' | 'REVERSED'; targetDisplay: string; occurredAt: string; reversalOf: string | null;
}

export interface BeneficiaryCommissionRecord {
  id: string; programType: 'PROMOTER_FIRST_PURCHASE' | 'PLAYER_LIFETIME'; sourceCustomerMasked: { display: string };
  amountMinor: number; currency: string; status: 'PENDING' | 'CONFIRMED' | 'PAID' | 'REVERSED';
  adjustments: Array<{ type: 'REVERSAL_DEBIT' | 'CORRECTION_DEBIT' | 'CORRECTION_CREDIT'; amountMinor: number; currency: string; createdAt: string }>;
  netAmountMinor: number; version: number; createdAt: string;
}

export interface AccountStore {
  findByDiscord(input: { guildId: string; discordUserId: string }): Promise<AccountBindingRecord | null>;
  findByExternal(input: { provider: string; externalUserId: string }): Promise<AccountBindingRecord | null>;
  createBinding(input: AccountBindingRecord): Promise<AccountBindingRecord>;
  commitBinding?(input: { binding: AccountBindingRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void>;
  sumActiveReservations(input: { userId: string; currency: string }): Promise<number>;
  listConsumptions?(input: { userId: string; guildId: string; cursor: PageCursor | null; limit: number }): Promise<ConsumptionPageResult>;
  listBeneficiaryCommissions?(input: { userId: string; cursor: PageCursor | null; limit: number }): Promise<CurrentCommissionPageResult>;
}

interface PageCursor { occurredAt: string; id: string }

export interface AccountQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface AccountTransactionClient extends AccountQueryClient {
  release(): void;
}

export interface AccountPool extends AccountQueryClient {
  connect(): Promise<AccountTransactionClient>;
}

export interface CreateBindingInput {
  credentialType: 'ONE_TIME_CODE';
  credentialValue: string;
  expectedCurrency: string;
}

export interface PreparedBinding {
  data: BindingResult;
  binding: AccountBindingRecord;
}

export class AccountError extends Error {
  readonly code:
    | 'BINDING_CONFLICT'
    | 'ACCOUNT_NOT_BOUND'
    | 'PROVIDER_UNAVAILABLE'
    | 'VALIDATION_ERROR'
    | 'BUSINESS_RULE_VIOLATION';

  constructor(code: AccountError['code'], message: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

export class InMemoryAccountStore implements AccountStore {
  private readonly bindings = new Map<string, AccountBindingRecord>();
  private readonly externalIndex = new Map<string, string>();
  private readonly reservations: FundReservationBalanceRecord[];
  private readonly reservationSource: (() => FundReservationBalanceRecord[]) | null;
  private readonly consumptions: Array<ConsumptionRecord & { userId: string; guildId: string }>;
  private readonly commissions: Array<BeneficiaryCommissionRecord & { beneficiaryUserId: string }>;

  constructor(input: {
    bindings?: AccountBindingRecord[];
    reservations?: FundReservationBalanceRecord[];
    reservationSource?: () => FundReservationBalanceRecord[];
    consumptions?: Array<ConsumptionRecord & { userId: string; guildId?: string }>;
    commissions?: Array<BeneficiaryCommissionRecord & { beneficiaryUserId: string }>;
  }) {
    this.reservations = input.reservations ?? [];
    this.reservationSource = input.reservationSource ?? null;
    const guildsByUser = new Map<string, Set<string>>();
    for (const item of input.bindings ?? []) {
      const guilds = guildsByUser.get(item.userId) ?? new Set<string>();
      guilds.add(item.guildId); guildsByUser.set(item.userId, guilds);
    }
    this.consumptions = clone(input.consumptions ?? []).map((item) => ({ ...item,
      guildId: item.guildId ?? (guildsByUser.get(item.userId)?.size === 1 ? [...guildsByUser.get(item.userId)!][0]! : '') }));
    this.commissions = clone(input.commissions ?? []);
    for (const binding of input.bindings ?? []) {
      this.bindings.set(discordKey(binding), clone(binding));
      this.externalIndex.set(externalKey(binding.provider, binding.externalUserId), discordKey(binding));
    }
  }

  async findByDiscord(input: { guildId: string; discordUserId: string }): Promise<AccountBindingRecord | null> {
    const binding = this.bindings.get(`${input.guildId}:${input.discordUserId}`);
    return binding ? clone(binding) : null;
  }

  async findByExternal(input: { provider: string; externalUserId: string }): Promise<AccountBindingRecord | null> {
    const key = this.externalIndex.get(externalKey(input.provider, input.externalUserId));
    const binding = key ? this.bindings.get(key) : null;
    return binding ? clone(binding) : null;
  }

  async createBinding(input: AccountBindingRecord): Promise<AccountBindingRecord> {
    if (await this.findByDiscord(input)) {
      throw new AccountError('BINDING_CONFLICT', 'Discord account is already bound.');
    }
    if (await this.findByExternal(input)) {
      throw new AccountError('BINDING_CONFLICT', 'External account is already bound.');
    }
    this.bindings.set(discordKey(input), clone(input));
    this.externalIndex.set(externalKey(input.provider, input.externalUserId), discordKey(input));
    return clone(input);
  }

  async commitBinding(input: { binding: AccountBindingRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    const bindingsSnapshot = new Map(this.bindings);
    const externalIndexSnapshot = new Map(this.externalIndex);
    try {
      await this.createBinding(input.binding);
      await input.auditSink.append(input.auditRecord);
    } catch (error) {
      this.bindings.clear();
      this.externalIndex.clear();
      for (const [key, binding] of bindingsSnapshot.entries()) {
        this.bindings.set(key, binding);
      }
      for (const [key, value] of externalIndexSnapshot.entries()) {
        this.externalIndex.set(key, value);
      }
      throw error;
    }
  }

  async sumActiveReservations(input: { userId: string; currency: string }): Promise<number> {
    const reservations = this.reservationSource ? this.reservationSource() : this.reservations;
    return reservations
      .filter((reservation) => reservation.userId === input.userId)
      .filter((reservation) => reservation.currency === input.currency)
      .filter((reservation) => activeReservationStatuses.has(reservation.status))
      .reduce((sum, reservation) => sum + reservation.amountMinor, 0);
  }

  async listConsumptions(input: { userId: string; guildId: string; cursor: PageCursor | null; limit: number }): Promise<ConsumptionPageResult> {
    const page = paginate(this.consumptions.filter((item) => item.userId === input.userId && item.guildId === input.guildId),
      input.cursor, input.limit, 'account-consumptions');
    return { items: page.items.map(({ userId: _hidden, guildId: _guildId, ...item }) => item), nextCursor: page.nextCursor };
  }

  async listBeneficiaryCommissions(input: { userId: string; cursor: PageCursor | null; limit: number }): Promise<CurrentCommissionPageResult> {
    const owned = this.commissions.filter((item) => item.beneficiaryUserId === input.userId);
    const page = paginate(owned, input.cursor, input.limit, 'account-commissions');
    return { summary: commissionSummary(owned), items: page.items.map(({ beneficiaryUserId: _hidden, ...item }) => item), nextCursor: page.nextCursor };
  }
}

export class PostgresAccountStore implements AccountStore {
  private readonly client: AccountQueryClient;
  private readonly pool: AccountPool | null;

  constructor(options: { client?: AccountQueryClient; pool?: AccountPool }) {
    if (!options.client && !options.pool) {
      throw new AccountError('VALIDATION_ERROR', 'PostgresAccountStore requires a client or pool.');
    }
    this.client = options.pool ?? options.client!;
    this.pool = options.pool ?? null;
  }

  async findByDiscord(input: { guildId: string; discordUserId: string }): Promise<AccountBindingRecord | null> {
    const result = await this.client.query<AccountBindingRow>(
      `
SELECT users.id AS user_id,
       users.display_name,
       users.status AS user_status,
       users.row_version AS user_version,
       discord.id AS discord_account_id,
       discord.guild_id,
       discord.discord_user_id,
       external.id AS external_account_id,
       external.provider,
       external.external_user_id,
       external.status AS external_account_status,
       discord.bound_at
FROM discord_accounts AS discord
JOIN users ON users.id = discord.user_id
LEFT JOIN LATERAL (
  SELECT *
  FROM external_accounts
  WHERE external_accounts.user_id = users.id
    AND external_accounts.status = 'ACTIVE'
  ORDER BY external_accounts.created_at ASC
  LIMIT 1
) AS external ON true
WHERE discord.guild_id = $1
  AND discord.discord_user_id = $2
LIMIT 1
      `,
      [input.guildId, input.discordUserId]
    );
    return result.rows[0] ? mapAccountBindingRow(result.rows[0]) : null;
  }

  async findByExternal(input: { provider: string; externalUserId: string }): Promise<AccountBindingRecord | null> {
    const result = await this.client.query<AccountBindingRow>(
      `
SELECT users.id AS user_id,
       users.display_name,
       users.status AS user_status,
       users.row_version AS user_version,
       discord.id AS discord_account_id,
       discord.guild_id,
       discord.discord_user_id,
       external.id AS external_account_id,
       external.provider,
       external.external_user_id,
       external.status AS external_account_status,
       discord.bound_at
FROM external_accounts AS external
JOIN users ON users.id = external.user_id
JOIN discord_accounts AS discord ON discord.user_id = users.id
WHERE external.provider = $1
  AND external.external_user_id = $2
  AND external.status = 'ACTIVE'
LIMIT 1
      `,
      [input.provider, input.externalUserId]
    );
    return result.rows[0] ? mapAccountBindingRow(result.rows[0]) : null;
  }

  async listConsumptions(input: { userId: string; guildId: string; cursor: PageCursor | null; limit: number }): Promise<ConsumptionPageResult> {
    const result = await this.client.query<ConsumptionRow>(`SELECT ce.id,ce.entry_type,ce.source_id,ce.amount_minor,
      ce.currency,ce.direction,ce.occurred_at,ce.reversal_of_entry_id,o.public_id AS order_public_id,
      gr.gift_name_snapshot
      FROM consumption_entries ce LEFT JOIN orders o ON o.id=ce.order_id
      LEFT JOIN gift_requests gr ON gr.id=ce.gift_request_id
      WHERE ce.user_id=$1 AND ${consumptionGuildPredicate('ce', '$2')}
      AND ($3::timestamptz IS NULL OR (ce.occurred_at,ce.id) < ($3,$4::uuid))
      ORDER BY ce.occurred_at DESC,ce.id DESC LIMIT $5`, [input.userId, input.guildId, input.cursor?.occurredAt ?? null,
      input.cursor?.id ?? null, input.limit + 1]);
    const items = result.rows.slice(0, input.limit).map(mapConsumption);
    return { items, nextCursor: result.rows.length > input.limit && items.length
      ? encodeCursor({ occurredAt: items.at(-1)!.occurredAt, id: items.at(-1)!.id }, 'account-consumptions') : null };
  }

  async listBeneficiaryCommissions(input: { userId: string; cursor: PageCursor | null; limit: number }): Promise<CurrentCommissionPageResult> {
    const result = await this.client.query<CommissionSelfRow>(`SELECT c.id,c.program_type_snapshot,c.amount_minor,c.currency,c.status,
      c.row_version,c.created_at,source_user.display_name AS source_display,
      COALESCE(jsonb_agg(jsonb_build_object('type',ca.type,'amountMinor',ca.amount_minor,'currency',ca.currency,
        'createdAt',ca.created_at) ORDER BY ca.created_at) FILTER (WHERE ca.id IS NOT NULL),'[]'::jsonb) AS adjustments
      FROM commissions c JOIN referral_attributions ra ON ra.id=c.referral_attribution_id
      JOIN users source_user ON source_user.id=ra.referred_user_id
      LEFT JOIN commission_adjustments ca ON ca.commission_id=c.id
      WHERE c.beneficiary_user_id=$1 AND ($2::timestamptz IS NULL OR (c.created_at,c.id) < ($2,$3::uuid))
      GROUP BY c.id,source_user.display_name ORDER BY c.created_at DESC,c.id DESC LIMIT $4`, [input.userId,
      input.cursor?.occurredAt ?? null, input.cursor?.id ?? null, input.limit + 1]);
    const summaryResult = await this.client.query<{ status: string; amount: string }>(`SELECT c.status::text,
      COALESCE(SUM(GREATEST(0,c.amount_minor - COALESCE(a.debits,0) + COALESCE(a.credits,0))),0)::text AS amount
      FROM commissions c LEFT JOIN LATERAL (SELECT
        SUM(amount_minor) FILTER (WHERE type IN ('REVERSAL_DEBIT','CORRECTION_DEBIT')) AS debits,
        SUM(amount_minor) FILTER (WHERE type='CORRECTION_CREDIT') AS credits
        FROM commission_adjustments WHERE commission_id=c.id) a ON true
      WHERE c.beneficiary_user_id=$1 GROUP BY c.status`, [input.userId]);
    const items = result.rows.slice(0, input.limit).map(mapSelfCommission);
    const summary = { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: result.rows[0]?.currency ?? 'CNY' };
    for (const row of summaryResult.rows) {
      if (row.status === 'PENDING') summary.pendingMinor = Number(row.amount);
      if (row.status === 'CONFIRMED') summary.confirmedMinor = Number(row.amount);
      if (row.status === 'PAID') summary.paidMinor = Number(row.amount);
    }
    return { summary, items, nextCursor: result.rows.length > input.limit && items.length
      ? encodeCursor({ occurredAt: items.at(-1)!.createdAt, id: items.at(-1)!.id }, 'account-commissions') : null };
  }

  async createBinding(input: AccountBindingRecord): Promise<AccountBindingRecord> {
    const client = this.pool ? await this.pool.connect() : this.client;
    try {
      await client.query('BEGIN');
      const created = await insertBinding(client, input);
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if ('release' in client && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  async commitBinding(input: { binding: AccountBindingRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    const client = this.pool ? await this.pool.connect() : this.client;
    try {
      await client.query('BEGIN');
      await insertBinding(client, input.binding);
      await insertAuditRecord(client, input.auditRecord);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      if ('release' in client && typeof client.release === 'function') {
        client.release();
      }
    }
  }

  async sumActiveReservations(input: { userId: string; currency: string }): Promise<number> {
    const result = await this.client.query<{ reserved_minor: string | number | bigint | null }>(
      `
SELECT COALESCE(SUM(amount_minor), 0) AS reserved_minor
FROM fund_reservations
WHERE user_id = $1
  AND currency = $2
  AND status = ANY($3::"FundReservationStatus"[])
      `,
      [input.userId, input.currency, Array.from(activeReservationStatuses)]
    );
    return Number(result.rows[0]?.reserved_minor ?? 0);
  }
}

export async function createBinding(input: {
  store: AccountStore;
  fundingAdapter: Pick<FundingAdapter, 'resolveUser'>;
  providerKey: string;
  actor: ActorContext;
  input: CreateBindingInput;
  now: Date;
}): Promise<BindingResult> {
  const prepared = await prepareCreateBinding(input);
  await input.store.createBinding(prepared.binding);
  return prepared.data;
}

export async function prepareCreateBinding(input: {
  store: AccountStore;
  fundingAdapter: Pick<FundingAdapter, 'resolveUser'>;
  providerKey: string;
  actor: ActorContext;
  input: CreateBindingInput;
  now: Date;
}): Promise<PreparedBinding> {
  const actorIds = requireDiscordActor(input.actor);
  validateCreateBindingInput(input.input);
  const existingDiscord = await input.store.findByDiscord(actorIds);
  if (existingDiscord) {
    throw new AccountError('BINDING_CONFLICT', 'Discord account is already bound.');
  }

  const providerUser = await callProvider(() =>
    input.fundingAdapter.resolveUser({
      credentialType: input.input.credentialType,
      credentialValue: input.input.credentialValue,
      expectedCurrency: input.input.expectedCurrency
    })
  );
  if (providerUser.accountStatus !== 'ACTIVE') {
    throw new AccountError('BUSINESS_RULE_VIOLATION', 'Provider account is not active.');
  }
  const existingExternal = await input.store.findByExternal({
    provider: input.providerKey,
    externalUserId: providerUser.externalUserId
  });
  if (existingExternal) {
    throw new AccountError('BINDING_CONFLICT', 'External account is already bound.');
  }

  const record: AccountBindingRecord = {
    userId: crypto.randomUUID(),
    displayName: maskExternalUser(providerUser.displayName),
    userStatus: 'ACTIVE',
    userVersion: 1,
    discordAccountId: crypto.randomUUID(),
    guildId: actorIds.guildId,
    discordUserId: actorIds.discordUserId,
    externalAccountId: crypto.randomUUID(),
    provider: input.providerKey,
    externalUserId: providerUser.externalUserId,
    externalUserDisplay: maskExternalUser(providerUser.displayName),
    externalAccountStatus: 'ACTIVE',
    boundAt: input.now.toISOString()
  };

  return {
    data: {
      userId: record.userId,
      externalAccountId: record.externalAccountId,
      externalUserDisplay: record.externalUserDisplay,
      accountStatus: providerUser.accountStatus,
      boundAt: record.boundAt
    },
    binding: record
  };
}

async function commitBinding(
  store: AccountStore,
  binding: AccountBindingRecord,
  auditRecord: AuditRecord,
  auditSink: AuditSink
): Promise<void> {
  if (store.commitBinding) {
    await store.commitBinding({ binding, auditRecord, auditSink });
    return;
  }
  await store.createBinding(binding);
  await auditSink.append(auditRecord);
}

export async function getCurrentUser(input: {
  store: AccountStore;
  actor: ActorContext;
}): Promise<CurrentUserResult> {
  const binding = await requireCurrentBinding(input.store, input.actor);
  return {
    user: {
      id: binding.userId,
      displayName: binding.displayName,
      status: binding.userStatus,
      externalAccountDisplay: binding.externalUserDisplay,
      activeOrderId: null,
      riskFlags: [],
      version: binding.userVersion
    },
    activeOrderId: null,
    consumptionSummary: { totalMinor: 0, currency: 'CNY' },
    commissionSummary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CNY' }
  };
}

export async function getCurrentBalance(input: {
  store: AccountStore;
  fundingAdapter: Pick<FundingAdapter, 'getProviderBalance'>;
  actor: ActorContext;
}): Promise<BalanceResult> {
  const binding = await requireCurrentBinding(input.store, input.actor);
  const providerBalance = await callProvider(() =>
    input.fundingAdapter.getProviderBalance({ externalUserId: binding.externalUserId })
  );
  const reservedMinor = await input.store.sumActiveReservations({
    userId: binding.userId,
    currency: providerBalance.currency
  });
  return {
    providerBalanceMinor: providerBalance.providerBalanceMinor,
    reservedMinor,
    availableMinor: Math.max(0, providerBalance.providerBalanceMinor - reservedMinor),
    currency: providerBalance.currency,
    fetchedAt: providerBalance.fetchedAt
  };
}

export async function listCurrentUserConsumptions(input: {
  store: AccountStore;
  actor: ActorContext;
  cursor?: string;
  limit?: number;
}): Promise<ConsumptionPageResult> {
  const binding = await requireCurrentBinding(input.store, input.actor);
  const actorIds = requireDiscordActor(input.actor);
  if (!input.store.listConsumptions) return { items: [], nextCursor: null };
  return input.store.listConsumptions({ userId: binding.userId, guildId: actorIds.guildId,
    cursor: decodeCursor(input.cursor, 'account-consumptions'), limit: input.limit ?? 50 });
}

export async function listCurrentUserCommissions(input: {
  store: AccountStore;
  actor: ActorContext;
  cursor?: string;
  limit?: number;
}): Promise<CurrentCommissionPageResult> {
  const binding = await requireCurrentBinding(input.store, input.actor);
  if (!input.store.listBeneficiaryCommissions) return { summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CNY' }, items: [], nextCursor: null };
  return input.store.listBeneficiaryCommissions({ userId: binding.userId, cursor: decodeCursor(input.cursor, 'account-commissions'), limit: input.limit ?? 50 });
}

export async function getCurrentUserProfileSummary(input: {
  store: AccountStore;
  profileStore: CustomerProfileStore;
  fundingAdapter: Pick<FundingAdapter, 'getProviderBalance'>;
  actor: ActorContext;
  rechargeUrl: string;
  now: Date;
}): Promise<CurrentUserProfileResult> {
  const binding = await requireCurrentBinding(input.store, input.actor);
  const actorIds = requireDiscordActor(input.actor);
  const scope = selfProfileScope(binding.userId, actorIds.guildId);
  const summary = await input.profileStore.getSummaryData({ ...scope, window: 'ALL', now: input.now });
  if (!summary || summary.user.discordUserId !== actorIds.discordUserId) {
    throw new AccountError('ACCOUNT_NOT_BOUND', 'Current Discord actor is not bound.');
  }
  let snapshot = null as Awaited<ReturnType<CustomerProfileStore['getLatestBalanceSnapshot']>>;
  let providerStale = false;
  let providerError: CurrentUserProfileResult['balance']['providerError'] = null;
  try {
    const balance = await input.fundingAdapter.getProviderBalance({ externalUserId: binding.externalUserId });
    snapshot = { id: crypto.randomUUID(), userId: binding.userId, provider: binding.provider,
      providerBalanceMinor: balance.providerBalanceMinor, currency: balance.currency, fetchedAt: balance.fetchedAt };
    providerStale = balance.stale;
    if (!balance.stale) await input.profileStore.appendBalanceSnapshot(snapshot);
  } catch (error) {
    snapshot = await input.profileStore.getLatestBalanceSnapshot({ userId: binding.userId, provider: binding.provider });
    providerError = { code: error instanceof AdapterError && error.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
      retryable: error instanceof AdapterError ? error.retryable : true,
      requestId: error instanceof AdapterError ? error.requestId : 'req_provider_unavailable' };
  }
  const reservedMinor = snapshot ? await input.profileStore.sumActiveReservations({ userId: binding.userId, currency: snapshot.currency }) : null;
  return {
    user: { userId: binding.userId, discordUserId: actorIds.discordUserId, displayName: binding.displayName, status: binding.userStatus },
    balance: snapshot ? { providerBalanceMinor: snapshot.providerBalanceMinor, reservedMinor,
      availableMinor: snapshot.providerBalanceMinor - reservedMinor!, currency: snapshot.currency, fetchedAt: snapshot.fetchedAt,
      stale: providerStale || providerError !== null, providerError } : { providerBalanceMinor: null, reservedMinor: null,
      availableMinor: null, currency: null, fetchedAt: null, stale: true, providerError },
    statistics: summary.statistics,
    activeReservationCount: await input.profileStore.countActiveReservations({ userId: binding.userId }),
    rechargeUrl: input.rechargeUrl
  };
}

export async function listCurrentUserOrders(input: { store: AccountStore; profileStore: CustomerProfileStore;
  actor: ActorContext; cursor?: string; limit?: number }) {
  const binding = await requireCurrentBinding(input.store, input.actor);
  const actorIds = requireDiscordActor(input.actor);
  const page = await input.profileStore.listOrders({ ...selfProfileScope(binding.userId, actorIds.guildId), cursor: input.cursor ?? null, limit: input.limit ?? 50 });
  return { items: page.items.map((order) => ({ id: order.id, publicId: order.publicId, status: order.status,
    gameKey: order.gameKey, serviceKey: order.serviceKey, playerDisplayName: order.playerDisplayName,
    amountMinor: order.amountMinor, currency: order.currency, createdAt: order.createdAt, completedAt: order.completedAt })),
    nextCursor: page.nextCursor };
}

export function registerAccountRoutes(
  server: FastifyInstance,
  options: {
    store: AccountStore;
    fundingAdapter: Pick<FundingAdapter, 'resolveUser' | 'getProviderBalance'>;
    providerKey: string;
    now?: () => Date;
    auditSink?: AuditSink;
    profileStore?: CustomerProfileStore;
    rechargeUrl?: string;
  }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Account routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());
  const auditSink = options.auditSink ?? security.auditSink ?? new InMemoryAuditSink();

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/bindings',
    permission: 'account.bind',
    action: 'CREATE_BINDING',
    targetType: 'external_account_binding',
    successStatusCode: 201,
    acceptedSources: ['DISCORD_BOT'],
    fingerprintBody: (request) => sanitizeBindingFingerprint(request.body),
    handler: async (request, actor) => {
      const prepared = await prepareCreateBinding({
        store: options.store,
        fundingAdapter: options.fundingAdapter,
        providerKey: options.providerKey,
        actor,
        input: request.body as CreateBindingInput,
        now: now()
      });
      return {
        data: prepared.data,
        commit: async (auditRecord: AuditRecord) => {
          await commitBinding(options.store, prepared.binding, auditRecord, auditSink);
        }
      };
    },
    mapError: mapAccountError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/me',
    permission: 'account.self.read',
    action: 'GET_CURRENT_USER',
    targetType: 'user',
    handler: (_request, actor) => getCurrentUser({ store: options.store, actor }),
    mapError: mapAccountError
  });

  if (options.profileStore && options.rechargeUrl) {
    registerSecureReadRoute(server, security, {
      method: 'GET', url: '/api/v1/me/profile', permission: 'account.self.read', action: 'GET_CURRENT_USER_PROFILE',
      targetType: 'user', acceptedSources: ['DISCORD_BOT'], mapError: mapSelfProfileError,
      handler: (_request, actor) => getCurrentUserProfileSummary({ store: options.store, profileStore: options.profileStore!,
        fundingAdapter: options.fundingAdapter, actor, rechargeUrl: options.rechargeUrl!, now: now() })
    });
    registerSecureReadRoute(server, security, {
      method: 'GET', url: '/api/v1/me/orders', permission: 'order.read', action: 'LIST_CURRENT_USER_ORDERS',
      targetType: 'order', acceptedSources: ['DISCORD_BOT'], mapError: mapSelfProfileError,
      handler: (request, actor) => listCurrentUserOrders({ store: options.store, profileStore: options.profileStore!, actor, ...pageQuery(request) })
    });
  }

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/me/balance',
    permission: 'balance.self.read',
    action: 'GET_CURRENT_BALANCE',
    targetType: 'user_balance',
    handler: (_request, actor) => getCurrentBalance({
      store: options.store,
      fundingAdapter: options.fundingAdapter,
      actor
    }),
    mapError: mapAccountError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/me/consumptions',
    permission: 'consumption.self.read',
    action: 'LIST_CURRENT_USER_CONSUMPTIONS',
    targetType: 'consumption',
    handler: (request, actor) => listCurrentUserConsumptions({ store: options.store, actor, ...pageQuery(request) }),
    mapError: mapAccountError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/me/commissions',
    permission: 'commission.self.read',
    action: 'LIST_CURRENT_USER_COMMISSIONS',
    targetType: 'commission',
    handler: (request, actor) => listCurrentUserCommissions({ store: options.store, actor, ...pageQuery(request) }),
    mapError: mapAccountError
  });
}

const activeReservationStatuses = new Set<ReservationStatus>([
  'PENDING',
  'ACTIVE',
  'DISPUTED',
  'PARTIALLY_SETTLED'
]);

function validateCreateBindingInput(input: CreateBindingInput): void {
  if (!input || typeof input !== 'object') {
    throw new AccountError('VALIDATION_ERROR', 'Binding payload is required.');
  }
  if (input.credentialType !== 'ONE_TIME_CODE') {
    throw new AccountError('VALIDATION_ERROR', 'credentialType must be ONE_TIME_CODE.');
  }
  if (!input.credentialValue || typeof input.credentialValue !== 'string') {
    throw new AccountError('VALIDATION_ERROR', 'credentialValue is required.');
  }
  if (!input.expectedCurrency || typeof input.expectedCurrency !== 'string') {
    throw new AccountError('VALIDATION_ERROR', 'expectedCurrency is required.');
  }
}

function sanitizeBindingFingerprint(body: unknown): unknown {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const input = body as Partial<CreateBindingInput>;
  return {
    credentialType: input.credentialType ?? null,
    credentialHash:
      typeof input.credentialValue === 'string'
        ? createHash('sha256').update(input.credentialValue).digest('hex')
        : null,
    expectedCurrency: input.expectedCurrency ?? null
  };
}

async function requireCurrentBinding(store: AccountStore, actor: ActorContext): Promise<AccountBindingRecord> {
  const actorIds = requireDiscordActor(actor);
  const binding = await store.findByDiscord(actorIds);
  if (!binding) {
    throw new AccountError('ACCOUNT_NOT_BOUND', 'Current Discord actor is not bound.');
  }
  return binding;
}

function requireDiscordActor(actor: ActorContext): { guildId: string; discordUserId: string } {
  if (!actor.guildId || !actor.discordUserId) {
    throw new AccountError('VALIDATION_ERROR', 'Discord actor context is required.');
  }
  return {
    guildId: actor.guildId,
    discordUserId: actor.discordUserId
  };
}

function selfProfileScope(userId: string, guildId: string) {
  return { userId, guildId, actorStaffId: userId, actorLevel: 'L2_SUPERVISOR' as const };
}

async function callProvider<T>(fn: () => MaybePromise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AdapterError) {
      throw new AccountError(
        error.retryable ? 'PROVIDER_UNAVAILABLE' : 'BUSINESS_RULE_VIOLATION',
        error.message
      );
    }
    throw error;
  }
}

function mapAccountError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof AccountError)) {
    return null;
  }
  const statusByCode: Record<AccountError['code'], number> = {
    BINDING_CONFLICT: 409,
    ACCOUNT_NOT_BOUND: 403,
    PROVIDER_UNAVAILABLE: 503,
    VALIDATION_ERROR: 400,
    BUSINESS_RULE_VIOLATION: 422
  };
  return {
    statusCode: statusByCode[error.code],
    code: error.code,
    message: error.message
  };
}

function mapSelfProfileError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (error instanceof CustomerProfileError) {
    return { statusCode: error.code === 'NOT_FOUND' ? 404 : 400, code: error.code, message: error.message };
  }
  const mapped = mapAccountError(error);
  return error instanceof AccountError && error.code === 'ACCOUNT_NOT_BOUND'
    ? { statusCode: 404, code: 'NOT_FOUND', message: 'The requested resource was not found.' }
    : mapped;
}

function maskExternalUser(value: string): string {
  const normalized = value.trim();
  if (normalized.startsWith('mock-user-')) {
    return `mock-***-${normalized.slice('mock-user-'.length)}`;
  }
  if (normalized.length <= 4) {
    return '***';
  }
  return `${normalized.slice(0, 2)}***${normalized.slice(-2)}`;
}

function discordKey(input: Pick<AccountBindingRecord, 'guildId' | 'discordUserId'>): string {
  return `${input.guildId}:${input.discordUserId}`;
}

function externalKey(provider: string, externalUserId: string): string {
  return `${provider}:${externalUserId}`;
}

interface AccountBindingRow {
  user_id: string;
  display_name: string;
  user_status: UserStatus;
  user_version: number;
  discord_account_id: string;
  guild_id: string;
  discord_user_id: string;
  external_account_id: string | null;
  provider: string | null;
  external_user_id: string | null;
  external_account_status: ExternalAccountStatus | null;
  bound_at: Date | string;
}

async function insertBinding(client: AccountQueryClient, binding: AccountBindingRecord): Promise<AccountBindingRecord> {
  const insertedUser = await client.query<{ id: string }>(
    `
INSERT INTO users (id, display_name, status, row_version, created_at, updated_at)
VALUES ($1, $2, $3::"UserStatus", $4, $5, $5)
ON CONFLICT (id) DO NOTHING
RETURNING id
    `,
    [
      binding.userId,
      binding.displayName,
      binding.userStatus,
      binding.userVersion,
      new Date(binding.boundAt)
    ]
  );
  if (!insertedUser.rows[0]) {
    throw new AccountError('BINDING_CONFLICT', 'User id is already bound.');
  }

  const insertedDiscord = await client.query<{ id: string }>(
    `
INSERT INTO discord_accounts (id, user_id, guild_id, discord_user_id, username, bound_at, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
ON CONFLICT (guild_id, discord_user_id) DO NOTHING
RETURNING id
    `,
    [
      binding.discordAccountId,
      binding.userId,
      binding.guildId,
      binding.discordUserId,
      binding.displayName,
      new Date(binding.boundAt)
    ]
  );
  if (!insertedDiscord.rows[0]) {
    throw new AccountError('BINDING_CONFLICT', 'Discord account is already bound.');
  }

  const insertedExternal = await client.query<{ id: string }>(
    `
INSERT INTO external_accounts (
  id, user_id, provider, external_user_id, status, active_user_provider_key, verified_at, created_at, updated_at
)
VALUES ($1, $2, $3, $4, $5::"ExternalAccountStatus", $6, $7, $7, $7)
ON CONFLICT (provider, external_user_id) DO NOTHING
RETURNING id
    `,
    [
      binding.externalAccountId,
      binding.userId,
      binding.provider,
      binding.externalUserId,
      binding.externalAccountStatus,
      `${binding.userId}:${binding.provider}`,
      new Date(binding.boundAt)
    ]
  );
  if (!insertedExternal.rows[0]) {
    throw new AccountError('BINDING_CONFLICT', 'External account is already bound.');
  }
  return clone(binding);
}

async function insertAuditRecord(client: AccountQueryClient, record: AuditRecord): Promise<void> {
  await client.query(
    `
INSERT INTO audit_logs (
  id, actor_user_id, actor_staff_id, actor_level, actor_source, client_id,
  interaction_id, permission_code, action, target_type, target_id, outcome,
  before_snapshot, after_snapshot, reason, request_id, approval_request_id, created_at
)
VALUES (
  $1, $2, $3, $4::"StaffLevel", $5::"ActorSource", $6,
  $7, $8, $9, $10, $11, $12::"AuditOutcome",
  $13::jsonb, $14::jsonb, $15, $16, $17, $18
)
    `,
    [
      record.id,
      isUuid(record.actorId) ? record.actorId : null,
      record.actorStaffId,
      record.actorLevel,
      record.actorSource,
      record.clientId,
      record.interactionId,
      record.permissionCode,
      record.action,
      record.targetType,
      record.targetId,
      record.outcome,
      record.beforeSnapshot ? JSON.stringify(record.beforeSnapshot) : null,
      record.afterSnapshot ? JSON.stringify(record.afterSnapshot) : null,
      record.reason,
      record.requestId,
      record.approvalRequestId,
      new Date(record.occurredAt)
    ]
  );
}

function mapAccountBindingRow(row: AccountBindingRow): AccountBindingRecord {
  if (!row.external_account_id || !row.provider || !row.external_user_id || !row.external_account_status) {
    throw new AccountError('ACCOUNT_NOT_BOUND', 'Current user does not have an active external account.');
  }
  const externalUserDisplay = maskExternalUser(row.external_user_id);
  return {
    userId: row.user_id,
    displayName: row.display_name,
    userStatus: row.user_status,
    userVersion: row.user_version,
    discordAccountId: row.discord_account_id,
    guildId: row.guild_id,
    discordUserId: row.discord_user_id,
    externalAccountId: row.external_account_id,
    provider: row.provider,
    externalUserId: row.external_user_id,
    externalUserDisplay,
    externalAccountStatus: row.external_account_status,
    boundAt: toIsoString(row.bound_at)
  };
}

function isUuid(value: string | null): boolean {
  return Boolean(value?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function pageQuery(request: FastifyRequest): { cursor?: string; limit: number } {
  const query = request.query as { cursor?: unknown; limit?: unknown };
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AccountError('VALIDATION_ERROR', 'limit must be between 1 and 100.');
  if (query.cursor !== undefined && typeof query.cursor !== 'string') throw new AccountError('VALIDATION_ERROR', 'cursor is invalid.');
  return { cursor: query.cursor, limit };
}

function encodeCursor(cursor: PageCursor, scope: Extract<CursorScope, 'account-consumptions' | 'account-commissions'>): string {
  return encodeKeysetCursor(scope, { id: cursor.id, at: cursor.occurredAt });
}

function decodeCursor(value: string | undefined, scope: Extract<CursorScope, 'account-consumptions' | 'account-commissions'>): PageCursor | null {
  if (!value) return null;
  try {
    const parsed = decodeKeysetCursor(value, scope);
    return { occurredAt: parsed.at, id: parsed.id };
  } catch {
    throw new AccountError('VALIDATION_ERROR', 'cursor is invalid.');
  }
}

function paginate<T extends { id: string; occurredAt?: string; createdAt?: string }>(records: T[], cursor: PageCursor | null, limit: number,
  scope: Extract<CursorScope, 'account-consumptions' | 'account-commissions'>) {
  const sorted = clone(records).sort((left, right) => {
    const leftAt = left.occurredAt ?? left.createdAt!;
    const rightAt = right.occurredAt ?? right.createdAt!;
    return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
  });
  const filtered = cursor ? sorted.filter((item) => {
    const at = item.occurredAt ?? item.createdAt!;
    return at < cursor.occurredAt || (at === cursor.occurredAt && item.id < cursor.id);
  }) : sorted;
  const items = filtered.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: filtered.length > limit && last
    ? encodeCursor({ occurredAt: last.occurredAt ?? last.createdAt!, id: last.id }, scope) : null };
}

function commissionSummary(records: Array<BeneficiaryCommissionRecord & { beneficiaryUserId: string }>) {
  const summary = { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: records[0]?.currency ?? 'CNY' };
  for (const record of records) {
    if (record.status === 'PENDING') summary.pendingMinor += record.netAmountMinor;
    if (record.status === 'CONFIRMED') summary.confirmedMinor += record.netAmountMinor;
    if (record.status === 'PAID') summary.paidMinor += record.netAmountMinor;
  }
  return summary;
}

function mapConsumption(row: ConsumptionRow): ConsumptionRecord {
  const type = row.entry_type === 'ORDER_CHARGE' ? 'ORDER' : row.entry_type === 'GIFT_CHARGE' ? 'GIFT' : 'REVERSAL';
  return { id: row.id, type, sourceId: row.source_id,
    amountMinor: row.direction === 'CREDIT' ? -Number(row.amount_minor) : Number(row.amount_minor), currency: row.currency,
    status: row.direction === 'CREDIT' ? 'REVERSED' : 'SUCCEEDED',
    targetDisplay: row.order_public_id ? `Order ${row.order_public_id}` : row.gift_name_snapshot ? `Gift ${row.gift_name_snapshot}` : 'Refund adjustment',
    occurredAt: toIsoString(row.occurred_at), reversalOf: row.reversal_of_entry_id };
}

function mapSelfCommission(row: CommissionSelfRow): BeneficiaryCommissionRecord {
  const adjustments = row.adjustments.map((item) => ({ type: item.type,
    amountMinor: Number(item.amountMinor), currency: item.currency, createdAt: toIsoString(item.createdAt) }));
  const net = adjustments.reduce((value, item) => item.type === 'CORRECTION_CREDIT'
    ? value + item.amountMinor : value - item.amountMinor, Number(row.amount_minor));
  return { id: row.id, programType: row.program_type_snapshot, sourceCustomerMasked: { display: 'Customer ***' },
    amountMinor: Number(row.amount_minor), currency: row.currency, status: row.status, adjustments,
    netAmountMinor: Math.max(0, net), version: row.row_version, createdAt: toIsoString(row.created_at) };
}

interface ConsumptionRow {
  id: string; entry_type: 'ORDER_CHARGE' | 'GIFT_CHARGE' | 'REFUND_REVERSAL'; source_id: string;
  amount_minor: string | number | bigint; currency: string; direction: 'DEBIT' | 'CREDIT'; occurred_at: Date | string;
  reversal_of_entry_id: string | null; order_public_id: string | null; gift_name_snapshot: string | null;
}

interface CommissionSelfRow {
  id: string; program_type_snapshot: BeneficiaryCommissionRecord['programType']; amount_minor: string | number | bigint;
  currency: string; status: BeneficiaryCommissionRecord['status']; row_version: number; created_at: Date | string;
  source_display: string; adjustments: Array<{ type: BeneficiaryCommissionRecord['adjustments'][number]['type']; amountMinor: number | string; currency: string; createdAt: Date | string }>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
