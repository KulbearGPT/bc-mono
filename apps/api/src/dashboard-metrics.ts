import type { Pool } from 'pg';
import type { StaffLevel } from './security.js';
import {
  activeReservationStatuses,
  reservationRemainingMinorSql,
  reservationSettlementLateralSql
} from './reservation-balance.js';

export interface DashboardMetricFacts {
  todayOrderCount: number;
  inProgressOrderCount: number;
  pendingStaffTaskCount: number;
  completedOrderNetConsumptionMinor: number;
  giftNetConsumptionMinor: number;
  activeReservedMinor: number;
  dispatchAcceptedCount: number;
  dispatchStartedCount: number;
  exceptionCount: number;
}

export interface DashboardMetricsSummary {
  windowStart: string;
  windowEnd: string;
  timeZone: 'Asia/Shanghai';
  currency: 'CAT';
  metrics: {
    todayOrderCount: number;
    inProgressOrderCount: number;
    pendingStaffTaskCount: number;
    completedOrderNetConsumptionMinor: number | null;
    giftNetConsumptionMinor: number | null;
    activeReservedMinor: number | null;
    dispatchSuccessRateBps: number;
    exceptionCount: number;
  };
}

export interface DashboardMetricsStore {
  getSummary(input: {
    actorStaffId: string;
    actorLevel: StaffLevel;
    guildId: string | null;
    now: Date;
    timeZone: 'Asia/Shanghai';
    currency: 'CAT';
  }): Promise<DashboardMetricsSummary> | DashboardMetricsSummary;
}

export class InMemoryDashboardMetricsStore implements DashboardMetricsStore {
  constructor(private readonly input: { facts?: DashboardMetricFacts }) {}

  getSummary(input: Parameters<DashboardMetricsStore['getSummary']>[0]): DashboardMetricsSummary {
    return buildDashboardMetricsSummary(this.input.facts ?? emptyFacts(), input);
  }
}

export class PostgresDashboardMetricsStore implements DashboardMetricsStore {
  constructor(private readonly pool: Pool) {}

  async getSummary(input: Parameters<DashboardMetricsStore['getSummary']>[0]): Promise<DashboardMetricsSummary> {
    const window = calculateBusinessDayWindow(input.now, input.timeZone);
    const result = await this.pool.query<DashboardFactsRow>(dashboardFactsSql, [input.actorStaffId, input.actorLevel, input.guildId,
      window.windowStart, window.windowEnd, input.currency]);
    const row = result.rows[0];
    return buildDashboardMetricsSummary({
      todayOrderCount: safe(row?.today_order_count),
      inProgressOrderCount: safe(row?.in_progress_order_count),
      pendingStaffTaskCount: safe(row?.pending_staff_task_count),
      completedOrderNetConsumptionMinor: safe(row?.completed_order_net_consumption_minor),
      giftNetConsumptionMinor: safe(row?.gift_net_consumption_minor),
      activeReservedMinor: safe(row?.active_reserved_minor),
      dispatchAcceptedCount: safe(row?.dispatch_accepted_count),
      dispatchStartedCount: safe(row?.dispatch_started_count),
      exceptionCount: safe(row?.exception_count)
    }, input);
  }
}

const dashboardReservationSettlementJoin = reservationSettlementLateralSql('fr', 'settlement');
const dashboardReservationRemainingMinor = reservationRemainingMinorSql('fr', 'settlement');

