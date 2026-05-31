import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AuditRecord, AuditSink, StaffAccount, StaffDirectory, StaffLevel } from './security.js';
import { InMemoryAuditSink, insertPostgresAuditRecord, registerSecureReadRoute, registerSecureWriteRoute } from './security.js';
import type { DashboardAuthStore } from './dashboard-auth.js';

export interface RoleMappingRecord { guildId: string; discordRoleId: string; targetLevel: StaffLevel; enabled: boolean; version: number; reconciliationQueued: boolean }
export interface StaffAccessRecord { staffId: string; discordUserId: string; guildId: string; level: StaffLevel; requestedLevel: StaffLevel | null; status: 'ACTIVE' | 'REVOKED'; permissionsVersion: number; observedRoleIds: string[] }
export interface RoleSyncResult { discordUserId: string; previousLevel: StaffLevel | null; requestedLevel: StaffLevel | null; effectiveLevel: StaffLevel | null; status: 'APPLIED' | 'NO_CHANGE' | 'ACCESS_REVOKED'; permissionsVersion: number; sessionsRevoked: boolean }
export interface PendingRoleElevation { code: 'ROLE_ELEVATION_PENDING'; staffId: string; effectiveLevel: StaffLevel; requestedLevel: StaffLevel; approvalRequestId: string }
interface StagedAccessWrite<T> { data: T; statusCode?: number; commit(audit: AuditRecord, auditSink: AuditSink): Promise<void> | void }

export interface AccessStore {
  listMappings(): RoleMappingRecord[] | Promise<RoleMappingRecord[]>;
  updateMapping(input: { guildId: string; discordRoleId: string; targetLevel: StaffLevel; expectedVersion: number; enabled: boolean; actorStaffId: string; now: Date }): StagedAccessWrite<RoleMappingRecord> | Promise<StagedAccessWrite<RoleMappingRecord>>;
  syncRoles(input: { guildId: string; discordUserId: string; observedRoleIds: string[]; mappingVersion: number; source: string; sourceEventId: string; observedAt: Date }): StagedAccessWrite<RoleSyncResult | PendingRoleElevation> | Promise<StagedAccessWrite<RoleSyncResult | PendingRoleElevation>>;
  approveElevation(input: { targetStaffId: string; actorStaffId: string; expectedPermissionsVersion: number; requestedLevel: StaffLevel; now: Date }): StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }> | Promise<StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }>>;
  updateStaffRole(input: { targetStaffId: string; expectedPermissionsVersion: number; level: StaffLevel; status: 'ACTIVE' | 'REVOKED'; now: Date }): StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }> | Promise<StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }>>;
  revokeSessions(input: { targetStaffId: string; now: Date }): StagedAccessWrite<{ staffId: string; revokedSessionCount: number; revokedAt: string }> | Promise<StagedAccessWrite<{ staffId: string; revokedSessionCount: number; revokedAt: string }>>;
}

export class AccessError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CONFLICT' | 'VALIDATION_ERROR' | 'SELF_APPROVAL_FORBIDDEN' | 'MAPPING_VERSION_STALE' | 'ROLE_ELEVATION_NOT_PENDING' | 'ROLE_NOT_OBSERVED' | 'BOOTSTRAP_ALREADY_USED', message: string, readonly expectedVersion?: number) { super(message); }
}

const rank: Record<StaffLevel, number> = { L1_SUPPORT: 1, L2_SUPERVISOR: 2, L3_OPERATIONS: 3, L4_ADMIN_OWNER: 4 };

export class InMemoryAccessStore implements AccessStore, StaffDirectory {
  private readonly mappings: RoleMappingRecord[];
  private readonly staff = new Map<string, StaffAccessRecord>();
  private readonly staffByDiscord = new Map<string, string>();
  private readonly syncResults = new Map<string, RoleSyncResult | PendingRoleElevation>();
  private readonly manuallyRevoked = new Set<string>();
  private readonly lastObservedAt = new Map<string, number>();

  constructor(private readonly options: { authStore: DashboardAuthStore; mappings?: RoleMappingRecord[]; staff?: StaffAccessRecord[] }) {
    this.mappings = options.mappings?.map((item) => ({ ...item })) ?? [];
    for (const item of options.staff ?? []) { this.staff.set(item.staffId, cloneStaff(item)); this.staffByDiscord.set(key(item.guildId, item.discordUserId), item.staffId); }
  }

  listMappings(): RoleMappingRecord[] {
    const generations = new Map<string, number>();
    for (const item of this.mappings) generations.set(item.guildId, Math.max(generations.get(item.guildId) ?? 0, item.version));
    return this.mappings.filter((item) => item.enabled).map((item) => ({ ...item, version: generations.get(item.guildId) ?? item.version })).sort((a, b) => rank[a.targetLevel] - rank[b.targetLevel]);
  }

  resolveByDiscord(input: { discordUserId: string; guildId: string }): StaffAccount | null {
    const staffId = this.staffByDiscord.get(key(input.guildId, input.discordUserId));
    const staff = staffId ? this.staff.get(staffId) : null;
    return staff ? {
      staffId: staff.staffId,
      userId: staff.staffId,
      level: staff.level,
      permissionsVersion: staff.permissionsVersion,
      status: staff.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED'
    } : null;
  }

  updateMapping(input: { guildId: string; discordRoleId: string; targetLevel: StaffLevel; expectedVersion: number; enabled: boolean; actorStaffId: string; now: Date }): StagedAccessWrite<RoleMappingRecord> {
    const current = this.mappings.filter((item) => item.guildId === input.guildId && item.targetLevel === input.targetLevel).sort((a, b) => b.version - a.version)[0];
    const currentVersion = Math.max(0, ...this.mappings.filter((item) => item.guildId === input.guildId).map((item) => item.version));
    if (currentVersion !== input.expectedVersion) throw new AccessError('CONFLICT', 'Role mapping version is stale.');
    const data: RoleMappingRecord = { guildId: input.guildId, discordRoleId: input.discordRoleId, targetLevel: input.targetLevel, enabled: input.enabled, version: currentVersion + 1, reconciliationQueued: true };
    return staged(data, async (audit, sink) => { await sink.append(audit); if (current) current.enabled = false; this.mappings.push({ ...data }); });
  }

