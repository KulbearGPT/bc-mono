import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BusinessTagRecord, BusinessTagStore } from './business-tags.js';
import { decodeAdminCollectionCursor, paginateAdminCollection, parseAdminCollectionSort, type CursorBinding, type SortDirection } from './admin-collection-sort.js';
import {
  InMemoryAuditSink,
  insertPostgresAuditRecord,
  registerSecureReadRoute,
  registerSecureWriteRoute,
  type ActorContext,
  type AuditRecord,
  type AuditSink,
  type StaffLevel
} from './security.js';

export type CatalogStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export type Currency = 'CAT';

export interface MoneyInput {
  amountMinor: number;
  currency: Currency;
}

export interface ServiceCatalogRecord {
  id: string;
  offeringKey: string;
  serviceOfferingId?: string | null;
  game: string;
  gameDisplayName?: string;
  service: string;
  serviceDisplayName?: string;
  region: string | null;
  regionDisplayName?: string | null;
  billingUnitMinutes: number;
  minimumUnits: number;
  customerUnitPriceMinor: number | null;
  playerUnitPayoutMinor: number | null;
  defaultPlayerPayoutBps?: number | null;
  currency: Currency;
  status: CatalogStatus;
  version: number;
  createdByStaffId: string;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  archivedAt?: string | null;
}

export interface PublicServiceCatalog {
  id: string;
  game: string;
  gameDisplayName: string;
  service: string;
  serviceDisplayName: string;
  region: string | null;
  regionDisplayName: string | null;
  billingUnitMinutes: number;
  minimumUnits: number;
  customerUnitPriceMinor: number;
  currency: Currency;
  version: number;
}

export interface AdminServiceCatalog extends PublicServiceCatalog {
  offeringKey: string;
  serviceOfferingId: string;
  status: CatalogStatus;
  defaultPlayerPayoutBps: number;
  playerUnitPayoutMinor: number;
  enabled: boolean;
  createdByStaffId: string;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  archivedAt: string | null;
}

export interface EstimateServiceResult {
  serviceCatalogId: string;
  catalogVersion: number;
  unitCount: number;
  billingUnitMinutes: number;
  amountMinor: number;
  playerEarningMinor: number;
  currency: Currency;
  validUntil: string;
}

