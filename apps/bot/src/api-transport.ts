import type { GuildBotActorContext } from './actor-context.js';

export interface BotApiEnvelope<T> {
  requestId?: string;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class BotApiTransportError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;
  public readonly details: unknown;

  public constructor(input: {
    code: string;
    message: string;
    requestId: string;
    statusCode: number;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'BotApiTransportError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.statusCode = input.statusCode;
    this.details = input.details;
  }
}

interface BotApiRequestInput {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  actor?: GuildBotActorContext & { discordUserId?: string; interactionId?: string };
  idempotencyKey?: string;
  body?: unknown;
  includeStatus?: boolean;
}

export class BotApiTransport {
  private readonly apiBaseUrl: string;
  private readonly botServiceToken: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(input: { apiBaseUrl: string; botServiceToken: string; fetch?: typeof fetch; timeoutMs?: number }) {
    this.apiBaseUrl = input.apiBaseUrl.replace(/\/+$/u, '');
    this.botServiceToken = input.botServiceToken;
    this.fetchImplementation = input.fetch ?? fetch;
    this.timeoutMs = input.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error('Bot API timeout must be a positive integer.');
  }

  public async request<T>(
    path: string,
    input: BotApiRequestInput & { includeStatus: true }
  ): Promise<{ statusCode: number; data: T; requestId: string }>;
  public async request<T>(path: string, input: BotApiRequestInput): Promise<T>;
  public async request<T>(
    path: string,
    input: BotApiRequestInput
  ): Promise<T | { statusCode: number; data: T; requestId: string }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.botServiceToken}`,
      'x-client-source': 'DISCORD_BOT'
    };
    if (input.actor) {
      headers['x-actor-guild-id'] = input.actor.guildId;
      if (input.actor.discordUserId) headers['x-actor-discord-user-id'] = input.actor.discordUserId;
      if (input.actor.interactionId) headers['x-discord-interaction-id'] = input.actor.interactionId;
    }
    if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
    if (input.body !== undefined) headers['content-type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(`${this.apiBaseUrl}${path}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal
      });
    } catch {
      if (controller.signal.aborted) {
        throw new BotApiTransportError({
          code: 'GATEWAY_TIMEOUT',
          message: 'Unified API request timed out.',
          requestId: 'bot-api-timeout',
          statusCode: 504
        });
      }
      throw new BotApiTransportError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Unified API is unavailable.',
        requestId: 'bot-api-unreachable',
        statusCode: 503
      });
    } finally {
      clearTimeout(timeout);
    }

    let envelope: BotApiEnvelope<T>;
    try {
      envelope =
        typeof response.text === 'function'
          ? (JSON.parse(await response.text()) as BotApiEnvelope<T>)
          : ((await response.json()) as BotApiEnvelope<T>);
      if (!envelope || typeof envelope !== 'object') throw new Error('Invalid envelope.');
    } catch {
      throw new BotApiTransportError({
        code: 'INVALID_RESPONSE',
        message: 'Unified API returned an invalid response.',
        requestId: 'bot-api-invalid-response',
        statusCode: 502
      });
    }

    if (!response.ok) {
      throw new BotApiTransportError({
        code: envelope.error?.code ?? 'SERVICE_UNAVAILABLE',
        message: envelope.error?.message ?? 'Unified API request failed.',
        requestId: envelope.requestId ?? 'unknown',
        statusCode: response.status,
        details: envelope.error?.details
      });
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      throw new BotApiTransportError({
        code: 'INVALID_RESPONSE',
        message: 'Unified API returned an invalid response.',
        requestId: envelope.requestId ?? 'bot-api-invalid-response',
        statusCode: 502
      });
    }

    if (input.includeStatus) {
      return { statusCode: response.status, data: envelope.data as T, requestId: envelope.requestId ?? 'unknown' };
    }
    return envelope.data as T;
  }
}
