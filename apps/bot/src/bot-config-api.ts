import { BotApiTransport, BotApiTransportError } from './api-transport.js';
import { BotApiDataValidationError, validateBotApiData } from './bot-api-validation.js';
import {
  BotConfigChannelField,
  BotConfigActorContext,
  BotConfigSnapshot,
  BotConfigChangeRequest,
  BotConfigValidationResult,
  BotConfigUpdateResult,
  BotConfigDeliveryTestResult,
  WelcomeDmContext,
  BotConfigApiClient
} from './bot-config-contracts.js';

export class BotConfigApiError extends Error {
  public readonly code: string;
  public readonly requestId: string;
  public readonly statusCode: number;

  public constructor(input: { code: string; message: string; requestId: string; statusCode: number }) {
    super(input.message);
    this.name = 'BotConfigApiError';
    this.code = input.code;
    this.requestId = input.requestId;
    this.statusCode = input.statusCode;
  }
}

export class HttpBotConfigApiClient implements BotConfigApiClient {
  private readonly transport: BotApiTransport;

  public constructor(input: {
    apiBaseUrl: string;
    botServiceToken: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
    transport?: BotApiTransport;
  }) {
    this.transport = input.transport ?? new BotApiTransport(input);
  }

  public async getBotConfig(guildId: string, actor: BotConfigActorContext): Promise<BotConfigSnapshot> {
    const snapshot = await this.request<BotConfigSnapshot>(
      `/api/v1/admin/bot-config?guildId=${encodeURIComponent(guildId)}`,
      {
        method: 'GET',
        actor: actor.discordUserId ? actor : undefined
      }
    );
    try {
      return validateBotApiData('bot-config', snapshot);
    } catch (error) {
      if (!(error instanceof BotApiDataValidationError)) throw error;
      throw new BotConfigApiError({
        code: 'INVALID_RESPONSE',
        message: error.message,
        requestId: 'bot-api-invalid-data',
        statusCode: 502
      });
    }
  }

  public getWelcomeDmContext(
    guildId: string,
    targetDiscordUserId: string,
    actor: BotConfigActorContext
  ): Promise<WelcomeDmContext> {
    const query = new URLSearchParams({ guildId, targetDiscordUserId });
    return this.request(`/api/v1/bot/welcome-dm/context?${query.toString()}`, {
      method: 'GET',
      actor
    });
  }

  public validateBotConfigChange(
    input: BotConfigChangeRequest,
    actor: BotConfigActorContext,
    idempotencyKey: string
  ): Promise<BotConfigValidationResult> {
    return this.request('/api/v1/admin/bot-config/validate', {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public updateBotConfig(
    input: BotConfigChangeRequest & { validationToken: string },
    actor: BotConfigActorContext,
    idempotencyKey: string
  ): Promise<BotConfigUpdateResult> {
    return this.request('/api/v1/admin/bot-config', {
      method: 'PATCH',
      actor,
      idempotencyKey,
      body: input
    });
  }

  public testBotConfigDelivery(
    input: {
      guildId: string;
      expectedVersion: number;
      channelField: BotConfigChannelField;
      channelId: string;
      reason: string;
    },
    actor: BotConfigActorContext,
    idempotencyKey: string
  ): Promise<BotConfigDeliveryTestResult> {
    return this.request('/api/v1/admin/bot-config/test-delivery', {
      method: 'POST',
      actor,
      idempotencyKey,
      body: input
    });
  }

  private async request<T>(
    path: string,
    input: {
      method: 'GET' | 'POST' | 'PATCH';
      actor?: BotConfigActorContext;
      idempotencyKey?: string;
      body?: unknown;
    }
  ): Promise<T> {
    try {
      return await this.transport.request<T>(path, input);
    } catch (error) {
      if (!(error instanceof BotApiTransportError)) throw error;
      throw new BotConfigApiError({
        code: error.code,
        message: error.message,
        requestId: error.requestId,
        statusCode: error.statusCode
      });
    }
  }
}
