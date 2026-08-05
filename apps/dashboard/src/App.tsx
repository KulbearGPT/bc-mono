import { useCallback, useEffect, useState } from 'react';
import { buildDashboardManifest } from './manifest.js';
import {
  buildDashboardState,
  createDashboardApiClient,
  dashboardSessionExpiredEvent,
  type DashboardCapabilities
} from './dashboard-shell.js';
import { SupportWorkbenchPage } from './SupportWorkbenchPage.js';
import { AdminBusinessRoute } from './AdminBusinessRoute.js';
import { buildAdminBusinessNavigation, buildAdminBusinessPage, resolveAdminBusinessPage } from './admin-business.js';
import { SecurityPage } from './SecurityPage.js';
import { OperationsRoute } from './OperationsRoute.js';
import { SettlementRoute } from './SettlementRoute.js';
import { CustomerProfileRoute } from './CustomerProfileRoute.js';
import { AccessManagementRoute } from './AccessManagementRoute.js';
import { BusinessTagsRoute } from './BusinessTagsRoute.js';
import { BotConfigPage } from './BotConfigPage.js';
import { DashboardErrorBoundary } from './DashboardErrorBoundary.js';
import { DashboardChrome, DashboardGate, DashboardOverview, FeatureUnavailable, RouteForbidden, RouteNotFound } from './DashboardChrome.js';

export { DashboardChrome, DashboardOverview } from './DashboardChrome.js';
import { buildSettlementNavigation } from './settlements.js';
import {
  getSandboxBanner,
  hasFeature,
  resolveDashboardBusinessEnvironment,
  type PilotDashboardCapabilities
} from './pilot-features.js';

const knownDashboardPaths = new Set([
  '/', '/support', '/security', '/operations', '/access', '/business-tags', '/bot-config', '/settlements', '/reports'
]);

export type DashboardPathAccess = 'ALLOWED' | 'FORBIDDEN' | 'NOT_FOUND';

export function resolveDashboardPathAccess(pathname: string, visiblePaths: string[], knownRoute: boolean): DashboardPathAccess {
  if (visiblePaths.includes(pathname)) return 'ALLOWED';
  return knownRoute ? 'FORBIDDEN' : 'NOT_FOUND';
}

