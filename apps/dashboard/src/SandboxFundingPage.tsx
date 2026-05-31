import { useMemo, useRef, useState } from 'react';
import { createDashboardApiClient } from './dashboard-shell.js';
import {
  canManageSandboxFunding,
  getSandboxFundingAccount,
  setSandboxTargetBalance,
  type DashboardCapabilities,
  type SandboxFundingAccount
} from './sandbox-funding.js';

export function SandboxFundingPage(props: { capabilities: DashboardCapabilities }) {
  const client = useMemo(() => createDashboardApiClient(), []);
  const [userId, setUserId] = useState('');
  const [account, setAccount] = useState<SandboxFundingAccount | null>(null);
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState<'IDLE' | 'LOADING' | 'SAVING' | 'ERROR'>('IDLE');
  const [notice, setNotice] = useState<string | null>(null);
  const lookupGeneration = useRef(0);

  if (!canManageSandboxFunding(props.capabilities)) {
    return <section className="dashboard-page"><h1>测试余额</h1><p>仅 Sandbox OWNER 可管理测试余额。</p></section>;
  }

  async function load() {
    const generation = ++lookupGeneration.current;
    const requestedUserId = userId.trim();
    setStatus('LOADING'); setNotice(null);
    try {
      const next = await getSandboxFundingAccount(client, requestedUserId);
      if (generation !== lookupGeneration.current) return;
      setAccount(next); setTarget(String(next.providerBalanceMinor)); setStatus('IDLE');
    } catch (error) {
      if (generation !== lookupGeneration.current) return;
      setStatus('ERROR'); setNotice(error instanceof Error ? error.message : 'SANDBOX_FUNDING_FAILED');
    }
  }

  async function submit() {
    if (!account) return;
    setStatus('SAVING'); setNotice(null);
    try {
      const result = await setSandboxTargetBalance(client, account.userId, account, Number(target));
      setAccount(result.account); setTarget(String(result.account.providerBalanceMinor)); setStatus('IDLE');
      setNotice(result.kind === 'CONFLICT'
        ? `账户状态已变化（${result.errorCode}），已刷新服务端余额；请确认后重新提交。request_id: ${result.requestId ?? 'unknown'}`
        : '测试余额已更新。');
    } catch (error) {
      setStatus('ERROR'); setNotice(error instanceof Error ? error.message : 'SANDBOX_FUNDING_FAILED');
    }
  }

  return (
    <section className="dashboard-page sandbox-funding-page">
      <h1>Sandbox 测试余额</h1>
      <p>输入业务用户 ID 查看服务端余额快照。调额固定记录为 SANDBOX_TEST_SETUP。</p>
      <div className="sandbox-lookup">
        <label>业务用户 ID<input value={userId} onChange={(event) => {
          lookupGeneration.current += 1;
          setUserId(event.target.value);
          setAccount(null);
          setTarget('');
          setNotice(null);
          setStatus('IDLE');
        }} /></label>
        <button type="button" disabled={!userId.trim() || status === 'LOADING'} onClick={() => void load()}>查询</button>
      </div>
      {account && <div className="sandbox-balance-card">
        <dl>
          <dt>业务用户</dt><dd>{account.userId}</dd>
          <dt>Provider 测试余额</dt><dd>{account.providerBalanceMinor} {account.currency} minor units</dd>
          <dt>活动预留</dt><dd>{account.reservedMinor} {account.currency} minor units</dd>
          <dt>可用余额</dt><dd>{account.availableMinor} {account.currency} minor units</dd>
          <dt>版本</dt><dd>{account.version}</dd>
          <dt>更新时间</dt><dd>{account.fetchedAt}</dd>
        </dl>
        <label>目标 Provider 测试余额（minor units）
          <input type="number" min="0" step="1" value={target} onChange={(event) => setTarget(event.target.value)} />
        </label>
        <button type="button" disabled={status === 'SAVING'} onClick={() => void submit()}>设置目标余额</button>
      </div>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
