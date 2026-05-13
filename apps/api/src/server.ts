import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { validateRuntimeEnv, type RuntimeEnvInput } from '@blackcat/platform/env';
import type { SecurityOptions } from './security.js';
import { registerCatalogRoutes, type ServiceCatalogStore } from './catalog.js';
import {
  registerAccountRoutes,
  type AccountStore
} from './accounts.js';
import { registerOrderRoutes, type OrderFundingAdapter, type OrderStore } from './orders.js';
import { registerPlayerRoutes, type PlayerStore } from './players.js';
import {
  registerDispatchRoutes,
  type DispatchPlayerPool,
  type DispatchStore
} from './dispatch.js';
import { registerServiceLifecycleRoutes, type ServiceLifecycleStore } from './service-lifecycle.js';
import { registerStaffTaskRoutes, type StaffTaskStore } from './staff-tasks.js';
import { registerRiskEventRoutes, type RiskEventStore } from './risk-events.js';
import {
  registerAdminOrderActionRoutes,
  type AdminRefundOrderStore,
  type RefundFundingAdapter
} from './admin-order-actions.js';
import type { MockFundingAdapter } from './payment-adapter.js';
import { registerPaymentWebhookRoutes, type PaymentWebhookFundingAdapter } from './webhooks.js';
import { registerGiftRoutes, type GiftCaptureFundingAdapter, type GiftStore } from './gifts.js';
import { registerPlayerEarningRoutes, type PlayerEarningStore } from './player-earnings.js';
import { registerCommissionRoutes, type CommissionStore } from './commissions.js';
import { registerReferralAttributionRoutes, type ReferralAttributionStore } from './referrals.js';
import { registerDashboardAuthRoutes, type DashboardAuthOptions } from './dashboard-auth.js';
import { registerSupportWorkbenchRoutes, type SupportWorkbenchStore } from './support-workbench.js';
import { registerAdminDirectoryRoutes, type AdminDirectoryStore } from './admin-directory.js';
import { registerAccessRoutes, type AccessStore } from './access.js';
import { registerOperationsRoutes, type OperationsStore } from './operations.js';
import type { TransactionTimelineStore } from './transaction-timeline.js';
import type { DashboardMetricsStore } from './dashboard-metrics.js';
import { registerBotConfigRoutes, type BotConfigRouteOptions } from './bot-config.js';

export interface ApiServerOptions {
  env?: RuntimeEnvInput;
  dependencyTimeoutMs?: number;
  security?: SecurityOptions;
  catalog?: {
    store: ServiceCatalogStore;
    now?: () => Date;
  };
  account?: {
    store: AccountStore;
    fundingAdapter: Pick<MockFundingAdapter, 'resolveUser' | 'getProviderBalance'>;
    providerKey: string;
    now?: () => Date;
  };
  order?: {
    orderStore: OrderStore;
    accountStore: AccountStore;
    catalogStore: ServiceCatalogStore;
    fundingAdapter?: OrderFundingAdapter;
    providerKey?: string;
    staffTaskStore?: StaffTaskStore;
    now?: () => Date;
  };
  player?: {
    store: PlayerStore;
    now?: () => Date;
  };
  dispatch?: {
    orderStore: OrderStore;
    dispatchStore: DispatchStore;
    playerPool: DispatchPlayerPool;
    dispatchChannelId: string;
    now?: () => Date;
  };
  serviceLifecycle?: {
    store: ServiceLifecycleStore;
    now?: () => Date;
  };
  staffTasks?: {
    store: StaffTaskStore;
    orderStore: OrderStore;
    accountStore?: AccountStore;
    now?: () => Date;
  };
  riskEvents?: {
    store: RiskEventStore;
    now?: () => Date;
  };
  adminOrders?: {
    orderStore: AdminRefundOrderStore;
    fundingAdapter: RefundFundingAdapter;
    providerKey: string;
    now?: () => Date;
  };
  paymentWebhook?: {
    fundingAdapter: PaymentWebhookFundingAdapter;
    providerKey: string;
    now?: () => Date;
  };
  gift?: {
    store: GiftStore;
    orderStore: OrderStore;
    accountStore: AccountStore;
    fundingAdapter: OrderFundingAdapter & GiftCaptureFundingAdapter;
    providerKey: string;
    broadcastChannelId: string;
    now?: () => Date;
  };
  playerEarnings?: {
    store: PlayerEarningStore;
    now?: () => Date;
  };
  commissions?: { store: CommissionStore; now?: () => Date };
  referrals?: { store: ReferralAttributionStore; now?: () => Date };
  dashboardAuth?: DashboardAuthOptions;
  dashboardMetrics?: { store: DashboardMetricsStore; timeZone?: 'Asia/Shanghai'; currency?: 'CNY' };
  botConfig?: BotConfigRouteOptions;
  supportWorkbench?: { store: SupportWorkbenchStore; now?: () => Date };
  adminDirectory?: { store: AdminDirectoryStore; timelineStore?: TransactionTimelineStore; now?: () => Date };
  access?: { store: AccessStore; now?: () => Date };
  operations?: { store: OperationsStore; now?: () => Date };
}

