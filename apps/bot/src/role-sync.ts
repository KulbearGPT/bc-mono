import { createHash } from 'node:crypto';
import { BotApiTransport, BotApiTransportError } from './api-transport.js';

export type RoleSyncSource = 'GUILD_MEMBER_UPDATE' | 'STARTUP_RECONCILIATION' | 'MANUAL_RETRY';

export interface RoleSyncObservation {
  guildId: string;
  discordUserId: string;
  observedRoleIds: string[];
  mappingVersion: number;
  source: RoleSyncSource;
  sourceEventId: string;
  observedAt: string;
}

export interface RoleSyncApi {
  syncDiscordRoles(observation: RoleSyncObservation): Promise<unknown>;
}

export interface DiscordMemberLike {
  id: string;
  guild: { id: string };
  user: { bot: boolean };
  roles: { cache: Iterable<[string, unknown]> };
}

export interface DiscordGuildLike {
  id: string;
  members: { fetch(): Promise<Iterable<[string, DiscordMemberLike]>> };
}

export interface ReconciliationResult {
  guilds: number;
  observedMembers: number;
  syncedMembers: number;
  failedMembers: number;
}

export class RoleSyncApiError extends Error {
  public readonly statusCode: number | null;
  public readonly code: string | null;
  public readonly expectedMappingVersion: number | null;

  public constructor(
    message: string,
    statusCode: number | null = null,
    code: string | null = null,
    expectedMappingVersion: number | null = null
  ) {
    super(message);
    this.name = 'RoleSyncApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.expectedMappingVersion = expectedMappingVersion;
  }
}

export class HttpRoleSyncApiClient implements RoleSyncApi {
  private readonly transport: BotApiTransport;
  private readonly retryDelaysMs: readonly number[];

  public constructor(input: {
    apiBaseUrl: string;
    botServiceToken: string;
    retryDelaysMs?: readonly number[];
    fetch?: typeof fetch;
    timeoutMs?: number;
    transport?: BotApiTransport;
  }) {
    this.transport = input.transport ?? new BotApiTransport(input);
    this.retryDelaysMs = input.retryDelaysMs ?? [250, 1_000];
  }

  public async syncDiscordRoles(observation: RoleSyncObservation): Promise<unknown> {
    let currentObservation = { ...observation };
    let refreshedMappingVersion = false;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.transport.request('/api/v1/internal/discord/role-sync', {
          method: 'POST',
          idempotencyKey: buildRoleSyncIdempotencyKey(currentObservation),
          body: currentObservation
        });
      } catch (error) {
        const roleError =
          error instanceof BotApiTransportError
            ? new RoleSyncApiError(
                error.message,
                error.statusCode,
                error.code,
                getExpectedMappingVersion(error.details as Array<{ field?: string; reason?: string }> | undefined)
              )
            : new RoleSyncApiError('Role sync request failed.');
        if (
          roleError.code === 'MAPPING_VERSION_STALE' &&
          roleError.expectedMappingVersion !== null &&
          !refreshedMappingVersion
        ) {
          currentObservation = { ...currentObservation, mappingVersion: roleError.expectedMappingVersion };
          refreshedMappingVersion = true;
          attempt -= 1;
          continue;
        }
        if (
          (roleError.statusCode !== null && !isTransientStatus(roleError.statusCode)) ||
          attempt >= this.retryDelaysMs.length
        ) {
          throw roleError;
        }
      }

      await sleep(this.retryDelaysMs[attempt] ?? 0);
    }
  }
}

function buildRoleSyncIdempotencyKey(
  observation: Pick<RoleSyncObservation, 'sourceEventId' | 'mappingVersion'>
): string {
  const identity = createHash('sha256')
    .update(`${observation.sourceEventId}:v${observation.mappingVersion}`)
    .digest('hex');
  return `discord:role-sync:${identity}`;
}

