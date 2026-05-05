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
import { AdapterError, type MockFundingAdapter } from './payment-adapter.js';

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

export interface ConsumptionPageResult {
  items: [];
  nextCursor: null;
}

export interface CurrentCommissionPageResult {
  summary: { pendingMinor: number; confirmedMinor: number; paidMinor: number; currency: string };
  items: [];
  nextCursor: null;
}

export interface AccountStore {
  findByDiscord(input: { guildId: string; discordUserId: string }): Promise<AccountBindingRecord | null>;
  findByExternal(input: { provider: string; externalUserId: string }): Promise<AccountBindingRecord | null>;
  createBinding(input: AccountBindingRecord): Promise<AccountBindingRecord>;
  commitBinding?(input: { binding: AccountBindingRecord; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void>;
  sumActiveReservations(input: { userId: string; currency: string }): Promise<number>;
}

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

  constructor(input: {
    bindings?: AccountBindingRecord[];
    reservations?: FundReservationBalanceRecord[];
    reservationSource?: () => FundReservationBalanceRecord[];
  }) {
    this.reservations = input.reservations ?? [];
    this.reservationSource = input.reservationSource ?? null;
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
  fundingAdapter: Pick<MockFundingAdapter, 'resolveUser'>;
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
  fundingAdapter: Pick<MockFundingAdapter, 'resolveUser'>;
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

  const providerUser = callProvider(() =>
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
  fundingAdapter: Pick<MockFundingAdapter, 'getProviderBalance'>;
  actor: ActorContext;
}): Promise<BalanceResult> {
  const binding = await requireCurrentBinding(input.store, input.actor);
  const providerBalance = callProvider(() =>
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
}): Promise<ConsumptionPageResult> {
  await requireCurrentBinding(input.store, input.actor);
  return {
    items: [],
    nextCursor: null
  };
}

export async function listCurrentUserCommissions(input: {
  store: AccountStore;
  actor: ActorContext;
}): Promise<CurrentCommissionPageResult> {
  await requireCurrentBinding(input.store, input.actor);
  return {
    summary: { pendingMinor: 0, confirmedMinor: 0, paidMinor: 0, currency: 'CNY' },
    items: [],
    nextCursor: null
  };
}

export function registerAccountRoutes(
  server: FastifyInstance,
  options: {
    store: AccountStore;
    fundingAdapter: Pick<MockFundingAdapter, 'resolveUser' | 'getProviderBalance'>;
    providerKey: string;
    now?: () => Date;
    auditSink?: AuditSink;
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
    handler: (_request, actor) => listCurrentUserConsumptions({ store: options.store, actor }),
    mapError: mapAccountError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/me/commissions',
    permission: 'commission.self.read',
    action: 'LIST_CURRENT_USER_COMMISSIONS',
    targetType: 'commission',
    handler: (_request, actor) => listCurrentUserCommissions({ store: options.store, actor }),
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

function callProvider<T>(fn: () => T): T {
  try {
    return fn();
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
