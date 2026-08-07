import { BotApiTransport } from './api-transport.js';
import { BotConfigFlow, BotConfigSessionStore, HttpBotConfigApiClient, botConfigCache } from './bot-config.js';
import { HttpOnboardingApiClient } from './onboarding.js';
import { OrderChannelTranscriptApi } from './order-channel-transcript.js';
import { HttpRoleSyncApiClient, readRoleMappingVersion } from './role-sync.js';
import { HttpBotApiClient } from './service-center-api.js';

export interface BotRuntimeDependencies {
  transport: BotApiTransport;
  api: HttpBotApiClient;
  botConfigApi: HttpBotConfigApiClient;
  botConfigFlow: BotConfigFlow;
  onboardingApi: HttpOnboardingApiClient;
  transcriptApi: OrderChannelTranscriptApi;
  roleSyncApi: HttpRoleSyncApiClient;
  giftContinuationSigningSecret: string;
  reviewContinuationSigningSecret: string;
  roleMappingVersion: number;
  fetch: typeof fetch;
}

export function createBotRuntimeDependencies(input: {
  apiBaseUrl: string;
  botServiceToken: string;
  giftContinuationSigningSecret?: string;
  reviewContinuationSigningSecret?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  roleMappingVersion?: string;
}): BotRuntimeDependencies {
  const fetchImplementation = input.fetch ?? fetch;
  const transport = new BotApiTransport({
    apiBaseUrl: input.apiBaseUrl,
    botServiceToken: input.botServiceToken,
    fetch: fetchImplementation,
    timeoutMs: input.timeoutMs
  });
  const botConfigApi = new HttpBotConfigApiClient({
    apiBaseUrl: input.apiBaseUrl,
    botServiceToken: input.botServiceToken,
    transport
  });
  const giftContinuationSigningSecret = input.giftContinuationSigningSecret?.trim() || input.botServiceToken.trim();
  const reviewContinuationSigningSecret = input.reviewContinuationSigningSecret?.trim() || input.botServiceToken.trim();
  if (input.reviewContinuationSigningSecret !== undefined && reviewContinuationSigningSecret.length < 32)
    throw new Error('Review continuation signing secret must contain at least 32 characters.');
  return {
    transport,
    api: new HttpBotApiClient({ apiBaseUrl: input.apiBaseUrl, botServiceToken: input.botServiceToken, transport }),
    botConfigApi,
    botConfigFlow: new BotConfigFlow({
      api: botConfigApi,
      cache: botConfigCache,
      sessions: new BotConfigSessionStore()
    }),
    onboardingApi: new HttpOnboardingApiClient({
      apiBaseUrl: input.apiBaseUrl,
      botServiceToken: input.botServiceToken,
      transport
    }),
    transcriptApi: new OrderChannelTranscriptApi({
      apiBaseUrl: input.apiBaseUrl,
      botServiceToken: input.botServiceToken,
      transport
    }),
    roleSyncApi: new HttpRoleSyncApiClient({
      apiBaseUrl: input.apiBaseUrl,
      botServiceToken: input.botServiceToken,
      transport
    }),
    giftContinuationSigningSecret,
    reviewContinuationSigningSecret,
    roleMappingVersion: readRoleMappingVersion(input.roleMappingVersion ?? '0'),
    fetch: fetchImplementation
  };
}

let configuredDependencies: BotRuntimeDependencies | null = null;

export function configureBotRuntimeDependencies(dependencies: BotRuntimeDependencies): void {
  if (configuredDependencies) throw new Error('Bot runtime dependencies are already configured.');
  configuredDependencies = dependencies;
}

export function getBotRuntimeDependencies(): BotRuntimeDependencies {
  if (!configuredDependencies) throw new Error('Bot runtime dependencies are not configured.');
  return configuredDependencies;
}

export function resetBotRuntimeDependenciesForTests(): void {
  configuredDependencies = null;
}
