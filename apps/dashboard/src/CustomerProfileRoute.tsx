import { useEffect, useMemo, useRef, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { CustomerProfilePage } from './CustomerProfilePage.js';
import { appendCursor, buildCustomerProfileRequests,buildCustomerProfileUpdateRequest, buildCustomerProfileView, type CustomerProfileModules, type PageModule } from './customer-profile.js';
import { buildWalletAdjustmentRequest,buildWalletRequest,createWalletAdjustmentIdempotencyKey,createWalletIdempotencyKey,parseWalletBalance,parseWalletEntryPage,walletPaths,type WalletAdjustmentSubmission,type WalletBalance,type WalletEntry,type WalletFundingSubmission } from './customer-wallet.js';
import { LatestRequestGate,RetriableWriteKeys,runBusyTask } from './request-state.js';

export function CustomerProfileRoute(props: { userId: string; capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []); const [windowValue, setWindow] = useState<'DAYS_30' | 'DAYS_90' | 'ALL'>('DAYS_30');
  const [modules, setModules] = useState<CustomerProfileModules>(loadingModules());
  const [wallet,setWallet]=useState<{userId:string;balance:WalletBalance;entries:WalletEntry[];nextCursor:string|null;busy:boolean}|null>(null);
  const [walletError,setWalletError]=useState<string|null>(null);
  const [internalNoteBusy,setInternalNoteBusy]=useState(false);const [internalNoteError,setInternalNoteError]=useState<string|null>(null);
  const [profileEditBusy,setProfileEditBusy]=useState(false);const [profileEditError,setProfileEditError]=useState<string|null>(null);
  const fundingKeys=useRef<Partial<Record<'TOP_UP'|'CASH_REFUND_DEBIT',string>>>({});
  const activeUserId=useRef(props.userId);activeUserId.current=props.userId;
  const summaryRequests=useRef(new LatestRequestGate());
  const walletRequests=useRef(new LatestRequestGate());
  const pageRequests=useRef({orders:new LatestRequestGate(),consumptions:new LatestRequestGate()});
  const writeKeys=useRef(new RetriableWriteKeys());
  const mayRead = props.capabilities.permissions.includes('customer_profile.read');
  const mayAppendInternalNote = props.capabilities.permissions.includes('customer_profile.note.append');
  const mayTopUp = props.capabilities.permissions.includes('wallet.top_up');
  const mayExternalRefund = props.capabilities.permissions.includes('wallet.external_refund');
  const mayAdjustWallet = props.capabilities.permissions.includes('wallet.adjust');
  const mayEditProfile=props.capabilities.permissions.includes('customer_profile.manage');

  async function loadSummary(window = windowValue) {
    const userId=props.userId;const request=summaryRequests.current.begin();const isCurrent=()=>request.isCurrent()&&activeUserId.current===userId;
    setModules((current) => ({ ...current, identity: { kind: 'LOADING' }, balance: { kind: 'LOADING' }, statistics: { kind: 'LOADING' }, preferences: { kind: 'LOADING' }, internal: { kind: 'LOADING' } }));
    try{const response = await client.get(buildCustomerProfileRequests(userId, window).summary); const body = await response.json().catch(() => null) as Envelope | null;if(!isCurrent())return;
      if (!response.ok || !body?.data) { const state = { kind: response.status === 403 ? 'FORBIDDEN' : 'ERROR', requestId: body?.requestId ?? null } as const;
        setModules((current) => ({ ...current, identity: state, balance: state, statistics: state, preferences: state, internal: state })); return; }
      const data = body.data;setModules((current) => ({ ...current,
        identity: { kind: 'READY', data: object(data.user) },balance: { kind: 'READY', data: object(data.balance) },
        statistics: { kind: 'READY', data: object(data.statistics) }, preferences: { kind: 'READY', data: object(data.preferences) },
        internal: { kind: 'READY', data: {}, notes: array(data.internalNotes), riskFlags: stringArray(data.riskFlags) }
      }));
    }catch{if(!isCurrent())return;const state={kind:'ERROR',requestId:null} as const;setModules((current)=>({...current,identity:state,balance:state,statistics:state,preferences:state,internal:state}));}
  }
  async function loadWallet(cursor:string|null=null,append=false){const userId=props.userId;const request=walletRequests.current.begin();const isCurrent=()=>request.isCurrent()&&activeUserId.current===userId;const paths=walletPaths(userId);try{const [balanceResponse,entriesResponse]=await Promise.all([client.get(paths.balance),client.get(cursor?appendCursor(paths.entries,cursor):paths.entries)]);
    const balanceBody=await balanceResponse.json().catch(()=>null) as Envelope|null;const entriesBody=await entriesResponse.json().catch(()=>null) as {requestId?:string;data?:unknown}|null;if(!isCurrent())return;
    const balance=parseWalletBalance(balanceBody?.data);const page=parseWalletEntryPage(entriesBody?.data);
    if(balanceResponse.ok&&entriesResponse.ok&&balance&&page){setWalletError(null);setWallet(current=>({userId,balance,entries:append&&current?.userId===userId?[...current.entries,...page.items]:page.items,nextCursor:page.nextCursor,busy:false}));return;}setWallet(null);setWalletError(balanceBody?.requestId??entriesBody?.requestId??'—');}catch{if(!isCurrent())return;setWallet(null);setWalletError('—');}}
  async function fund(kind:'TOP_UP'|'CASH_REFUND_DEBIT',submission:WalletFundingSubmission){if(!wallet||wallet.busy||wallet.userId!==props.userId)return;const snapshot=wallet;const userId=props.userId;
    await runBusyTask((busy)=>setWallet(current=>current?.userId===userId?{...current,busy}:current),async()=>{try{
      const key=fundingKeys.current[kind]??createWalletIdempotencyKey(kind,userId);fundingKeys.current[kind]=key;
      const request=buildWalletRequest(kind,userId,submission,snapshot.balance.version);const response=await client.post(request.path,request.body,key);
      const body=await response.json().catch(()=>null) as {requestId?:string;data?:{id?:string}}|null;if(!response.ok||!body?.data?.id){if(activeUserId.current===userId)setWalletError(body?.requestId??'—');return;}
      if(submission.receipt){const form=new FormData();form.append('evidenceType',kind);form.append('evidenceId',body.data.id);form.append('file',submission.receipt);
        const upload=await client.upload(walletPaths(userId).receipt,form,`${key}:receipt`);if(!upload.ok){if(activeUserId.current===userId)setWalletError('—');return;}}
      delete fundingKeys.current[kind];await Promise.allSettled([loadSummary(),loadWallet()]);
    }catch{if(activeUserId.current===userId)setWalletError('—');}});}
  async function adjustWallet(submission:WalletAdjustmentSubmission){if(!wallet||wallet.busy||wallet.userId!==props.userId)return;const snapshot=wallet;const userId=props.userId;
    await runBusyTask((busy)=>setWallet(current=>current?.userId===userId?{...current,busy}:current),async()=>{try{const request=buildWalletAdjustmentRequest(userId,submission,snapshot.balance.version);const fingerprint=JSON.stringify({kind:'ADJUSTMENT',userId,request});const key=writeKeys.current.get(fingerprint,()=>createWalletAdjustmentIdempotencyKey(userId));const response=await client.post(request.path,request.body,key);
      if(!response.ok){const body=await response.json().catch(()=>null) as {requestId?:string}|null;if(activeUserId.current===userId)setWalletError(body?.requestId??'—');return;}writeKeys.current.complete(fingerprint);await Promise.allSettled([loadSummary(),loadWallet()]);
    }catch{if(activeUserId.current===userId)setWalletError('—');}});}
  async function loadPage(kind: 'orders' | 'consumptions', cursor: string | null = null, append = false) {
    const userId=props.userId;const request=pageRequests.current[kind].begin();const isCurrent=()=>request.isCurrent()&&activeUserId.current===userId;
    setModules((current) => ({ ...current, [kind]: { ...current[kind], kind: 'LOADING' } }));
    try{const base = buildCustomerProfileRequests(userId, windowValue)[kind]; const response = await client.get(cursor ? appendCursor(base, cursor) : base);
      const body = await response.json().catch(() => null) as PageEnvelope | null;if(!isCurrent())return;
      setModules((current) => { const prior = current[kind]; if (!response.ok || !body?.data) return { ...current, [kind]: { ...prior, kind: response.status === 403 ? 'FORBIDDEN' : 'ERROR', requestId: body?.requestId ?? null } };
        const items = append ? [...prior.items, ...(body.data.items ?? [])] : body.data.items ?? []; return { ...current, [kind]: { kind: items.length ? 'READY' : 'EMPTY', items, nextCursor: body.data.nextCursor ?? null, requestId: null } }; });
    }catch{if(!isCurrent())return;setModules((current)=>({...current,[kind]:{...current[kind],kind:'ERROR',requestId:null}}));}
  }
  async function appendInternalNote(body:string){if(internalNoteBusy)return false;setInternalNoteBusy(true);setInternalNoteError(null);
    const fingerprint=JSON.stringify({kind:'PROFILE_NOTE',userId:props.userId,body});const key=writeKeys.current.get(fingerprint,()=>`dashboard:profile-note:${crypto.randomUUID()}`);
    try{const response=await client.post(`/api/v1/admin/users/${encodeURIComponent(props.userId)}/profile-notes`,{body},key);
      const payload=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;
      if(!response.ok){setInternalNoteError(`${payload?.error?.message??'内部备注未能追加。'}${payload?.requestId?` 请求编号：${payload.requestId}`:''}`);return false;}
      writeKeys.current.complete(fingerprint);await loadSummary();return true;
    }catch{setInternalNoteError('内部备注未能追加，请稍后重试。');return false;}finally{setInternalNoteBusy(false);}}
  async function updateProfile(value:{displayName:string;expectedVersion:number;reasonCode:string;note:string}){if(profileEditBusy)return false;setProfileEditBusy(true);setProfileEditError(null);const request=buildCustomerProfileUpdateRequest(props.userId,value);const fingerprint=JSON.stringify({kind:'PROFILE_EDIT',userId:props.userId,request});const key=writeKeys.current.get(fingerprint,()=>`dashboard:profile-edit:${crypto.randomUUID()}`);try{const response=await client.patch(request.path,request.body,key);const payload=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;if(!response.ok){setProfileEditError(`${payload?.error?.message??'客户名称未能保存。'}${payload?.requestId?` 请求编号：${payload.requestId}`:''}`);return false;}writeKeys.current.complete(fingerprint);await loadSummary();return true;}catch{setProfileEditError('客户名称未能保存，请稍后重试。');return false;}finally{setProfileEditBusy(false);}}
  useEffect(() => {summaryRequests.current.invalidate();walletRequests.current.invalidate();pageRequests.current.orders.invalidate();pageRequests.current.consumptions.invalidate();fundingKeys.current={};writeKeys.current.clear();setWallet(null);setWalletError(null);
    if (!mayRead) { setModules(forbiddenModules()); return; }setModules(loadingModules());void Promise.allSettled([loadSummary(), loadPage('orders'), loadPage('consumptions'),loadWallet()]);
    return()=>{summaryRequests.current.invalidate();walletRequests.current.invalidate();pageRequests.current.orders.invalidate();pageRequests.current.consumptions.invalidate();};}, [props.userId, mayRead]);
  function changeWindow(value: 'DAYS_30' | 'DAYS_90' | 'ALL') { setWindow(value); void loadSummary(value); }
  const retry = (module: string) => module === 'orders' || module === 'consumptions' ? void loadPage(module) : void loadSummary();
  return <CustomerProfilePage model={buildCustomerProfileView(modules)} window={windowValue} onWindowChange={changeWindow} onRetryModule={retry}
    onNextOrders={(cursor) => void loadPage('orders', cursor, true)} onNextConsumptions={(cursor) => void loadPage('consumptions', cursor, true)} wallet={wallet?{balance:wallet.balance,entries:wallet.entries,nextCursor:wallet.nextCursor,busy:wallet.busy}:undefined} walletError={walletError}
    canAppendInternalNote={mayAppendInternalNote} internalNoteBusy={internalNoteBusy} internalNoteError={internalNoteError} onAppendInternalNote={appendInternalNote}
    canEditProfile={mayEditProfile} profileEditBusy={profileEditBusy} profileEditError={profileEditError} onUpdateProfile={updateProfile}
    canTopUp={mayTopUp} canExternalRefund={mayExternalRefund} onTopUp={mayTopUp?(value)=>fund('TOP_UP',value):undefined} onExternalRefund={mayExternalRefund?(value)=>fund('CASH_REFUND_DEBIT',value):undefined} canAdjustWallet={mayAdjustWallet} onWalletAdjustment={mayAdjustWallet?adjustWallet:undefined}
    onNextWalletPage={wallet?.nextCursor?()=>void loadWallet(wallet.nextCursor,true):undefined} />;
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