export interface ServiceCatalogStore {
  list(): Promise<ServiceCatalogRecord[]>;
  listPage(input: CatalogPageInput): Promise<CatalogPage>;
  getById(id: string): Promise<ServiceCatalogRecord | null>;
  save(record: ServiceCatalogRecord): Promise<ServiceCatalogRecord>;
  commit?(input: { records: ServiceCatalogRecord[]; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void>;
}

interface CatalogPageInput {
  cursor: string | null;
  limit: number;
  sortBy: string;
  sortDirection: SortDirection;
  binding: CursorBinding;
}

interface CatalogPage {
  items: ServiceCatalogRecord[];
  nextCursor: string | null;
}

export interface CatalogQueryClient {
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}

export interface CatalogTransactionClient extends CatalogQueryClient {
  release(): void;
}

export interface CatalogPool extends CatalogQueryClient {
  connect(): Promise<CatalogTransactionClient>;
}

export interface CreateServiceCatalogInput {
  game: string;
  gameDisplayName?: string;
  service: string;
  serviceDisplayName?: string;
  region: string | null;
  regionDisplayName?: string | null;
  billingUnitMinutes: number;
  minimumUnits: number;
  customerUnitPrice: MoneyInput | null;
  playerUnitPayout: MoneyInput | null;
  defaultPlayerPayoutBps?: number;
  enabled: boolean;
  reasonCode: string;
}

export interface UpdateServiceCatalogInput {
  expectedVersion: number;
  action: 'ENABLE' | 'DISABLE' | 'SUPERSEDE' | 'ARCHIVE';
  reasonCode: string;
  replacement?: CreateServiceCatalogInput | null;
}

export interface PreparedCatalogWrite<TData> {
  data: TData;
  records: ServiceCatalogRecord[];
}

type NormalizedCreateServiceCatalogInput = Omit<CreateServiceCatalogInput, 'customerUnitPrice' | 'playerUnitPayout'> & {
  customerUnitPrice: MoneyInput;
  playerUnitPayout: MoneyInput;
};

const levelRank: Record<StaffLevel, number> = {
  L1_SUPPORT: 1,
  L2_SUPERVISOR: 2,
  L3_OPERATIONS: 3,
  L4_ADMIN_OWNER: 4
};

export class CatalogError extends Error {
  readonly code:
    | 'PERMISSION_DENIED'
    | 'BUSINESS_RULE_VIOLATION'
    | 'SERVICE_NOT_AVAILABLE'
    | 'RESOURCE_NOT_FOUND'
    | 'CONFLICT'
    | 'VALIDATION_ERROR';

  constructor(code: CatalogError['code'], message: string) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

export class InMemoryServiceCatalogStore implements ServiceCatalogStore {
  private readonly records = new Map<string, ServiceCatalogRecord>();

  constructor(input: { records: ServiceCatalogRecord[] }) {
    for (const record of input.records) {
      this.records.set(record.id, clone(record));
    }
  }

  async list(): Promise<ServiceCatalogRecord[]> {
    return Array.from(this.records.values()).map(clone).sort((left, right) => {
      const offeringDiff = left.offeringKey.localeCompare(right.offeringKey);
      return offeringDiff === 0 ? left.version - right.version : offeringDiff;
    });
  }

  async listPage(input: CatalogPageInput): Promise<CatalogPage> {
    return pageCatalogRecords(Array.from(this.records.values()).filter((record)=>!record.archivedAt), normalizeCatalogPageInput(input));
  }

  async getById(id: string): Promise<ServiceCatalogRecord | null> {
    const record = this.records.get(id);
    return record ? clone(record) : null;
  }

  async save(record: ServiceCatalogRecord): Promise<ServiceCatalogRecord> {
    this.records.set(record.id, clone(record));
    return clone(record);
  }

  async commit(input: { records: ServiceCatalogRecord[]; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    const snapshot = new Map(this.records);
    try {
      for (const record of input.records) {
        this.records.set(record.id, clone(record));
      }
      await input.auditSink.append(input.auditRecord);
    } catch (error) {
      this.records.clear();
      for (const [id, record] of snapshot.entries()) {
        this.records.set(id, record);
      }
      throw error;
    }
  }
}

export class PostgresServiceCatalogStore implements ServiceCatalogStore {
  private readonly client: CatalogQueryClient;
  private readonly pool: CatalogPool | null;

  constructor(options: { client?: CatalogQueryClient; pool?: CatalogPool }) {
    if (!options.client && !options.pool) {
      throw new CatalogError('VALIDATION_ERROR', 'PostgresServiceCatalogStore requires a client or pool.');
    }
    this.client = options.pool ?? options.client!;
    this.pool = options.pool ?? null;
  }

  async list(): Promise<ServiceCatalogRecord[]> {
    const result = await this.client.query<ServiceCatalogRow>(`
SELECT version.id, version.service_offering_id, offering.game_code, offering.game_name,
       offering.service_code, offering.service_name, offering.region_code,
       (SELECT tag.display_name FROM skill_tags AS tag WHERE tag.type = 'REGION' AND tag.code = offering.region_code) AS region_name,
       offering.archived_at,
       version.billing_unit_minutes, version.minimum_units,
       version.customer_unit_price_minor, version.player_unit_payout_minor, version.default_player_payout_bps,
       version.currency, version.status, version.version,
       version.created_by_staff_id, version.created_at,
       version.activated_at, version.retired_at
FROM service_catalog_versions AS version
JOIN service_offerings AS offering ON offering.id = version.service_offering_id
ORDER BY offering.game_code ASC, offering.service_code ASC, offering.region_code ASC NULLS FIRST, version.version ASC
    `);
    return result.rows.map(mapServiceCatalogRow);
  }

  async listPage(input: CatalogPageInput): Promise<CatalogPage> {
    input=normalizeCatalogPageInput(input);
    const cursor=decodeCatalogCursor(input);const sort=catalogSqlSort(input.sortBy,input.sortDirection);
    const result = await this.client.query<ServiceCatalogRow>(
      `
SELECT version.id, version.service_offering_id, offering.game_code, offering.game_name,
       offering.service_code, offering.service_name, offering.region_code,
       (SELECT tag.display_name FROM skill_tags AS tag WHERE tag.type = 'REGION' AND tag.code = offering.region_code) AS region_name,
       offering.archived_at,
       version.billing_unit_minutes, version.minimum_units,
       version.customer_unit_price_minor, version.player_unit_payout_minor, version.default_player_payout_bps,
       version.currency, version.status, version.version,
       version.created_by_staff_id, version.created_at,
       version.activated_at, version.retired_at
FROM service_catalog_versions AS version
JOIN service_offerings AS offering ON offering.id = version.service_offering_id
WHERE offering.archived_at IS NULL AND ${catalogKeysetPredicate(sort,cursor!==null)}
ORDER BY (${sort.expression} IS NULL) ASC, ${sort.expression} ${sort.direction}, version.id ${sort.direction}
LIMIT $4
      `,
      [cursor?.sortValue ?? null, cursor?.id ?? null, cursor!==null, input.limit + 1]
    );
    return pageCatalogRecords(result.rows.map(mapServiceCatalogRow),{...input,cursor:null});
  }

  async getById(id: string): Promise<ServiceCatalogRecord | null> {
    const result = await this.client.query<ServiceCatalogRow>(
      `
SELECT version.id, version.service_offering_id, offering.game_code, offering.game_name,
       offering.service_code, offering.service_name, offering.region_code,
       (SELECT tag.display_name FROM skill_tags AS tag WHERE tag.type = 'REGION' AND tag.code = offering.region_code) AS region_name,
       offering.archived_at,
       version.billing_unit_minutes, version.minimum_units,
       version.customer_unit_price_minor, version.player_unit_payout_minor, version.default_player_payout_bps,
       version.currency, version.status, version.version,
       version.created_by_staff_id, version.created_at,
       version.activated_at, version.retired_at
FROM service_catalog_versions AS version
JOIN service_offerings AS offering ON offering.id = version.service_offering_id
WHERE version.id = $1
      `,
      [id]
    );
    return result.rows[0] ? mapServiceCatalogRow(result.rows[0]) : null;
  }

  async save(record: ServiceCatalogRecord): Promise<ServiceCatalogRecord> {
    return savePostgresCatalogRecord(this.client, record);
  }

  async commit(input: { records: ServiceCatalogRecord[]; auditRecord: AuditRecord; auditSink: AuditSink }): Promise<void> {
    const transactionClient = this.pool ? await this.pool.connect() : this.client;
    try {
      await transactionClient.query('BEGIN');
      for (const record of input.records) {
        await this.saveWithClient(transactionClient, record);
      }
      await this.insertAuditRecord(transactionClient, input.auditRecord);
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

  private async insertAuditRecord(client: CatalogQueryClient, record: AuditRecord): Promise<void> {
    await insertPostgresAuditRecord(client, record);
  }

  private async saveWithClient(client: CatalogQueryClient, record: ServiceCatalogRecord): Promise<ServiceCatalogRecord> {
    return savePostgresCatalogRecord(client, record);
  }
}

async function savePostgresCatalogRecord(
  client: CatalogQueryClient,
  record: ServiceCatalogRecord
): Promise<ServiceCatalogRecord> {
  const offeringId = crypto.randomUUID();
  const result = await client.query<ServiceCatalogRow>(
    `
WITH offering AS (
  INSERT INTO service_offerings (
    id, code, game_code, game_name, service_code, service_name, region_code, archived_at, created_at, updated_at
  )
  VALUES ($13, $14, $2, $20, $3, $21, $4, $19, $15, $15)
  ON CONFLICT (code) DO UPDATE
    SET game_name = EXCLUDED.game_name,
        service_name = EXCLUDED.service_name,
        archived_at = EXCLUDED.archived_at,
        updated_at = EXCLUDED.updated_at
  RETURNING id, game_code, game_name, service_code, service_name, region_code, archived_at
),
version_upsert AS (
  INSERT INTO service_catalog_versions (
    id, service_offering_id, version, status, active_offering_key,
    billing_unit_minutes, minimum_units, customer_unit_price_minor, player_unit_payout_minor, default_player_payout_bps,
    currency, created_by_staff_id, activated_at, retired_at, created_at
  )
  SELECT $1, offering.id, $12, $9::"CatalogVersionStatus",
         CASE WHEN $9 = 'ACTIVE' THEN offering.id ELSE NULL END,
         $5, $6, $7, $8, $18, $10, $11, $16, $17, $15
  FROM offering
  ON CONFLICT (id) DO UPDATE
    SET status = EXCLUDED.status,
        active_offering_key = EXCLUDED.active_offering_key,
        activated_at = EXCLUDED.activated_at,
        retired_at = EXCLUDED.retired_at
  RETURNING id, service_offering_id, billing_unit_minutes, minimum_units,
            customer_unit_price_minor, player_unit_payout_minor, default_player_payout_bps, currency, status, version,
            created_by_staff_id, created_at, activated_at, retired_at
)
SELECT version_upsert.id, version_upsert.service_offering_id,
       offering.game_code, offering.game_name, offering.service_code, offering.service_name, offering.region_code, offering.archived_at,
       version_upsert.billing_unit_minutes, version_upsert.minimum_units,
       version_upsert.customer_unit_price_minor, version_upsert.player_unit_payout_minor, version_upsert.default_player_payout_bps,
       version_upsert.currency, version_upsert.status, version_upsert.version,
       version_upsert.created_by_staff_id, version_upsert.created_at,
       version_upsert.activated_at, version_upsert.retired_at
FROM version_upsert
JOIN offering ON offering.id = version_upsert.service_offering_id
      `,
    [
      record.id,
      record.game,
      record.service,
      record.region,
      record.billingUnitMinutes,
      record.minimumUnits,
      record.customerUnitPriceMinor,
      record.playerUnitPayoutMinor,
      record.status,
      record.currency,
      record.createdByStaffId,
      record.version,
      offeringId,
      record.offeringKey,
      new Date(record.createdAt),
      record.activatedAt ? new Date(record.activatedAt) : null,
      record.retiredAt ? new Date(record.retiredAt) : null,
      record.defaultPlayerPayoutBps ?? Math.floor((record.playerUnitPayoutMinor ?? 0) * 10000 / (record.customerUnitPriceMinor ?? 1)),
      record.archivedAt ? new Date(record.archivedAt) : null,
      record.gameDisplayName ?? record.game,
      record.serviceDisplayName ?? record.service
    ]
  );
  if (!result.rows[0]) {
    throw new CatalogError('RESOURCE_NOT_FOUND', 'Service catalog version could not be saved.');
  }
  return mapServiceCatalogRow(result.rows[0]);
}

export async function listServices(input: {
  store: ServiceCatalogStore;
  filters?: { game?: string; region?: string | null };
}): Promise<{ items: PublicServiceCatalog[] }> {
  const records = await input.store.list();
  const items = records
    .filter((record) => isPubliclyAvailable(record))
    .filter((record) => !input.filters?.game || record.game === input.filters.game)
    .filter((record) => input.filters?.region === undefined || record.region === input.filters.region)
    .map(toPublicCatalog);
  return { items };
}

export async function estimateService(input: {
  store: ServiceCatalogStore;
  serviceCatalogId: string;
  unitCount: number;
  now: Date;
}): Promise<EstimateServiceResult> {
  const record = await input.store.getById(input.serviceCatalogId);
  assertAvailableService(record);
  if (!Number.isInteger(input.unitCount) || input.unitCount < record.minimumUnits) {
    throw new CatalogError('VALIDATION_ERROR', 'Unit count must be at least the service minimum.');
  }
  return {
    serviceCatalogId: record.id,
    catalogVersion: record.version,
    unitCount: input.unitCount,
    billingUnitMinutes: record.billingUnitMinutes,
    amountMinor: input.unitCount * record.customerUnitPriceMinor,
    playerEarningMinor: input.unitCount * record.playerUnitPayoutMinor,
    currency: record.currency,
    validUntil: new Date(input.now.getTime() + 5 * 60_000).toISOString()
  };
}

export async function createServiceCatalogVersion(input: {
  store: ServiceCatalogStore;
  actor: ActorContext;
  input: CreateServiceCatalogInput;
  now: Date;
}): Promise<AdminServiceCatalog> {
  const prepared = await prepareCreateServiceCatalogVersion(input);
  await saveCatalogRecords(input.store, prepared.records);
  return prepared.data;
}

export async function prepareCreateServiceCatalogVersion(input: {
  store: ServiceCatalogStore;
  actor: ActorContext;
  input: CreateServiceCatalogInput;
  now: Date;
}): Promise<PreparedCatalogWrite<AdminServiceCatalog>> {
  requireCatalogManager(input.actor);
  const normalized = normalizeCreateInput(input.input);
  const existing = await input.store.list();
  const offeringKey = buildOfferingKey(normalized);
  const nextVersion = Math.max(0, ...existing.filter((record) => record.offeringKey === offeringKey).map((record) => record.version)) + 1;
  const records = normalized.enabled
    ? existing
        .filter((record) => record.offeringKey === offeringKey && record.status === 'ACTIVE')
        .map((record) => ({ ...record, status: 'RETIRED' as const, retiredAt: input.now.toISOString() }))
    : [];
  const record = buildCreatedCatalogRecord({
    actor: input.actor,
    normalized,
    offeringKey,
    version: nextVersion,
    now: input.now
  });

  return {
    data: toAdminCatalog(record),
    records: [...records, record]
  };
}

export async function updateServiceCatalogVersion(input: {
  store: ServiceCatalogStore;
  actor: ActorContext;
  serviceCatalogId: string;
  input: UpdateServiceCatalogInput;
  now: Date;
}): Promise<AdminServiceCatalog> {
  const prepared = await prepareUpdateServiceCatalogVersion(input);
  await saveCatalogRecords(input.store, prepared.records);
  return prepared.data;
}

export async function prepareUpdateServiceCatalogVersion(input: {
  store: ServiceCatalogStore;
  actor: ActorContext;
  serviceCatalogId: string;
  input: UpdateServiceCatalogInput;
  now: Date;
}): Promise<PreparedCatalogWrite<AdminServiceCatalog>> {
  requireCatalogManager(input.actor);
  const record = await input.store.getById(input.serviceCatalogId);
  if (!record) {
    throw new CatalogError('RESOURCE_NOT_FOUND', 'Service catalog version was not found.');
  }
  if (record.version !== input.input.expectedVersion) {
    throw new CatalogError('CONFLICT', 'Service catalog version is stale.');
  }

  if(input.input.action==='ARCHIVE'){
    if(record.archivedAt)throw new CatalogError('CONFLICT','Service offering is already archived.');
    const archived={...record,status:'RETIRED' as const,retiredAt:record.retiredAt??input.now.toISOString(),archivedAt:input.now.toISOString()};
    return{data:toAdminCatalog(archived),records:[archived]};
  }
  if(record.archivedAt)throw new CatalogError('BUSINESS_RULE_VIOLATION','Archived service offerings cannot be changed.');

  if (input.input.action === 'DISABLE') {
    const retired = {
      ...record,
      status: 'RETIRED' as const,
      retiredAt: input.now.toISOString()
    };
    return {
      data: toAdminCatalog(retired),
      records: [retired]
    };
  }

  if (input.input.action === 'ENABLE') {
    assertCompletePrices(record);
    const retiredRecords = (await input.store.list())
      .filter((candidate) => candidate.offeringKey === record.offeringKey && candidate.status === 'ACTIVE' && candidate.id !== record.id)
      .map((active) => ({ ...active, status: 'RETIRED' as const, retiredAt: input.now.toISOString() }));
    const enabled = {
      ...record,
      status: 'ACTIVE' as const,
      activatedAt: input.now.toISOString(),
      retiredAt: null
    };
    return {
      data: toAdminCatalog(enabled),
      records: [...retiredRecords, enabled]
    };
  }

  if (!input.input.replacement) {
    throw new CatalogError('BUSINESS_RULE_VIOLATION', 'Replacement catalog data is required.');
  }
  const retired = { ...record, status: 'RETIRED' as const, retiredAt: input.now.toISOString() };
  const replacement = await prepareCreateServiceCatalogVersion({
    store: input.store,
    actor: input.actor,
    input: input.input.replacement,
    now: input.now
  });
  return {
    data: replacement.data,
    records: [retired, ...replacement.records]
  };
}

export function registerCatalogRoutes(
  server: FastifyInstance,
  options: { store: ServiceCatalogStore; businessTags?: BusinessTagStore; now?: () => Date; auditSink?: AuditSink }
): void {
  const security = server.securityOptions;
  if (!security) {
    throw new Error('Catalog routes require buildApiServer({ security })');
  }
  const now = options.now ?? (() => new Date());
  const auditSink = options.auditSink ?? security.auditSink ?? new InMemoryAuditSink();

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/services',
    permission: 'service.read',
    action: 'LIST_SERVICES',
    targetType: 'service_catalog_version',
    handler: async (request) => listServices({ store: options.store, filters: readCatalogFilters(request) }),
    mapError: mapCatalogError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/admin/service-catalog/:serviceCatalogId',
    permission: 'catalog.read',
    action: 'GET_SERVICE_CATALOG_VERSION',
    targetType: 'service_catalog_version',
    targetId: (request) => readParams(request).serviceCatalogId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request) => {
      const record = await options.store.getById(readParams(request).serviceCatalogId ?? '');
      if (!record) throw new CatalogError('RESOURCE_NOT_FOUND', 'Service catalog version was not found.');
      return toAdminCatalog(record);
    },
    mapError: mapCatalogError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/services/:serviceCatalogId/estimate',
    permission: 'service.estimate',
    action: 'ESTIMATE_SERVICE',
    targetType: 'service_catalog_version',
    targetId: (request) => readParams(request).serviceCatalogId ?? '00000000-0000-0000-0000-000000000000',
    handler: async (request) => omitPlayerEarning(
      await estimateService({
        store: options.store,
        serviceCatalogId: readParams(request).serviceCatalogId ?? '',
        unitCount: readUnitCount(request.body),
        now: now()
      })
    ),
    mapError: mapCatalogError
  });

  registerSecureReadRoute(server, security, {
    method: 'GET',
    url: '/api/v1/admin/service-catalog',
    permission: 'catalog.read',
    action: 'LIST_SERVICE_CATALOG_VERSIONS',
    targetType: 'service_catalog_version',
    handler: async (request,actor) => {
      const page = await options.store.listPage(readCatalogPageQuery(request,actor));
      return { items: page.items.map(toAdminCatalog), nextCursor: page.nextCursor };
    },
    mapError: mapCatalogError
  });

  registerSecureWriteRoute(server, security, {
    method: 'POST',
    url: '/api/v1/admin/service-catalog',
    permission: 'catalog.manage',
    action: 'CREATE_SERVICE_CATALOG_VERSION',
    targetType: 'service_catalog_version',
    successStatusCode: 201,
    successReason: (request) => readReasonCode(request.body),
    handler: async (request, actor) => {
      const input = await catalogCreateInput(request.body, options.businessTags);
      const prepared = await prepareCreateServiceCatalogVersion({
        store: options.store,
        actor,
        input,
        now: now()
      });
      return {
        data: prepared.data,
        commit: async (auditRecord: AuditRecord) => {
          await commitCatalogWrite(options.store, prepared.records, auditRecord, auditSink);
        }
      };
    },
    mapError: mapCatalogError
  });

  registerSecureWriteRoute(server, security, {
    method: 'PATCH',
    url: '/api/v1/admin/service-catalog/:serviceCatalogId',
    permission: 'catalog.manage',
    action: 'UPDATE_SERVICE_CATALOG_VERSION',
    targetType: 'service_catalog_version',
    targetId: (request) => readParams(request).serviceCatalogId ?? '00000000-0000-0000-0000-000000000000',
    successReason: (request) => readReasonCode(request.body),
    handler: async (request, actor) => {
      const input = await catalogUpdateInput(request.body, options.businessTags);
      const prepared = await prepareUpdateServiceCatalogVersion({
        store: options.store,
        actor,
        serviceCatalogId: readParams(request).serviceCatalogId ?? '',
        input,
        now: now()
      });
      return {
        data: prepared.data,
        commit: async (auditRecord: AuditRecord) => {
          await commitCatalogWrite(options.store, prepared.records, auditRecord, auditSink);
        }
      };
    },
    mapError: mapCatalogError
  });
}

function requireCatalogManager(actor: ActorContext): void {
  if (!actor.actorLevel || levelRank[actor.actorLevel] < levelRank.L3_OPERATIONS) {
    throw new CatalogError('PERMISSION_DENIED', 'catalog.manage requires L3_OPERATIONS or above.');
  }
}

function normalizeCreateInput(input: CreateServiceCatalogInput): NormalizedCreateServiceCatalogInput {
  if (!input.customerUnitPrice || !input.playerUnitPayout) {
    throw new CatalogError('BUSINESS_RULE_VIOLATION', 'Enabled service versions require customer and player prices.');
  }
  if (input.customerUnitPrice.currency !== input.playerUnitPayout.currency) {
    throw new CatalogError('BUSINESS_RULE_VIOLATION', 'Customer and player prices must use the same currency.');
  }
  if (
    input.billingUnitMinutes < 1 ||
    input.minimumUnits < 1 ||
    input.customerUnitPrice.amountMinor < 1 ||
    input.playerUnitPayout.amountMinor < 1 ||
    (input.defaultPlayerPayoutBps !== undefined && (!Number.isInteger(input.defaultPlayerPayoutBps) || input.defaultPlayerPayoutBps < 1 || input.defaultPlayerPayoutBps > 10000))
  ) {
    throw new CatalogError('BUSINESS_RULE_VIOLATION', 'Catalog units and prices must be positive.');
  }
  return {
    ...input,
    game: input.game.trim(),
    gameDisplayName: input.gameDisplayName?.trim() || input.game.trim(),
    service: input.service.trim(),
    serviceDisplayName: input.serviceDisplayName?.trim() || input.service.trim(),
    region: input.region?.trim() || null,
    regionDisplayName: input.regionDisplayName?.trim() || input.region?.trim() || null,
    customerUnitPrice: input.customerUnitPrice,
    playerUnitPayout: input.playerUnitPayout
  };
}

async function catalogCreateInput(value: unknown, tags?: BusinessTagStore): Promise<CreateServiceCatalogInput> {
  if (!tags) return value as CreateServiceCatalogInput;
  const input = value as Record<string, unknown>;
  const game = await singleTag(tags, input.gameTagId, 'GAME', 'gameTagId', false);
  const service = await singleTag(tags, input.serviceTagId, 'SERVICE', 'serviceTagId', false);
  const region = await singleTag(tags, input.regionTagId, 'REGION', 'regionTagId', true);
  return {
    ...(input as unknown as CreateServiceCatalogInput),
    game: game!.code,
    gameDisplayName: game!.displayName,
    service: service!.code,
    serviceDisplayName: service!.displayName,
    region: region?.code ?? null,
    regionDisplayName: region?.displayName ?? null
  };
}

async function catalogUpdateInput(value: unknown, tags?: BusinessTagStore): Promise<UpdateServiceCatalogInput> {
  if (!tags) return value as UpdateServiceCatalogInput;
  const input = value as Record<string, unknown>;
  return {
    ...(input as unknown as UpdateServiceCatalogInput),
    replacement: input.replacement == null ? null : await catalogCreateInput(input.replacement, tags)
  };
}

async function singleTag(tags: BusinessTagStore, value: unknown, type: 'GAME' | 'SERVICE' | 'REGION', field: string, optional: boolean): Promise<BusinessTagRecord | null> {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value) throw new CatalogError('BUSINESS_RULE_VIOLATION', `${field} must reference an enabled business tag.`);
  try {
    const [tag] = await tags.resolveEnabled([value], [type]);
    return tag;
  } catch {
    throw new CatalogError('BUSINESS_RULE_VIOLATION', `${field} must reference an enabled ${type} tag.`);
  }
}

function buildCreatedCatalogRecord(input: {
  actor: ActorContext;
  normalized: NormalizedCreateServiceCatalogInput;
  offeringKey: string;
  version: number;
  now: Date;
}): ServiceCatalogRecord {
  return {
    id: crypto.randomUUID(),
    offeringKey: input.offeringKey,
    game: input.normalized.game,
    gameDisplayName: input.normalized.gameDisplayName,
    service: input.normalized.service,
    serviceDisplayName: input.normalized.serviceDisplayName,
    region: input.normalized.region,
    regionDisplayName: input.normalized.regionDisplayName,
    billingUnitMinutes: input.normalized.billingUnitMinutes,
    minimumUnits: input.normalized.minimumUnits,
    customerUnitPriceMinor: input.normalized.customerUnitPrice.amountMinor,
    playerUnitPayoutMinor: input.normalized.playerUnitPayout.amountMinor,
    defaultPlayerPayoutBps: input.normalized.defaultPlayerPayoutBps ?? Math.floor(input.normalized.playerUnitPayout.amountMinor * 10000 / input.normalized.customerUnitPrice.amountMinor),
    currency: input.normalized.customerUnitPrice.currency,
    status: input.normalized.enabled ? 'ACTIVE' : 'DRAFT',
    version: input.version,
    createdByStaffId: input.actor.actorStaffId ?? '00000000-0000-0000-0000-000000000000',
    createdAt: input.now.toISOString(),
    activatedAt: input.normalized.enabled ? input.now.toISOString() : null,
    retiredAt: null,
    archivedAt: null
  };
}

async function commitCatalogWrite(
  store: ServiceCatalogStore,
  records: ServiceCatalogRecord[],
  auditRecord: AuditRecord,
  auditSink: AuditSink
): Promise<void> {
  if (store.commit) {
    await store.commit({ records, auditRecord, auditSink });
    return;
  }
  for (const record of records) {
    await store.save(record);
  }
  await auditSink.append(auditRecord);
}

async function saveCatalogRecords(store: ServiceCatalogStore, records: ServiceCatalogRecord[]): Promise<void> {
  for (const record of records) {
    await store.save(record);
  }
}

function assertAvailableService(record: ServiceCatalogRecord | null): asserts record is ServiceCatalogRecord & {
  customerUnitPriceMinor: number;
  playerUnitPayoutMinor: number;
} {
  if (!record || !isPubliclyAvailable(record)) {
    throw new CatalogError('SERVICE_NOT_AVAILABLE', 'Service is not available.');
  }
}

function isPubliclyAvailable(record: ServiceCatalogRecord): record is ServiceCatalogRecord & {
  customerUnitPriceMinor: number;
  playerUnitPayoutMinor: number;
} {
  return (
    record.status === 'ACTIVE' &&
    !record.archivedAt &&
    typeof record.customerUnitPriceMinor === 'number' &&
    record.customerUnitPriceMinor > 0 &&
    typeof record.playerUnitPayoutMinor === 'number' &&
    record.playerUnitPayoutMinor > 0
  );
}

function assertCompletePrices(record: ServiceCatalogRecord): void {
  if (typeof record.customerUnitPriceMinor!=='number'||record.customerUnitPriceMinor<1||typeof record.playerUnitPayoutMinor!=='number'||record.playerUnitPayoutMinor<1) {
    throw new CatalogError('BUSINESS_RULE_VIOLATION', 'Catalog version requires customer and player prices before enable.');
  }
}

function toPublicCatalog(record: ServiceCatalogRecord & { customerUnitPriceMinor: number }): PublicServiceCatalog {
  return {
    id: record.id,
    game: record.game,
    gameDisplayName: record.gameDisplayName ?? record.game,
    service: record.service,
    serviceDisplayName: record.serviceDisplayName ?? record.service,
    region: record.region,
    regionDisplayName: record.regionDisplayName ?? record.region,
    billingUnitMinutes: record.billingUnitMinutes,
    minimumUnits: record.minimumUnits,
    customerUnitPriceMinor: record.customerUnitPriceMinor,
    currency: record.currency,
    version: record.version
  };
}

function toAdminCatalog(record: ServiceCatalogRecord): AdminServiceCatalog {
  assertCompletePrices(record);
  return {
    ...toPublicCatalog(record as ServiceCatalogRecord & { customerUnitPriceMinor: number }),
    offeringKey: record.offeringKey,
    serviceOfferingId: record.serviceOfferingId ?? record.offeringKey,
    status: record.status,
    defaultPlayerPayoutBps: record.defaultPlayerPayoutBps ?? Math.floor((record.playerUnitPayoutMinor as number) * 10000 / (record.customerUnitPriceMinor as number)),
    playerUnitPayoutMinor: record.playerUnitPayoutMinor as number,
    enabled: record.status === 'ACTIVE',
    createdByStaffId: record.createdByStaffId,
    createdAt: record.createdAt,
    activatedAt: record.activatedAt,
    retiredAt: record.retiredAt,
    archivedAt: record.archivedAt ?? null
  };
}

function omitPlayerEarning(input: EstimateServiceResult): Omit<EstimateServiceResult, 'playerEarningMinor'> {
  const { playerEarningMinor: _playerEarningMinor, ...publicEstimate } = input;
  return publicEstimate;
}

function readCatalogFilters(request: FastifyRequest): { game?: string; region?: string | null } {
  const query = request.query as { game?: string; region?: string };
  return {
    game: query.game,
    region: query.region
  };
}

function readCatalogPageQuery(request: FastifyRequest,actor:ActorContext): CatalogPageInput {
  const query = request.query as { cursor?: unknown; limit?: unknown };
  const limit = Number(query.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CatalogError('VALIDATION_ERROR', 'limit must be between 1 and 100.');
  }
  if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 500)) {
    throw new CatalogError('VALIDATION_ERROR', 'cursor is invalid.');
  }
  const sort=parseAdminCollectionSort('service_catalog',request.query as Record<string,unknown>,message=>new CatalogError('VALIDATION_ERROR',message));
  return { cursor: query.cursor === undefined ? null : query.cursor as string, limit,...sort,binding:{actorGuildId:actor.guildId??null,actorScope:`${actor.actorLevel}:${actor.actorStaffId}`,filters:{}} };
}