  syncRoles(input: { guildId: string; discordUserId: string; observedRoleIds: string[]; mappingVersion: number; source: string; sourceEventId: string; observedAt: Date }): StagedAccessWrite<RoleSyncResult | PendingRoleElevation> {
    const replayKey = `${input.source}:${input.sourceEventId}`;
    const replay = this.syncResults.get(replayKey);
    if (replay) return staged(clone(replay), () => undefined, 'code' in replay ? 202 : 200);
    const active = this.listMappings().filter((item) => item.guildId === input.guildId);
    const mappingVersion = Math.max(0, ...this.mappings.filter((item) => item.guildId === input.guildId).map((item) => item.version));
    if (input.mappingVersion !== mappingVersion) throw new AccessError('MAPPING_VERSION_STALE', 'Role mapping version is stale.', mappingVersion);
    const candidate = active.filter((item) => input.observedRoleIds.includes(item.discordRoleId)).sort((a, b) => rank[b.targetLevel] - rank[a.targetLevel])[0]?.targetLevel ?? null;
    const staffId = this.staffByDiscord.get(key(input.guildId, input.discordUserId));
    const current = staffId ? this.staff.get(staffId)! : null;
    const previousLevel = current?.status === 'ACTIVE' ? current.level : null;
    const nextVersion = (current?.permissionsVersion ?? 0) + 1;
    let next: StaffAccessRecord | null = current ? cloneStaff(current) : null;
    let data: RoleSyncResult | PendingRoleElevation;
    let revoke = false;

    const lastObservedAt = current ? this.lastObservedAt.get(current.staffId) : undefined;
    const observationIsStale = lastObservedAt !== undefined && input.observedAt.getTime() < lastObservedAt;
    const isManuallyRevoked = Boolean(current && current.status === 'REVOKED' && this.manuallyRevoked.has(current.staffId));
    if (observationIsStale || isManuallyRevoked) {
      data = noChange(input.discordUserId, previousLevel, current?.status === 'ACTIVE' ? current.level : null, current?.permissionsVersion ?? 0);
      return staged(data, async (audit, sink) => {
        await sink.append(audit);
        if (!observationIsStale && current) this.lastObservedAt.set(current.staffId, input.observedAt.getTime());
        this.syncResults.set(replayKey, clone(data));
      });
    }

    if (!candidate) {
      if (!current || current.status === 'REVOKED') data = { discordUserId: input.discordUserId, previousLevel, requestedLevel: null, effectiveLevel: null, status: 'NO_CHANGE', permissionsVersion: current?.permissionsVersion ?? 0, sessionsRevoked: false };
      else { next = { ...current, status: 'REVOKED', requestedLevel: null, observedRoleIds: [...input.observedRoleIds], permissionsVersion: nextVersion }; revoke = true; data = { discordUserId: input.discordUserId, previousLevel, requestedLevel: null, effectiveLevel: null, status: 'ACCESS_REVOKED', permissionsVersion: nextVersion, sessionsRevoked: true }; }
    } else if (!current) {
      const baseLevel: StaffLevel = rank[candidate] <= 2 ? candidate : 'L1_SUPPORT';
      next = { staffId: crypto.randomUUID(), guildId: input.guildId, discordUserId: input.discordUserId, level: baseLevel, requestedLevel: rank[candidate] >= 3 ? candidate : null, status: 'ACTIVE', permissionsVersion: 1, observedRoleIds: [...input.observedRoleIds] };
      data = rank[candidate] >= 3 ? pending(next, candidate) : applied(input.discordUserId, null, next, false);
    } else if (rank[candidate] < rank[current.level] || current.status === 'REVOKED') {
      next = { ...current, level: candidate, requestedLevel: null, status: 'ACTIVE', permissionsVersion: nextVersion, observedRoleIds: [...input.observedRoleIds] }; revoke = true; data = applied(input.discordUserId, previousLevel, next, true);
    } else if (rank[candidate] === rank[current.level]) {
      next = { ...current, requestedLevel: null, observedRoleIds: [...input.observedRoleIds] }; data = { discordUserId: input.discordUserId, previousLevel, requestedLevel: null, effectiveLevel: current.level, status: 'NO_CHANGE', permissionsVersion: current.permissionsVersion, sessionsRevoked: false };
    } else if (rank[candidate] <= 2) {
      next = { ...current, level: candidate, requestedLevel: null, permissionsVersion: nextVersion, observedRoleIds: [...input.observedRoleIds] }; revoke = true; data = applied(input.discordUserId, previousLevel, next, true);
    } else {
      next = { ...current, requestedLevel: candidate, observedRoleIds: [...input.observedRoleIds] }; data = pending(next, candidate);
    }
    const statusCode = 'code' in data ? 202 : 200;
    return staged(data, async (audit, sink) => {
      await sink.append(audit);
      if (next) { this.staff.set(next.staffId, next); this.staffByDiscord.set(key(next.guildId, next.discordUserId), next.staffId); }
      if (revoke && next) await this.options.authStore.revokeStaffSessions(next.staffId, input.observedAt);
      if (next) this.lastObservedAt.set(next.staffId, input.observedAt.getTime());
      this.syncResults.set(replayKey, clone(data));
    }, statusCode);
  }

  approveElevation(input: { targetStaffId: string; actorStaffId: string; expectedPermissionsVersion: number; requestedLevel: StaffLevel; now: Date }): StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }> {
    if (input.actorStaffId === input.targetStaffId) throw new AccessError('SELF_APPROVAL_FORBIDDEN', 'Staff cannot approve their own access elevation.');
    const current = this.staff.get(input.targetStaffId); if (!current) throw new AccessError('NOT_FOUND', 'Staff account was not found.');
    if (current.permissionsVersion !== input.expectedPermissionsVersion || current.requestedLevel !== input.requestedLevel) throw new AccessError('ROLE_ELEVATION_NOT_PENDING', 'The elevation request is no longer pending.');
    const mappedRole = this.listMappings().find((item) => item.guildId === current.guildId && item.targetLevel === input.requestedLevel)?.discordRoleId;
    if (!mappedRole || !current.observedRoleIds.includes(mappedRole)) throw new AccessError('ROLE_NOT_OBSERVED', 'The required Discord Role is no longer present.');
    const next = { ...current, level: input.requestedLevel, requestedLevel: null, permissionsVersion: current.permissionsVersion + 1 };
    return staged({ ...cloneStaff(next), sessionsRevoked: true }, async (audit, sink) => { await sink.append(audit); this.staff.set(next.staffId, next); await this.options.authStore.revokeStaffSessions(next.staffId, input.now); });
  }

  updateStaffRole(input: { targetStaffId: string; expectedPermissionsVersion: number; level: StaffLevel; status: 'ACTIVE' | 'REVOKED'; now: Date }): StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }> {
    const current = this.staff.get(input.targetStaffId); if (!current) throw new AccessError('NOT_FOUND', 'Staff account was not found.');
    if (current.permissionsVersion !== input.expectedPermissionsVersion) throw new AccessError('CONFLICT', 'Staff permissions version is stale.');
    if (input.status === 'ACTIVE' && rank[input.level] > rank[current.level]) throw new AccessError('VALIDATION_ERROR', 'Manual role updates cannot bypass advanced elevation approval.');
    const next = { ...current, level: input.level, requestedLevel: null, status: input.status, permissionsVersion: current.permissionsVersion + 1 };
    return staged({ ...cloneStaff(next), sessionsRevoked: true }, async (audit, sink) => { await sink.append(audit); this.staff.set(next.staffId, next); if (input.status === 'REVOKED') this.manuallyRevoked.add(next.staffId); else this.manuallyRevoked.delete(next.staffId); await this.options.authStore.revokeStaffSessions(next.staffId, input.now); });
  }

  revokeSessions(input: { targetStaffId: string; now: Date }): StagedAccessWrite<{ staffId: string; revokedSessionCount: number; revokedAt: string }> {
    if (!this.staff.has(input.targetStaffId)) throw new AccessError('NOT_FOUND', 'Staff account was not found.');
    const data = { staffId: input.targetStaffId, revokedSessionCount: 0, revokedAt: input.now.toISOString() };
    return staged(data, async (audit, sink) => { await sink.append(audit); data.revokedSessionCount = await this.options.authStore.revokeStaffSessions(input.targetStaffId, input.now); });
  }
}

