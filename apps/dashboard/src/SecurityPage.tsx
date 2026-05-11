import { useState } from 'react';
import { createDashboardApiClient, type DashboardCapabilities } from './dashboard-shell.js';

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
    <section style={{ padding: 24, maxWidth: 920 }}>
      <h1 style={{ fontSize: 24 }}>账户安全与操作范围</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <PolicyItem title="当前层级" value={capabilities.level ?? '未知'} />
        <PolicyItem title="礼物直接执行上限" value={formatLimit(capabilities.thresholds?.giftApprovalLimitMinor)} />
        <PolicyItem title="退款直接执行上限" value={formatLimit(capabilities.thresholds?.refundLimitMinor)} />
        <PolicyItem title="近期验证" value={capabilities.stepUp?.validUntil ? `有效至 ${new Date(capabilities.stepUp.validUntil).toLocaleString('zh-CN')}` : '当前未验证'} />
      </div>
      <p style={{ marginTop: 16, color: '#4d6268' }}>超过当前层级金额上限的操作会进入审批，不会提前扣款、退款或广播。达到执行层级后，敏感操作仍需完成 15 分钟内的近期验证。</p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18 }}>
        {!capabilities.mfa?.enrolled && <button type="button" onClick={() => void beginEnrollment()}>绑定验证器</button>}
        <button type="button" onClick={() => void beginStepUp()}>进行近期验证</button>
      </div>
      {(enrollment || challenge) && (
        <div style={{ marginTop: 18, padding: 16, border: '1px solid #cbd7da', background: '#fff' }}>
          {enrollment && <p style={{ overflowWrap: 'anywhere' }}><strong>验证器配置：</strong>{enrollment.provisioningUri}</p>}
          <label style={{ display: 'block', marginBottom: 8 }}>验证码或恢复码</label>
          <input value={proof} onChange={(event) => setProof(event.target.value)} autoComplete="one-time-code" />
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {enrollment && <button type="button" onClick={() => void verifyEnrollment()}>确认绑定</button>}
            {challenge && <button type="button" onClick={() => void completeStepUp('TOTP')}>使用验证码确认</button>}
            {challenge && <button type="button" onClick={() => void completeStepUp('RECOVERY_CODE')}>使用恢复码确认</button>}
          </div>
        </div>
      )}
      {recoveryCodes.length > 0 && (
        <div style={{ marginTop: 18, padding: 16, border: '1px solid #c49a43', background: '#fffaf0' }}>
          <strong>一次性恢复码</strong>
          <p>请离线保存。每枚恢复码只能使用一次，关闭或刷新页面后不再显示。</p>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{recoveryCodes.join('\n')}</pre>
        </div>
      )}
      {message && <p role="status" style={{ marginTop: 16 }}>{message}</p>}
    </section>
  );
}

function PolicyItem({ title, value }: { title: string; value: string }) {
  return <div style={{ padding: 14, border: '1px solid #d9e1e3', background: '#fff' }}><div style={{ color: '#60757b', fontSize: 13 }}>{title}</div><strong>{value}</strong></div>;
}

function formatLimit(value: number | null | undefined): string {
  return value == null ? '无直接执行权限' : `¥${(value / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 })}`;
}
