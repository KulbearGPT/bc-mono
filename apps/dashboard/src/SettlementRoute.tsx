import { useEffect, useMemo, useRef, useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { SettlementPage } from './SettlementPage.js';
import { buildSettlementPage, buildSettlementRequest, type SettlementAction, type SettlementSection } from './settlements.js';

export function SettlementRoute(props: { section: SettlementSection; capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []);
  const [status, setStatus] = useState<'LOADING' | 'READY' | 'ERROR'>('LOADING');
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [requestId, setRequestId] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const endpoint = props.section === 'settlements' ? '/api/v1/admin/settlement-batches?limit=50' : '/api/v1/admin/weekly-reports?limit=50';

  async function load() {
    setStatus('LOADING');
    try {
      const response = await client.get(endpoint); const body = await response.json().catch(() => null) as Envelope | null;
      if (!response.ok || !body?.data) { setRequestId(body?.requestId ?? null); setStatus('ERROR'); return; }
      setItems(body.data.items ?? []); setRequestId(null); setStatus('READY');
    } catch { setStatus('ERROR'); setRequestId(null); }
  }
  useEffect(() => { void load(); }, [props.section]);

  async function act(action: SettlementAction, item?: Record<string, unknown>, fields: Record<string, unknown> = {}) {
    if (props.section === 'reports' && action === 'EXPORT' && item?.id) return exportResponse(`/api/v1/admin/weekly-reports/${encodeURIComponent(String(item.id))}/export`, `weekly-report-${String(item.id)}.csv`);
    const request = buildSettlementRequest({ action, batchId: typeof item?.id === 'string' ? item.id : undefined,
      version: typeof item?.version === 'number' ? item.version : undefined, fields });
    if (request.method === 'GET') return exportResponse(request.path, `settlement-${String(item?.id ?? 'preview')}.csv`);
    const fingerprint = JSON.stringify({ action, id: item?.id ?? null, request });
    let key = keys.current.get(fingerprint); if (!key) { key = `dashboard:m6:${crypto.randomUUID()}`; keys.current.set(fingerprint, key); }
    const response = await client.post(request.path, request.body, key); const body = await response.json().catch(() => null) as Envelope | null;
    if (!response.ok) { setStatus('ERROR'); setRequestId(body?.requestId ?? null); return; }
    keys.current.delete(fingerprint);
    if (action === 'PREVIEW' && body?.data) { setItems([body.data]); setStatus('READY'); return; }
    await load();
  }

  async function exportResponse(path: string, filename: string) {
    const response = await client.get(path); if (!response.ok) { const body = await response.json().catch(() => null) as Envelope | null; setRequestId(body?.requestId ?? null); setStatus('ERROR'); return; }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
  }
  const model = buildSettlementPage({ section: props.section, permissions: props.capabilities.permissions, status, items, requestId });
  return <SettlementPage model={model} onRetry={() => void load()} onAction={(action,item,fields) => void act(action,item,fields)} />;
}

interface Envelope { requestId?: string; data?: { items?: Array<Record<string, unknown>> } & Record<string, unknown> }
