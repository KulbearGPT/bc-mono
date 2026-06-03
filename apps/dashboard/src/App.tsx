import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  BadgeCheck,
  BookOpenText,
  BriefcaseBusiness,
  ChartNoAxesCombined,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  FileClock,
  Gift,
  Headphones,
  LayoutDashboard,
  LockKeyhole,
  PackageSearch,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Tags,
  UserRoundCog,
  UsersRound,
  WalletCards
} from 'lucide-react';
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
import { AccessManagementRoute } from './AccessManagementRoute.js';
import { BusinessTagsRoute } from './BusinessTagsRoute.js';
import { buildSettlementNavigation } from './settlements.js';
import {
  getSandboxBanner,
  hasFeature,
  resolveDashboardBusinessEnvironment,
  type PilotDashboardCapabilities
} from './pilot-features.js';

interface DashboardNavItem {
  id: string;
  label: string;
  href: string;
}

interface DashboardChromeProps {
  appName: string;
  capabilities: DashboardCapabilities;
  navigation: DashboardNavItem[];
  currentPath: string;
  banner?: string | null;
  contentBusy?: boolean;
  onNavigate?: (href: string) => void;
  children: ReactNode;
}

const navigationIcons: Array<[RegExp, LucideIcon]> = [
  [/^\/$/u, LayoutDashboard],
  [/support/u, Headphones],
  [/orders/u, ReceiptText],
  [/users/u, UsersRound],
  [/players/u, BadgeCheck],
  [/catalog/u, PackageSearch],
  [/gift/u, Gift],
  [/commission/u, ChartNoAxesCombined],
  [/earning/u, CircleDollarSign],
  [/settlement/u, WalletCards],
  [/reports/u, BookOpenText],
  [/security/u, ShieldCheck],
  [/operations/u, Activity],
  [/business-tags/u, Tags],
  [/access/u, UserRoundCog]
];

export function App(props: { publicBusinessEnvironment?: 'SANDBOX' | 'PRODUCTION' } = {}) {
  const manifest = buildDashboardManifest();
  const [result, setResult] = useState<{ status: number; capabilities?: DashboardCapabilities } | null>(null);
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);
  const [contentBusy, setContentBusy] = useState(false);

  useEffect(() => {
    void createDashboardApiClient().get('/api/v1/admin/me/capabilities').then(async (response) => {
      const body = response.ok ? await response.json() as { data: DashboardCapabilities } : null;
      setResult({ status: response.status, capabilities: body?.data });
    }).catch(() => setResult({ status: 500 }));
  }, []);

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
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
    return <DashboardGate kind="SIGNED_OUT" appName={manifest.appName} />;
  }
  if (state.kind === 'FORBIDDEN') {
    return <DashboardGate kind="FORBIDDEN" appName={manifest.appName} />;
  }
  if (state.kind === 'ERROR') {
    return <DashboardGate kind="ERROR" appName={manifest.appName} />;
  }

  const navigation = [...state.navigation, ...adminNavigation, ...m6Navigation]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.href === item.href) === index);

  const content = profileMatch
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
    : <DashboardOverview capabilities={result!.capabilities!} navigation={navigation} />;

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
      {content}
    </DashboardChrome>
  );
}