function pageCatalogRecords(records: ServiceCatalogRecord[], input: CatalogPageInput): CatalogPage {
  try{return paginateAdminCollection(records,{...input,resource:'service_catalog',idOf:record=>record.id,valueOf:record=>catalogSortValue(record,input.sortBy)});}catch(error){if((error as Error).message==='cursor is invalid.')throw new CatalogError('VALIDATION_ERROR','cursor is invalid.');throw error;}
}
function normalizeCatalogPageInput(input:CatalogPageInput):CatalogPageInput{return{cursor:input.cursor??null,limit:input.limit,sortBy:input.sortBy??'createdAt',sortDirection:input.sortDirection??'desc',binding:input.binding??{actorGuildId:null,actorScope:'legacy',filters:{}}};}

function catalogSortValue(record:ServiceCatalogRecord,sortBy:string){if(sortBy==='offeringName')return `${record.gameDisplayName??record.game}\u0001${record.serviceDisplayName??record.service}\u0001${record.regionDisplayName??record.region??''}`;if(sortBy==='customerUnitPriceMinor')return record.customerUnitPriceMinor;if(sortBy==='version')return record.version;return record.createdAt;}
function decodeCatalogCursor(input:CatalogPageInput){try{return decodeAdminCollectionCursor({...input,resource:'service_catalog'});}catch{throw new CatalogError('VALIDATION_ERROR','cursor is invalid.');}}
function catalogSqlSort(sortBy:string,direction:SortDirection){const entries:Record<string,{expression:string;cast:string}>={createdAt:{expression:'version.created_at',cast:'timestamptz'},offeringName:{expression:`(COALESCE(offering.game_name, offering.game_code) || chr(1) || COALESCE(offering.service_name, offering.service_code) || chr(1) || COALESCE(offering.region_code, '')) COLLATE "C"`,cast:'text'},customerUnitPriceMinor:{expression:'version.customer_unit_price_minor',cast:'bigint'},version:{expression:'version.version',cast:'integer'}};return{...entries[sortBy]!,direction:direction.toUpperCase()};}
function catalogKeysetPredicate(sort:{expression:string;cast:string;direction:string},hasCursor:boolean){if(!hasCursor)return`($1::${sort.cast} IS NULL AND $2::uuid IS NULL AND $3::boolean=FALSE)`;const op=sort.direction==='ASC'?'>':'<';return `((${sort.expression} IS NULL AND $1::${sort.cast} IS NULL AND version.id ${op} $2::uuid) OR ($1::${sort.cast} IS NOT NULL AND (${sort.expression} IS NULL OR ${sort.expression} ${op} $1::${sort.cast} OR (${sort.expression} = $1::${sort.cast} AND version.id ${op} $2::uuid)))) AND $3::boolean`;}