const dashboardFactsSql = `
WITH visible_orders AS (
  SELECT o.* FROM orders o
  WHERE o.guild_id=$3::text AND (
    $2::text IN ('L2_SUPERVISOR','L3_OPERATIONS','L4_ADMIN_OWNER')
    OR ($2::text='L1_SUPPORT' AND EXISTS (
      SELECT 1 FROM staff_tasks st WHERE st.order_id=o.id AND st.claimed_by_staff_id=$1::uuid
        AND st.status IN ('CLAIMED','VERIFIED','PENDING_APPROVAL')
    )))
), visible_pending_tasks AS (
  SELECT st.* FROM staff_tasks st
  LEFT JOIN orders direct_order ON direct_order.id=st.order_id
  LEFT JOIN gift_requests gr ON gr.id=st.gift_request_id
  LEFT JOIN orders gift_order ON gift_order.id=gr.order_id
  WHERE st.status IN ('OPEN','CLAIMED','VERIFIED','PENDING_APPROVAL')
    AND COALESCE(direct_order.guild_id,gift_order.guild_id,st.context_snapshot->>'guildId')=$3::text AND (
    $2::text IN ('L2_SUPERVISOR','L3_OPERATIONS','L4_ADMIN_OWNER')
    OR ($2::text='L1_SUPPORT' AND st.claimed_by_staff_id=$1::uuid)
  )
), reservation_remainders AS (
  SELECT fr.id,fr.order_id,${dashboardReservationRemainingMinor} AS remaining_minor
  FROM fund_reservations fr JOIN visible_orders vo ON vo.id=fr.order_id
  ${dashboardReservationSettlementJoin}
  WHERE fr.currency=$6::text AND fr.status IN (${activeReservationStatuses.map(status => `'${status}'`).join(',')})
), exception_keys AS (
  SELECT 'order:'||vo.id::text AS key FROM visible_orders vo WHERE vo.status='EXCEPTION'
  UNION
  SELECT COALESCE('order:'||st.order_id::text,'gift:'||st.gift_request_id::text,'task:'||st.id::text)
  FROM visible_pending_tasks st
  WHERE st.type IN ('CANCELLATION_ASSIST','PLAYER_START_LATE','PLAYER_NO_SHOW','CUSTOMER_NO_SHOW','SERVICE_INTERRUPTED','COMPLETION_REVIEW','DISPUTE','AUTOMATION_FAILURE')
    OR st.reason_code IN ('READINESS_TIMEOUT','INSUFFICIENT_AVAILABLE_BALANCE','RESERVATION_CONFLICT','DISPATCH_TIMEOUT')
  UNION
  SELECT 'order:'||fr.order_id::text FROM fund_reservations fr JOIN visible_orders vo ON vo.id=fr.order_id
  WHERE fr.status IN ('DISPUTED','FAILED','EXPIRED') AND vo.status NOT IN ('COMPLETED','CANCELLED')
)
SELECT
  (SELECT count(*) FROM visible_orders WHERE created_at >= $4::timestamptz AND created_at < $5::timestamptz) AS today_order_count,
  (SELECT count(*) FROM visible_orders WHERE status IN ('PENDING_DISPATCH','ACCEPTED','IN_SERVICE','PENDING_CONFIRMATION')) AS in_progress_order_count,
  (SELECT count(*) FROM visible_pending_tasks) AS pending_staff_task_count,
  (SELECT COALESCE(sum(CASE ce.direction WHEN 'DEBIT' THEN ce.amount_minor ELSE -ce.amount_minor END),0)
    FROM consumption_entries ce JOIN visible_orders vo ON vo.id=ce.order_id
    WHERE vo.completed_at >= $4::timestamptz AND vo.completed_at < $5::timestamptz AND ce.currency=$6::text) AS completed_order_net_consumption_minor,
  (SELECT COALESCE(sum(CASE ce.direction WHEN 'DEBIT' THEN ce.amount_minor ELSE -ce.amount_minor END),0)
    FROM consumption_entries ce JOIN gift_requests gr ON gr.id=ce.gift_request_id JOIN visible_orders vo ON vo.id=gr.order_id
    WHERE ce.occurred_at >= $4::timestamptz AND ce.occurred_at < $5::timestamptz AND ce.currency=$6::text) AS gift_net_consumption_minor,
  (SELECT COALESCE(sum(remaining_minor),0) FROM reservation_remainders) AS active_reserved_minor,
  (SELECT count(*) FILTER (WHERE da.status='ACCEPTED') FROM dispatch_attempts da JOIN visible_orders vo ON vo.id=da.order_id
    WHERE da.started_at >= $4::timestamptz AND da.started_at < $5::timestamptz AND da.status NOT IN ('PENDING','CANCELLED')) AS dispatch_accepted_count,
  (SELECT count(*) FROM dispatch_attempts da JOIN visible_orders vo ON vo.id=da.order_id
    WHERE da.started_at >= $4::timestamptz AND da.started_at < $5::timestamptz AND da.status NOT IN ('PENDING','CANCELLED')) AS dispatch_started_count,
  (SELECT count(*) FROM exception_keys) AS exception_count`;

export function calculateBusinessDayWindow(current: Date, timeZone: 'Asia/Shanghai') {
  if (timeZone !== 'Asia/Shanghai') throw new TypeError('The P0 business timezone must be Asia/Shanghai.');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(current).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  const start = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 8 * 60 * 60 * 1000);
  return { windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 86_400_000).toISOString() };
}

function buildDashboardMetricsSummary(facts: DashboardMetricFacts, input: Parameters<DashboardMetricsStore['getSummary']>[0]): DashboardMetricsSummary {
  const window = calculateBusinessDayWindow(input.now, input.timeZone);
  const mayViewMoney = input.actorLevel !== 'L1_SUPPORT';
  return {
    ...window,
    timeZone: input.timeZone,
    currency: input.currency,
    metrics: {
      todayOrderCount: count(facts.todayOrderCount),
      inProgressOrderCount: count(facts.inProgressOrderCount),
      pendingStaffTaskCount: count(facts.pendingStaffTaskCount),
      completedOrderNetConsumptionMinor: mayViewMoney ? minor(facts.completedOrderNetConsumptionMinor) : null,
      giftNetConsumptionMinor: mayViewMoney ? minor(facts.giftNetConsumptionMinor) : null,
      activeReservedMinor: mayViewMoney ? minor(facts.activeReservedMinor) : null,
      dispatchSuccessRateBps: facts.dispatchStartedCount === 0 ? 0 : Math.floor(count(facts.dispatchAcceptedCount) * 10_000 / count(facts.dispatchStartedCount)),
      exceptionCount: count(facts.exceptionCount)
    }
  };
}

function emptyFacts(): DashboardMetricFacts {
  return { todayOrderCount: 0, inProgressOrderCount: 0, pendingStaffTaskCount: 0, completedOrderNetConsumptionMinor: 0,
    giftNetConsumptionMinor: 0, activeReservedMinor: 0, dispatchAcceptedCount: 0, dispatchStartedCount: 0, exceptionCount: 0 };
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Dashboard count must be a non-negative safe integer.');
  return value;
}

function minor(value: number): number {
  if (!Number.isSafeInteger(value)) throw new TypeError('Dashboard amount must be a safe integer.');
  return Math.max(0, value);
}

function safe(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) throw new TypeError('Dashboard aggregate is outside the safe integer range.');
  return parsed;
}

interface DashboardFactsRow {
  today_order_count: string | number; in_progress_order_count: string | number; pending_staff_task_count: string | number;
  completed_order_net_consumption_minor: string | number; gift_net_consumption_minor: string | number; active_reserved_minor: string | number;
  dispatch_accepted_count: string | number; dispatch_started_count: string | number; exception_count: string | number;
}