export function DashboardChrome(props: DashboardChromeProps) {
  const activeItem = props.navigation.find((item) => isActivePath(item.href, props.currentPath));
  const environment = props.capabilities.businessEnvironment === 'SANDBOX'
    ? 'Sandbox 环境'
    : props.capabilities.businessEnvironment === 'PRODUCTION' ? '生产环境' : '环境待确认';
  const environmentClass = props.capabilities.businessEnvironment === 'SANDBOX'
    ? 'is-sandbox'
    : props.capabilities.businessEnvironment === 'PRODUCTION' ? 'is-production' : 'is-unknown';
  const routeClick = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!props.onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onNavigate(href);
  };

  return (
    <div className="dashboard-app">
      <a className="skip-link" href="#dashboard-main">跳到主要内容</a>
      <aside className="dashboard-sidebar" aria-label={props.appName}>
        <a className="brand-lockup" href="/" aria-label="BlackCat 运营台首页" onClick={routeClick('/')}>
          <span className="brand-mark" aria-hidden="true"><Sparkles size={21} strokeWidth={2.2} /></span>
          <span>
            <strong>BLACKCAT</strong>
            <small>陪玩业务运营中枢</small>
          </span>
        </a>
        <div className={`environment-card ${environmentClass}`}>
          <span className="environment-dot" aria-hidden="true" />
          <span><small>当前工作空间</small><strong>{environment}</strong></span>
        </div>
        <nav className="dashboard-nav" aria-label="管理导航">
          <span className="dashboard-nav__label">工作区</span>
          <div className="dashboard-nav__items">
            {props.navigation.map((item) => {
              const Icon = iconForPath(item.href);
              const active = isActivePath(item.href, props.currentPath);
              return (
                <a key={`${item.id}:${item.href}`} href={item.href} aria-current={active ? 'page' : undefined} onClick={routeClick(item.href)}>
                  <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
                  <span>{item.label}</span>
                  {active && <span className="nav-active-dot" aria-hidden="true" />}
                </a>
              );
            })}
          </div>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-footer__icon" aria-hidden="true"><LockKeyhole size={18} /></div>
          <span><small>服务端权限已同步</small><strong>{formatLevel(props.capabilities.level)}</strong></span>
        </div>
      </aside>
      <div className="dashboard-workspace">
        <header className="dashboard-topbar">
          <div>
            <span className="dashboard-topbar__eyebrow">BlackCat / 运营工作区</span>
            <strong>{activeItem?.label ?? '运营概览'}</strong>
          </div>
          <div className="dashboard-topbar__meta">
            <span className={`topbar-environment ${environmentClass}`}>{environment}</span>
            <span className="sync-status"><span aria-hidden="true" /> 权限已同步</span>
            {props.capabilities.displayRole && <span className="display-role">{props.capabilities.displayRole}</span>}
            <span className="level-avatar" aria-label={`当前权限 ${formatLevel(props.capabilities.level)}`}>
              {levelInitial(props.capabilities.level)}
            </span>
          </div>
        </header>
        {props.banner && <div className="sandbox-banner" role="status">{props.banner}</div>}
        <main id="dashboard-main" className="dashboard-content" tabIndex={-1} aria-busy={props.contentBusy}>
          {props.contentBusy && <div className="content-route-loader" role="status"><Activity size={20} aria-hidden="true" /><span>正在切换工作区…</span></div>}
          {props.children}
        </main>
      </div>
    </div>
  );
}

export function DashboardOverview(props: {
  capabilities: DashboardCapabilities;
  navigation: DashboardNavItem[];
}) {
  const nextWorkspace = props.navigation.find((item) => item.href !== '/');
  const enabledFeatureCount = props.capabilities.enabledFeatures?.length ?? 0;

  return (
    <section className="dashboard-page dashboard-overview" aria-labelledby="overview-title">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">OPERATIONS DESK</span>
          <h1 id="overview-title">运营控制台</h1>
          <p>从一个可信入口处理客服任务、业务对象和资金相关流程。</p>
        </div>
        {nextWorkspace && <a className="button button-primary" href={nextWorkspace.href}>进入工作区 <ChevronRight size={17} aria-hidden="true" /></a>}
      </header>

      <div className="overview-hero">
        <div className="overview-hero__glow" aria-hidden="true" />
        <div className="overview-hero__copy">
          <span className="hero-kicker"><ShieldCheck size={16} aria-hidden="true" /> 服务端能力已就绪</span>
          <h2>今晚的运营节奏，<br /><span>由一套可信权限掌控。</span></h2>
          <p>页面与操作均由统一业务 API 返回的 capabilities 裁剪。当前视图不在浏览器中推断角色、金额或对象归属。</p>
          <div className="hero-tags" aria-label="当前会话特征">
            <span>{formatLevel(props.capabilities.level)}</span>
            <span>{props.capabilities.businessEnvironment === 'SANDBOX' ? 'Sandbox' : props.capabilities.businessEnvironment === 'PRODUCTION' ? 'Production' : 'Environment pending'}</span>
            <span>API scoped</span>
          </div>
        </div>
        <div className="overview-session-card" aria-label="当前会话快照">
          <span className="overview-session-card__label">SESSION SNAPSHOT</span>
          <dl>
            <div><dt>可用工作区</dt><dd>{props.navigation.length}</dd></div>
            <div><dt>权限能力</dt><dd>{props.capabilities.permissions.length}</dd></div>
            <div><dt>Pilot 功能</dt><dd>{enabledFeatureCount}</dd></div>
          </dl>
          <div className="session-secure"><BadgeCheck size={17} aria-hidden="true" /> 权限版本由服务端校验</div>
        </div>
      </div>

      <section className="overview-section" aria-labelledby="workspace-links-title">
        <div className="section-heading">
          <div><span className="page-eyebrow">QUICK ACCESS</span><h2 id="workspace-links-title">快速进入工作区</h2></div>
          <p>仅显示当前员工实际具备查看权限的入口。</p>
        </div>
        <div className="workspace-grid">
          {props.navigation.map((item, index) => {
            const Icon = iconForPath(item.href);
            return (
              <a className="workspace-card" href={item.href} key={`${item.id}:${item.href}`}>
                <span className="workspace-card__number">{String(index + 1).padStart(2, '0')}</span>
                <span className="workspace-card__icon"><Icon size={21} aria-hidden="true" /></span>
                <strong>{item.label}</strong>
                <span>打开工作区 <ChevronRight size={15} aria-hidden="true" /></span>
              </a>
            );
          })}
        </div>
      </section>
    </section>
  );
}

