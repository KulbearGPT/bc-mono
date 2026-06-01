import { useEffect, useState } from 'react';
import { buildDashboardManifest } from './manifest.js';
import {
  buildDashboardState,
  createDashboardApiClient,
  type DashboardCapabilities
} from './dashboard-shell.js';
import { SupportWorkbenchPage } from './SupportWorkbenchPage.js';
import { AdminBusinessRoute } from './AdminBusinessRoute.js';
import { buildAdminBusinessNavigation, resolveAdminBusinessPage } from './admin-business.js';
import { SecurityPage } from './SecurityPage.js';
import { OperationsRoute } from './OperationsRoute.js';
import { SettlementRoute } from './SettlementRoute.js';
import { CustomerProfileRoute } from './CustomerProfileRoute.js';
import { buildSettlementNavigation } from './settlements.js';
import {
  getSandboxBanner,
  hasFeature,
  resolveDashboardBusinessEnvironment,
  type PilotDashboardCapabilities
} from './pilot-features.js';

export function App(props: { publicBusinessEnvironment?: 'SANDBOX' | 'PRODUCTION' } = {}) {
  const manifest = buildDashboardManifest();
  const [result, setResult] = useState<{ status: number; capabilities?: DashboardCapabilities } | null>(null);

  useEffect(() => {
    void createDashboardApiClient().get('/api/v1/admin/me/capabilities').then(async (response) => {
      const body = response.ok ? await response.json() as { data: DashboardCapabilities } : null;
      setResult({ status: response.status, capabilities: body?.data });
    }).catch(() => setResult({ status: 500 }));
  }, []);

  const state = result ? buildDashboardState(result) : null;
  const enabledFeatures = result?.capabilities?.enabledFeatures;
  const adminNavigation = result?.capabilities ? buildAdminBusinessNavigation(result.capabilities.permissions, enabledFeatures) : [];
  const activeAdminPage = resolveAdminBusinessPage(window.location.pathname);
  const profileMatch = window.location.pathname.match(/^\/admin\/users\/([^/]+)\/profile$/u);
  const m6Navigation = result?.capabilities ? buildSettlementNavigation(result.capabilities.permissions, enabledFeatures) : [];
  const pilotCapabilities = result?.capabilities as PilotDashboardCapabilities | undefined;
  const businessEnvironment = resolveDashboardBusinessEnvironment(
    props.publicBusinessEnvironment,
    pilotCapabilities?.businessEnvironment
  );
  const sandboxBanner = businessEnvironment ? getSandboxBanner(businessEnvironment) : null;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: '#f4f7f8', color: '#18282d' }}>
      <header style={{ padding: '18px 24px', background: '#173238', color: '#fff' }}>
        <strong>{manifest.appName}</strong>{pilotCapabilities?.displayRole && <span className="display-role">{pilotCapabilities.displayRole}</span>}
      </header>
      {sandboxBanner && <div className="sandbox-banner" role="status">{sandboxBanner}</div>}
      {!state && <section style={{ padding: 24 }}>正在载入...</section>}
      {state?.kind === 'SIGNED_OUT' && (
        <section style={{ padding: 24 }}><h1>客服管理后台</h1><a href="/api/v1/auth/discord">使用 Discord 登录</a></section>
      )}
      {state?.kind === 'FORBIDDEN' && (
        <section style={{ padding: 24 }}><h1>无权访问</h1><p>当前员工账户没有此页面所需权限。</p></section>
      )}
      {state?.kind === 'ERROR' && (
        <section style={{ padding: 24 }}><h1>暂时无法载入</h1><p>请稍后重试或向管理员提供请求编号。</p></section>
      )}
      {state?.kind === 'READY' && (
        <div className="dashboard-layout">
          <nav className="dashboard-nav" aria-label="管理导航">
            {[...state.navigation, ...adminNavigation, ...m6Navigation].filter((item,index,all) => all.findIndex((candidate) => candidate.href === item.href) === index).map((item) => <a key={item.id} href={item.href}>{item.label}</a>)}
          </nav>
          {profileMatch
            ? hasFeature(pilotCapabilities!, 'M6') ? <CustomerProfileRoute userId={decodeURIComponent(profileMatch[1]!)} capabilities={result!.capabilities!} /> : <FeatureUnavailable />
            : window.location.pathname === '/settlements'
            ? hasFeature(pilotCapabilities!, 'M6') ? <SettlementRoute section="settlements" capabilities={result!.capabilities!} /> : <FeatureUnavailable />
            : window.location.pathname === '/reports'
            ? hasFeature(pilotCapabilities!, 'M6') ? <SettlementRoute section="reports" capabilities={result!.capabilities!} /> : <FeatureUnavailable />
            : activeAdminPage
            ? adminNavigation.some((item) => item.id === activeAdminPage) ? <AdminBusinessRoute page={activeAdminPage} capabilities={result!.capabilities!} /> : <FeatureUnavailable />
            : window.location.pathname === '/support'
            ? <SupportWorkbenchPage capabilities={result!.capabilities!} />
            : window.location.pathname === '/security'
            ? <SecurityPage capabilities={result!.capabilities!} />
            : window.location.pathname === '/operations'
            ? <OperationsRoute capabilities={result!.capabilities!} />
            : <section style={{ padding: 24 }}><h1>运营概览</h1><p>当前页面与操作均按服务端员工权限显示。</p></section>}
        </div>
      )}
    </main>
  );
}

function FeatureUnavailable() {
  return <section className="dashboard-page"><h1>功能暂未开放</h1><p>当前 Pilot 阶段未开放此功能。</p></section>;
}
