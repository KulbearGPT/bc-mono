import { useEffect, useMemo, useRef, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { CustomerProfilePage } from './CustomerProfilePage.js';
import { appendCursor, buildCustomerProfileRequests, buildCustomerProfileView, type CustomerProfileModules, type PageModule } from './customer-profile.js';
import { buildWalletRequest,createWalletIdempotencyKey,walletPaths,type WalletBalance,type WalletEntry,type WalletFundingSubmission } from './customer-wallet.js';

export function CustomerProfileRoute(props: { userId: string; capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []); const [windowValue, setWindow] = useState<'DAYS_30' | 'DAYS_90' | 'ALL'>('DAYS_30');
  const [modules, setModules] = useState<CustomerProfileModules>(loadingModules());
  const [wallet,setWallet]=useState<{balance:WalletBalance;entries:WalletEntry[];busy:boolean}|null>(null);
  const fundingKeys=useRef<Partial<Record<'TOP_UP'|'EXTERNAL_REFUND_DEBIT',string>>>({});
  const mayRead = props.capabilities.permissions.includes('customer_profile.read');

  async function loadSummary(window = windowValue) {
    setModules((current) => ({ ...current, identity: { kind: 'LOADING' }, balance: { kind: 'LOADING' }, statistics: { kind: 'LOADING' }, preferences: { kind: 'LOADING' }, internal: { kind: 'LOADING' } }));
    const response = await client.get(buildCustomerProfileRequests(props.userId, window).summary); const body = await response.json().catch(() => null) as Envelope | null;
    if (!response.ok || !body?.data) { const state = { kind: response.status === 403 ? 'FORBIDDEN' : 'ERROR', requestId: body?.requestId ?? null } as const;
      setModules((current) => ({ ...current, identity: state, balance: state, statistics: state, preferences: state, internal: state })); return; }
    const data = body.data;
    setModules((current) => ({ ...current,
      identity: { kind: 'READY', data: object(data.user) },
      balance: { kind: 'READY', data: object(data.balance) },
      statistics: { kind: 'READY', data: object(data.statistics) }, preferences: { kind: 'READY', data: object(data.preferences) },
      internal: { kind: 'READY', data: {}, notes: array(data.internalNotes), riskFlags: stringArray(data.riskFlags) }
    }));
  }
  async function loadWallet(){const paths=walletPaths(props.userId);const [balanceResponse,entriesResponse]=await Promise.all([client.get(paths.balance),client.get(paths.entries)]);
    const balanceBody=await balanceResponse.json().catch(()=>null) as Envelope|null;const entriesBody=await entriesResponse.json().catch(()=>null) as {data?:WalletEntry[]}|null;
    if(balanceResponse.ok&&entriesResponse.ok&&balanceBody?.data&&Array.isArray(entriesBody?.data))setWallet({balance:balanceBody.data as unknown as WalletBalance,entries:entriesBody.data,busy:false});}
  async function fund(kind:'TOP_UP'|'EXTERNAL_REFUND_DEBIT',submission:WalletFundingSubmission){if(!wallet||wallet.busy)return;setWallet({...wallet,busy:true});
    const key=fundingKeys.current[kind]??createWalletIdempotencyKey(kind,props.userId);fundingKeys.current[kind]=key;
    const request=buildWalletRequest(kind,props.userId,submission,wallet.balance.version);const response=await client.post(request.path,request.body,key);
    const body=await response.json().catch(()=>null) as {data?:{id?:string}}|null;if(!response.ok||!body?.data?.id){setWallet(current=>current?{...current,busy:false}:current);return;}
    if(submission.receipt){const form=new FormData();form.append('evidenceType',kind);form.append('evidenceId',body.data.id);form.append('file',submission.receipt);
      const upload=await client.upload(walletPaths(props.userId).receipt,form,`${key}:receipt`);if(!upload.ok){setWallet(current=>current?{...current,busy:false}:current);return;}}
    delete fundingKeys.current[kind];await Promise.all([loadSummary(),loadWallet()]);}
  async function loadPage(kind: 'orders' | 'consumptions', cursor: string | null = null, append = false) {
    setModules((current) => ({ ...current, [kind]: { ...current[kind], kind: 'LOADING' } }));
    const base = buildCustomerProfileRequests(props.userId, windowValue)[kind]; const response = await client.get(cursor ? appendCursor(base, cursor) : base);
    const body = await response.json().catch(() => null) as PageEnvelope | null;
    setModules((current) => { const prior = current[kind]; if (!response.ok || !body?.data) return { ...current, [kind]: { ...prior, kind: response.status === 403 ? 'FORBIDDEN' : 'ERROR', requestId: body?.requestId ?? null } };
      const items = append ? [...prior.items, ...(body.data.items ?? [])] : body.data.items ?? []; return { ...current, [kind]: { kind: items.length ? 'READY' : 'EMPTY', items, nextCursor: body.data.nextCursor ?? null, requestId: null } }; });
  }
  useEffect(() => { if (!mayRead) { setModules(forbiddenModules()); return; } void Promise.all([loadSummary(), loadPage('orders'), loadPage('consumptions'),loadWallet()]); }, [props.userId, mayRead]);
  function changeWindow(value: 'DAYS_30' | 'DAYS_90' | 'ALL') { setWindow(value); void loadSummary(value); }
  const retry = (module: string) => module === 'orders' || module === 'consumptions' ? void loadPage(module) : void loadSummary();
  return <CustomerProfilePage model={buildCustomerProfileView(modules)} window={windowValue} onWindowChange={changeWindow} onRetryModule={retry}
    onNextOrders={(cursor) => void loadPage('orders', cursor, true)} onNextConsumptions={(cursor) => void loadPage('consumptions', cursor, true)} wallet={wallet??undefined}
    onTopUp={(value)=>fund('TOP_UP',value)} onExternalRefund={(value)=>fund('EXTERNAL_REFUND_DEBIT',value)} />;
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
