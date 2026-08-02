import { useEffect, useMemo, useRef, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { AdminBusinessPage } from './AdminBusinessPage.js';
import {
  buildAdminActionRequest,
  buildAdminBusinessPage,
  buildAdminDetailRequest,
  buildAdminOrderTimelineRequest,
  buildAddOrderParticipantRequest,
  buildUpdateAdminOrderNoteRequest,
  buildUpdateAdminOrderRequirementRequest,
  buildUpdateOrderParticipantRequest,
  buildAdminResourceQuery,
  buildAdminUserConsumptionRequest,
  buildAdminCollectionUrl,
  isAdminCollectionPage,
  readAdminCollectionState,
  type AdminBusinessAction,
  type AdminBusinessDetailState,
  type AdminBusinessPageId,
  type AdminCollectionState,
  type AdminCollectionView,
  type AdminSortDirection
} from './admin-business.js';
import { groupEnabledBusinessTags, type BusinessTagRecord, type BusinessTagGroups } from './business-tags.js';
import { createLatestRequestSequence } from './live-query-refresh.js';

export { createLatestRequestSequence } from './live-query-refresh.js';

export function createRetriableDashboardWrite<T>(input: {
  send: (idempotencyKey: string) => Promise<T>;
  createKey?: () => string;
}): () => Promise<T> {
  const idempotencyKey = (input.createKey ?? (() => `dashboard:${crypto.randomUUID()}`))();
  return () => input.send(idempotencyKey);
}
function initialCollectionState(page:AdminBusinessPageId):AdminCollectionState|null{if(!isAdminCollectionPage(page))return null;return readAdminCollectionState(page,typeof window==='undefined'?'':window.location.search);}

export function AdminBusinessRoute(props: { page: AdminBusinessPageId; capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []);
  const [status, setStatus] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const initialCollection=initialCollectionState(props.page);
  const [filters, setFilters] = useState<Record<string, string>>(initialCollection?.filters??{});
  const [view,setView]=useState<AdminCollectionView>(initialCollection?.view??'CARD');
  const [sortBy,setSortBy]=useState(initialCollection?.sortBy??'createdAt');
  const [sortDirection,setSortDirection]=useState<AdminSortDirection>(initialCollection?.sortDirection??'desc');
  const [activeAction, setActiveAction] = useState<{ action: AdminBusinessAction; item?: Record<string, unknown> } | null>(null);
  const [actionStatus, setActionStatus] = useState<'IDLE' | 'SUBMITTING' | 'ERROR'>('IDLE');
  const [actionError, setActionError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminBusinessDetailState | null>(null);
  const [businessTagOptions,setBusinessTagOptions]=useState<BusinessTagGroups>(()=>groupEnabledBusinessTags([]));
  const [serviceCatalogOptions,setServiceCatalogOptions]=useState<Array<Record<string,unknown>>>([]);
  const dispatchCandidateOptions=useMemo<Array<Record<string,unknown>>>(()=>[],[]);
  const [participantPlayerOptions,setParticipantPlayerOptions]=useState<Array<Record<string,unknown>>>([]);
  const [participantMutationError,setParticipantMutationError]=useState<string|null>(null);
  const activeWrite = useRef<{ fingerprint: string; retry: () => Promise<Response> } | null>(null);
  const requestSequence=useRef(createLatestRequestSequence()).current;
  const detailRequestSequence=useRef(createLatestRequestSequence()).current;
  const definition = buildAdminBusinessPage({ page: props.page, permissions: props.capabilities.permissions, status: 'LOADING' });
  const mayReadPage = props.capabilities.permissions.includes(definition.requiredPermission);

  async function load(cursor: string | null = null, activeFilters = filters,activeSort={sortBy,sortDirection}) {
    const sequence=requestSequence.begin();
    setStatus('LOADING');
    try {
      const sorting=isAdminCollectionPage(props.page)?activeSort:{};
      const response = await client.get(`${definition.endpoint}${buildAdminResourceQuery({ cursor, limit: 25, ...activeFilters,...sorting })}`);
      const body = await response.json().catch(() => null) as { requestId?: string; data?: { items?: Array<Record<string, unknown>>; nextCursor?: string | null } } | null;
      if(!requestSequence.isCurrent(sequence))return;
      if (!response.ok || !body?.data) {
        setRequestId(body?.requestId ?? null);
        setStatus('ERROR');
        return;
      }
      setItems(body.data.items ?? []);
      setNextCursor(body.data.nextCursor ?? null);
      setRequestId(null);
      setStatus('READY');
    } catch {
      if(!requestSequence.isCurrent(sequence))return;
      setRequestId(null);
      setStatus('ERROR');
    }
  }

  useEffect(() => {
    requestSequence.invalidate();
    detailRequestSequence.invalidate();
    setActiveAction(null);
    setDetail(null);
    activeWrite.current = null;
    const restored=initialCollectionState(props.page);const restoredFilters=restored?.filters??{};setFilters(restoredFilters);setView(restored?.view??'CARD');setSortBy(restored?.sortBy??'createdAt');setSortDirection(restored?.sortDirection??'desc');
    if (!mayReadPage) return;
    void load(null, restoredFilters,{sortBy:restored?.sortBy??'createdAt',sortDirection:restored?.sortDirection??'desc'});
    if(['players','serviceCatalog','giftCatalog'].includes(props.page))void client.get('/api/v1/admin/business-tags?enabled=true').then(async(response)=>{const body=await response.json().catch(()=>null) as {data?:{items?:BusinessTagRecord[]}|BusinessTagRecord[]}|null;const items=Array.isArray(body?.data)?body.data:body?.data?.items??[];if(response.ok)setBusinessTagOptions(groupEnabledBusinessTags(items));});
    if(props.page==='players'||props.page==='servicePackages')void client.get('/api/v1/admin/service-catalog?limit=100').then(async(response)=>{const body=await response.json().catch(()=>null) as {data?:{items?:Array<Record<string,unknown>>}}|null;if(response.ok)setServiceCatalogOptions((body?.data?.items??[]).filter((item)=>item.enabled!==false));});
  }, [props.page, mayReadPage]);

  async function submitAction(action: AdminBusinessAction, item: Record<string, unknown> | undefined, fields: Record<string, string | boolean>) {
    setActionStatus('SUBMITTING');
    setActionError(null);
    try {
      const request = buildAdminActionRequest({ actionId: action.id, item, fields });
      const fingerprint = JSON.stringify({ actionId: action.id, itemId: item?.id ?? null, request });
      if (!activeWrite.current || activeWrite.current.fingerprint !== fingerprint) {
        activeWrite.current = {
          fingerprint,
          retry: createRetriableDashboardWrite({
            send: (idempotencyKey) => request.method === 'POST' ? client.post(request.path, request.body, idempotencyKey)
              : request.method === 'PUT' ? client.put(request.path, request.body, idempotencyKey)
                : client.patch(request.path, request.body, idempotencyKey)
          })
        };
      }
      const response = await activeWrite.current.retry();
      const body = await response.json().catch(() => null) as { requestId?: string; error?: { message?: string } } | null;
      if (!response.ok) {
        const requestIdSuffix = body?.requestId ? ` request_id: ${body.requestId}` : '';
        setActionError(`${body?.error?.message ?? '操作未完成，请检查对象状态后重试。'}${requestIdSuffix}`);
        setActionStatus('ERROR');
        return;
      }
      setActiveAction(null);
      setActionStatus('IDLE');
      activeWrite.current = null;
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '操作表单无效。');
      setActionStatus('ERROR');
    }
  }

  async function openDetail(item: Record<string, unknown>) {
    const page = props.page;
    if (page !== 'orders' && page !== 'users' && page !== 'players' && page !== 'giftRequests' && page !== 'giftCatalog' && page !== 'serviceCatalog' && page !== 'servicePackages') return;
    const sequence = detailRequestSequence.begin();
    const isCurrent = () => detailRequestSequence.isCurrent(sequence);
    setDetail({ kind: 'LOADING', page, requestId: null, data: null });
    try {
      const response = await client.get(buildAdminDetailRequest(page, item));
      const body = await response.json().catch(() => null) as { requestId?: string; data?: Record<string, unknown> } | null;
      if (!isCurrent()) return;
      if (response.status === 403) {
        setDetail({ kind: 'FORBIDDEN', page, requestId: body?.requestId ?? null, data: null });
        return;
      }
      if (!response.ok || !body?.data) {
        setDetail({ kind: 'ERROR', page, requestId: body?.requestId ?? null, data: null });
        return;
      }
      if (page !== 'users') {
        let data=body.data;
        if(page==='orders'&&typeof item.id==='string'){
          const participantResponse=await client.get(`/api/v1/admin/orders/${encodeURIComponent(item.id)}/participants?limit=100`);
          const participantBody=await participantResponse.json().catch(()=>null) as {requestId?:string;data?:Record<string,unknown>}|null;
          if (!isCurrent()) return;
          if(!participantResponse.ok||!participantBody?.data){setDetail({kind:participantResponse.status===403?'FORBIDDEN':'ERROR',page,requestId:participantBody?.requestId??null,data:null});return;}
          const requirementResponse=await client.get(`/api/v1/admin/orders/${encodeURIComponent(item.id)}/requirements?limit=100`);
          const requirementBody=await requirementResponse.json().catch(()=>null) as {requestId?:string;data?:Record<string,unknown>}|null;
          if (!isCurrent()) return;
          if(!requirementResponse.ok||!requirementBody?.data){setDetail({kind:requirementResponse.status===403?'FORBIDDEN':'ERROR',page,requestId:requirementBody?.requestId??null,data:null});return;}
          const transcriptResponse=await client.get(`/api/v1/admin/orders/${encodeURIComponent(item.id)}/transcript?limit=25`);
          const transcriptBody=await transcriptResponse.json().catch(()=>null) as {requestId?:string;data?:Record<string,unknown>}|null;
          if (!isCurrent()) return;
          const candidateResponse=await client.get(`/api/v1/admin/orders/${encodeURIComponent(item.id)}/participant-candidates?limit=100`);
          const candidateBody=await candidateResponse.json().catch(()=>null) as {data?:{items?:Array<Record<string,unknown>>}}|null;
          if (!isCurrent()) return;
          if(candidateResponse.ok){
            const candidates=candidateBody?.data?.items??[];
            setParticipantPlayerOptions(candidates);
            const projects=new Map<string,Record<string,unknown>>();
            for(const candidate of candidates){for(const project of Array.isArray(candidate.projects)?candidate.projects:[]){if(project&&typeof project==='object'&&!Array.isArray(project)&&typeof (project as Record<string,unknown>).id==='string')projects.set(String((project as Record<string,unknown>).id),project as Record<string,unknown>);}}
            for(const participant of Array.isArray(participantBody.data.items)?participantBody.data.items:[]){if(participant&&typeof participant==='object'&&!Array.isArray(participant)){const record=participant as Record<string,unknown>;if(typeof record.serviceCatalogVersionId==='string')projects.set(record.serviceCatalogVersionId,{id:record.serviceCatalogVersionId,game:record.game,gameDisplayName:record.gameDisplayName,service:record.service,serviceDisplayName:record.serviceDisplayName,region:record.region,regionDisplayName:record.regionDisplayName,billingUnitMinutes:record.billingUnitMinutes,customerUnitPriceMinor:record.customerUnitPriceMinor});}}
            setServiceCatalogOptions(Array.from(projects.values()));
          }
          data={...body.data,requirements:requirementBody.data,participants:participantBody.data,transcript:transcriptResponse.ok&&transcriptBody?.data?transcriptBody.data:{items:[],nextCursor:null}};
          setDetail({ kind: 'READY', page, requestId: body.requestId ?? null, data,
            timelinePage: { kind: 'READY', requestId: null },transcriptPage:{kind:transcriptResponse.ok?'READY':'ERROR',requestId:transcriptBody?.requestId??null} });
          return;
        }
        setDetail({ kind: 'READY', page, requestId: body.requestId ?? null, data,
          timelinePage: page === 'orders' ? { kind: 'READY', requestId: null } : undefined });
        return;
      }
      const userId = typeof body.data.id === 'string' ? body.data.id : null;
      if (!userId) {
        setDetail({ kind: 'ERROR', page, requestId: body.requestId ?? null, data: null });
        return;
      }
      setDetail({ kind: 'READY', page, requestId: body.requestId ?? null, data: body.data, consumptions: { kind: 'LOADING', requestId: null, items: [], nextCursor: null } });
      await loadUserConsumptions(userId, null, false);
    } catch {
      if (isCurrent()) setDetail({ kind: 'ERROR', page, requestId: null, data: null });
    }
  }

  async function mutateParticipant(kind:'ADD'|'UPDATE',fields:Record<string,unknown>){
    if(detail?.kind!=='READY'||detail.page!=='orders'||!detail.data)return;
    const order=detail.data.order as Record<string,unknown>|undefined;if(!order||typeof order.id!=='string'||typeof order.version!=='number')return;
    try{setParticipantMutationError(null);const request=kind==='ADD'?buildAddOrderParticipantRequest(order.id,{...fields,expectedOrderVersion:order.version} as Parameters<typeof buildAddOrderParticipantRequest>[1]):buildUpdateOrderParticipantRequest(order.id,String(fields.participantId??''),{...fields,expectedOrderVersion:order.version} as Parameters<typeof buildUpdateOrderParticipantRequest>[2]);const response=request.method==='POST'?await client.post(request.path,request.body,`dashboard:${crypto.randomUUID()}`):await client.patch(request.path,request.body,`dashboard:${crypto.randomUUID()}`);const body=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;if(!response.ok){setParticipantMutationError(`${body?.error?.message??'陪玩明细未能保存。'}${body?.requestId?` request_id: ${body.requestId}`:''}`);return;}await openDetail({id:order.id});}
    catch(error){setParticipantMutationError(error instanceof Error?error.message:'陪玩明细表单无效。');}
  }

  async function mutateOrderNote(fields:Record<string,unknown>){if(detail?.kind!=='READY'||detail.page!=='orders'||!detail.data)return;const order=detail.data.order as Record<string,unknown>|undefined;if(!order||typeof order.id!=='string'||typeof order.version!=='number')return;try{setParticipantMutationError(null);const request=buildUpdateAdminOrderNoteRequest(order.id,{...fields,expectedOrderVersion:order.version} as Parameters<typeof buildUpdateAdminOrderNoteRequest>[1]);const response=await client.patch(request.path,request.body,`dashboard:${crypto.randomUUID()}`);const body=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;if(!response.ok){setParticipantMutationError(`${body?.error?.message??'订单备注未能保存。'}${body?.requestId?` request_id: ${body.requestId}`:''}`);return;}await openDetail({id:order.id});}catch(error){setParticipantMutationError(error instanceof Error?error.message:'订单备注表单无效。');}}

  async function mutateRequirement(fields:Record<string,unknown>){if(detail?.kind!=='READY'||detail.page!=='orders'||!detail.data)return;const order=detail.data.order as Record<string,unknown>|undefined;if(!order||typeof order.id!=='string'||typeof order.version!=='number')return;try{setParticipantMutationError(null);const request=buildUpdateAdminOrderRequirementRequest(order.id,String(fields.requirementId??''),{...fields,expectedOrderVersion:order.version} as Parameters<typeof buildUpdateAdminOrderRequirementRequest>[2]);const response=await client.patch(request.path,request.body,`dashboard:${crypto.randomUUID()}`);const body=await response.json().catch(()=>null) as {requestId?:string;error?:{message?:string}}|null;if(!response.ok){setParticipantMutationError(`${body?.error?.message??'席位备注未能保存。'}${body?.requestId?` request_id: ${body.requestId}`:''}`);return;}await openDetail({id:order.id});}catch(error){setParticipantMutationError(error instanceof Error?error.message:'席位备注表单无效。');}}

  async function loadUserConsumptions(userId: string, cursor: string | null, append: boolean) {
    try {
      const consumptionResponse = await client.get(buildAdminUserConsumptionRequest(userId, cursor));
      const consumptionBody = await consumptionResponse.json().catch(() => null) as { requestId?: string; data?: { items?: Array<Record<string, unknown>>; nextCursor?: string | null } } | null;
      setDetail((current) => {
        if (current?.kind !== 'READY' || current.page !== 'users' || current.data?.id !== userId) return current;
        if (!consumptionResponse.ok || !consumptionBody?.data) {
          return { ...current, consumptions: { kind: 'ERROR', requestId: consumptionBody?.requestId ?? null, items: current.consumptions?.items ?? [], nextCursor: current.consumptions?.nextCursor ?? null } };
        }
        const consumptions = append ? [...(current.consumptions?.items ?? []), ...(consumptionBody.data.items ?? [])] : consumptionBody.data.items ?? [];
        return { ...current, consumptions: { kind: consumptions.length ? 'READY' : 'EMPTY', requestId: consumptionBody.requestId ?? null, items: consumptions, nextCursor: consumptionBody.data.nextCursor ?? null } };
      });
    } catch {
      setDetail((current) => current?.kind === 'READY' && current.page === 'users'
        ? { ...current, consumptions: { kind: 'ERROR', requestId: null, items: current.consumptions?.items ?? [], nextCursor: current.consumptions?.nextCursor ?? null } }
        : current);
    }
  }

  async function loadMoreOrderTimeline(cursor: string) {
    if (detail?.kind !== 'READY' || detail.page !== 'orders' || !detail.data) return;
    const order = detail.data.order as Record<string, unknown> | undefined;
    if (!order || typeof order.id !== 'string') return;
    setDetail((current) => current?.kind === 'READY' && current.page === 'orders'
      ? { ...current, timelinePage: { kind: 'LOADING', requestId: null } }
      : current);
    try {
      const response = await client.get(buildAdminOrderTimelineRequest(order.id, cursor));
      const body = await response.json().catch(() => null) as { requestId?: string; data?: Record<string, unknown> } | null;
      if (!response.ok || !body?.data) {
        setDetail((current) => current?.kind === 'READY' && current.page === 'orders'
          ? { ...current, timelinePage: { kind: 'ERROR', requestId: body?.requestId ?? null } }
          : current);
        return;
      }
      setDetail((current) => {
        if (current?.kind !== 'READY' || current.page !== 'orders' || !current.data) return current;
        const prior=current.data.timeline as {items?:unknown[]}|undefined;const next=body.data!.timeline as {items?:unknown[];nextCursor?:unknown}|undefined;
        return { ...current, timelinePage: { kind: 'READY', requestId: null }, data: { ...current.data, timeline: { items: [...(prior?.items??[]),...(next?.items??[])], nextCursor: typeof next?.nextCursor==='string'?next.nextCursor:null } } };
      });
    } catch {
      setDetail((current) => current?.kind === 'READY' && current.page === 'orders'
        ? { ...current, timelinePage: { kind: 'ERROR', requestId: null } }
        : current);
    }
  }

  async function loadMoreOrderTranscript(cursor:string){
    if(detail?.kind!=='READY'||detail.page!=='orders'||!detail.data)return;const order=detail.data.order as Record<string,unknown>|undefined;if(!order||typeof order.id!=='string')return;
    setDetail(current=>current?.kind==='READY'&&current.page==='orders'?{...current,transcriptPage:{kind:'LOADING',requestId:null}}:current);
    try{const response=await client.get(`/api/v1/admin/orders/${encodeURIComponent(order.id)}/transcript?limit=25&cursor=${encodeURIComponent(cursor)}`);const body=await response.json().catch(()=>null) as {requestId?:string;data?:{items?:unknown[];nextCursor?:unknown}}|null;setDetail(current=>{if(current?.kind!=='READY'||current.page!=='orders'||!current.data)return current;if(!response.ok||!body?.data)return{...current,transcriptPage:{kind:'ERROR',requestId:body?.requestId??null}};const prior=current.data.transcript as {items?:unknown[]}|undefined;return{...current,transcriptPage:{kind:'READY',requestId:null},data:{...current.data,transcript:{items:[...(prior?.items??[]),...(body.data.items??[])],nextCursor:typeof body.data.nextCursor==='string'?body.data.nextCursor:null}}};});}catch{setDetail(current=>current?.kind==='READY'&&current.page==='orders'?{...current,transcriptPage:{kind:'ERROR',requestId:null}}:current);}
  }

  function loadMoreConsumptions(cursor: string) {
    if (detail?.kind !== 'READY' || detail.page !== 'users' || typeof detail.data?.id !== 'string') return;
    const userId = detail.data.id;
    setDetail((current) => current?.kind === 'READY' && current.page === 'users' && current.consumptions
      ? { ...current, consumptions: { ...current.consumptions, kind: 'LOADING' } }
      : current);
    void loadUserConsumptions(userId, cursor, true);
  }

  async function openAction(action:AdminBusinessAction,item?:Record<string,unknown>){
    activeWrite.current=null;
    if(action.id==='EDIT_PLAYER_COMPENSATION'&&item&&typeof item.playerId==='string'){
      const response=await client.get(`/api/v1/admin/players/${encodeURIComponent(item.playerId)}/compensation`);
      const body=await response.json().catch(()=>null) as {data?:{items?:Array<Record<string,unknown>>}}|null;
      if(response.ok){const rules=body?.data?.items??[];setServiceCatalogOptions((current)=>current.map((offering)=>({...offering,compensationRule:rules.find((rule)=>rule.serviceOfferingId===offering.serviceOfferingId)})));}
    }
    setActiveAction({action,item});setActionError(null);setActionStatus('IDLE');
  }

  function replaceCollectionUrl(next:AdminCollectionState){if(isAdminCollectionPage(props.page)&&typeof window!=='undefined')window.history.replaceState(null,'',buildAdminCollectionUrl(props.page,next));}
  const model = buildAdminBusinessPage({ page: props.page, permissions: props.capabilities.permissions, status, items, nextCursor, requestId });
  return <AdminBusinessPage model={model} onRetry={() => void load()} onNextPage={(cursor) => void load(cursor)}
    view={view} sortBy={sortBy} sortDirection={sortDirection} activeFilters={filters}
    onViewChange={(nextView)=>{setView(nextView);replaceCollectionUrl({view:nextView,sortBy,sortDirection,filters});}}
    onSortChange={(nextSortBy,nextDirection)=>{setSortBy(nextSortBy);setSortDirection(nextDirection);setNextCursor(null);replaceCollectionUrl({view,sortBy:nextSortBy,sortDirection:nextDirection,filters});void load(null,filters,{sortBy:nextSortBy,sortDirection:nextDirection});}}
    onClearFilters={() => { setFilters({});setNextCursor(null);replaceCollectionUrl({view,sortBy,sortDirection,filters:{}}); void load(null, {}); }}
    onFilter={(value) => { setFilters(value);setNextCursor(null);replaceCollectionUrl({view,sortBy,sortDirection,filters:value}); void load(null, value); }}
    onAction={(action, item) => { void openAction(action,item); }}
    activeAction={activeAction} actionStatus={actionStatus} actionError={actionError}
    onCancelAction={() => { activeWrite.current = null; setActiveAction(null); setActionError(null); setActionStatus('IDLE'); }}
    onSubmitAction={(action, item, fields) => void submitAction(action, item, fields)}
    detail={detail} onOpenDetail={(item) => void openDetail(item)} onCloseDetail={() => { detailRequestSequence.invalidate(); setDetail(null); }}
    onNextConsumptions={loadMoreConsumptions} onNextTimeline={(cursor) => void loadMoreOrderTimeline(cursor)} onNextTranscript={(cursor)=>void loadMoreOrderTranscript(cursor)} businessTagOptions={businessTagOptions} serviceCatalogOptions={serviceCatalogOptions} dispatchCandidateOptions={dispatchCandidateOptions}
    participantPlayerOptions={participantPlayerOptions} participantMutationError={participantMutationError} onAddOrderParticipant={(fields)=>void mutateParticipant('ADD',fields)} onUpdateOrderParticipant={(fields)=>void mutateParticipant('UPDATE',fields)} onUpdateOrderNote={(fields)=>void mutateOrderNote(fields)} onUpdateOrderRequirement={(fields)=>void mutateRequirement(fields)} />;
}
