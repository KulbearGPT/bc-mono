import { useEffect, useMemo, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { CustomerProfilePage } from './CustomerProfilePage.js';
import { appendCursor, buildCustomerProfileRequests, buildCustomerProfileView, type CustomerProfileModules, type PageModule } from './customer-profile.js';

export function CustomerProfileRoute(props: { userId: string; capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []); const [windowValue, setWindow] = useState<'DAYS_30' | 'DAYS_90' | 'ALL'>('DAYS_30');
  const [modules, setModules] = useState<CustomerProfileModules>(loadingModules());
  const mayRead = props.capabilities.permissions.includes('customer_profile.read');

  async function loadSummary(window = windowValue) {
    setModules((current) => ({ ...current, identity: { kind: 'LOADING' }, balance: { kind: 'LOADING' }, statistics: { kind: 'LOADING' }, preferences: { kind: 'LOADING' }, internal: { kind: 'LOADING' } }));
    const response = await client.get(buildCustomerProfileRequests(props.userId, window).summary); const body = await response.json().catch(() => null) as Envelope | null;
    if (!response.ok || !body?.data) { const state = { kind: response.status === 403 ? 'FORBIDDEN' : 'ERROR', requestId: body?.requestId ?? null } as const;
      setModules((current) => ({ ...current, identity: state, balance: state, statistics: state, preferences: state, internal: state })); return; }
    const data = body.data; const providerError = object(data.balance)?.providerError as Record<string, unknown> | null | undefined;
    setModules((current) => ({ ...current,
      identity: { kind: 'READY', data: { ...object(data.user), externalAccountDisplay: data.externalAccountDisplay } },
      balance: providerError ? { kind: 'ERROR', requestId: String(providerError.requestId ?? body.requestId ?? ''), data: object(data.balance) } : { kind: 'READY', data: object(data.balance) },
      statistics: { kind: 'READY', data: object(data.statistics) }, preferences: { kind: 'READY', data: object(data.preferences) },
      internal: { kind: 'READY', data: {}, notes: array(data.internalNotes), riskFlags: stringArray(data.riskFlags) }
    }));
  }
  async function loadPage(kind: 'orders' | 'consumptions', cursor: string | null = null, append = false) {
    setModules((current) => ({ ...current, [kind]: { ...current[kind], kind: 'LOADING' } }));
    const base = buildCustomerProfileRequests(props.userId, windowValue)[kind]; const response = await client.get(cursor ? appendCursor(base, cursor) : base);
    const body = await response.json().catch(() => null) as PageEnvelope | null;
    setModules((current) => { const prior = current[kind]; if (!response.ok || !body?.data) return { ...current, [kind]: { ...prior, kind: response.status === 403 ? 'FORBIDDEN' : 'ERROR', requestId: body?.requestId ?? null } };
      const items = append ? [...prior.items, ...(body.data.items ?? [])] : body.data.items ?? []; return { ...current, [kind]: { kind: items.length ? 'READY' : 'EMPTY', items, nextCursor: body.data.nextCursor ?? null, requestId: null } }; });
  }
  useEffect(() => { if (!mayRead) { setModules(forbiddenModules()); return; } void Promise.all([loadSummary(), loadPage('orders'), loadPage('consumptions')]); }, [props.userId, mayRead]);
  function changeWindow(value: 'DAYS_30' | 'DAYS_90' | 'ALL') { setWindow(value); void loadSummary(value); }
  const retry = (module: string) => module === 'orders' || module === 'consumptions' ? void loadPage(module) : void loadSummary();
  return <CustomerProfilePage model={buildCustomerProfileView(modules)} window={windowValue} onWindowChange={changeWindow} onRetryModule={retry}
    onNextOrders={(cursor) => void loadPage('orders', cursor, true)} onNextConsumptions={(cursor) => void loadPage('consumptions', cursor, true)} />;
}

function loadingPage(): PageModule { return { kind: 'LOADING', items: [], nextCursor: null }; }
function loadingModules(): CustomerProfileModules { return { identity: { kind: 'LOADING' }, balance: { kind: 'LOADING' }, statistics: { kind: 'LOADING' },
  orders: loadingPage(), consumptions: loadingPage(), preferences: { kind: 'LOADING' }, internal: { kind: 'LOADING' } }; }
function forbiddenModules(): CustomerProfileModules { const state = { kind: 'FORBIDDEN', requestId: null } as const; const page = { ...state, items: [], nextCursor: null }; return {
  identity: state, balance: state, statistics: state, orders: page, consumptions: page, preferences: state, internal: state }; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as Array<Record<string, unknown>> : []; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
interface Envelope { requestId?: string; data?: Record<string, unknown> } interface PageEnvelope { requestId?: string; data?: { items?: Array<Record<string, unknown>>; nextCursor?: string | null } }
