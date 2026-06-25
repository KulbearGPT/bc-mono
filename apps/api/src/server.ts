import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { Client } from 'pg';
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateRuntimeEnv,
  type RuntimeEnvInput,
} from "@blackcat/platform/env";
import { validateProductionEnv } from "@blackcat/platform/production-env";
import type { SecurityOptions } from "./security.js";
import { registerCatalogRoutes, type ServiceCatalogStore } from "./catalog.js";
import { registerAccountRoutes, type AccountStore } from "./accounts.js";
import { registerOrderRoutes, type OrderStore } from "./orders.js";
import { registerPlayerRoutes, type PlayerStore } from "./players.js";
import {
  registerDispatchRoutes,
  type DispatchPlayerPool,
  type DispatchStore,
} from "./dispatch.js";
import {
  registerServiceLifecycleRoutes,
  type ServiceLifecycleStore,
} from "./service-lifecycle.js";
import { registerStaffTaskRoutes, type StaffTaskStore } from "./staff-tasks.js";
import { registerRiskEventRoutes, type RiskEventStore } from "./risk-events.js";
import {
  registerAdminOrderActionRoutes,
  type AdminRefundOrderStore,
} from "./admin-order-actions.js";
import { registerGiftRoutes, type GiftStore } from "./gifts.js";
import {
  registerPlayerEarningRoutes,
  type PlayerEarningStore,
} from "./player-earnings.js";
import {
  registerCommissionRoutes,
  type CommissionStore,
} from "./commissions.js";
import {
  registerReferralAttributionRoutes,
  type ReferralAttributionStore,
} from "./referrals.js";
import {
  registerDashboardAuthRoutes,
  type DashboardAuthOptions,
} from "./dashboard-auth.js";
import {
  registerSupportWorkbenchRoutes,
  type SupportWorkbenchStore,
} from "./support-workbench.js";
import {
  registerAdminDirectoryRoutes,
  type AdminDirectoryStore,
} from "./admin-directory.js";
import { registerAccessRoutes, type AccessStore } from "./access.js";
import {
  registerOperationsRoutes,
  type OperationsStore,
} from "./operations.js";
import type { TransactionTimelineStore } from "./transaction-timeline.js";
import type { DashboardMetricsStore } from "./dashboard-metrics.js";
import {
  registerBotConfigRoutes,
  type BotConfigRouteOptions,
} from "./bot-config.js";
import {
  registerSettlementRoutes,
  type SettlementRouteOptions,
} from "./settlements.js";
import {
  registerWeeklyReportRoutes,
  type WeeklyReportStore,
} from "./weekly-reports.js";
import {
  registerCustomerProfileRoutes,
  type CustomerProfileScope,
  type CustomerProfileStore,
} from "./customer-profiles.js";
import { configureCursorSigningSecret } from "./signed-cursor.js";
import {
  registerWalletRoutes,
  type WalletApplicationService,
  type WalletFundingService,
} from "./wallet.js";
import type { ReceiptStorage } from "./receipt-storage.js";
import {
  registerOnboardingRoutes,
  type OnboardingStore,
} from "./onboarding.js";
import {
  registerBusinessTagRoutes,
  type BusinessTagStore,
} from "./business-tags.js";
import {
  registerPlayerCompensationRoutes,
  type PlayerCompensationStore,
} from "./player-compensation.js";
import {
  registerOrderChannelEventRoutes,
  type OrderChannelEventStore,
} from "./order-channel-events.js";
import {
  registerOrderParticipantRoutes,
  type OrderParticipantStore,
} from "./order-participants.js";
import {
  registerOrderRequirementRoutes,
  type OrderRequirementStore,
} from "./order-requirements.js";
import {
  registerServicePackageRoutes,
  type ServicePackageStore,
} from "./service-packages.js";
import {
  registerSelectionPoolRoutes,
  type SelectionPoolStore,
} from "./selection-pools.js";

