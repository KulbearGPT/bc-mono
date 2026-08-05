import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Activity, BadgeCheck, BookOpenText, BriefcaseBusiness, ChartNoAxesCombined, Cat, ChevronRight,
  CircleDollarSign, Cpu, Gift, Headphones, LayoutDashboard, LockKeyhole, LogOut, PackageSearch,
  ReceiptText, Search, Settings2, ShieldCheck, Sparkles, Tags, UserRoundCog, UsersRound, WalletCards,
  type LucideIcon
} from 'lucide-react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { DashboardMetricSummaryLoader } from './SupportWorkbenchPage.js';

export interface DashboardNavItem { id: string; label: string; href: string }

const dashboardNavigationGroups = [
  { id: 'command', label: '指挥中心' },
  { id: 'business', label: '业务运营' },
  { id: 'finance', label: '财务控制' },
  { id: 'governance', label: '系统治理' }
] as const;

type DashboardTheme = 'tech' | 'cute';
const dashboardThemeStorageKey = 'blackcat-dashboard-theme';

interface DashboardChromeProps {
  appName: string; capabilities: DashboardCapabilities; navigation: DashboardNavItem[]; currentPath: string;
  banner?: string | null; contentBusy?: boolean; onNavigate?: (href: string) => void; children: ReactNode;
}

const navigationIcons: Array<[RegExp, LucideIcon]> = [
  [/^\/$/u, LayoutDashboard], [/support/u, Headphones], [/orders/u, ReceiptText], [/users/u, UsersRound],
  [/players/u, BadgeCheck], [/catalog/u, PackageSearch], [/gift/u, Gift], [/commission/u, ChartNoAxesCombined],
  [/earning/u, CircleDollarSign], [/settlement/u, WalletCards], [/reports/u, BookOpenText], [/security/u, ShieldCheck],
  [/operations/u, Activity], [/business-tags/u, Tags], [/bot-config/u, Settings2], [/access/u, UserRoundCog]
];

