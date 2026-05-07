export type DashboardStaffLevel = 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER';
export type DashboardResumeAction = 'REDISPATCH' | 'RESTART_READINESS_TIMEOUT' | 'NONE';

export interface AutomationControlViewInput {
  orderId: string;
  orderVersion: number;
  orderStatus: string;
  automationState: 'RUNNING' | 'PAUSED';
  automationExpiresAt: string | null;
  staffLevel: DashboardStaffLevel;
  hasClaimedOrderTask: boolean;
}

export interface AutomationControlView {
  statusLabel: '自动处理中' | '客服处理中';
  expiresAt: string | null;
  resumeAction: DashboardResumeAction;
  actions: Array<{
    id: 'PAUSE' | 'RESUME';
    label: string;
    enabled: boolean;
    operationId: 'pauseOrderAutomation' | 'resumeOrderAutomation';
  }>;
}

export function buildAutomationControlView(input: AutomationControlViewInput): AutomationControlView {
  const canPause = input.automationState === 'RUNNING'
    && (input.staffLevel !== 'L1_SUPPORT' || input.hasClaimedOrderTask);
  const canResume = input.automationState === 'PAUSED' && input.staffLevel !== 'L1_SUPPORT';
  return {
    statusLabel: input.automationState === 'PAUSED' ? '客服处理中' : '自动处理中',
    expiresAt: input.automationExpiresAt,
    resumeAction: resolveResumeAction(input.orderStatus),
    actions: [
      { id: 'PAUSE', label: '暂停自动流程', enabled: canPause, operationId: 'pauseOrderAutomation' },
      { id: 'RESUME', label: '恢复自动流程', enabled: canResume, operationId: 'resumeOrderAutomation' }
    ]
  };
}

function resolveResumeAction(orderStatus: string): DashboardResumeAction {
  if (orderStatus === 'PENDING_DISPATCH') return 'REDISPATCH';
  if (orderStatus === 'ACCEPTED') return 'RESTART_READINESS_TIMEOUT';
  return 'NONE';
}