export interface HealthPayload {
  requestId: string;
  data: {
    status: 'OK';
    checkedAt: string;
  };
}

export interface ReadinessPayload {
  requestId: string;
  data: {
    status: 'READY' | 'NOT_READY';
    checkedAt: string;
    dependencies: Array<{
      name: 'database' | 'discord' | 'config';
      status: 'READY' | 'MISSING_CONFIG' | 'TOKEN_NOT_CONFIGURED' | 'UNREACHABLE';
      required: boolean;
    }>;
  };
}

export function getHealthPayload(requestId = createRequestId()): HealthPayload {
  return {
    requestId,
    data: {
      status: 'OK',
      checkedAt: new Date().toISOString()
    }
  };
}

export async function getReadinessPayload(
  env: RuntimeEnvInput = process.env,
  options: { discordTokenPresent?: boolean; dependencyTimeoutMs?: number } = {}
): Promise<ReadinessPayload> {
  const validation = validateRuntimeEnv(env, { allowMissingDiscordToken: true });
  const databaseStatus = await getDatabaseDependencyStatus(
    validation.values.databaseUrl,
    options.dependencyTimeoutMs
  );
  const dependencies: ReadinessPayload['data']['dependencies'] = [
    {
      name: 'database',
      status: databaseStatus,
      required: true
    },
    {
      name: 'config',
      status: validation.ok ? 'READY' : 'MISSING_CONFIG',
      required: true
    },
    {
      name: 'discord',
      status:
        options.discordTokenPresent ?? Boolean(env.DISCORD_BOT_TOKEN?.trim())
          ? 'READY'
          : 'TOKEN_NOT_CONFIGURED',
      required: false
    }
  ];
  const blockingDependencies = dependencies.filter((dependency) => {
    return dependency.required && dependency.status !== 'READY';
  });

  return {
    requestId: createRequestId(),
    data: {
      status: blockingDependencies.length === 0 ? 'READY' : 'NOT_READY',
      checkedAt: new Date().toISOString(),
      dependencies
    }
  };
}

