import type { SupportTaskCardInput } from './support-workbench.js';

export interface StaffTaskPayload extends SupportTaskCardInput {
  version: number;
  responseStatus?: 'NOT_REQUIRED' | 'PENDING' | 'MET' | 'OVERDUE';
  responseDueAt?: string | null;
  firstRespondedAt?: string | null;
}

export interface OrderContext {
  order: {
    id: string;
    publicId: string;
    version: number;
    status: string;
    game?: string | null;
    gameDisplayName?: string | null;
    service?: string | null;
    serviceDisplayName?: string | null;
    amountMinor?: number;
    currency?: string;
    customerDisplayName?: string | null;
  };
  readiness?: {
    participants?: Array<{
      participantId: string;
      playerId?: string;
      displayName: string;
      readiness: 'READY' | 'NOT_READY';
    }>;
    allActivePlayersReady: boolean;
    readyDeadlineAt?: string | null;
    startedAt?: string | null;
    staffTaskId?: string | null;
  };
  automation?: {
    state: 'RUNNING' | 'PAUSED';
    version: number;
    reasonCode: string | null;
    expiresAt: string | null;
  };
  matching?: { stage: string; nextStep: string } | null;
  timeline?: { items: unknown[]; nextCursor: string | null };
}

interface DashboardMetrics {
  todayOrderCount: number;
  inProgressOrderCount: number;
  pendingStaffTaskCount: number;
  completedOrderNetConsumptionMinor: number | null;
  giftNetConsumptionMinor: number | null;
  activeReservedMinor: number | null;
  dispatchSuccessRateBps: number;
  exceptionCount: number;
}

export interface DashboardSummaryData {
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  currency: string;
  metrics: DashboardMetrics;
}

export type DashboardMetricState = {
  kind: 'LOADING' | 'READY' | 'ERROR';
  requestId: string | null;
  data: DashboardSummaryData | null;
  stale?: boolean;
};
