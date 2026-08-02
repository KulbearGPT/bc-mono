import { useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';
import { formatMinorCurrency } from './admin-business.js';

type Enrollment = { enrollmentId: string; provisioningUri: string; expiresAt: string };
type Challenge = { challengeId: string; expiresAt: string };

export function SecurityPage({ capabilities }: { capabilities: DashboardCapabilities }) {
  const api = createDashboardApiClient();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [proof, setProof] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  async function beginEnrollment() {
    const response = await api.post('/api/v1/admin/auth/mfa/enrollment', { method: 'TOTP' });
    const body = await response.json() as { data?: Enrollment; error?: { message?: string } };
    if (!response.ok || !body.data) return setMessage(body.error?.message ?? '无法开始验证器绑定。');
    setEnrollment(body.data);
    setMessage('请在验证器应用中添加此账户，然后输入六位验证码。');
  }

  async function verifyEnrollment() {
    if (!enrollment) return;
    const response = await api.post(`/api/v1/admin/auth/mfa/enrollment/${encodeURIComponent(enrollment.enrollmentId)}/verify`, { proof });
    const body = await response.json() as { data?: { recoveryCodes?: string[] }; error?: { message?: string } };
    if (!response.ok || !body.data) return setMessage(body.error?.message ?? '验证码验证失败。');
    setRecoveryCodes(body.data.recoveryCodes ?? []);
    setEnrollment(null);
    setProof('');
    setMessage('MFA 已启用。恢复码仅显示这一次。');
  }

  async function beginStepUp() {
    const response = await api.post('/api/v1/admin/auth/step-up', { purpose: 'HIGH_RISK_BUSINESS_ACTION' });
    const body = await response.json() as { data?: Challenge; error?: { message?: string } };
    if (!response.ok || !body.data) return setMessage(body.error?.message ?? '无法开始近期验证。');
    setChallenge(body.data);
    setMessage('输入验证器验证码或一枚未使用的恢复码。');
  }

  async function completeStepUp(method: 'TOTP' | 'RECOVERY_CODE') {
    if (!challenge) return;
    const response = await api.post(`/api/v1/admin/auth/step-up/${encodeURIComponent(challenge.challengeId)}/complete`, { method, proof });
    const body = await response.json() as { data?: { validUntil: string }; error?: { message?: string } };
    if (!response.ok || !body.data) return setMessage(body.error?.message ?? '近期验证失败。');
    setChallenge(null);
    setProof('');
    setMessage(`近期验证有效至 ${new Date(body.data.validUntil).toLocaleString('zh-CN')}。`);
  }

  return (
    <section className="dashboard-page security-page" aria-labelledby="security-title">
      <header className="page-heading"><div><span className="page-eyebrow">SECURITY</span><h1 id="security-title">账户安全与操作范围</h1><p>管理多因素验证，并查看由服务端返回的当前执行边界。</p></div></header>
      <div className="card-grid">
        <PolicyItem title="当前层级" value={capabilities.level ?? '未知'} />
        <PolicyItem title="礼物直接执行上限" value={formatLimit(capabilities.thresholds?.giftApprovalLimitMinor,capabilities.thresholds?.currency)} />
        <PolicyItem title="退款直接执行上限" value={formatLimit(capabilities.thresholds?.refundLimitMinor,capabilities.thresholds?.currency)} />
        <PolicyItem title="近期验证" value={capabilities.stepUp?.validUntil ? `有效至 ${new Date(capabilities.stepUp.validUntil).toLocaleString('zh-CN')}` : '当前未验证'} />
      </div>
      <div className="content-panel security-guidance"><p>超过当前层级金额上限的操作会进入审批，不会提前扣款、退款或广播。达到执行层级后，敏感操作仍需完成 15 分钟内的近期验证。</p><div className="inline-actions">
        {!capabilities.mfa?.enrolled && <button className="button-primary" type="button" onClick={() => void beginEnrollment()}>绑定验证器</button>}
        <button type="button" onClick={() => void beginStepUp()}>进行近期验证</button>
      </div></div>
      {(enrollment || challenge) && (
        <div className="action-panel">
          <div className="panel-heading"><div><span className="page-eyebrow">VERIFICATION</span><h2>{enrollment ? '绑定验证器' : '近期验证'}</h2></div></div>
          {enrollment && <p className="break-anywhere"><strong>验证器配置：</strong>{enrollment.provisioningUri}</p>}
          <label className="field security-proof"><span>验证码或恢复码</span><input value={proof} onChange={(event) => setProof(event.target.value)} autoComplete="one-time-code" /></label>
          <div className="inline-actions security-proof-actions">
            {enrollment && <button className="button-primary" type="button" onClick={() => void verifyEnrollment()}>确认绑定</button>}
            {challenge && <button type="button" onClick={() => void completeStepUp('TOTP')}>使用验证码确认</button>}
            {challenge && <button type="button" onClick={() => void completeStepUp('RECOVERY_CODE')}>使用恢复码确认</button>}
          </div>
        </div>
      )}
      {recoveryCodes.length > 0 && (
        <div className="state-card state-card--warning recovery-card">
          <h2>一次性恢复码</h2>
          <p>请离线保存。每枚恢复码只能使用一次，关闭或刷新页面后不再显示。</p>
          <pre>{recoveryCodes.join('\n')}</pre>
        </div>
      )}
      {message && <p className="status-message" role="status">{message}</p>}
    </section>
  );
}

function PolicyItem({ title, value }: { title: string; value: string }) {
  return <div className="metric-card"><small>{title}</small><strong>{value}</strong></div>;
}

export function formatLimit(value: number | null | undefined,currency='CAT'): string {
  return value == null ? '无直接执行权限' : formatMinorCurrency(value,currency);
}