export function buildApiServer(options: ApiServerOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;
  const server = Fastify({ logger: false });
  server.securityOptions = options.security ? { env, ...options.security } : undefined;

  server.get('/health', async (request) => {
    return getHealthPayload(getRequestId(request.headers['x-request-id']));
  });

  server.get('/ready', async (_request, reply) => {
    const payload = await getReadinessPayload(env, {
      dependencyTimeoutMs: options.dependencyTimeoutMs
    });
    if (payload.data.status !== 'READY') {
      reply.code(503);
    }
    return payload;
  });

  if (options.catalog) {
    if (!server.securityOptions) {
      throw new Error('Catalog routes require buildApiServer({ security, catalog })');
    }
    registerCatalogRoutes(server, options.catalog);
  }

  if (options.account) {
    if (!server.securityOptions) {
      throw new Error('Account routes require buildApiServer({ security, account })');
    }
    registerAccountRoutes(server, options.account);
  }

  if (options.order) {
    if (!server.securityOptions) {
      throw new Error('Order routes require buildApiServer({ security, order })');
    }
    registerOrderRoutes(server, options.order);
  }

  if (options.player) {
    if (!server.securityOptions) {
      throw new Error('Player routes require buildApiServer({ security, player })');
    }
    registerPlayerRoutes(server, options.player);
  }

  if (options.dispatch) {
    if (!server.securityOptions) {
      throw new Error('Dispatch routes require buildApiServer({ security, dispatch })');
    }
    registerDispatchRoutes(server, { ...options.dispatch, policyReader: options.operations?.store,botConfigStore:options.botConfig?.store });
  }

  if (options.serviceLifecycle) {
    if (!server.securityOptions) {
      throw new Error('Service lifecycle routes require buildApiServer({ security, serviceLifecycle })');
    }
    registerServiceLifecycleRoutes(server, options.serviceLifecycle);
  }

  if (options.staffTasks) {
    if (!server.securityOptions) {
      throw new Error('Staff task routes require buildApiServer({ security, staffTasks })');
    }
    registerStaffTaskRoutes(server, options.staffTasks);
  }

  if (options.riskEvents) {
    if (!server.securityOptions) {
      throw new Error('Risk event routes require buildApiServer({ security, riskEvents })');
    }
    registerRiskEventRoutes(server, options.riskEvents);
  }

  if (options.adminOrders) {
    if (!server.securityOptions) {
      throw new Error('Admin order action routes require buildApiServer({ security, adminOrders })');
    }
    registerAdminOrderActionRoutes(server, { ...options.adminOrders, policyReader: options.operations?.store });
  }

  if (options.paymentWebhook) {
    registerPaymentWebhookRoutes(server, options.paymentWebhook);
  }

  if (options.gift) {
    if (!server.securityOptions) {
      throw new Error('Gift routes require buildApiServer({ security, gift })');
    }
    registerGiftRoutes(server, { ...options.gift, policyReader: options.operations?.store,botConfigStore:options.botConfig?.store });
  }

  if (options.playerEarnings) {
    if (!server.securityOptions) throw new Error('Player earning routes require buildApiServer({ security, playerEarnings })');
    registerPlayerEarningRoutes(server, options.playerEarnings);
  }
  if (options.commissions) {
    if (!server.securityOptions) throw new Error('Commission routes require buildApiServer({ security, commissions })');
    registerCommissionRoutes(server, options.commissions);
  }
  if(options.referrals){if(!server.securityOptions)throw new Error('Referral routes require buildApiServer({ security, referrals })');registerReferralAttributionRoutes(server,options.referrals);}
  if (options.dashboardAuth) registerDashboardAuthRoutes(server, { ...options.dashboardAuth, policyReader: options.operations?.store,
    metricsStore: options.dashboardMetrics?.store, metricsTimeZone: options.dashboardMetrics?.timeZone, metricsCurrency: options.dashboardMetrics?.currency });
  if (options.access) registerAccessRoutes(server, options.access);
  if (options.supportWorkbench) registerSupportWorkbenchRoutes(server, {
    ...options.supportWorkbench,
    registerOrderRoute: !options.adminDirectory?.timelineStore
  });
  if (options.adminDirectory) registerAdminDirectoryRoutes(server, options.adminDirectory);
  if (options.operations) registerOperationsRoutes(server, options.operations);
  if (options.botConfig) registerBotConfigRoutes(server, options.botConfig);

  return server;
}

function createRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function getRequestId(headerValue: string | string[] | undefined): string {
  if (Array.isArray(headerValue)) {
    return headerValue[0] ?? createRequestId();
  }
  return headerValue ?? createRequestId();
}

async function getDatabaseDependencyStatus(
  databaseUrl: string,
  timeoutMs = 1_000
): Promise<'READY' | 'MISSING_CONFIG' | 'UNREACHABLE'> {
  if (!databaseUrl) {
    return 'MISSING_CONFIG';
  }

  return (await canReachPostgresBaselineSchema(databaseUrl, timeoutMs)) ? 'READY' : 'UNREACHABLE';
}

async function canReachPostgresBaselineSchema(databaseUrl: string, timeoutMs: number): Promise<boolean> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
    application_name: 'blackcat_ready_probe'
  });

  try {
    await client.connect();
    const result = await client.query<{ users_table: string | null }>(
      "SELECT to_regclass('public.users')::text AS users_table"
    );
    return result.rows[0]?.users_table === 'users';
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