export function buildRoleSyncObservation(input: {
  guildId: string;
  discordUserId: string;
  observedRoleIds: Iterable<string>;
  mappingVersion: number;
  source: RoleSyncSource;
  observedAt: string;
}): RoleSyncObservation {
  const observedRoleIds = normalizeRoleIds(input.observedRoleIds);
  const roleFingerprint = createHash('sha256').update(observedRoleIds.join(',')).digest('hex').slice(0, 12);
  const sourceEventId = [
    'role-sync',
    input.source.toLowerCase().replaceAll('_', '-'),
    input.guildId,
    input.discordUserId,
    input.observedAt,
    roleFingerprint
  ].join(':');

  return {
    guildId: input.guildId,
    discordUserId: input.discordUserId,
    observedRoleIds,
    mappingVersion: input.mappingVersion,
    source: input.source,
    sourceEventId,
    observedAt: input.observedAt
  };
}

export async function syncGuildMemberUpdate(
  oldMember: DiscordMemberLike,
  newMember: DiscordMemberLike,
  dependencies: { api: RoleSyncApi; mappingVersion: number; now?: () => Date }
): Promise<boolean> {
  const previousRoleIds = normalizeRoleIds(roleIds(oldMember));
  const observedRoleIds = normalizeRoleIds(roleIds(newMember));
  if (sameValues(previousRoleIds, observedRoleIds)) {
    return false;
  }

  await dependencies.api.syncDiscordRoles(
    buildRoleSyncObservation({
      guildId: newMember.guild.id,
      discordUserId: newMember.id,
      observedRoleIds,
      mappingVersion: dependencies.mappingVersion,
      source: 'GUILD_MEMBER_UPDATE',
      observedAt: (dependencies.now ?? (() => new Date()))().toISOString()
    })
  );
  return true;
}

export async function reconcileDiscordGuilds(input: {
  guilds: Iterable<[string, DiscordGuildLike]>;
  api: RoleSyncApi;
  mappingVersion: number;
  now?: () => Date;
  isIgnorableError?: (error: unknown) => boolean;
  onError?: (error: unknown, context: { guildId: string; discordUserId?: string }) => void;
}): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    guilds: 0,
    observedMembers: 0,
    syncedMembers: 0,
    failedMembers: 0
  };

  for (const [, guild] of input.guilds) {
    result.guilds += 1;
    let members: Iterable<[string, DiscordMemberLike]>;
    try {
      members = await guild.members.fetch();
    } catch (error) {
      input.onError?.(error, { guildId: guild.id });
      continue;
    }

    for (const [, member] of members) {
      if (member.user.bot) {
        continue;
      }
      result.observedMembers += 1;
      const observedAt = (input.now ?? (() => new Date()))().toISOString();
      try {
        await input.api.syncDiscordRoles(
          buildRoleSyncObservation({
            guildId: guild.id,
            discordUserId: member.id,
            observedRoleIds: roleIds(member),
            mappingVersion: input.mappingVersion,
            source: 'STARTUP_RECONCILIATION',
            observedAt
          })
        );
        result.syncedMembers += 1;
      } catch (error) {
        if (input.isIgnorableError?.(error)) continue;
        result.failedMembers += 1;
        input.onError?.(error, { guildId: guild.id, discordUserId: member.id });
      }
    }
  }

  return result;
}

export function readRoleMappingVersion(value: string | undefined): number {
  const mappingVersion = Number(value);
  if (!Number.isSafeInteger(mappingVersion) || mappingVersion < 0) {
    throw new Error('DISCORD_ROLE_MAPPING_VERSION must be a non-negative integer.');
  }
  return mappingVersion;
}

function roleIds(member: DiscordMemberLike): string[] {
  return Array.from(member.roles.cache, ([roleId]) => roleId);
}

function normalizeRoleIds(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isTransientStatus(statusCode: number): boolean {
  return statusCode === 429 || statusCode >= 500;
}

function getExpectedMappingVersion(details: Array<{ field?: string; reason?: string }> | undefined): number | null {
  const reason = details?.find((detail) => detail.field === 'mappingVersion')?.reason;
  const match = reason?.match(/^expected (\d+)$/u);
  const value = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
