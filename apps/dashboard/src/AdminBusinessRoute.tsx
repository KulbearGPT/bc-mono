import { useEffect, useMemo, useRef, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { AdminBusinessPage } from './AdminBusinessPage.js';
import {
  buildAdminActionRequest,
  buildAdminBusinessPage,
  buildAdminDetailRequest,
  buildAdminOrderTimelineRequest,
  buildAdminResourceQuery,
  buildAdminUserConsumptionRequest,
  type AdminBusinessAction,
  type AdminBusinessDetailState,
  type AdminBusinessPageId
} from './admin-business.js';

export function createRetriableDashboardWrite<T>(input: {
  send: (idempotencyKey: string) => Promise<T>;
  createKey?: () => string;
}): () => Promise<T> {
  const idempotencyKey = (input.createKey ?? (() => `dashboard:${crypto.randomUUID()}`))();
  return () => input.send(idempotencyKey);
}

export function AdminBusinessRoute(props: { page: AdminBusinessPageId; capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []);
  const [status, setStatus] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [activeAction, setActiveAction] = useState<{ action: AdminBusinessAction; item?: Record<string, unknown> } | null>(null);
  const [actionStatus, setActionStatus] = useState<'IDLE' | 'SUBMITTING' | 'ERROR'>('IDLE');
  const [actionError, setActionError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminBusinessDetailState | null>(null);
  const activeWrite = useRef<{ fingerprint: string; retry: () => Promise<Response> } | null>(null);
  const definition = buildAdminBusinessPage({ page: props.page, permissions: props.capabilities.permissions, status: 'LOADING' });
  const mayReadPage = props.capabilities.permissions.includes(definition.requiredPermission);

  async function load(cursor: string | null = null, activeFilters = filters) {
    setStatus('LOADING');
    const response = await client.get(`${definition.endpoint}${buildAdminResourceQuery({ cursor, limit: 25, ...activeFilters })}`);
    const body = await response.json().catch(() => null) as { requestId?: string; data?: { items?: Array<Record<string, unknown>>; nextCursor?: string | null } } | null;
    if (!response.ok || !body?.data) {
      setRequestId(body?.requestId ?? null);
      setStatus('ERROR');
      return;
    }
    setItems(body.data.items ?? []);
    setNextCursor(body.data.nextCursor ?? null);
    setRequestId(null);
    setStatus('READY');
  }

  useEffect(() => {
    setActiveAction(null);
    setDetail(null);
    activeWrite.current = null;
    if (!mayReadPage) return;
    void load(null, {});
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
    if (page !== 'orders' && page !== 'users' && page !== 'players' && page !== 'giftRequests') return;
    setDetail({ kind: 'LOADING', page, requestId: null, data: null });
    try {
      const response = await client.get(buildAdminDetailRequest(page, item));
      const body = await response.json().catch(() => null) as { requestId?: string; data?: Record<string, unknown> } | null;
      if (response.status === 403) {
        setDetail({ kind: 'FORBIDDEN', page, requestId: body?.requestId ?? null, data: null });
        return;
      }
      if (!response.ok || !body?.data) {
        setDetail({ kind: 'ERROR', page, requestId: body?.requestId ?? null, data: null });
        return;
      }
      if (page !== 'users') {
        setDetail({ kind: 'READY', page, requestId: body.requestId ?? null, data: body.data,
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
      setDetail({ kind: 'ERROR', page, requestId: null, data: null });
    }
  }

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

  function loadMoreConsumptions(cursor: string) {
    if (detail?.kind !== 'READY' || detail.page !== 'users' || typeof detail.data?.id !== 'string') return;
    const userId = detail.data.id;
    setDetail((current) => current?.kind === 'READY' && current.page === 'users' && current.consumptions
      ? { ...current, consumptions: { ...current.consumptions, kind: 'LOADING' } }
      : current);
    void loadUserConsumptions(userId, cursor, true);
  }

  const model = buildAdminBusinessPage({ page: props.page, permissions: props.capabilities.permissions, status, items, nextCursor, requestId });
  return <AdminBusinessPage model={model} onRetry={() => void load()} onNextPage={(cursor) => void load(cursor)}
    onClearFilters={() => { setFilters({}); void load(null, {}); }}
    onFilter={(value) => { setFilters(value); void load(null, value); }}
    onAction={(action, item) => { activeWrite.current = null; setActiveAction({ action, item }); setActionError(null); setActionStatus('IDLE'); }}
    activeAction={activeAction} actionStatus={actionStatus} actionError={actionError}
    onCancelAction={() => { activeWrite.current = null; setActiveAction(null); setActionError(null); setActionStatus('IDLE'); }}
    onSubmitAction={(action, item, fields) => void submitAction(action, item, fields)}
    detail={detail} onOpenDetail={(item) => void openDetail(item)} onCloseDetail={() => setDetail(null)}
    onNextConsumptions={loadMoreConsumptions} onNextTimeline={(cursor) => void loadMoreOrderTimeline(cursor)} />;
}