export function DashboardChrome(props: DashboardChromeProps) {
  const [theme, setTheme] = useState<DashboardTheme>(readDashboardTheme);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const activeItem = props.navigation.find((item) => isActivePath(item.href, props.currentPath));
  const groupedNavigation = dashboardNavigationGroups
    .map((group) => ({ ...group, items: props.navigation.filter((item) => navigationGroupForPath(item.href) === group.id) }))
    .filter((group) => group.items.length > 0);
  const environment = props.capabilities.businessEnvironment === 'SANDBOX'
    ? '非生产环境'
    : props.capabilities.businessEnvironment === 'PRODUCTION' ? '生产环境' : '环境待确认';
  const environmentClass = props.capabilities.businessEnvironment === 'SANDBOX'
    ? 'is-sandbox'
    : props.capabilities.businessEnvironment === 'PRODUCTION' ? 'is-production' : 'is-unknown';
  const routeClick = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!props.onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    props.onNavigate(href);
  };
  const searchScopes = [
    props.capabilities.permissions.includes('order.read') ? { id: 'orders', label: '订单', path: '/admin/orders' } : null,
    props.capabilities.permissions.includes('user.read') ? { id: 'users', label: '用户', path: '/admin/users' } : null
  ].filter((scope): scope is { id: string; label: string; path: string } => scope !== null);

  function submitGlobalSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const query = String(fields.get('query') ?? '').trim();
    const scope = searchScopes.find((candidate) => candidate.id === fields.get('scope'));
    if (!query || !scope) return;
    window.location.assign(`${scope.path}?query=${encodeURIComponent(query)}`);
  }

  async function logout() {
    setLogoutError(null);
    try {
      const response = await createDashboardApiClient().post('/api/v1/auth/logout', {});
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setLogoutError(body?.error?.message ?? '退出失败，请稍后重试。');
        return;
      }
      window.location.assign('/api/v1/auth/discord');
    } catch {
      setLogoutError('退出失败，请检查网络后重试。');
    }
  }

  useEffect(() => {
    try {
      window.localStorage.setItem(dashboardThemeStorageKey, theme);
    } catch {
      // The theme remains usable when storage is disabled by the browser.
    }
  }, [theme]);

  return (
    <div className="dashboard-app" data-theme={theme}>
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
          <div className="dashboard-nav__items">
            {groupedNavigation.map((group) => (
              <section className="dashboard-nav__group" aria-labelledby={`nav-group-${group.id}`} key={group.id}>
                <h2 id={`nav-group-${group.id}`}>{group.label}</h2>
                <div>
                  {group.items.map((item) => {
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
              </section>
            ))}
          </div>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-footer__icon" aria-hidden="true"><LockKeyhole size={18} /></div>
          <span><small>权限状态已同步</small><strong>{formatLevel(props.capabilities.level)}</strong></span>
        </div>
      </aside>
      <div className="dashboard-workspace">
        <header className="dashboard-topbar">
          <div>
            <span className="dashboard-topbar__eyebrow">BlackCat / 运营工作区</span>
            <strong>{activeItem?.label ?? '运营概览'}</strong>
          </div>
          {searchScopes.length > 0 && <form className="global-search" aria-label="全局业务检索" onSubmit={submitGlobalSearch}>
            <label><span className="sr-only">检索范围</span><select name="scope" aria-label="检索范围">{searchScopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.label}</option>)}</select></label>
            <label><span className="sr-only">检索词</span><input name="query" type="search" required maxLength={100} aria-label="检索词" placeholder="订单号、Discord ID 或用户 ID" /></label>
            <button type="submit" aria-label="执行检索"><Search size={17} aria-hidden="true" /></button>
          </form>}
          <div className="dashboard-topbar__meta">
            <div className="status-rail" aria-label="当前系统状态">
              <span className="status-rail__item is-online"><Activity size={13} aria-hidden="true" /> 权限已载入</span>
              <span className={`status-rail__item ${environmentClass}`}>{environment}</span>
              <span className="status-rail__item">{props.capabilities.displayRole ?? 'STAFF'} / {formatLevel(props.capabilities.level)}</span>
            </div>
            <button
              className="theme-switcher"
              type="button"
              aria-label={theme === 'cute' ? '切换到科技主题' : '切换到可爱主题'}
              aria-pressed={theme === 'cute'}
              title={theme === 'cute' ? '切换到科技主题' : '切换到可爱主题'}
              onClick={() => setTheme((current) => current === 'cute' ? 'tech' : 'cute')}
            >
              {theme === 'cute' ? <Cpu size={19} aria-hidden="true" /> : <Cat size={20} aria-hidden="true" />}
            </button>
            <details className="account-menu">
              <summary aria-label="账户菜单"><span className="level-avatar" aria-hidden="true">{levelInitial(props.capabilities.level)}</span></summary>
              <div className="account-menu__panel">
                <strong>{props.capabilities.displayRole ?? 'STAFF'} · {formatLevel(props.capabilities.level)}</strong>
                <small>{props.capabilities.staffId ? `员工编号 ${props.capabilities.staffId}` : '员工身份已验证'}</small>
                {props.capabilities.permissions.includes('mfa.manage_self') && <a href="/security" onClick={routeClick('/security')}>账户安全</a>}
                <button type="button" onClick={() => void logout()}><LogOut size={15} aria-hidden="true" />退出登录</button>
                {logoutError && <span role="alert">{logoutError}</span>}
              </div>
            </details>
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
  navigation: DashboardNavItem[];
}) {
  const nextWorkspace = props.navigation.find((item) => item.href !== '/');

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

      <DashboardMetricSummaryLoader />

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

export function DashboardGate(props: { kind: 'LOADING' | 'SIGNED_OUT' | 'FORBIDDEN' | 'ERROR'; appName: string; authReason?: string | null }) {
  const content = {
    LOADING: { icon: Activity, eyebrow: 'SECURE SESSION', title: '正在建立安全工作区', copy: '正在读取员工权限与可用工作区。' },
    SIGNED_OUT: { icon: LockKeyhole, eyebrow: 'STAFF ACCESS', title: '登录客服管理后台', copy: props.authReason === 'SESSION_REVOKED' ? '权限已变化，请重新登录。新的内部有效级别会在登录后载入。' : '使用 Discord 完成身份验证后进入 BlackCat 运营工作区。' },
    FORBIDDEN: { icon: ShieldCheck, eyebrow: 'ACCESS LIMITED', title: '当前账户无权访问', copy: '员工账户没有此页面所需权限，请联系管理员确认内部有效级别。' },
    ERROR: { icon: Activity, eyebrow: 'CONNECTION ERROR', title: '暂时无法载入', copy: '请稍后重试，或向管理员提供请求编号以便排查。' }
  }[props.kind];
  const Icon = content.icon;

  return (
    <main className="dashboard-gate" aria-labelledby="gate-title">
      <div className="dashboard-gate__ambient" aria-hidden="true" />
      <section className="dashboard-gate__card" role={props.kind === 'ERROR' ? 'alert' : undefined} aria-live={props.kind === 'LOADING' ? 'polite' : undefined}>
        <div className="brand-mark brand-mark--large" aria-hidden="true"><Icon size={28} /></div>
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

export function FeatureUnavailable() {
  return <section className="dashboard-page empty-page"><div className="empty-page__icon" aria-hidden="true"><Settings2 size={25} /></div><span className="page-eyebrow">FEATURE ACCESS</span><h1>此功能当前不可用</h1><p>此功能未在当前工作区启用，请联系管理员确认可用范围。</p></section>;
}

export function RouteForbidden() {
  return <section className="dashboard-page empty-page"><div className="empty-page__icon" aria-hidden="true"><ShieldCheck size={25} /></div><span className="page-eyebrow">ACCESS LIMITED</span><h1>无权访问此页面</h1><p>当前内部有效权限不包含此工作区。Discord Role 不会替代内部授权。</p></section>;
}

export function RouteNotFound() {
  return <section className="dashboard-page empty-page"><div className="empty-page__icon" aria-hidden="true"><PackageSearch size={25} /></div><span className="page-eyebrow">404 / NOT FOUND</span><h1>页面不存在</h1><p>请从左侧导航进入可用工作区。</p></section>;
}

function iconForPath(path: string): LucideIcon {
  return navigationIcons.find(([pattern]) => pattern.test(path))?.[1] ?? BriefcaseBusiness;
}

function navigationGroupForPath(path: string): typeof dashboardNavigationGroups[number]['id'] {
  if (path === '/' || path.startsWith('/support')) return 'command';
  if (/settlement|reports|commission|earning/u.test(path)) return 'finance';
  if (/security|operations|access/u.test(path)) return 'governance';
  return 'business';
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

function readDashboardTheme(): DashboardTheme {
  if (typeof window === 'undefined') return 'tech';
  try {
    return window.localStorage.getItem(dashboardThemeStorageKey) === 'cute' ? 'cute' : 'tech';
  } catch {
    return 'tech';
  }
}
