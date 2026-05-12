import { describe, expect, test } from 'vitest';
import {
  buildAuditLogView,
  buildFailedJobsView,
  buildOperationsError,
  buildPolicySettingsView,
  buildRetryJobRequest,
  buildUpdatePolicySettingRequest
} from '../apps/dashboard/src/operations.js';

const auditRow = {
  id: 'audit-1',
  actorId: 'staff-1',
  actorLevel: 'L2_SUPERVISOR',
  actorSource: 'STAFF',
  clientId: 'dashboard',
  interactionId: null,
  permissionCode: 'job.retry',
  action: 'JOB_RETRY',
  targetType: 'OUTBOX_JOB',
  targetId: 'job-1',
  reason: 'DELIVERY_RECOVERY',
  requestId: 'req-audit-row',
  approvalRequestId: null,
  occurredAt: '2026-07-18T12:00:00.000Z'
};

const failedJob = {
  id: 'job-1',
  type: 'GIFT_ANNOUNCEMENT',
  status: 'FAILED',
  attempts: 3,
  lastError: 'Discord channel unavailable',
  runAfter: '2026-07-18T12:05:00.000Z',
  version: 4
};

describe('M4-US-06 Dashboard operations presenter', () => {
  test('shows immutable audit rows and cursor only with audit.read', () => {
    const allowed = buildAuditLogView({
      permissions: ['audit.read'], status: 'READY', items: [auditRow], nextCursor: 'audit-next'
    });
    const denied = buildAuditLogView({
      permissions: [], status: 'READY', items: [auditRow], nextCursor: 'audit-next'
    });

    expect(allowed).toMatchObject({
      kind: 'READY', endpoint: '/api/v1/admin/audit-logs', requiredPermission: 'audit.read',
      rows: [{ id: 'audit-1', action: 'JOB_RETRY', requestId: 'req-audit-row', readOnly: true }],
      pagination: { hasNext: true, nextCursor: 'audit-next' }
    });
    expect(denied).toMatchObject({ kind: 'FORBIDDEN', rows: [], pagination: { hasNext: false, nextCursor: null } });
  });

  test('models loading, empty and requestId-bearing audit errors without stale rows', () => {
    const base = { permissions: ['audit.read'], items: [auditRow], nextCursor: null };
    expect(buildAuditLogView({ ...base, status: 'LOADING' })).toMatchObject({ kind: 'LOADING', rows: [] });
    expect(buildAuditLogView({ ...base, status: 'READY', items: [] })).toMatchObject({ kind: 'EMPTY', rows: [] });
    expect(buildAuditLogView({ ...base, status: 'ERROR', requestId: 'req-audit-failure' })).toMatchObject({
      kind: 'ERROR', rows: [], error: { requestId: 'req-audit-failure', requestIdLabel: '请求编号：req-audit-failure' }
    });
  });

  test('enables retry only for failed jobs with job.retry and disables an in-flight retry', () => {
    const ready = buildFailedJobsView({
      permissions: ['job.read', 'job.retry'], status: 'READY', items: [failedJob], retryingJobIds: []
    });
    const retrying = buildFailedJobsView({
      permissions: ['job.read', 'job.retry'], status: 'READY', items: [failedJob], retryingJobIds: ['job-1']
    });
    const readOnly = buildFailedJobsView({
      permissions: ['job.read'], status: 'READY', items: [failedJob], retryingJobIds: []
    });

    expect(ready.rows[0]).toMatchObject({ retry: { visible: true, enabled: true, state: 'IDLE' } });
    expect(retrying.rows[0]).toMatchObject({ retry: { visible: true, enabled: false, state: 'SUBMITTING' } });
    expect(readOnly.rows[0]).toMatchObject({ retry: { visible: false, enabled: false, state: 'UNAVAILABLE' } });
  });

  test('does not offer retry for non-failed job data even if the server returns it', () => {
    const view = buildFailedJobsView({
      permissions: ['job.read', 'job.retry'], status: 'READY',
      items: [{ ...failedJob, status: 'PENDING' }], retryingJobIds: []
    });

    expect(view.rows[0]?.retry).toEqual({ visible: true, enabled: false, state: 'UNAVAILABLE' });
  });

  test('does not offer L2 manual retry for timeout or Role reconciliation jobs', () => {
    const view = buildFailedJobsView({
      permissions: ['job.read', 'job.retry'], status: 'READY',
      items: [{ ...failedJob, type: 'ROLE_RECONCILIATION' }, { ...failedJob, id: 'job-2', type: 'DISPATCH_TIMEOUT' }, { ...failedJob, id: 'job-3', type: 'CHANNEL_CREATE_FAILURE' }]
    });
    expect(view.rows.map((row) => row.retry.enabled)).toEqual([false, false, false]);
  });

  test('maps retry to the unified API with optimistic version and a required reason', () => {
    expect(buildRetryJobRequest(failedJob, 'DELIVERY_RECOVERY', 'Channel permissions restored.')).toEqual({
      method: 'POST',
      path: '/api/v1/admin/jobs/job-1/retry',
      body: { expectedVersion: 4, reasonCode: 'DELIVERY_RECOVERY', note: 'Channel permissions restored.' }
    });
    expect(() => buildRetryJobRequest(failedJob, '  ')).toThrow(/reasonCode/);
  });

  test('shows versioned settings only to policy readers and gates edits separately', () => {
    const item = { key: 'DISPATCH_ROUND_TIMEOUT_SECONDS', integerValue: 300, currency: null, version: 7 };
    const editable = buildPolicySettingsView({
      permissions: ['policy.read', 'policy.manage'], status: 'READY', items: [item]
    });
    const readOnly = buildPolicySettingsView({ permissions: ['policy.read'], status: 'READY', items: [item] });
    const denied = buildPolicySettingsView({ permissions: [], status: 'READY', items: [item] });

    expect(editable.rows[0]).toMatchObject({ key: item.key, integerValue: 300, version: 7, edit: { visible: true, enabled: true } });
    expect(readOnly.rows[0]?.edit).toEqual({ visible: false, enabled: false });
    expect(denied).toMatchObject({ kind: 'FORBIDDEN', rows: [] });
  });

  test('maps a policy edit to an append-version request without changing the source row', () => {
    const setting = { key: 'L2_GIFT_APPROVAL_LIMIT_MINOR', integerValue: 200_000, currency: 'CNY', version: 2 };

    expect(buildUpdatePolicySettingRequest(setting, {
      integerValue: 250_000, currency: 'CNY', reasonCode: 'LIMIT_REVIEW'
    })).toEqual({
      method: 'PUT',
      path: '/api/v1/admin/policy-settings/L2_GIFT_APPROVAL_LIMIT_MINOR',
      body: { expectedVersion: 2, integerValue: 250_000, currency: 'CNY', reasonCode: 'LIMIT_REVIEW' }
    });
    expect(setting).toEqual({ key: 'L2_GIFT_APPROVAL_LIMIT_MINOR', integerValue: 200_000, currency: 'CNY', version: 2 });
  });

  test('presents API error details with a visible requestId for staff escalation', () => {
    expect(buildOperationsError({
      requestId: 'req-channel-create',
      error: { code: 'SERVICE_UNAVAILABLE', message: 'Discord channel creation failed.', retryable: true, details: [] }
    })).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Discord channel creation failed.',
      retryable: true,
      requestId: 'req-channel-create',
      requestIdLabel: '请求编号：req-channel-create'
    });
  });
});
