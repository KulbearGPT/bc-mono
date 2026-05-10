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

export function App() {
  const manifest = buildDashboardManifest();
  const [result, setResult] = useState<{ status: number; capabilities?: DashboardCapabilities } | null>(null);

  useEffect(() => {
    void createDashboardApiClient().get('/api/v1/admin/me/capabilities').then(async (response) => {
      const body = response.ok ? await response.json() as { data: DashboardCapabilities } : null;
      setResult({ status: response.status, capabilities: body?.data });
    }).catch(() => setResult({ status: 500 }));
  }, []);

  const state = result ? buildDashboardState(result) : null;
  const adminNavigation = result?.capabilities ? buildAdminBusinessNavigation(result.capabilities.permissions) : [];
  const activeAdminPage = resolveAdminBusinessPage(window.location.pathname);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', background: '#f4f7f8', color: '#18282d' }}>
      <header style={{ padding: '18px 24px', background: '#173238', color: '#fff' }}>
        <strong>{manifest.appName}</strong>
      </header>
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
        <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', minHeight: 'calc(100vh - 57px)' }}>
          <nav aria-label="管理导航" style={{ padding: 16, background: '#fff', borderRight: '1px solid #d9e1e3' }}>
            {state.navigation.map((item) => <a key={item.id} href={item.href} style={{ display: 'block', padding: '10px 8px', color: '#173238' }}>{item.label}</a>)}
            {adminNavigation.map((item) => <a key={item.id} href={item.href} style={{ display: 'block', padding: '10px 8px', color: '#173238' }}>{item.label}</a>)}
          </nav>
          {activeAdminPage
            ? <AdminBusinessRoute page={activeAdminPage} capabilities={result!.capabilities!} />
            : window.location.pathname === '/support'
            ? <SupportWorkbenchPage capabilities={result!.capabilities!} />
            : <section style={{ padding: 24 }}><h1>运营概览</h1><p>当前页面与操作均按服务端员工权限显示。</p></section>}
        </div>
      )}
    </main>
  );
}