type MappingRow = {
  guild_id: string;
  discord_role_id: string;
  target_level: StaffLevel;
  enabled: boolean;
  version: number;
};

type StaffRow = {
  staff_id: string;
  user_id: string;
  discord_user_id: string;
  guild_id: string;
  level: StaffLevel;
  requested_level: StaffLevel | null;
  status: 'ACTIVE' | 'PENDING_ELEVATION' | 'SUSPENDED' | 'DISABLED';
  role_source: 'DISCORD_ROLE' | 'MANUAL' | 'BOOTSTRAP';
  permissions_version: number;
  observed_role_ids: string[] | null;
  latest_observed_at: Date | null;
};

type SyncEventRow = {
  mapping_version_snapshot: unknown;
};

type ApprovalRow = {
  id: string;
  payload_hash: string;
  target_version: number;
};

type SyncInput = Parameters<AccessStore['syncRoles']>[0];
type SyncOutcome = RoleSyncResult | PendingRoleElevation;

/** PostgreSQL access persistence. Discord Roles remain observations; staff_accounts is authoritative. */
export class PostgresAccessStore implements AccessStore {
  constructor(private readonly pool: Pool) {}

  async bootstrapOwner(input: { guildId: string; discordUserId: string; now: Date }): Promise<StaffAccessRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('blackcat:access-bootstrap'))`);
      const existing = await client.query<{ used: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM audit_logs WHERE action = 'BOOTSTRAP_L4_OWNER'
           UNION ALL
           SELECT 1 FROM staff_accounts
            WHERE role_source = 'BOOTSTRAP'
               OR (level = 'L4_ADMIN_OWNER' AND status = 'ACTIVE')
         ) AS used`
      );
      if (existing.rows[0]?.used) throw new AccessError('BOOTSTRAP_ALREADY_USED', 'The one-time L4 bootstrap has already been used or an active L4 already exists.');
      let resolved: { userId: string; staff: StaffRow | null };
      try {
        resolved = await loadStaffByDiscord(client, input.guildId, input.discordUserId, true);
      } catch (error) {
        if (!(error instanceof AccessError) || error.code !== 'NOT_FOUND') throw error;
        const userId = randomUUID();
        await client.query(
          `INSERT INTO users (id,display_name,status,row_version,created_at,updated_at)
           VALUES ($1::uuid,'Bootstrap Owner','ACTIVE',1,$2::timestamptz,$2::timestamptz)`,
          [userId, input.now]
        );
        await client.query(
          `INSERT INTO discord_accounts
             (id,user_id,guild_id,discord_user_id,bound_at,created_at,updated_at)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$5::timestamptz,$5::timestamptz)`,
          [randomUUID(), userId, input.guildId, input.discordUserId, input.now]
        );
        resolved = { userId, staff: null };
      }
      const staffId = resolved.staff?.staff_id ?? randomUUID();
      const permissionsVersion = (resolved.staff?.permissions_version ?? 0) + 1;
      if (resolved.staff) {
        await client.query(
          `UPDATE staff_accounts
              SET level = 'L4_ADMIN_OWNER', requested_level = NULL, status = 'ACTIVE',
                  role_source = 'BOOTSTRAP', role_synced_at = $2::timestamptz,
                  confirmed_by_staff_id = NULL, confirmed_at = $2::timestamptz,
                  permissions_version = $3, disabled_at = NULL, updated_at = $2::timestamptz
            WHERE id = $1::uuid`,
          [staffId, input.now, permissionsVersion]
        );
        await revokeActiveSessions(client, staffId, input.now);
      } else {
        await client.query(
          `INSERT INTO staff_accounts
             (id,user_id,level,requested_level,status,role_source,role_synced_at,
              confirmed_at,permissions_version,created_at,updated_at)
           VALUES ($1::uuid,$2::uuid,'L4_ADMIN_OWNER',NULL,'ACTIVE','BOOTSTRAP',
             $3::timestamptz,$3::timestamptz,1,$3::timestamptz,$3::timestamptz)`,
          [staffId, resolved.userId, input.now]
        );
      }
      await insertPostgresAuditRecord(client, {
        id: randomUUID(), actorId: resolved.userId, actorStaffId: staffId,
        actorLevel: 'L4_ADMIN_OWNER', actorSource: 'SYSTEM_JOB', clientId: 'API_BOOTSTRAP',
        interactionId: null, permissionCode: 'access.bootstrap', action: 'BOOTSTRAP_L4_OWNER',
        targetType: 'staff_account', targetId: staffId, outcome: 'SUCCEEDED',
        reason: 'ONE_TIME_BOOTSTRAP', requestId: `bootstrap_${randomUUID()}`,
        approvalRequestId: null, occurredAt: input.now.toISOString()
      });
      await client.query('COMMIT');
      return { staffId, discordUserId: input.discordUserId, guildId: input.guildId, level: 'L4_ADMIN_OWNER', requestedLevel: null, status: 'ACTIVE', permissionsVersion, observedRoleIds: resolved.staff?.observed_role_ids ?? [] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listMappings(): Promise<RoleMappingRecord[]> {
    const result = await this.pool.query<MappingRow>(
      `SELECT mapping.guild_id, mapping.discord_role_id, mapping.target_level, mapping.enabled,
              (SELECT max(history.version) FROM discord_role_mappings history WHERE history.guild_id = mapping.guild_id) AS version
         FROM discord_role_mappings mapping
        WHERE enabled = true AND retired_at IS NULL
        ORDER BY CASE target_level
          WHEN 'L1_SUPPORT' THEN 1 WHEN 'L2_SUPERVISOR' THEN 2
          WHEN 'L3_OPERATIONS' THEN 3 ELSE 4 END, guild_id`
    );
    return result.rows.map((row) => mapMapping(row, false));
  }

  async updateMapping(input: Parameters<AccessStore['updateMapping']>[0]): Promise<StagedAccessWrite<RoleMappingRecord>> {
    const currentVersion = await loadGuildMappingVersion(this.pool, input.guildId);
    if (currentVersion !== input.expectedVersion) throw new AccessError('CONFLICT', 'Role mapping version is stale.');
    const data: RoleMappingRecord = {
      guildId: input.guildId,
      discordRoleId: input.discordRoleId,
      targetLevel: input.targetLevel,
      enabled: input.enabled,
      version: currentVersion + 1,
      reconciliationQueued: true
    };
    const mappingId = randomUUID();
    return staged(data, async (audit) => {
      await this.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`blackcat:role-mapping:${input.guildId}`]);
        await loadActiveMappings(client, input.guildId, true);
        const lockedVersion = await loadGuildMappingVersion(client, input.guildId);
        if (lockedVersion !== input.expectedVersion) throw new AccessError('CONFLICT', 'Role mapping version is stale.');
        await client.query(
          `UPDATE discord_role_mappings
              SET enabled = false, active_mapping_key = NULL, active_level_key = NULL, retired_at = $3::timestamptz
            WHERE guild_id = $1 AND (target_level = $2::"StaffLevel" OR discord_role_id = $4)
              AND retired_at IS NULL`,
          [input.guildId, input.targetLevel, input.now, input.discordRoleId]
        );
        await client.query(
          `INSERT INTO discord_role_mappings
             (id, guild_id, discord_role_id, target_level, version, enabled,
              active_mapping_key, active_level_key, created_by_staff_id, created_at)
           VALUES ($1::uuid, $2::varchar, $3::varchar, $4::"StaffLevel", $5, $6,
             CASE WHEN $6 THEN $2::text || ':' || $3::text ELSE NULL END,
             CASE WHEN $6 THEN $2::text || ':' || $4::text ELSE NULL END,
             $7::uuid, $8::timestamptz)`,
          [mappingId, input.guildId, input.discordRoleId, input.targetLevel, data.version, input.enabled, input.actorStaffId, input.now]
        );
        await client.query(
          `INSERT INTO outbox_events
             (id,event_type,aggregate_type,aggregate_id,dedupe_key,payload,status,row_version,
              attempt_count,max_attempts,available_at,created_at,updated_at)
           VALUES ($1::uuid,'ROLE_RECONCILIATION','discord_role_mapping',$2::uuid,$3,$4::jsonb,
             'PENDING',1,0,8,$5::timestamptz,$5::timestamptz,$5::timestamptz)`,
          [randomUUID(), mappingId, `role-reconciliation:${input.guildId}:${input.targetLevel}:${data.version}`, JSON.stringify({ guildId: input.guildId, targetLevel: input.targetLevel, mappingVersion: data.version }), input.now]
        );
        await insertPostgresAuditRecord(client, audit);
      });
    });
  }

  async syncRoles(input: SyncInput): Promise<StagedAccessWrite<SyncOutcome>> {
    const replay = await loadSyncReplay(this.pool, input.source, input.sourceEventId);
    if (replay) return staged(replay, () => undefined, isPending(replay) ? 202 : 200);
    const preview = await buildSyncPlan(this.pool, input);
    const data = clone(preview.outcome);
    return staged(data, async (audit) => {
      try {
        await this.transaction(async (client) => {
          const concurrentReplay = await loadSyncReplay(client, input.source, input.sourceEventId);
          if (concurrentReplay) {
            replaceOutcome(data, concurrentReplay);
            return;
          }
          const plan = await buildSyncPlan(client, input, true);
          replaceOutcome(data, plan.outcome);
          await persistSyncPlan(client, input, plan);
          await insertPostgresAuditRecord(client, {
            ...audit,
            targetId: plan.staff?.staffId ?? audit.targetId,
            approvalRequestId: plan.approvalRequestId
          });
        });
      } catch (error) {
        if (!isUniqueSyncEventViolation(error)) throw error;
        const concurrentReplay = await loadSyncReplay(this.pool, input.source, input.sourceEventId);
        if (!concurrentReplay) throw error;
        replaceOutcome(data, concurrentReplay);
      }
    }, isPending(data) ? 202 : 200);
  }

  async approveElevation(input: Parameters<AccessStore['approveElevation']>[0]): Promise<StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }>> {
    if (input.actorStaffId === input.targetStaffId) throw new AccessError('SELF_APPROVAL_FORBIDDEN', 'Staff cannot approve their own access elevation.');
    const current = await loadStaffById(this.pool, input.targetStaffId);
    assertElevation(current, input.expectedPermissionsVersion, input.requestedLevel);
    const data = { ...toAccessRecord({ ...current!, level: input.requestedLevel, requested_level: null, permissions_version: current!.permissions_version + 1 }), sessionsRevoked: true };
    return staged(data, async (audit) => {
      await this.transaction(async (client) => {
        const actor = await loadStaffById(client, input.actorStaffId, true);
        if (!actor || actor.status !== 'ACTIVE' || actor.level !== 'L4_ADMIN_OWNER') throw new AccessError('VALIDATION_ERROR', 'An active L4 staff account must approve the elevation.');
        const locked = await loadStaffById(client, input.targetStaffId, true);
        assertElevation(locked, input.expectedPermissionsVersion, input.requestedLevel);
        await assertObservedMappedRole(client, locked!, input.requestedLevel);
        const approval = await loadPendingAccessApproval(client, input.targetStaffId, input.requestedLevel, true);
        if (!approval) throw new AccessError('CONFLICT', 'The role elevation approval is no longer pending.');
        await client.query(
          `INSERT INTO approval_decisions
             (id, approval_request_id, decision, decided_by_staff_id, reason,
              target_version_checked, payload_hash_checked, decided_at)
           VALUES ($1::uuid, $2::uuid, 'APPROVE', $3::uuid, $4, $5, $6, $7::timestamptz)`,
          [randomUUID(), approval.id, input.actorStaffId, 'ROLE_AND_IDENTITY_VERIFIED', approval.target_version, approval.payload_hash, input.now]
        );
        await client.query(
          `UPDATE approval_requests SET status = 'APPROVED', row_version = row_version + 1, updated_at = $2::timestamptz
            WHERE id = $1::uuid AND status = 'PENDING'`,
          [approval.id, input.now]
        );
        await client.query(
          `UPDATE staff_accounts
              SET level = $2::"StaffLevel", requested_level = NULL, status = 'ACTIVE',
                  confirmed_by_staff_id = $3::uuid, confirmed_at = $4::timestamptz,
                  role_synced_at = $4::timestamptz, permissions_version = permissions_version + 1,
                  updated_at = $4::timestamptz
            WHERE id = $1::uuid`,
          [input.targetStaffId, input.requestedLevel, input.actorStaffId, input.now]
        );
        await revokeActiveSessions(client, input.targetStaffId, input.now);
        await insertPostgresAuditRecord(client, { ...audit, approvalRequestId: approval.id });
      });
    });
  }

  async updateStaffRole(input: Parameters<AccessStore['updateStaffRole']>[0]): Promise<StagedAccessWrite<StaffAccessRecord & { sessionsRevoked: boolean }>> {
    const current = await loadStaffById(this.pool, input.targetStaffId);
    assertManualRoleUpdate(current, input);
    const data = {
      ...toAccessRecord({
        ...current!,
        level: input.level,
        requested_level: null,
        status: input.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED',
        permissions_version: current!.permissions_version + 1
      }),
      sessionsRevoked: true
    };
    return staged(data, async (audit) => {
      await this.transaction(async (client) => {
        const locked = await loadStaffById(client, input.targetStaffId, true);
        assertManualRoleUpdate(locked, input);
        if (locked!.role_source === 'BOOTSTRAP' && locked!.level === 'L4_ADMIN_OWNER' && (input.level !== 'L4_ADMIN_OWNER' || input.status !== 'ACTIVE')) {
          const owners = await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM staff_accounts WHERE level = 'L4_ADMIN_OWNER' AND status = 'ACTIVE'`
          );
          if ((owners.rows[0]?.count ?? 0) <= 1) throw new AccessError('CONFLICT', 'The only active bootstrap owner cannot be removed.');
        }
        await client.query(
          `UPDATE staff_accounts
              SET level = $2::"StaffLevel", requested_level = NULL,
                  status = $3::"StaffAccountStatus", role_source = 'MANUAL',
                  confirmed_by_staff_id = $4::uuid, confirmed_at = $5::timestamptz,
                  disabled_at = CASE WHEN $3 = 'DISABLED' THEN $5::timestamptz ELSE NULL END,
                  permissions_version = permissions_version + 1, updated_at = $5::timestamptz
            WHERE id = $1::uuid`,
          [input.targetStaffId, input.level, input.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED', audit.actorStaffId, input.now]
        );
        await revokeActiveSessions(client, input.targetStaffId, input.now);
        await insertPostgresAuditRecord(client, audit);
      });
    });
  }

  async revokeSessions(input: Parameters<AccessStore['revokeSessions']>[0]): Promise<StagedAccessWrite<{ staffId: string; revokedSessionCount: number; revokedAt: string }>> {
    if (!(await loadStaffById(this.pool, input.targetStaffId))) throw new AccessError('NOT_FOUND', 'Staff account was not found.');
    const data = { staffId: input.targetStaffId, revokedSessionCount: 0, revokedAt: input.now.toISOString() };
    return staged(data, async (audit) => {
      await this.transaction(async (client) => {
        if (!(await loadStaffById(client, input.targetStaffId, true))) throw new AccessError('NOT_FOUND', 'Staff account was not found.');
        data.revokedSessionCount = await revokeActiveSessions(client, input.targetStaffId, input.now);
        await insertPostgresAuditRecord(client, audit);
      });
    });
  }

  private async transaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

type AccessDb = Pool | PoolClient;
type SyncPlan = {
  staff: StaffAccessRecord | null;
  userId: string;
  outcome: SyncOutcome;
  eventStatus: 'APPLIED' | 'PENDING_ELEVATION' | 'DOWNGRADED' | 'REJECTED';
  previousLevel: StaffLevel | null;
  revokeSessions: boolean;
  approvalRequestId: string | null;
  persistStaff: boolean;
};

async function loadGuildMappingVersion(db: AccessDb, guildId: string): Promise<number> {
  const result = await db.query<{ version: number | null }>(`SELECT max(version)::int AS version FROM discord_role_mappings WHERE guild_id = $1`, [guildId]);
  return result.rows[0]?.version ?? 0;
}

async function loadActiveMappings(db: AccessDb, guildId: string, lock = false): Promise<MappingRow[]> {
  const result = await db.query<MappingRow>(
    `SELECT guild_id, discord_role_id, target_level, enabled, version
       FROM discord_role_mappings
      WHERE guild_id = $1 AND enabled = true AND retired_at IS NULL
      ORDER BY version DESC${lock ? ' FOR SHARE' : ''}`,
    [guildId]
  );
  return result.rows;
}

async function loadStaffById(db: AccessDb, staffId: string, lock = false): Promise<StaffRow | null> {
  const result = await db.query<StaffRow>(
    `SELECT staff.id AS staff_id, staff.user_id, account.discord_user_id,
            account.guild_id, staff.level, staff.requested_level, staff.status,
            staff.role_source, staff.permissions_version, observation.created_at AS latest_observed_at,
            COALESCE(observation.observed_discord_role_ids, ARRAY[]::text[]) AS observed_role_ids
       FROM staff_accounts staff
       LEFT JOIN LATERAL (
         SELECT event.guild_id, event.observed_discord_role_ids, event.created_at
           FROM staff_role_sync_events event
          WHERE event.staff_account_id = staff.id
          ORDER BY event.created_at DESC, event.id DESC LIMIT 1
       ) observation ON true
       LEFT JOIN LATERAL (
         SELECT discord_user_id, guild_id FROM discord_accounts
          WHERE user_id = staff.user_id
          ORDER BY (guild_id = observation.guild_id) DESC, created_at ASC LIMIT 1
       ) account ON true
      WHERE staff.id = $1::uuid${lock ? ' FOR UPDATE OF staff' : ''}`,
    [staffId]
  );
  return result.rows[0] ?? null;
}

async function loadStaffByDiscord(db: AccessDb, guildId: string, discordUserId: string, lock = false): Promise<{ userId: string; staff: StaffRow | null }> {
  const accountResult = await db.query<{ user_id: string }>(
    `SELECT user_id FROM discord_accounts
      WHERE guild_id = $1 AND discord_user_id = $2 LIMIT 1${lock ? ' FOR SHARE' : ''}`,
    [guildId, discordUserId]
  );
  const account = accountResult.rows[0];
  if (!account) throw new AccessError('NOT_FOUND', 'The Discord account is not linked to a user.');
  const staffResult = await db.query<{ id: string }>(
    `SELECT id FROM staff_accounts WHERE user_id = $1::uuid${lock ? ' FOR UPDATE' : ''}`,
    [account.user_id]
  );
  const staff = staffResult.rows[0] ? await loadStaffById(db, staffResult.rows[0].id) : null;
  if (staff) {
    staff.guild_id = guildId;
    staff.discord_user_id = discordUserId;
  }
  return { userId: account.user_id, staff };
}

async function loadSyncReplay(db: AccessDb, source: string, sourceEventId: string): Promise<SyncOutcome | null> {
  const result = await db.query<SyncEventRow>(
    `SELECT mapping_version_snapshot FROM staff_role_sync_events
      WHERE source = $1 AND source_event_id = $2 LIMIT 1`,
    [source, sourceEventId]
  );
  const snapshot = result.rows[0]?.mapping_version_snapshot;
  if (!snapshot || typeof snapshot !== 'object' || !('outcome' in snapshot)) return null;
  return clone((snapshot as { outcome: SyncOutcome }).outcome);
}

async function buildSyncPlan(db: AccessDb, input: SyncInput, lock = false): Promise<SyncPlan> {
  const mappings = await loadActiveMappings(db, input.guildId, lock);
  const mappingVersion = await loadGuildMappingVersion(db, input.guildId);
  if (input.mappingVersion !== mappingVersion) throw new AccessError('MAPPING_VERSION_STALE', 'Role mapping version is stale.', mappingVersion);
  const resolved = await loadStaffByDiscord(db, input.guildId, input.discordUserId, lock);
  const current = resolved.staff;
  const candidate = mappings
    .filter((item) => input.observedRoleIds.includes(item.discord_role_id))
    .sort((left, right) => rank[right.target_level] - rank[left.target_level])[0]?.target_level ?? null;
  const previousLevel = current?.status === 'ACTIVE' ? current.level : null;

  if (!candidate && !current) {
    return {
      staff: null,
      userId: resolved.userId,
      outcome: noChange(input.discordUserId, null, null, 0),
      eventStatus: 'APPLIED',
      previousLevel: null,
      revokeSessions: false,
      approvalRequestId: null,
      persistStaff: false
    };
  }

  if (!current) {
    const staffId = randomUUID();
    const requestedLevel = rank[candidate!] >= 3 ? candidate : null;
    const staff: StaffAccessRecord = {
      staffId,
      discordUserId: input.discordUserId,
      guildId: input.guildId,
      level: requestedLevel ? 'L1_SUPPORT' : candidate!,
      requestedLevel,
      status: 'ACTIVE',
      permissionsVersion: 1,
      observedRoleIds: [...input.observedRoleIds]
    };
    const approvalRequestId = requestedLevel ? randomUUID() : null;
    return {
      staff,
      userId: resolved.userId,
      outcome: requestedLevel ? pendingWithId(staff, requestedLevel, approvalRequestId!) : applied(input.discordUserId, null, staff, false),
      eventStatus: requestedLevel ? 'PENDING_ELEVATION' : 'APPLIED',
      previousLevel: null,
      revokeSessions: false,
      approvalRequestId,
      persistStaff: true
    };
  }

  const currentRecord = toAccessRecord(current);
  if (current.latest_observed_at && input.observedAt < new Date(current.latest_observed_at)) {
    return { staff: currentRecord, userId: resolved.userId, outcome: noChange(input.discordUserId, previousLevel, current.status === 'ACTIVE' ? current.level : null, current.permissions_version), eventStatus: 'REJECTED', previousLevel, revokeSessions: false, approvalRequestId: null, persistStaff: false };
  }
  if (current.status !== 'ACTIVE' && current.role_source === 'MANUAL') {
    return { staff: currentRecord, userId: resolved.userId, outcome: noChange(input.discordUserId, null, null, current.permissions_version), eventStatus: 'REJECTED', previousLevel: null, revokeSessions: false, approvalRequestId: null, persistStaff: false };
  }
  if (!candidate) {
    const changed = current.status === 'ACTIVE';
    const next: StaffAccessRecord = {
      ...currentRecord,
      requestedLevel: null,
      status: 'REVOKED',
      permissionsVersion: current.permissions_version + (changed ? 1 : 0),
      observedRoleIds: [...input.observedRoleIds]
    };
    return {
      staff: next,
      userId: resolved.userId,
      outcome: changed
        ? { discordUserId: input.discordUserId, previousLevel, requestedLevel: null, effectiveLevel: null, status: 'ACCESS_REVOKED', permissionsVersion: next.permissionsVersion, sessionsRevoked: true }
        : noChange(input.discordUserId, previousLevel, null, next.permissionsVersion),
      eventStatus: changed ? 'DOWNGRADED' : 'APPLIED',
      previousLevel,
      revokeSessions: changed,
      approvalRequestId: null,
      persistStaff: true
    };
  }

  if (rank[candidate] < rank[current.level] || (rank[candidate] === rank[current.level] && current.status !== 'ACTIVE')) {
    const next: StaffAccessRecord = {
      ...currentRecord,
      level: candidate,
      requestedLevel: null,
      status: 'ACTIVE',
      permissionsVersion: current.permissions_version + 1,
      observedRoleIds: [...input.observedRoleIds]
    };
    return { staff: next, userId: resolved.userId, outcome: applied(input.discordUserId, previousLevel, next, true), eventStatus: 'DOWNGRADED', previousLevel, revokeSessions: true, approvalRequestId: null, persistStaff: true };
  }

  if (rank[candidate] === rank[current.level]) {
    const next = { ...currentRecord, requestedLevel: null, observedRoleIds: [...input.observedRoleIds] };
    return { staff: next, userId: resolved.userId, outcome: noChange(input.discordUserId, previousLevel, current.level, current.permissions_version), eventStatus: 'APPLIED', previousLevel, revokeSessions: false, approvalRequestId: null, persistStaff: true };
  }

  if (rank[candidate] <= 2) {
    const next: StaffAccessRecord = { ...currentRecord, level: candidate, requestedLevel: null, status: 'ACTIVE', permissionsVersion: current.permissions_version + 1, observedRoleIds: [...input.observedRoleIds] };
    return { staff: next, userId: resolved.userId, outcome: applied(input.discordUserId, previousLevel, next, true), eventStatus: 'APPLIED', previousLevel, revokeSessions: true, approvalRequestId: null, persistStaff: true };
  }

  const existingApproval = await loadPendingAccessApproval(db, current.staff_id, candidate, lock);
  const approvalRequestId = existingApproval?.id ?? randomUUID();
  const effectiveLevel = current.status === 'ACTIVE' ? current.level : 'L1_SUPPORT';
  const permissionsVersion = current.permissions_version + (current.status === 'ACTIVE' ? 0 : 1);
  const next: StaffAccessRecord = { ...currentRecord, level: effectiveLevel, requestedLevel: candidate, status: 'ACTIVE', permissionsVersion, observedRoleIds: [...input.observedRoleIds] };
  return { staff: next, userId: resolved.userId, outcome: pendingWithId(next, candidate, approvalRequestId), eventStatus: 'PENDING_ELEVATION', previousLevel, revokeSessions: current.status !== 'ACTIVE', approvalRequestId, persistStaff: true };
}

async function persistSyncPlan(client: PoolClient, input: SyncInput, plan: SyncPlan): Promise<void> {
  if (plan.staff && plan.persistStaff) {
    const existing = await client.query<{ id: string }>('SELECT id FROM staff_accounts WHERE id = $1::uuid', [plan.staff.staffId]);
    if (existing.rows[0]) {
      await client.query(
        `UPDATE staff_accounts
            SET level = $2::"StaffLevel", requested_level = $3::"StaffLevel",
                status = $4::"StaffAccountStatus", role_source = 'DISCORD_ROLE',
                role_synced_at = $5::timestamptz, permissions_version = $6,
                disabled_at = CASE WHEN $4 = 'DISABLED' THEN $5::timestamptz ELSE NULL END,
                updated_at = $5::timestamptz
          WHERE id = $1::uuid`,
        [plan.staff.staffId, plan.staff.level, plan.staff.requestedLevel, plan.staff.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED', input.observedAt, plan.staff.permissionsVersion]
      );
    } else {
      await client.query(
        `INSERT INTO staff_accounts
           (id, user_id, level, requested_level, status, role_source, role_synced_at,
            permissions_version, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::"StaffLevel", $4::"StaffLevel", 'ACTIVE',
           'DISCORD_ROLE', $5::timestamptz, $6, $5::timestamptz, $5::timestamptz)`,
        [plan.staff.staffId, plan.userId, plan.staff.level, plan.staff.requestedLevel, input.observedAt, plan.staff.permissionsVersion]
      );
    }
  }

  if (plan.approvalRequestId && plan.staff) {
    const existingApproval = await client.query<{ id: string }>('SELECT id FROM approval_requests WHERE id = $1::uuid', [plan.approvalRequestId]);
    if (!existingApproval.rows[0]) {
      const payload = { staffId: plan.staff.staffId, requestedLevel: plan.staff.requestedLevel, source: input.source, sourceEventId: input.sourceEventId };
      const payloadHash = hashPayload(payload);
      await client.query(
        `INSERT INTO approval_requests
           (id, public_id, action, target_type, target_id, target_version,
            payload_snapshot, payload_hash, requested_by_staff_id, required_level,
            status, row_version, reason, expires_at, created_at, updated_at)
         VALUES ($1::uuid, $2, 'ACCESS_CHANGE', 'staff_account', $3::uuid, $4,
           $5::jsonb, $6, $3::uuid, 'L4_ADMIN_OWNER', 'PENDING', 1,
           $7, $8::timestamptz, $9::timestamptz, $9::timestamptz)`,
        [plan.approvalRequestId, approvalPublicId(plan.approvalRequestId), plan.staff.staffId, plan.staff.permissionsVersion, JSON.stringify(payload), payloadHash, 'Discord Role elevation requires internal L4 confirmation.', new Date(input.observedAt.getTime() + 24 * 60 * 60_000), input.observedAt]
      );
    }
  }

  if (plan.revokeSessions && plan.staff) await revokeActiveSessions(client, plan.staff.staffId, input.observedAt);
  await client.query(
    `INSERT INTO staff_role_sync_events
       (id, staff_account_id, guild_id, discord_user_id, observed_discord_role_ids,
        mapping_version_snapshot, previous_level, requested_level, applied_level,
        status, source, source_event_id, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::text[], $6::jsonb,
       $7::"StaffLevel", $8::"StaffLevel", $9::"StaffLevel",
       $10::"RoleSyncStatus", $11, $12, $13::timestamptz)`,
    [randomUUID(), plan.staff?.staffId ?? null, input.guildId, input.discordUserId, input.observedRoleIds,
      JSON.stringify({ mappingVersion: input.mappingVersion, outcome: plan.outcome }), plan.previousLevel,
      plan.staff?.requestedLevel ?? null, plan.staff?.status === 'ACTIVE' ? plan.staff.level : null,
      plan.eventStatus, input.source, input.sourceEventId, input.observedAt]
  );
}

async function loadPendingAccessApproval(db: AccessDb, staffId: string, requestedLevel: StaffLevel, lock = false): Promise<ApprovalRow | null> {
  const result = await db.query<ApprovalRow>(
    `SELECT id, payload_hash, target_version FROM approval_requests
      WHERE action = 'ACCESS_CHANGE' AND target_type = 'staff_account' AND target_id = $1::uuid
        AND status = 'PENDING' AND payload_snapshot->>'requestedLevel' = $2
      ORDER BY created_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [staffId, requestedLevel]
  );
  return result.rows[0] ?? null;
}

async function assertObservedMappedRole(client: PoolClient, staff: StaffRow, requestedLevel: StaffLevel): Promise<void> {
  const result = await client.query<{ discord_role_id: string; observed_role_ids: string[] }>(
    `SELECT mapping.discord_role_id,
            COALESCE(event.observed_discord_role_ids, ARRAY[]::text[]) AS observed_role_ids
       FROM discord_role_mappings mapping
       LEFT JOIN LATERAL (
         SELECT observed_discord_role_ids FROM staff_role_sync_events
          WHERE staff_account_id = $1::uuid AND guild_id = $2
          ORDER BY created_at DESC, id DESC LIMIT 1
       ) event ON true
      WHERE mapping.guild_id = $2 AND mapping.target_level = $3::"StaffLevel"
        AND mapping.enabled = true AND mapping.retired_at IS NULL LIMIT 1 FOR SHARE OF mapping`,
    [staff.staff_id, staff.guild_id, requestedLevel]
  );
  const row = result.rows[0];
  if (!row || !row.observed_role_ids.includes(row.discord_role_id)) throw new AccessError('CONFLICT', 'The required Discord Role is no longer present.');
}

function assertElevation(current: StaffRow | null, expectedVersion: number, requestedLevel: StaffLevel): asserts current is StaffRow {
  if (!current) throw new AccessError('NOT_FOUND', 'Staff account was not found.');
  if (current.permissions_version !== expectedVersion || current.requested_level !== requestedLevel) throw new AccessError('CONFLICT', 'The elevation request is stale.');
  if (rank[requestedLevel] < 3 || rank[requestedLevel] <= rank[current.level]) throw new AccessError('CONFLICT', 'The role elevation is no longer pending.');
}

function assertManualRoleUpdate(current: StaffRow | null, input: { expectedPermissionsVersion: number; level: StaffLevel; status: 'ACTIVE' | 'REVOKED' }): asserts current is StaffRow {
  if (!current) throw new AccessError('NOT_FOUND', 'Staff account was not found.');
  if (current.permissions_version !== input.expectedPermissionsVersion) throw new AccessError('CONFLICT', 'Staff permissions version is stale.');
  if (input.status === 'ACTIVE' && rank[input.level] > rank[current.level]) throw new AccessError('VALIDATION_ERROR', 'Manual role updates cannot bypass advanced elevation approval.');
}

async function revokeActiveSessions(client: PoolClient, staffId: string, now: Date): Promise<number> {
  const result = await client.query(
    `UPDATE staff_sessions SET revoked_at = $2::timestamptz, updated_at = $2::timestamptz
      WHERE staff_account_id = $1::uuid AND revoked_at IS NULL AND expires_at > $2::timestamptz
      RETURNING id`,
    [staffId, now]
  );
  return result.rows.length;
}

function mapMapping(row: MappingRow, reconciliationQueued: boolean): RoleMappingRecord {
  return { guildId: row.guild_id, discordRoleId: row.discord_role_id, targetLevel: row.target_level, enabled: row.enabled, version: row.version, reconciliationQueued };
}

function toAccessRecord(row: StaffRow): StaffAccessRecord {
  return {
    staffId: row.staff_id,
    discordUserId: row.discord_user_id,
    guildId: row.guild_id,
    level: row.level,
    requestedLevel: row.requested_level,
    status: row.status === 'ACTIVE' ? 'ACTIVE' : 'REVOKED',
    permissionsVersion: row.permissions_version,
    observedRoleIds: [...(row.observed_role_ids ?? [])]
  };
}

function noChange(discordUserId: string, previousLevel: StaffLevel | null, effectiveLevel: StaffLevel | null, permissionsVersion: number): RoleSyncResult {
  return { discordUserId, previousLevel, requestedLevel: null, effectiveLevel, status: 'NO_CHANGE', permissionsVersion, sessionsRevoked: false };
}

function pendingWithId(staff: StaffAccessRecord, requestedLevel: StaffLevel, approvalRequestId: string): PendingRoleElevation {
  return { code: 'ROLE_ELEVATION_PENDING', staffId: staff.staffId, effectiveLevel: staff.level, requestedLevel, approvalRequestId };
}

function isPending(value: SyncOutcome): value is PendingRoleElevation { return 'code' in value; }

function replaceOutcome(target: SyncOutcome, source: SyncOutcome): void {
  for (const property of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[property];
  Object.assign(target, clone(source));
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function approvalPublicId(id: string): string { return `APR-${id.replaceAll('-', '').slice(0, 20).toUpperCase()}`; }

function isUniqueSyncEventViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505' &&
    (!('constraint' in error) || error.constraint === 'staff_role_sync_events_source_source_event_id_key'));
}

export function registerAccessRoutes(server: FastifyInstance, options: { store: AccessStore; now?: () => Date }): void {
  if (!server.securityOptions) throw new Error('Access routes require security options.');
  const security = server.securityOptions; const auditSink = security.auditSink ?? new InMemoryAuditSink(); const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, security, { method: 'GET', url: '/api/v1/admin/discord-role-mappings', permission: 'access.read', action: 'LIST_DISCORD_ROLE_MAPPINGS', targetType: 'discord_role_mapping', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true, handler: async () => ({ items: await options.store.listMappings() }) });
  registerSecureWriteRoute(server, security, { method: 'PUT', url: '/api/v1/admin/discord-role-mappings/:level', permission: 'access.manage', action: 'UPDATE_DISCORD_ROLE_MAPPING', targetType: 'discord_role_mapping', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true, mapError, successReason: parseReason, handler: async (request, actor) => { parseReason(request); return bind(await options.store.updateMapping({ ...parseMapping(request), targetLevel: levelParam(request), actorStaffId: actor.actorStaffId!, now: now() }), auditSink); } });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/internal/discord/role-sync', permission: 'access.role_sync', action: 'SYNC_DISCORD_ROLES', targetType: 'staff_account', acceptedSources: ['DISCORD_BOT'], allowServiceActor: true, mapError, handler: async (request) => bind(await options.store.syncRoles(parseSync(request)), auditSink) });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/staff/:staffId/role-elevation/approve', permission: 'access.manage', action: 'APPROVE_STAFF_ROLE_ELEVATION', targetType: 'staff_account', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true, mapError, successReason: parseReason, handler: async (request, actor) => { parseReason(request); return bind(await options.store.approveElevation({ targetStaffId: param(request, 'staffId'), actorStaffId: actor.actorStaffId!, ...parseApproval(request), now: now() }), auditSink); } });
  registerSecureWriteRoute(server, security, { method: 'PATCH', url: '/api/v1/admin/staff/:staffId/role', permission: 'access.manage', action: 'UPDATE_STAFF_ROLE', targetType: 'staff_account', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true, mapError, successReason: parseReason, handler: async (request) => { parseReason(request); return bind(await options.store.updateStaffRole({ targetStaffId: param(request, 'staffId'), ...parseStaffRole(request), now: now() }), auditSink); } });
  registerSecureWriteRoute(server, security, { method: 'POST', url: '/api/v1/admin/staff/:staffId/revoke-sessions', permission: 'access.manage', action: 'REVOKE_STAFF_SESSIONS', targetType: 'staff_session', acceptedSources: ['DASHBOARD', 'DISCORD_BOT'], requiresRecentStepUp: true, mapError, successReason: parseReason, handler: async (request) => { parseReason(request); return bind(await options.store.revokeSessions({ targetStaffId: param(request, 'staffId'), now: now() }), auditSink); } });
}

function staged<T>(data: T, commit: (audit: AuditRecord, sink: AuditSink) => Promise<void> | void, statusCode?: number): StagedAccessWrite<T> { return { data, statusCode, commit }; }
function bind<T>(write: StagedAccessWrite<T>, sink: AuditSink) { return { data: write.data, statusCode: write.statusCode, commit: (audit: AuditRecord) => write.commit(audit, sink) }; }
function key(guildId: string, discordUserId: string) { return `${guildId}:${discordUserId}`; }
function clone<T>(value: T): T { return structuredClone(value); }
function cloneStaff(value: StaffAccessRecord): StaffAccessRecord { return { ...value, observedRoleIds: [...value.observedRoleIds] }; }
function pending(staff: StaffAccessRecord, requested: StaffLevel): PendingRoleElevation { return { code: 'ROLE_ELEVATION_PENDING', staffId: staff.staffId, effectiveLevel: staff.level, requestedLevel: requested, approvalRequestId: crypto.randomUUID() }; }
function applied(discordUserId: string, previous: StaffLevel | null, next: StaffAccessRecord, revoked: boolean): RoleSyncResult { return { discordUserId, previousLevel: previous, requestedLevel: next.requestedLevel, effectiveLevel: next.status === 'ACTIVE' ? next.level : null, status: 'APPLIED', permissionsVersion: next.permissionsVersion, sessionsRevoked: revoked }; }
function param(request: FastifyRequest, name: string): string { const value = (request.params as Record<string, unknown>)[name]; if (typeof value !== 'string' || !value) throw new AccessError('VALIDATION_ERROR', `${name} is required.`); return value; }
function levelParam(request: FastifyRequest): StaffLevel { const value = param(request, 'level'); if (!isLevel(value)) throw new AccessError('VALIDATION_ERROR', 'Staff level is invalid.'); return value; }
function body(request: FastifyRequest): Record<string, unknown> { if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new AccessError('VALIDATION_ERROR', 'A JSON body is required.'); return request.body as Record<string, unknown>; }
function parseMapping(request: FastifyRequest) { const value = body(request); return { guildId: snowflake(value.guildId), discordRoleId: snowflake(value.discordRoleId), expectedVersion: integer(value.expectedVersion), enabled: boolean(value.enabled) }; }
function parseSync(request: FastifyRequest) { const value = body(request); if (!Array.isArray(value.observedRoleIds) || value.observedRoleIds.length > 250 || value.observedRoleIds.some((item) => typeof item !== 'string' || !/^\d{17,20}$/.test(item))) throw new AccessError('VALIDATION_ERROR', 'observedRoleIds is invalid.'); if (value.source !== 'GUILD_MEMBER_UPDATE' && value.source !== 'STARTUP_RECONCILIATION' && value.source !== 'MANUAL_RETRY') throw new AccessError('VALIDATION_ERROR', 'source is invalid.'); if (typeof value.sourceEventId !== 'string' || value.sourceEventId.length < 1 || value.sourceEventId.length > 200) throw new AccessError('VALIDATION_ERROR', 'sourceEventId is invalid.'); const observedAt = new Date(String(value.observedAt)); if (Number.isNaN(observedAt.getTime())) throw new AccessError('VALIDATION_ERROR', 'observedAt is invalid.'); return { guildId: snowflake(value.guildId), discordUserId: snowflake(value.discordUserId), observedRoleIds: [...new Set(value.observedRoleIds as string[])], mappingVersion: integer(value.mappingVersion), source: value.source, sourceEventId: value.sourceEventId, observedAt }; }
function parseApproval(request: FastifyRequest) { const value = body(request); if (!isLevel(value.requestedLevel)) throw new AccessError('VALIDATION_ERROR', 'requestedLevel is invalid.'); return { expectedPermissionsVersion: integer(value.expectedPermissionsVersion), requestedLevel: value.requestedLevel }; }
function parseStaffRole(request: FastifyRequest) { const value = body(request); if (!isLevel(value.level) || (value.status !== 'ACTIVE' && value.status !== 'REVOKED')) throw new AccessError('VALIDATION_ERROR', 'Role update is invalid.'); return { expectedPermissionsVersion: integer(value.expectedPermissionsVersion), level: value.level, status: value.status as 'ACTIVE' | 'REVOKED' }; }
function parseReason(request: FastifyRequest): string { const value = body(request); if (typeof value.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,99}$/.test(value.reasonCode)) throw new AccessError('VALIDATION_ERROR', 'reasonCode is required.'); return value.reasonCode; }
function isLevel(value: unknown): value is StaffLevel { return value === 'L1_SUPPORT' || value === 'L2_SUPERVISOR' || value === 'L3_OPERATIONS' || value === 'L4_ADMIN_OWNER'; }
function snowflake(value: unknown): string { if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) throw new AccessError('VALIDATION_ERROR', 'A Discord snowflake is required.'); return value; }
function integer(value: unknown): number { if (!Number.isInteger(value) || (value as number) < 0) throw new AccessError('VALIDATION_ERROR', 'A non-negative integer is required.'); return value as number; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new AccessError('VALIDATION_ERROR', 'A boolean is required.'); return value; }
function mapError(error: unknown) { if (!(error instanceof AccessError)) return null; if (error.code === 'SELF_APPROVAL_FORBIDDEN') return { statusCode: 422, code: error.code, message: error.message }; return { statusCode: error.code === 'VALIDATION_ERROR' ? 400 : error.code === 'NOT_FOUND' ? 404 : 409, code: error.code, message: error.message, details: error.code === 'MAPPING_VERSION_STALE' && error.expectedVersion !== undefined ? [{ field: 'mappingVersion', reason: `expected ${error.expectedVersion}` }] : [] }; }
