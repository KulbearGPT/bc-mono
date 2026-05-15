import { createHash } from 'node:crypto';
import type { DispatchMessageStore, DispatchOfferDiscordAdapter } from './worker-handlers.js';

interface QueryClient {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount?: number | null }>;
}

export class PostgresDispatchMessageStore implements DispatchMessageStore {
  constructor(private readonly client: QueryClient) {}

  async getDispatchMessageId(dispatchAttemptId: string): Promise<string | null> {
    const result = await this.client.query<{ dispatch_message_id: string | null }>(
      'SELECT dispatch_message_id FROM dispatch_attempts WHERE id = $1::uuid',
      [dispatchAttemptId]
    );
    if (!result.rows[0]) throw new Error('Dispatch attempt was not found.');
    return result.rows[0].dispatch_message_id;
  }

  async recordDispatchMessageId(input: { dispatchAttemptId: string; messageId: string }): Promise<void> {
    const result = await this.client.query<{ id: string }>(
      `UPDATE dispatch_attempts
          SET dispatch_message_id = $2, updated_at = now()
        WHERE id = $1::uuid AND dispatch_message_id IS NULL
      RETURNING id`,
      [input.dispatchAttemptId, input.messageId]
    );
    if (!result.rows[0]) {
      const existing = await this.getDispatchMessageId(input.dispatchAttemptId);
      if (existing !== input.messageId) throw new Error('Dispatch message id was changed concurrently.');
    }
  }

  async replaceDispatchMessageId(input: { dispatchAttemptId: string; expectedMessageId: string; messageId: string }): Promise<void> {
    const result = await this.client.query<{ id: string }>(
      `UPDATE dispatch_attempts
          SET dispatch_message_id = $3, updated_at = now()
        WHERE id = $1::uuid AND dispatch_message_id = $2
      RETURNING id`,
      [input.dispatchAttemptId, input.expectedMessageId, input.messageId]
    );
    if (!result.rows[0]) {
      const existing = await this.getDispatchMessageId(input.dispatchAttemptId);
      if (existing !== input.messageId) throw new Error('Dispatch message id was changed concurrently.');
    }
  }
}