function readParams(request: FastifyRequest): { serviceCatalogId?: string } {
  return request.params as { serviceCatalogId?: string };
}

function readUnitCount(body: unknown): number {
  if (!body || typeof body !== 'object' || !('unitCount' in body)) {
    throw new CatalogError('VALIDATION_ERROR', 'unitCount is required.');
  }
  const value = (body as { unitCount?: unknown }).unitCount;
  if (typeof value !== 'number') {
    throw new CatalogError('VALIDATION_ERROR', 'unitCount must be a number.');
  }
  return value;
}

function readReasonCode(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('reasonCode' in body)) {
    return null;
  }
  const value = (body as { reasonCode?: unknown }).reasonCode;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildOfferingKey(input: Pick<CreateServiceCatalogInput, 'game' | 'service' | 'region'>): string {
  return `${input.game}|${input.service}|${input.region ?? ''}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mapCatalogError(error: unknown): { statusCode: number; code: string; message: string } | null {
  if (!(error instanceof CatalogError)) {
    return null;
  }
  const statusCodeByError: Record<CatalogError['code'], number> = {
    PERMISSION_DENIED: 403,
    BUSINESS_RULE_VIOLATION: 422,
    SERVICE_NOT_AVAILABLE: 422,
    RESOURCE_NOT_FOUND: 404,
    CONFLICT: 409,
    VALIDATION_ERROR: 400
  };
  return {
    statusCode: statusCodeByError[error.code],
    code: error.code,
    message: error.message
  };
}

interface ServiceCatalogRow {
  id: string;
  service_offering_id: string;
  game_code: string;
  game_name: string;
  service_code: string;
  service_name: string;
  region_code: string | null;
  region_name: string | null;
  billing_unit_minutes: number;
  minimum_units: number;
  customer_unit_price_minor: number | string | bigint | null;
  player_unit_payout_minor: number | string | bigint | null;
  default_player_payout_bps: number | null;
  currency: string;
  status: CatalogStatus;
  version: number;
  created_by_staff_id: string;
  created_at: Date | string;
  activated_at: Date | string | null;
  retired_at: Date | string | null;
  archived_at: Date | string | null;
}

function mapServiceCatalogRow(row: ServiceCatalogRow): ServiceCatalogRecord {
  return {
    id: row.id,
    offeringKey: `${row.game_code}|${row.service_code}|${row.region_code ?? ''}`,
    serviceOfferingId: row.service_offering_id,
    game: row.game_code,
    gameDisplayName: row.game_name,
    service: row.service_code,
    serviceDisplayName: row.service_name,
    region: row.region_code,
    regionDisplayName: row.region_name ?? row.region_code,
    billingUnitMinutes: row.billing_unit_minutes,
    minimumUnits: row.minimum_units,
    customerUnitPriceMinor: toNullableNumber(row.customer_unit_price_minor),
    playerUnitPayoutMinor: toNullableNumber(row.player_unit_payout_minor),
    defaultPlayerPayoutBps: row.default_player_payout_bps,
    currency: row.currency as Currency,
    status: row.status,
    version: row.version,
    createdByStaffId: row.created_by_staff_id,
    createdAt: toIsoString(row.created_at),
    activatedAt: row.activated_at ? toIsoString(row.activated_at) : null,
    retiredAt: row.retired_at ? toIsoString(row.retired_at) : null,
    archivedAt: row.archived_at ? toIsoString(row.archived_at) : null
  };
}

function toNullableNumber(value: number | string | bigint | null): number | null {
  if (value === null) {
    return null;
  }
  return Number(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUuid(value: string | null): boolean {
  return Boolean(value?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i));
}

function isCursorUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
