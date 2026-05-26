import { buildApiServer } from './server.js';
import { validateRuntimeEnv } from '@blackcat/platform/env';
import { Pool } from 'pg';
import { PostgresServiceCatalogStore } from './catalog.js';
import { PostgresAccountStore } from './accounts.js';
import { PostgresOrderStore } from './orders.js';
import { PostgresPlayerStore } from './players.js';
import { PostgresDispatchPlayerPool, PostgresDispatchStore } from './dispatch.js';
import { PostgresServiceLifecycleStore } from './service-lifecycle.js';
import { PostgresStaffTaskStore } from './staff-tasks.js';
import { PostgresRiskEventStore } from './risk-events.js';
import { PostgresAdminOrderActionStore } from './admin-order-actions.js';
import { PostgresAuditSink, PostgresIdempotencyStore, PostgresStaffDirectory } from './security.js';
import { PostgresSettlementStore } from './settlements.js';
import { PostgresGiftStore } from './gifts.js';
import { PostgresPlayerEarningStore } from './player-earnings.js';
import { PostgresCommissionStore } from './commissions.js';
import { PostgresReferralAttributionStore } from './referrals.js';
import { DiscordHttpOAuthProvider, PostgresDashboardAuthStore } from './dashboard-auth.js';
import { PostgresSupportWorkbenchStore } from './support-workbench.js';
import { PostgresAdminDirectoryStore } from './admin-directory.js';
import { PostgresAccessStore } from './access.js';
import { PostgresOperationsStore } from './operations.js';
import { PostgresTransactionTimelineStore } from './transaction-timeline.js';
import { PostgresDashboardMetricsStore } from './dashboard-metrics.js';
import { DiscordHttpBotConfigAdapter, PostgresBotConfigStore } from './bot-config.js';
import { PostgresWeeklyReportStore } from './weekly-reports.js';
import { PostgresCustomerProfileStore } from './customer-profiles.js';
import { PostgresWalletStore } from './wallet.js';
import { PrivateFileReceiptStorage } from './receipt-storage.js';

const validation = validateRuntimeEnv(process.env, { allowMissingDiscordToken: true });

if (!validation.ok) {
  console.error(
    JSON.stringify(
      {
        level: 'error',
        event: 'api.config.invalid',
        errors: validation.errors
      },
      null,
      2
    )
  );
  process.exit(1);
}

const databasePool = new Pool({
  connectionString: validation.values.databaseUrl,
  application_name: 'blackcat_api'
});
const catalogStore = new PostgresServiceCatalogStore({ pool: databasePool });
const accountStore = new PostgresAccountStore({ pool: databasePool });
const orderStore = new PostgresOrderStore({ pool: databasePool });
const playerStore = new PostgresPlayerStore({ pool: databasePool });
const dispatchStore = new PostgresDispatchStore({ pool: databasePool });
const dispatchPlayerPool = new PostgresDispatchPlayerPool({ pool: databasePool });
const serviceLifecycleStore = new PostgresServiceLifecycleStore({ pool: databasePool });
const staffTaskStore = new PostgresStaffTaskStore({ pool: databasePool });
const riskEventStore = new PostgresRiskEventStore({ pool: databasePool });
const adminOrderActionStore = new PostgresAdminOrderActionStore({ pool: databasePool });
const giftStore = new PostgresGiftStore(databasePool);
const playerEarningStore = new PostgresPlayerEarningStore(databasePool);
const commissionStore = new PostgresCommissionStore(databasePool);
const referralStore = new PostgresReferralAttributionStore(databasePool);
const weeklyReportStore = new PostgresWeeklyReportStore(databasePool);
const customerProfileStore = new PostgresCustomerProfileStore(databasePool);
const settlementStore = new PostgresSettlementStore(databasePool);
const walletStore = new PostgresWalletStore({ pool: databasePool });
const dispatchChannelId = process.env.DISPATCH_CHANNEL_ID?.trim() || '000000000000000000';
const giftBroadcastChannelId = process.env.GIFT_BROADCAST_CHANNEL_ID?.trim() || '000000000000000000';
const dashboardOAuthConfig = {
  clientId: process.env.DISCORD_OAUTH_CLIENT_ID?.trim(),
  clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET?.trim(),
  redirectUri: process.env.DISCORD_OAUTH_REDIRECT_URI?.trim(),
  guildId: process.env.DISCORD_GUILD_ID?.trim(),
  dashboardUrl: process.env.DASHBOARD_URL?.trim(),
  csrfSecret: process.env.DASHBOARD_CSRF_SECRET?.trim(),
  mfaEncryptionKey: process.env.DASHBOARD_MFA_ENCRYPTION_KEY?.trim()
};
const operationsStore = new PostgresOperationsStore(databasePool);
const dashboardAuthStore = Object.values(dashboardOAuthConfig).every(Boolean)
  ? new PostgresDashboardAuthStore({
      client: databasePool,
      csrfSecret: dashboardOAuthConfig.csrfSecret!,
      mfaEncryptionKey: dashboardOAuthConfig.mfaEncryptionKey!,
      policyReader: operationsStore
    })
  : undefined;