export class DiscordRestDeliveryAdapter implements DispatchOfferDiscordAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly input: {
    botToken: string;
    fetch?: typeof fetch;
    apiBaseUrl?: string;
    businessApiBaseUrl?: string;
    botServiceToken?: string;
  }) {
    this.fetchImpl = input.fetch ?? fetch;
  }

  async upsertDispatchOffer(
    payload: Record<string, unknown>,
    existingMessageId: string | null,
    notBefore: string
  ): Promise<{ messageId: string; recreated: boolean }> {
    const dispatchAttemptId = requiredString(payload.dispatchAttemptId, 'dispatchAttemptId');
    const channelId = requiredString(payload.dispatchChannelId, 'dispatchChannelId');
    const orderId = requiredString(payload.orderId, 'orderId');
    const orderVersion = requiredInteger(payload.orderVersion, 'orderVersion');
    const panel = {
      content: formatDispatchOffer(payload),
      components: [{
        type: 1,
        components: [
          { type: 2, style: 3, label: '接单', custom_id: `bc:dispatch:${dispatchAttemptId}:accept:${orderId}:v${orderVersion}` },
          { type: 2, style: 2, label: '无法接单', custom_id: `bc:dispatch:${dispatchAttemptId}:decline:${orderId}:v${orderVersion}` }
        ]
      }]
    };
    if (existingMessageId) {
      try {
        const response = await this.request(
          `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(existingMessageId)}`,
          { method: 'PATCH', body: panel }
        );
        return { messageId: requiredString(response.id, 'message.id'), recreated: false };
      } catch (error) {
        if (!(error instanceof DiscordDeliveryError) || error.status !== 404) throw error;
      }
    }
    const nonce = stableNonce(`dispatch:${dispatchAttemptId}`);
    const recoveredMessageId = await this.findMessageByNonce(channelId, nonce, notBefore);
    if (recoveredMessageId) return { messageId: recoveredMessageId, recreated: existingMessageId !== null };
    const response = await this.request(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      body: { ...panel, nonce, enforce_nonce: true }
    });
    const messageId = requiredString(response.id, 'message.id');
    return { messageId, recreated: existingMessageId !== null };
  }

  async sendMessage(input: { channelId: string; content: string; dedupeKey: string; notBefore: string }): Promise<{ messageId: string }> {
    const nonce = stableNonce(input.dedupeKey);
    const recoveredMessageId = await this.findMessageByNonce(input.channelId, nonce, input.notBefore);
    if (recoveredMessageId) return { messageId: recoveredMessageId };
    const response = await this.request(`/channels/${encodeURIComponent(input.channelId)}/messages`, {
      method: 'POST',
      body: { content: input.content, nonce, enforce_nonce: true }
    });
    return { messageId: requiredString(response.id, 'message.id') };
  }

  async archiveChannel(channelId: string): Promise<void> {
    const channel = await this.request(`/channels/${encodeURIComponent(channelId)}`, { method: 'GET' });
    const guildId = requiredString(channel.guild_id, 'channel.guild_id');
    const overwrites = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : [];
    const permissionOverwrites = overwrites.map((value) => {
      const overwrite = value as Record<string, unknown>;
      const allow = permissionBits(overwrite.allow, 'permission_overwrites.allow');
      const deny = permissionBits(overwrite.deny, 'permission_overwrites.deny');
      return {
        id: requiredString(overwrite.id, 'permission_overwrites.id'),
        type: Number(overwrite.type),
        allow: String(allow & ~SEND_MESSAGES),
        deny: String(deny | SEND_MESSAGES)
      };
    });
    if (!permissionOverwrites.some((overwrite) => overwrite.type === 0 && overwrite.id === guildId)) {
      permissionOverwrites.push({ id: guildId, type: 0, allow: '0', deny: String(SEND_MESSAGES) });
    }
    await this.request(`/channels/${encodeURIComponent(channelId)}`, {
      method: 'PATCH',
      body: { permission_overwrites: permissionOverwrites }
    });
  }

  async reconcileRoles(guildId: string, mappingVersion: number, observedAt: string): Promise<void> {
    const businessApiBaseUrl = this.input.businessApiBaseUrl?.replace(/\/+$/u, '');
    const serviceToken = this.input.botServiceToken?.trim();
    if (!businessApiBaseUrl || !serviceToken) throw new Error('Role reconciliation API configuration is incomplete.');
    let after: string | null = null;
    do {
      const suffix: string = after ? `&after=${encodeURIComponent(after)}` : '';
      const members: unknown = await this.request<unknown>(`/guilds/${encodeURIComponent(guildId)}/members?limit=1000${suffix}`, { method: 'GET' });
      if (!Array.isArray(members)) throw new Error('Discord Guild member response is invalid.');
      for (const value of members) {
        const member = value as { user?: { id?: unknown; bot?: unknown }; roles?: unknown };
        if (member.user?.bot === true) continue;
        const discordUserId = requiredString(member.user?.id, 'member.user.id');
        const observedRoleIds = Array.isArray(member.roles)
          ? member.roles.map((roleId) => requiredString(roleId, 'member.roles')).sort()
          : [];
        const fingerprint = stableNonce(`${guildId}:${discordUserId}:${mappingVersion}:${observedRoleIds.join(',')}`);
        const body = {
          guildId,
          discordUserId,
          observedRoleIds,
          mappingVersion,
          source: 'STARTUP_RECONCILIATION',
          sourceEventId: `role-reconciliation:${fingerprint}`,
          observedAt
        };
        const response = await this.fetchImpl(`${businessApiBaseUrl}/api/v1/internal/discord/role-sync`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serviceToken}`,
            'content-type': 'application/json',
            'x-client-source': 'DISCORD_BOT',
            'idempotency-key': `role-reconciliation:${fingerprint}`
          },
          body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(`Role reconciliation failed with HTTP ${response.status}.`);
      }
      after = members.length === 1000
        ? requiredString((members.at(-1) as { user?: { id?: unknown } }).user?.id, 'member.user.id')
        : null;
    } while (after);
  }

  private async findMessageByNonce(channelId: string, nonce: string, notBefore: string): Promise<string | null> {
    const cutoff = Date.parse(notBefore) - 5 * 60_000;
    if (!Number.isFinite(cutoff)) throw new Error('Message reconciliation boundary is invalid.');
    let before: string | null = null;
    while (true) {
      const suffix = before ? `&before=${encodeURIComponent(before)}` : '';
      const messages = await this.request<unknown>(`/channels/${encodeURIComponent(channelId)}/messages?limit=100${suffix}`, { method: 'GET' });
      if (!Array.isArray(messages)) throw new Error('Discord message history response is invalid.');
      const found = messages.find((value) => value && typeof value === 'object' && String((value as { nonce?: unknown }).nonce ?? '') === nonce);
      if (found) return requiredString((found as { id?: unknown }).id, 'message.id');
      if (messages.length < 100) return null;
      const oldest = messages.at(-1) as { id?: unknown; timestamp?: unknown };
      const oldestAt = Date.parse(requiredString(oldest.timestamp, 'message.timestamp'));
      if (!Number.isFinite(oldestAt)) throw new Error('Discord message timestamp is invalid.');
      if (oldestAt < cutoff) return null;
      before = requiredString(oldest.id, 'message.id');
    }
  }

  private async request<T = Record<string, unknown>>(path: string, input: { method: string; body?: unknown }): Promise<T> {
    const apiBaseUrl = this.input.apiBaseUrl?.replace(/\/+$/u, '') ?? 'https://discord.com/api/v10';
    const response = await this.fetchImpl(`${apiBaseUrl}${path}`, {
      method: input.method,
      headers: { authorization: `Bot ${this.input.botToken}`, 'content-type': 'application/json' },
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new DiscordDeliveryError(response.status, discordRetryAfterMs(response, body));
    return body as T;
  }
}

class DiscordDeliveryError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | null = null) {
    super(`Discord delivery failed with HTTP ${status}.`);
    this.name = 'DiscordDeliveryError';
  }
}

function discordRetryAfterMs(response: Response, body: Record<string, unknown>): number | null {
  const seconds = typeof body.retry_after === 'number' ? body.retry_after : Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1_000) : null;
}

function stableNonce(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function formatDispatchOffer(payload: Record<string, unknown>): string {
  const publicId = requiredString(payload.orderPublicId, 'orderPublicId');
  const fields = [payload.game, payload.service, payload.region].filter((value): value is string => typeof value === 'string');
  return `**新订单 ${publicId}**\n${fields.join(' · ')}\n接单截止：${requiredString(payload.expiresAt, 'expiresAt')}`;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required.`);
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer.`);
  return Number(value);
}

const SEND_MESSAGES = 2_048n;

function permissionBits(value: unknown, field: string): bigint {
  try {
    return BigInt(requiredString(value, field));
  } catch {
    throw new Error(`${field} must be a permission bit field.`);
  }
}