export interface ApiServerOptions {
  env?: RuntimeEnvInput;
  dependencyTimeoutMs?: number;
  security?: SecurityOptions;
  catalog?: {
    store: ServiceCatalogStore;
    businessTags?: BusinessTagStore;
    now?: () => Date;
  };
  account?: {
    store: AccountStore;
    walletFunding: WalletFundingService;
    now?: () => Date;
    profileStore?: CustomerProfileStore;
  };
  order?: {
    orderStore: OrderStore;
    accountStore: AccountStore;
    catalogStore: ServiceCatalogStore;
    walletFunding?: WalletFundingService;
    staffTaskStore?: StaffTaskStore;
    now?: () => Date;
  };
  player?: {
    store: PlayerStore;
    businessTags?: BusinessTagStore;
    now?: () => Date;
  };
  businessTags?: { store: BusinessTagStore; now?: () => Date };
  playerCompensation?: { store: PlayerCompensationStore; now?: () => Date };
  dispatch?: {
    orderStore: OrderStore;
    dispatchStore: DispatchStore;
    playerPool: DispatchPlayerPool;
    dispatchChannelId: string;
    now?: () => Date;
    compensationStore?: PlayerCompensationStore;
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
    now?: () => Date;
  };
  gift?: {
    store: GiftStore;
    orderStore: OrderStore;
    accountStore: AccountStore;
    walletFunding: WalletFundingService;
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
  dashboardMetrics?: {
    store: DashboardMetricsStore;
    timeZone?: "Asia/Shanghai";
    currency?: "CAT";
  };
  botConfig?: BotConfigRouteOptions;
  settlements?: SettlementRouteOptions;
  weeklyReports?: { store: WeeklyReportStore; now?: () => Date };
  customerProfiles?: {
    store: CustomerProfileStore;
    walletFunding: WalletFundingService;
    now?: () => Date;
  };
  supportWorkbench?: { store: SupportWorkbenchStore; now?: () => Date };
  adminDirectory?: {
    store: AdminDirectoryStore;
    businessTags?: BusinessTagStore;
    timelineStore?: TransactionTimelineStore;
    customerScope?: CustomerProfileScope;
    now?: () => Date;
  };
  access?: { store: AccessStore; now?: () => Date };
  operations?: { store: OperationsStore; guildId?: string; now?: () => Date };
  wallet?: {
    service: WalletApplicationService;
    accountStore?: Pick<AccountStore, "findByDiscord">;
    receiptStorage?: ReceiptStorage;
    now?: () => Date;
  };
  onboarding?: { store: OnboardingStore; now?: () => Date };
  orderChannelEvents?: { store: OrderChannelEventStore; now?: () => Date };
  orderParticipants?: { store: OrderParticipantStore; now?: () => Date };
  orderRequirements?: { store: OrderRequirementStore; now?: () => Date };
  servicePackages?: { store: ServicePackageStore; now?: () => Date };
  selectionPools?: { store: SelectionPoolStore; now?: () => Date };
}

export interface HealthPayload {
  requestId: string;
  data: {
    status: "OK";
    checkedAt: string;
  };
}

export interface ReadinessPayload {
  requestId: string;
  data: {
    status: "READY" | "NOT_READY";
    checkedAt: string;
    dependencies: Array<{
      name: "database" | "discord" | "config";
      status:
        "READY" | "MISSING_CONFIG" | "TOKEN_NOT_CONFIGURED" | "UNREACHABLE";
      required: boolean;
    }>;
  };
}

export function getHealthPayload(requestId = createRequestId()): HealthPayload {
  return {
    requestId,
    data: {
      status: "OK",
      checkedAt: new Date().toISOString(),
    },
  };
}

export async function getReadinessPayload(
  env: RuntimeEnvInput = process.env,
  options: { discordTokenPresent?: boolean; dependencyTimeoutMs?: number } = {},
): Promise<ReadinessPayload> {
  const validation = validateRuntimeEnv(env, {
    allowMissingDiscordToken: true,
  });
  const productionConfigurationReady =
    env.NODE_ENV !== "production" || validateProductionEnv(env).length === 0;
  const databaseStatus = await getDatabaseDependencyStatus(
    validation.values.databaseUrl,
    options.dependencyTimeoutMs,
  );
  const dependencies: ReadinessPayload["data"]["dependencies"] = [
    {
      name: "database",
      status: databaseStatus,
      required: true,
    },
    {
      name: "config",
      status:
        validation.ok && productionConfigurationReady
          ? "READY"
          : "MISSING_CONFIG",
      required: true,
    },
    {
      name: "discord",
      status:
        (options.discordTokenPresent ?? Boolean(env.DISCORD_BOT_TOKEN?.trim()))
          ? "READY"
          : "TOKEN_NOT_CONFIGURED",
      required: false,
    },
  ];
  const blockingDependencies = dependencies.filter((dependency) => {
    return dependency.required && dependency.status !== "READY";
  });

  return {
    requestId: createRequestId(),
    data: {
      status: blockingDependencies.length === 0 ? "READY" : "NOT_READY",
      checkedAt: new Date().toISOString(),
      dependencies,
    },
  };
}

export function buildApiServer(
  options: ApiServerOptions = {},
): FastifyInstance {
  const env = options.env ?? process.env;
  const validation = validateRuntimeEnv(env, {
    allowMissingDiscordToken: true,
  });
  configureCursorSigningSecret(validation.values.paginationCursorSigningSecret);
  const server = Fastify({ logger: false });
  server.securityOptions = options.security
    ? {
        env,
        now: options.dashboardAuth?.now,
        dashboardGuildId: options.dashboardAuth?.guildId,
        ...options.security,
      }
    : undefined;

  server.get("/health", async (request) => {
    return getHealthPayload(getRequestId(request.headers["x-request-id"]));
  });

  server.get("/ready", async (_request, reply) => {
    const payload = await getReadinessPayload(env, {
      dependencyTimeoutMs: options.dependencyTimeoutMs,
    });
    if (payload.data.status !== "READY") {
      reply.code(503);
    }
    return payload;
  });

  if (options.catalog) {
    if (!server.securityOptions) {
      throw new Error(
        "Catalog routes require buildApiServer({ security, catalog })",
      );
    }
    registerCatalogRoutes(server, options.catalog);
  }
  if (options.businessTags) {
    if (!server.securityOptions)
      throw new Error(
        "Business tag routes require buildApiServer({ security, businessTags })",
      );
    registerBusinessTagRoutes(server, options.businessTags);
  }
  if (options.playerCompensation)
    registerPlayerCompensationRoutes(server, options.playerCompensation);

  if (options.account) {
    if (!server.securityOptions) {
      throw new Error(
        "Account routes require buildApiServer({ security, account })",
      );
    }
    registerAccountRoutes(server, options.account);
  }

  if (options.order) {
    if (!server.securityOptions) {
      throw new Error(
        "Order routes require buildApiServer({ security, order })",
      );
    }
    registerOrderRoutes(server, options.order);
  }

  if (options.player) {
    if (!server.securityOptions) {
      throw new Error(
        "Player routes require buildApiServer({ security, player })",
      );
    }
    registerPlayerRoutes(server, options.player);
  }

  // Legacy first-wins dispatch stores remain readable for migration/history only.
  // Candidate-pool routes are the sole production assignment API.

  if (options.serviceLifecycle) {
    if (!server.securityOptions) {
      throw new Error(
        "Service lifecycle routes require buildApiServer({ security, serviceLifecycle })",
      );
    }
    registerServiceLifecycleRoutes(server, options.serviceLifecycle);
  }

  if (options.staffTasks) {
    if (!server.securityOptions) {
      throw new Error(
        "Staff task routes require buildApiServer({ security, staffTasks })",
      );
    }
    registerStaffTaskRoutes(server, options.staffTasks);
  }

  if (options.riskEvents) {
    if (!server.securityOptions) {
      throw new Error(
        "Risk event routes require buildApiServer({ security, riskEvents })",
      );
    }
    registerRiskEventRoutes(server, options.riskEvents);
  }

  if (options.adminOrders) {
    if (!server.securityOptions) {
      throw new Error(
        "Admin order action routes require buildApiServer({ security, adminOrders })",
      );
    }
    registerAdminOrderActionRoutes(server, {
      ...options.adminOrders,
      policyReader: options.operations?.store,
    });
  }

  if (options.gift) {
    if (!server.securityOptions) {
      throw new Error("Gift routes require buildApiServer({ security, gift })");
    }
    registerGiftRoutes(server, {
      ...options.gift,
      policyReader: options.operations?.store,
      botConfigStore: options.botConfig?.store,
    });
  }

  if (options.playerEarnings) {
    if (!server.securityOptions)
      throw new Error(
        "Player earning routes require buildApiServer({ security, playerEarnings })",
      );
    registerPlayerEarningRoutes(server, options.playerEarnings);
  }
  if (options.commissions) {
    if (!server.securityOptions)
      throw new Error(
        "Commission routes require buildApiServer({ security, commissions })",
      );
    registerCommissionRoutes(server, options.commissions);
  }
  if (options.referrals) {
    if (!server.securityOptions)
      throw new Error(
        "Referral routes require buildApiServer({ security, referrals })",
      );
    registerReferralAttributionRoutes(server, options.referrals);
  }
  if (options.dashboardAuth)
    registerDashboardAuthRoutes(server, {
      ...options.dashboardAuth,
      policyReader: options.operations?.store,
      metricsStore: options.dashboardMetrics?.store,
      metricsTimeZone: options.dashboardMetrics?.timeZone,
      metricsCurrency: options.dashboardMetrics?.currency,
    });
  if (options.access) registerAccessRoutes(server, options.access);
  if (options.supportWorkbench)
    registerSupportWorkbenchRoutes(server, {
      ...options.supportWorkbench,
      registerOrderRoute: !options.adminDirectory?.timelineStore,
    });
  if (options.adminDirectory)
    registerAdminDirectoryRoutes(server, options.adminDirectory);
  if (options.operations) registerOperationsRoutes(server, options.operations);
  if (options.botConfig) registerBotConfigRoutes(server, options.botConfig);
  if (options.settlements) {
    if (!server.securityOptions)
      throw new Error(
        "Settlement routes require buildApiServer({ security, settlements })",
      );
    registerSettlementRoutes(server, options.settlements);
  }
  if (options.weeklyReports) {
    if (!server.securityOptions)
      throw new Error(
        "Weekly report routes require buildApiServer({ security, weeklyReports })",
      );
    registerWeeklyReportRoutes(server, options.weeklyReports);
  }
  if (options.customerProfiles) {
    if (!server.securityOptions)
      throw new Error(
        "Customer profile routes require buildApiServer({ security, customerProfiles })",
      );
    registerCustomerProfileRoutes(server, options.customerProfiles);
  }
  if (options.wallet) {
    if (!server.securityOptions)
      throw new Error(
        "Wallet routes require buildApiServer({ security, wallet })",
      );
    registerWalletRoutes(server, options.wallet);
  }
  if (options.onboarding) {
    if (!server.securityOptions)
      throw new Error(
        "Onboarding routes require buildApiServer({ security, onboarding })",
      );
    registerOnboardingRoutes(server, options.onboarding);
  }
  if (options.orderChannelEvents)
    registerOrderChannelEventRoutes(server, options.orderChannelEvents);
  if (options.orderParticipants)
    registerOrderParticipantRoutes(server, options.orderParticipants);
  if (options.orderRequirements)
    registerOrderRequirementRoutes(server, options.orderRequirements);
  if (options.servicePackages)
    registerServicePackageRoutes(server, options.servicePackages);
  if (options.selectionPools)
    registerSelectionPoolRoutes(server, options.selectionPools);

  return server;
}

export async function registerDashboardAssets(
  server: FastifyInstance,
  dashboardDist: string,
  options: { businessEnvironment?: "SANDBOX" | "PRODUCTION" } = {},
): Promise<void> {
  await server.register(fastifyStatic, {
    root: join(dashboardDist, "assets"),
    prefix: "/assets/",
    decorateReply: true,
  });
  const indexTemplate = await readFile(
    join(dashboardDist, "index.html"),
    "utf8",
  );
  const environmentMarker = "__BLACKCAT_BUSINESS_ENV__";
  const businessEnvironment =
    options.businessEnvironment ?? server.securityOptions?.businessEnvironment;
  if (indexTemplate.includes(environmentMarker) && !businessEnvironment) {
    throw new Error(
      "Dashboard assets require a validated business environment.",
    );
  }
  const indexHtml = businessEnvironment
    ? indexTemplate.replaceAll(environmentMarker, businessEnvironment)
    : indexTemplate;
  server.get("/*", async (request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname === "/health" ||
      pathname === "/ready" ||
      pathname.startsWith("/assets/") ||
      pathname.startsWith("/api/v1/auth/")
    ) {
      return reply.callNotFound();
    }
    if (!request.headers.accept?.includes("text/html"))
      return reply.callNotFound();
    return reply.type("text/html; charset=utf-8").send(indexHtml);
  });
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
  timeoutMs = 1_000,
): Promise<"READY" | "MISSING_CONFIG" | "UNREACHABLE"> {
  if (!databaseUrl) {
    return "MISSING_CONFIG";
  }

  return (await canReachPostgresBaselineSchema(databaseUrl, timeoutMs))
    ? "READY"
    : "UNREACHABLE";
}

async function canReachPostgresBaselineSchema(
  databaseUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
    application_name: "blackcat_ready_probe",
  });

  try {
    await client.connect();
    const result = await client.query<{ users_table: string | null }>(
      "SELECT to_regclass('public.users')::text AS users_table",
    );
    return result.rows[0]?.users_table === "users";
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