const accessStore = new PostgresAccessStore(databasePool);
const discordBotToken = process.env.DISCORD_BOT_TOKEN?.trim();
const botConfigValidationSecret = process.env.BOT_CONFIG_VALIDATION_SECRET?.trim();
if (discordBotToken && (!botConfigValidationSecret || botConfigValidationSecret.length < 32)) {
  throw new Error('BOT_CONFIG_VALIDATION_SECRET must be at least 32 characters when Discord Bot configuration is enabled.');
}
const bootstrapOwnerDiscordUserId = process.env.BOOTSTRAP_L4_DISCORD_USER_ID?.trim();
if (bootstrapOwnerDiscordUserId) {
  if (!dashboardOAuthConfig.guildId) throw new Error('DISCORD_GUILD_ID is required for L4 bootstrap.');
  await accessStore.bootstrapOwner({
    guildId: dashboardOAuthConfig.guildId,
    discordUserId: bootstrapOwnerDiscordUserId,
    now: new Date()
  });
}

const server = buildApiServer({
  env: process.env,
  security: {
    auditSink: new PostgresAuditSink({ client: databasePool }),
    idempotencyStore: new PostgresIdempotencyStore({ client: databasePool }),
    staffDirectory: new PostgresStaffDirectory({ client: databasePool }),
    dashboardSessions: dashboardAuthStore
  },
  catalog: {
    store: catalogStore
  },
  account: {
    store: accountStore,
    walletFunding: walletStore,
    profileStore: customerProfileStore,
  },
  order: {
    orderStore,
    accountStore,
    catalogStore,
    walletFunding: walletStore,
    staffTaskStore
  },
  player: {
    store: playerStore
  },
  dispatch: {
    orderStore,
    dispatchStore,
    playerPool: dispatchPlayerPool,
    dispatchChannelId
  },
  serviceLifecycle: {
    store: serviceLifecycleStore
  },
  staffTasks: {
    store: staffTaskStore,
    orderStore,
    accountStore
  },
  riskEvents: {
    store: riskEventStore
  },
  adminOrders: {
    orderStore: adminOrderActionStore
  },
  gift: {
    store: giftStore,
    orderStore,
    accountStore,
    walletFunding: walletStore,
    broadcastChannelId: giftBroadcastChannelId
  },
  playerEarnings: {
    store: playerEarningStore
  },
  commissions: {
    store: commissionStore
  },
  referrals: {
    store: referralStore
  },
  weeklyReports: {
    store: weeklyReportStore
  },
  settlements: {
    store: settlementStore,
    manualDualReviewFromMinor: 400_000,
    l4ReviewFromMinor: 500_000
  },
  customerProfiles: {
    store: customerProfileStore,
    walletFunding: walletStore
  },
  wallet: { service: walletStore, receiptStorage: new PrivateFileReceiptStorage(process.env.RECEIPT_STORAGE_DIR?.trim() || '/tmp/blackcat-receipts') },
  dashboardAuth: dashboardAuthStore ? {
    store: dashboardAuthStore,
    oauth: new DiscordHttpOAuthProvider({
      clientId: dashboardOAuthConfig.clientId!,
      clientSecret: dashboardOAuthConfig.clientSecret!,
      redirectUri: dashboardOAuthConfig.redirectUri!
    }),
    staffDirectory: new PostgresStaffDirectory({ client: databasePool }),
    guildId: dashboardOAuthConfig.guildId!,
    dashboardUrl: dashboardOAuthConfig.dashboardUrl!,
    secureCookies: process.env.NODE_ENV === 'production'
  } : undefined,
  dashboardMetrics: dashboardAuthStore ? {
    store: new PostgresDashboardMetricsStore(databasePool),
    timeZone: 'Asia/Shanghai',
    currency: 'USD'
  } : undefined,
  supportWorkbench: {
    store: new PostgresSupportWorkbenchStore(databasePool)
  },
  adminDirectory: {
    store: new PostgresAdminDirectoryStore(databasePool),
    timelineStore: new PostgresTransactionTimelineStore(databasePool),
    customerScope: customerProfileStore
  },
  access: {
    store: accessStore
  },
  operations: {
    store: operationsStore,
    guildId: dashboardOAuthConfig.guildId
  },
  botConfig: discordBotToken && botConfigValidationSecret ? {
    store: new PostgresBotConfigStore(databasePool),
    discord: new DiscordHttpBotConfigAdapter(discordBotToken),
    validationSecret: botConfigValidationSecret
  } : undefined
});
await server.listen({ port: validation.values.apiPort, host: '0.0.0.0' });
console.log(
  JSON.stringify({
    level: 'info',
    event: 'api.started',
    port: validation.values.apiPort
  })
);