function DashboardGate(props: { kind: 'LOADING' | 'SIGNED_OUT' | 'FORBIDDEN' | 'ERROR'; appName: string }) {
  const content = {
    LOADING: { icon: Activity, eyebrow: 'SECURE SESSION', title: '正在建立安全工作区', copy: '正在读取服务端员工权限与可用能力。' },
    SIGNED_OUT: { icon: LockKeyhole, eyebrow: 'STAFF ACCESS', title: '登录客服管理后台', copy: '使用 Discord 完成身份验证后进入 BlackCat 运营工作区。' },
    FORBIDDEN: { icon: ShieldCheck, eyebrow: 'ACCESS LIMITED', title: '当前账户无权访问', copy: '员工账户没有此页面所需权限，请联系管理员确认内部有效级别。' },
    ERROR: { icon: Activity, eyebrow: 'CONNECTION ERROR', title: '暂时无法载入', copy: '请稍后重试，或向管理员提供请求编号以便排查。' }
  }[props.kind];
  const Icon = content.icon;

  return (
    <main className="dashboard-gate" aria-labelledby="gate-title">
      <div className="dashboard-gate__ambient" aria-hidden="true" />
      <section className="dashboard-gate__card" role={props.kind === 'ERROR' ? 'alert' : undefined} aria-live={props.kind === 'LOADING' ? 'polite' : undefined}>
        <div className="brand-mark brand-mark--large" aria-hidden="true"><Sparkles size={28} /></div>
        <span className="page-eyebrow">{content.eyebrow}</span>
        <h1 id="gate-title">{content.title}</h1>
        <p>{content.copy}</p>
        {props.kind === 'LOADING' && <div className="loading-track" aria-hidden="true"><span /></div>}
        {props.kind === 'SIGNED_OUT' && <a className="button button-primary" href="/api/v1/auth/discord">使用 Discord 登录 <ChevronRight size={17} aria-hidden="true" /></a>}
        {props.kind === 'ERROR' && <button type="button" onClick={() => window.location.reload()}>重新载入</button>}
        <small>{props.appName}</small>
      </section>
    </main>
  );
}

function FeatureUnavailable() {
  return <section className="dashboard-page empty-page"><div className="empty-page__icon" aria-hidden="true"><Settings2 size={25} /></div><span className="page-eyebrow">PILOT FEATURE</span><h1>功能暂未开放</h1><p>当前 Pilot 阶段未开放此功能。</p></section>;
}

function iconForPath(path: string): LucideIcon {
  return navigationIcons.find(([pattern]) => pattern.test(path))?.[1] ?? BriefcaseBusiness;
}

function isActivePath(href: string, currentPath: string) {
  if (href === '/') return currentPath === '/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

function formatLevel(level?: string) {
  const labels: Record<string, string> = {
    L1_SUPPORT: 'L1 客服',
    L2_SUPERVISOR: 'L2 主管',
    L3_OPERATIONS: 'L3 运营',
    L4_ADMIN_OWNER: 'L4 所有者'
  };
  return level ? labels[level] ?? level : '权限待同步';
}

function levelInitial(level?: string) {
  return level?.match(/^L[1-4]/u)?.[0] ?? 'BC';
}
