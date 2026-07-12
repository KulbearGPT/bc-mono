import { useEffect, useMemo, useRef, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { CustomerProfilePage } from './CustomerProfilePage.js';
import { appendCursor, buildCustomerProfileRequests,buildCustomerProfileUpdateRequest, buildCustomerProfileView, type CustomerProfileModules, type PageModule } from './customer-profile.js';
import { buildWalletAdjustmentRequest,buildWalletRequest,createWalletAdjustmentIdempotencyKey,createWalletIdempotencyKey,walletPaths,type WalletAdjustmentSubmission,type WalletBalance,type WalletEntry,type WalletFundingSubmission } from './customer-wallet.js';

export function CustomerProfileRoute(props: { userId: string; capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []); const [windowValue, setWindow] = useState<'DAYS_30' | 'DAYS_90' | 'ALL'>('DAYS_30');
  const [modules, setModules] = useState<CustomerProfileModules>(loadingModules());
  const [wallet,setWallet]=useState<{balance:WalletBalance;entries:WalletEntry[];busy:boolean}|null>(null);
  const [walletError,setWalletError]=useState<string|null>(null);
  const [internalNoteBusy,setInternalNoteBusy]=useState(false);const [internalNoteError,setInternalNoteError]=useState<string|null>(null);
  const [profileEditBusy,setProfileEditBusy]=useState(false);const [profileEditError,setProfileEditError]=useState<string|null>(null);
  const fundingKeys=useRef<Partial<Record<'TOP_UP'|'CASH_REFUND_DEBIT',string>>>({});
  const mayRead = props.capabilities.permissions.includes('customer_profile.read');
  const mayAppendInternalNote = props.capabilities.permissions.includes('customer_profile.note.append');
  const mayAdjustWallet = props.capabilities.permissions.includes('wallet.adjust');
  const mayEditProfile=props.capabilities.permissions.includes('customer_profile.manage');

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
  async function loadWallet(){const paths=walletPaths(props.userId);try{const [balanceResponse,entriesResponse]=await Promise.all([client.get(paths.balance),client.get(paths.entries)]);
    const balanceBody=await balanceResponse.json().catch(()=>null) as Envelope|null;const entriesBody=await entriesResponse.json().catch(()=>null) as {requestId?:string;data?:WalletEntry[]}|null;
    if(balanceResponse.ok&&entriesResponse.ok&&balanceBody?.data&&Array.isArray(entriesBody?.data)){setWalletError(null);setWallet({balance:balanceBody.data as unknown as WalletBalance,entries:entriesBody.data,busy:false});return;}setWallet(null);setWalletError(balanceBody?.requestId??entriesBody?.requestId??'—');}catch{setWallet(null);setWalletError('—');}}
  async function fund(kind:'TOP_UP'|'CASH_REFUND_DEBIT',submission:WalletFundingSubmission){if(!wallet||wallet.busy)return;setWallet({...wallet,busy:true});
    const key=fundingKeys.current[kind]??createWalletIdempotencyKey(kind,props.userId);fundingKeys.current[kind]=key;
    const request=buildWalletRequest(kind,props.userId,submission,wallet.balance.version);const response=await client.post(request.path,request.body,key);
    const body=await response.json().catch(()=>null) as {data?:{id?:string}}|null;if(!response.ok||!body?.data?.id){setWallet(current=>current?{...current,busy:false}:current);return;}
    if(submission.receipt){const form=new FormData();form.append('evidenceType',kind);form.append('evidenceId',body.data.id);form.append('file',submission.receipt);
      const upload=await client.upload(walletPaths(props.userId).receipt,form,`${key}:receipt`);if(!upload.ok){setWallet(current=>current?{...current,busy:false}:current);return;}}
    delete fundingKeys.current[kind];await Promise.all([loadSummary(),loadWallet()]);}
  async function adjustWallet(submission:WalletAdjustmentSubmission){if(!wallet||wallet.busy)return;setWallet({...wallet,busy:true});
    const request=buildWalletAdjustmentRequest(props.userId,submission,wallet.balance.version);const response=await client.post(request.path,request.body,createWalletAdjustmentIdempotencyKey(props.userId));
    if(!response.ok){setWallet(current=>current?{...current,busy:false}:current);return;}await Promise.all([loadSummary(),loadWallet()]);}
  async function loadPage(kind: 'orders' | 'consumptions', cursor: string | null = null, append = false) {
    setModules((current) => ({ ...current, [kind]: { ...current[kind], kind: 'LOADING' } }));
    const base = buildCustomerProfileRequests(props.userId, windowValue)[kind]; const response = await client.get(cursor ? appendCursor(base, cursor) : base);
    const body = await response.json().catch(() => null) as PageEnvelope | null;
    setModules((current) => { const prior = current[kind]; if (!response.ok || !body?.data) return { ...current, [kind]: { ...prior, kind: response.status === 403 ? 'FORBIDDEN' : 'ERROR', requestId: body?.requestId ?? null } };
      const items = append ? [...prior.items, ...(body.data.items ?? [])] : body.data.items ?? []; return { ...current, [kind]: { kind: items.length ? 'READY' : 'EMPTY', items, nextCursor: body.data.nextCursor ?? null, requestId: null } }; });
  }
  async function appendInternalNote(body:string){if(internalNoteBusy)return false;setInternalNoteBusy(true);setInternalNoteError(null);
    try{const response=await client.post(`/api/v1/admin/users/${encodeURIComponent(props.userId)}/profile-notes`,{body},`dashboard:profile-note:${crypto.randomUUID()}`);
      const payload=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;
      if(!response.ok){setInternalNoteError(`${payload?.error?.message??'内部备注未能追加。'}${payload?.requestId?` request_id: ${payload.requestId}`:''}`);return false;}
      await loadSummary();return true;
    }catch{setInternalNoteError('内部备注未能追加，请稍后重试。');return false;}finally{setInternalNoteBusy(false);}}
  async function updateProfile(value:{displayName:string;expectedVersion:number;reasonCode:string;note:string}){if(profileEditBusy)return false;setProfileEditBusy(true);setProfileEditError(null);try{const request=buildCustomerProfileUpdateRequest(props.userId,value);const response=await client.patch(request.path,request.body,`dashboard:profile-edit:${crypto.randomUUID()}`);const payload=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;if(!response.ok){setProfileEditError(`${payload?.error?.message??'客户名称未能保存。'}${payload?.requestId?` request_id: ${payload.requestId}`:''}`);return false;}await loadSummary();return true;}catch{setProfileEditError('客户名称未能保存，请稍后重试。');return false;}finally{setProfileEditBusy(false);}}
  useEffect(() => { if (!mayRead) { setModules(forbiddenModules()); return; } void Promise.all([loadSummary(), loadPage('orders'), loadPage('consumptions'),loadWallet()]); }, [props.userId, mayRead]);
  function changeWindow(value: 'DAYS_30' | 'DAYS_90' | 'ALL') { setWindow(value); void loadSummary(value); }
  const retry = (module: string) => module === 'orders' || module === 'consumptions' ? void loadPage(module) : void loadSummary();
  return <CustomerProfilePage model={buildCustomerProfileView(modules)} window={windowValue} onWindowChange={changeWindow} onRetryModule={retry}
    onNextOrders={(cursor) => void loadPage('orders', cursor, true)} onNextConsumptions={(cursor) => void loadPage('consumptions', cursor, true)} wallet={wallet??undefined} walletError={walletError}
    canAppendInternalNote={mayAppendInternalNote} internalNoteBusy={internalNoteBusy} internalNoteError={internalNoteError} onAppendInternalNote={appendInternalNote}
    canEditProfile={mayEditProfile} profileEditBusy={profileEditBusy} profileEditError={profileEditError} onUpdateProfile={updateProfile}
    onTopUp={(value)=>fund('TOP_UP',value)} onExternalRefund={(value)=>fund('CASH_REFUND_DEBIT',value)} canAdjustWallet={mayAdjustWallet} onWalletAdjustment={adjustWallet} />;
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