export function App(props: { publicBusinessEnvironment?: 'SANDBOX' | 'PRODUCTION' } = {}) {
  const manifest = buildDashboardManifest();
  const [result, setResult] = useState<{ status: number; capabilities?: DashboardCapabilities; authReason?: string | null } | null>(null);
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const [contentBusy, setContentBusy] = useState(false);

  useEffect(() => {
    void createDashboardApiClient().get('/api/v1/admin/me/capabilities').then(async (response) => {
      const body = await response.json().catch(() => null) as { data?: DashboardCapabilities; error?: { code?: string } } | null;
      setResult({ status: response.status, capabilities: body?.data, authReason: body?.error?.code ?? null });
    }).catch(() => setResult({ status: 500 }));
  }, []);

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    const handleSessionExpired = (event: Event) => setResult({
      status: 401,
      authReason: (event as CustomEvent<{ reason?: string | null }>).detail?.reason ?? null
    });
    window.addEventListener('popstate', handlePopState);
    window.addEventListener(dashboardSessionExpiredEvent, handleSessionExpired);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener(dashboardSessionExpiredEvent, handleSessionExpired);
    };
  }, []);

  const navigate = useCallback((href: string) => {
    if (href === currentPath) return;
    setContentBusy(true);
    window.history.pushState(null, '', href);
    setCurrentPath(window.location.pathname);
    window.requestAnimationFrame(() => setContentBusy(false));
  }, [currentPath]);

  const state = result ? buildDashboardState(result) : null;
  const enabledFeatures = result?.capabilities?.enabledFeatures;
  const adminNavigation = result?.capabilities ? buildAdminBusinessNavigation(result.capabilities.permissions, enabledFeatures) : [];
  const activeAdminPage = resolveAdminBusinessPage(currentPath);
  const profileMatch = currentPath.match(/^\/admin\/users\/([^/]+)\/profile$/u);
  const m6Navigation = result?.capabilities ? buildSettlementNavigation(result.capabilities.permissions, enabledFeatures) : [];
  const pilotCapabilities = result?.capabilities as PilotDashboardCapabilities | undefined;
  const businessEnvironment = resolveDashboardBusinessEnvironment(
    props.publicBusinessEnvironment,
    pilotCapabilities?.businessEnvironment
  );
  const sandboxBanner = businessEnvironment ? getSandboxBanner(businessEnvironment) : null;

  if (!state) {
    return <DashboardGate kind="LOADING" appName={manifest.appName} />;
  }
  if (state.kind === 'SIGNED_OUT') {
    return <DashboardGate kind="SIGNED_OUT" appName={manifest.appName} authReason={result?.authReason} />;
  }
  if (state.kind === 'FORBIDDEN') {
    return <DashboardGate kind="FORBIDDEN" appName={manifest.appName} />;
  }
  if (state.kind === 'ERROR') {
    return <DashboardGate kind="ERROR" appName={manifest.appName} />;
  }

  const navigation = [...state.navigation, ...adminNavigation, ...m6Navigation]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.href === item.href) === index);
  const authorizedPaths = navigation.map((item) => item.href);
  if (activeAdminPage) {
    const requiredPermission = buildAdminBusinessPage({
      page: activeAdminPage,
      permissions: result!.capabilities!.permissions,
      status: 'LOADING'
    }).requiredPermission;
    if (result!.capabilities!.permissions.includes(requiredPermission)) authorizedPaths.push(currentPath);
  }
  if (profileMatch && result!.capabilities!.permissions.includes('customer_profile.read')) authorizedPaths.push(currentPath);
  if (currentPath === '/settlements' && result!.capabilities!.permissions.includes('settlement.read')) authorizedPaths.push(currentPath);
  if (currentPath === '/reports' && result!.capabilities!.permissions.includes('weekly_report.read')) authorizedPaths.push(currentPath);
  const routeAccess = resolveDashboardPathAccess(
    currentPath,
    authorizedPaths,
    knownDashboardPaths.has(currentPath) || Boolean(activeAdminPage) || Boolean(profileMatch)
  );

  const content = routeAccess === 'NOT_FOUND'
    ? <RouteNotFound />
    : routeAccess === 'FORBIDDEN'
    ? <RouteForbidden />
    : profileMatch
    ? hasFeature(pilotCapabilities!, 'M6') ? <CustomerProfileRoute userId={decodeURIComponent(profileMatch[1]!)} capabilities={result!.capabilities!} /> : <FeatureUnavailable />
    : currentPath === '/settlements'
    ? hasFeature(pilotCapabilities!, 'M6') ? <SettlementRoute section="settlements" capabilities={result!.capabilities!} /> : <FeatureUnavailable />
    : currentPath === '/reports'
    ? hasFeature(pilotCapabilities!, 'M6') ? <SettlementRoute section="reports" capabilities={result!.capabilities!} /> : <FeatureUnavailable />
    : activeAdminPage
    ? adminNavigation.some((item) => item.id === activeAdminPage) ? <AdminBusinessRoute page={activeAdminPage} capabilities={result!.capabilities!} /> : <FeatureUnavailable />
    : currentPath === '/support'
    ? <SupportWorkbenchPage capabilities={result!.capabilities!} />
    : currentPath === '/security'
    ? <SecurityPage capabilities={result!.capabilities!} />
    : currentPath === '/operations'
    ? <OperationsRoute capabilities={result!.capabilities!} />
    : currentPath === '/access'
    ? <AccessManagementRoute capabilities={result!.capabilities!} />
    : currentPath === '/business-tags'
    ? <BusinessTagsRoute />
    : currentPath === '/bot-config'
    ? <BotConfigPage capabilities={result!.capabilities!} />
    : <DashboardOverview navigation={navigation} />;

  return (
    <DashboardChrome
      appName={manifest.appName}
      capabilities={{ ...result!.capabilities!, businessEnvironment }}
      navigation={navigation}
      currentPath={currentPath}
      banner={sandboxBanner}
      contentBusy={contentBusy}
      onNavigate={navigate}
    >
      <DashboardErrorBoundary key={currentPath}>{content}</DashboardErrorBoundary>
    </DashboardChrome>
  );
}
