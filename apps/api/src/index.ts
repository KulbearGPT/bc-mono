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
import { MockFundingAdapter } from './payment-adapter.js';
import { InMemoryAuditSink, InMemoryIdempotencyStore, PostgresStaffDirectory } from './security.js';
import { PostgresGiftStore } from './gifts.js';
import { PostgresPlayerEarningStore } from './player-earnings.js';
import { PostgresCommissionStore } from './commissions.js';
import { PostgresReferralAttributionStore } from './referrals.js';
import { DiscordHttpOAuthProvider, PostgresDashboardAuthStore } from './dashboard-auth.js';
import { PostgresSupportWorkbenchStore } from './support-workbench.js';

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
const fundingAdapter = new MockFundingAdapter();
const dispatchChannelId = process.env.DISPATCH_CHANNEL_ID?.trim() || '000000000000000000';
const giftBroadcastChannelId = process.env.GIFT_BROADCAST_CHANNEL_ID?.trim() || '000000000000000000';
const dashboardOAuthConfig = {
  clientId: process.env.DISCORD_OAUTH_CLIENT_ID?.trim(),
  clientSecret: process.env.DISCORD_OAUTH_CLIENT_SECRET?.trim(),
  redirectUri: process.env.DISCORD_OAUTH_REDIRECT_URI?.trim(),
  guildId: process.env.DISCORD_GUILD_ID?.trim(),
  dashboardUrl: process.env.DASHBOARD_URL?.trim(),
  csrfSecret: process.env.DASHBOARD_CSRF_SECRET?.trim()
};
const dashboardAuthStore = Object.values(dashboardOAuthConfig).every(Boolean)
  ? new PostgresDashboardAuthStore({ client: databasePool, csrfSecret: dashboardOAuthConfig.csrfSecret! })
  : undefined;

const server = buildApiServer({
  env: process.env,
  security: {
    auditSink: new InMemoryAuditSink(),
    idempotencyStore: new InMemoryIdempotencyStore(),
    staffDirectory: new PostgresStaffDirectory({ client: databasePool }),
    dashboardSessions: dashboardAuthStore
  },
  catalog: {
    store: catalogStore
  },
  account: {
    store: accountStore,
    fundingAdapter,
    providerKey: 'mock-provider'
  },
  order: {
    orderStore,
    accountStore,
    catalogStore,
    fundingAdapter,
    providerKey: 'mock-provider',
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
    orderStore: adminOrderActionStore,
    fundingAdapter,
    providerKey: 'mock-provider'
  },
  paymentWebhook: {
    fundingAdapter,
    providerKey: 'mock-provider'
  },
  gift: {
    store: giftStore,
    orderStore,
    accountStore,
    fundingAdapter,
    providerKey: 'mock-provider',
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
  supportWorkbench: {
    store: new PostgresSupportWorkbenchStore(databasePool)
  }
});
await server.listen({ port: validation.values.apiPort, host: '0.0.0.0' });
console.log(
  JSON.stringify({
    level: 'info',
    event: 'api.started',
    port: validation.values.apiPort
  })
);
