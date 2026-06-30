import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { registerSecureReadRoute, registerSecureWriteRoute, type ActorContext, type StaffLevel } from './security.js';

export interface SupportShiftRecord {
  id: string;
  guildId: string;
  staffId: string;
  clockedInAt: string;
  clockedOutAt: string | null;
}

export interface SupportSummaryItem {
  staffId: string;
  displayName: string;
  clockedIn: boolean;
  shiftSeconds: number;
  handledTaskCount: number;
  overdueTaskCount: number;
  ratingCount: number;
  averageRating: number | null;
}

export interface SupportSummary {
  windowStartedAt: string;
  calculatedAt: string;
  items: SupportSummaryItem[];
  unclaimedOverdueCount: number;
}

interface Scope { guildId: string; staffId: string }

export interface SupportOperationsStore {
  getCurrentShift(input: Scope): Promise<SupportShiftRecord | null> | SupportShiftRecord | null;
  clockIn(input: Scope & { now: Date }): Promise<SupportShiftRecord> | SupportShiftRecord;
  clockOut(input: Scope & { now: Date }): Promise<SupportShiftRecord> | SupportShiftRecord;
  summary(input: Scope & { actorLevel: StaffLevel; now: Date }): Promise<SupportSummary> | SupportSummary;
}

export class SupportOperationsError extends Error {
  constructor(
    readonly code: 'PERMISSION_DENIED' | 'ACTIVE_CLAIMED_TASKS' | 'NO_ACTIVE_SHIFT',
    message: string
  ) {
    super(message);
    this.name = 'SupportOperationsError';
  }
}

export class InMemorySupportOperationsStore implements SupportOperationsStore {
  readonly shifts: SupportShiftRecord[] = [];
  readonly claimedTaskStaffIds = new Set<string>();
  readonly metrics = new Map<string, Pick<SupportSummaryItem, 'handledTaskCount' | 'overdueTaskCount' | 'ratingCount' | 'averageRating'>>();
  unclaimedOverdueCount = 0;

  constructor(private readonly input: { staff: Array<{ staffId: string; displayName: string; level: StaffLevel }> }) {}

  getCurrentShift(input: Scope) {
    return clone(this.shifts.find((item) => item.guildId === input.guildId && item.staffId === input.staffId && item.clockedOutAt === null) ?? null);
  }

  clockIn(input: Scope & { now: Date }) {
    const existing = this.getCurrentShift(input);
    if (existing) return existing;
    const shift: SupportShiftRecord = {
      id: crypto.randomUUID(), guildId: input.guildId, staffId: input.staffId,
      clockedInAt: input.now.toISOString(), clockedOutAt: null
    };
    this.shifts.push(shift);
    return clone(shift);
  }

  clockOut(input: Scope & { now: Date }) {
    const active = this.shifts.find((item) => item.guildId === input.guildId && item.staffId === input.staffId && item.clockedOutAt === null);
    if (!active) throw new SupportOperationsError('NO_ACTIVE_SHIFT', 'No active support shift was found.');
    if (this.claimedTaskStaffIds.has(input.staffId)) {
      throw new SupportOperationsError('ACTIVE_CLAIMED_TASKS', 'Resolve or release claimed tasks before clocking out.');
    }
    active.clockedOutAt = input.now.toISOString();
    return clone(active);
  }

  summary(input: Scope & { actorLevel: StaffLevel; now: Date }): SupportSummary {
    const windowStart = new Date(input.now.getTime() - 30 * 86_400_000);
    const visible = input.actorLevel === 'L1_SUPPORT'
      ? this.input.staff.filter((item) => item.staffId === input.staffId)
      : this.input.staff;
    return {
      windowStartedAt: windowStart.toISOString(), calculatedAt: input.now.toISOString(),
      unclaimedOverdueCount: this.unclaimedOverdueCount,
      items: visible.map((staff) => {
        const shifts = this.shifts.filter((item) => item.guildId === input.guildId && item.staffId === staff.staffId
          && new Date(item.clockedInAt) <= input.now && new Date(item.clockedOutAt ?? input.now) >= windowStart);
        const metric = this.metrics.get(staff.staffId);
        return {
          staffId: staff.staffId, displayName: staff.displayName,
          clockedIn: shifts.some((shift) => shift.clockedOutAt === null),
          shiftSeconds: shifts.reduce((total, shift) => total + Math.max(0, Math.floor(((shift.clockedOutAt
            ? new Date(shift.clockedOutAt) : input.now).getTime() - Math.max(new Date(shift.clockedInAt).getTime(), windowStart.getTime())) / 1_000)), 0),
          handledTaskCount: metric?.handledTaskCount ?? 0, overdueTaskCount: metric?.overdueTaskCount ?? 0,
          ratingCount: metric?.ratingCount ?? 0, averageRating: metric?.averageRating ?? null
        };
      })
    };
  }
}

export class PostgresSupportOperationsStore implements SupportOperationsStore {
  constructor(private readonly pool: Pool) {}

  async getCurrentShift(input: Scope) {
    const result = await this.pool.query<ShiftRow>(
      'SELECT * FROM support_shifts WHERE guild_id = $1 AND staff_account_id = $2 AND clocked_out_at IS NULL LIMIT 1',
      [input.guildId, input.staffId]
    );
    return result.rows[0] ? mapShift(result.rows[0]) : null;
  }

  async clockIn(input: Scope & { now: Date }) {
    const result = await this.pool.query<ShiftRow>(`INSERT INTO support_shifts (id, guild_id, staff_account_id, clocked_in_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $3, $3)
      ON CONFLICT (guild_id, staff_account_id) WHERE clocked_out_at IS NULL
      DO UPDATE SET guild_id = EXCLUDED.guild_id RETURNING *`, [input.guildId, input.staffId, input.now]);
    return mapShift(result.rows[0]!);
  }

  async clockOut(input: Scope & { now: Date }) {
    return transaction(this.pool, async (client) => {
      const shift = await client.query<ShiftRow>(
        'SELECT * FROM support_shifts WHERE guild_id = $1 AND staff_account_id = $2 AND clocked_out_at IS NULL FOR UPDATE',
        [input.guildId, input.staffId]
      );
      if (!shift.rows[0]) throw new SupportOperationsError('NO_ACTIVE_SHIFT', 'No active support shift was found.');
      const tasks = await client.query(`SELECT st.id FROM staff_tasks st LEFT JOIN orders o ON o.id = st.order_id
        WHERE st.claimed_by_staff_id = $1 AND st.status = 'CLAIMED'
        AND COALESCE(o.guild_id, st.context_snapshot->>'guildId') = $2 LIMIT 1`, [input.staffId, input.guildId]);
      if (tasks.rows[0]) throw new SupportOperationsError('ACTIVE_CLAIMED_TASKS', 'Resolve or release claimed tasks before clocking out.');
      const ended = await client.query<ShiftRow>(
        'UPDATE support_shifts SET clocked_out_at = $2, updated_at = $2 WHERE id = $1 RETURNING *',
        [shift.rows[0].id, input.now]
      );
      return mapShift(ended.rows[0]!);
    });
  }

  async summary(input: Scope & { actorLevel: StaffLevel; now: Date }): Promise<SupportSummary> {
    const start = new Date(input.now.getTime() - 30 * 86_400_000);
    const selfOnly = input.actorLevel === 'L1_SUPPORT';
    const result = await this.pool.query<SummaryRow>(`WITH guild_staff AS (
      SELECT DISTINCT sa.id, u.display_name, sa.level::text AS level
      FROM staff_accounts sa JOIN users u ON u.id = sa.user_id JOIN discord_accounts da ON da.user_id = u.id
      WHERE da.guild_id = $1 AND sa.status = 'ACTIVE' AND ($4::boolean = false OR sa.id = $2)
    ), shift_stats AS (
      SELECT staff_account_id, bool_or(clocked_out_at IS NULL) clocked_in,
        floor(sum(extract(epoch from (LEAST(COALESCE(clocked_out_at, $3), $3) - GREATEST(clocked_in_at, $5)))))::int shift_seconds
      FROM support_shifts WHERE guild_id = $1 AND clocked_in_at <= $3 AND COALESCE(clocked_out_at, $3) >= $5 GROUP BY staff_account_id
    ), task_stats AS (
      SELECT st.claimed_by_staff_id staff_id, count(*)::int claimed_count,
        count(*) FILTER (WHERE st.response_status = 'OVERDUE' OR st.first_responded_at > st.response_due_at)::int overdue_count
      FROM staff_tasks st LEFT JOIN orders o ON o.id = st.order_id
      WHERE st.claimed_at >= $5 AND COALESCE(o.guild_id, st.context_snapshot->>'guildId') = $1 GROUP BY st.claimed_by_staff_id
    ), rating_stats AS (
      SELECT attributed_staff_id staff_id, count(*)::int rating_count, avg(score)::float average_rating
      FROM order_support_ratings rating JOIN orders rating_order ON rating_order.id = rating.order_id
      WHERE rating_order.guild_id = $1 AND rating.created_at >= $5 GROUP BY attributed_staff_id
    ) SELECT gs.*, COALESCE(ss.clocked_in,false) clocked_in, COALESCE(ss.shift_seconds,0) shift_seconds, COALESCE(ts.claimed_count,0) claimed_count,
      COALESCE(ts.overdue_count,0) overdue_count, COALESCE(rs.rating_count,0) rating_count, rs.average_rating
      FROM guild_staff gs LEFT JOIN shift_stats ss ON ss.staff_account_id=gs.id LEFT JOIN task_stats ts ON ts.staff_id=gs.id
      LEFT JOIN rating_stats rs ON rs.staff_id=gs.id ORDER BY gs.level, gs.id`,
    [input.guildId, input.staffId, input.now, selfOnly, start]);
    const unclaimed = await this.pool.query<{ count: number }>(`SELECT count(*)::int count FROM staff_tasks st
      LEFT JOIN orders o ON o.id=st.order_id WHERE st.claimed_by_staff_id IS NULL
      AND (st.response_status='OVERDUE' OR st.first_responded_at > st.response_due_at)
      AND st.created_at >= $2 AND COALESCE(o.guild_id, st.context_snapshot->>'guildId')=$1`, [input.guildId, start]);
    return {
      windowStartedAt: start.toISOString(), calculatedAt: input.now.toISOString(),
      unclaimedOverdueCount: unclaimed.rows[0]?.count ?? 0,
      items: result.rows.map((row) => ({
        staffId: row.id, displayName: row.display_name, clockedIn: row.clocked_in,
        shiftSeconds: row.shift_seconds, handledTaskCount: row.claimed_count, overdueTaskCount: row.overdue_count,
        ratingCount: row.rating_count, averageRating: row.average_rating === null ? null : Number(row.average_rating.toFixed(2))
      }))
    };
  }
}

export function registerSupportOperationsRoutes(
  server: FastifyInstance,
  options: { store: SupportOperationsStore; now?: () => Date }
): void {
  if (!server.securityOptions) throw new Error('Support operations routes require security options.');
  const now = options.now ?? (() => new Date());
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/admin/support-shifts/me', permission: 'dashboard.view',
    action: 'GET_MY_SUPPORT_SHIFT', targetType: 'support_shift', acceptedSources: ['DASHBOARD'], mapError,
    handler: (_request, actor) => options.store.getCurrentShift(scope(actor))
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/support-shifts/clock-in', permission: 'dashboard.view',
    action: 'CLOCK_IN_SUPPORT_SHIFT', targetType: 'support_shift', acceptedSources: ['DASHBOARD'], mapError,
    handler: (_request, actor) => { requireSupport(actor); return options.store.clockIn({ ...scope(actor), now: now() }); }
  });
  registerSecureWriteRoute(server, server.securityOptions, {
    method: 'POST', url: '/api/v1/admin/support-shifts/clock-out', permission: 'dashboard.view',
    action: 'CLOCK_OUT_SUPPORT_SHIFT', targetType: 'support_shift', acceptedSources: ['DASHBOARD'], mapError,
    handler: (_request, actor) => { requireSupport(actor); return options.store.clockOut({ ...scope(actor), now: now() }); }
  });
  registerSecureReadRoute(server, server.securityOptions, {
    method: 'GET', url: '/api/v1/admin/support/summary', permission: 'dashboard.view',
    action: 'GET_SUPPORT_SUMMARY', targetType: 'support_summary', acceptedSources: ['DASHBOARD'], mapError,
    handler: (_request, actor) => options.store.summary({ ...scope(actor), actorLevel: actor.actorLevel!, now: now() })
  });
}

function scope(actor: ActorContext): Scope {
  if (!actor.guildId || !actor.actorStaffId || !actor.actorLevel) {
    throw new SupportOperationsError('PERMISSION_DENIED', 'An active Guild staff account is required.');
  }
  return { guildId: actor.guildId, staffId: actor.actorStaffId };
}
function requireSupport(actor: ActorContext) {
  scope(actor);
  if (!['L1_SUPPORT', 'L2_SUPERVISOR'].includes(actor.actorLevel!)) {
    throw new SupportOperationsError('PERMISSION_DENIED', 'Only L1/L2 support staff may clock shifts.');
  }
}
function mapError(error: unknown) {
  if (!(error instanceof SupportOperationsError)) return null;
  return { statusCode: error.code === 'ACTIVE_CLAIMED_TASKS' || error.code === 'NO_ACTIVE_SHIFT' ? 409 : 403,
    code: error.code, message: error.message };
}
function clone<T>(value: T): T { return structuredClone(value); }
interface ShiftRow { id: string; guild_id: string; staff_account_id: string; clocked_in_at: Date | string; clocked_out_at: Date | string | null }
function mapShift(row: ShiftRow): SupportShiftRecord {
  return { id: row.id, guildId: row.guild_id, staffId: row.staff_account_id,
    clockedInAt: new Date(row.clocked_in_at).toISOString(), clockedOutAt: row.clocked_out_at ? new Date(row.clocked_out_at).toISOString() : null };
}
interface SummaryRow {
  id: string; display_name: string; level: StaffLevel; clocked_in: boolean;
  shift_seconds: number; claimed_count: number; overdue_count: number; rating_count: number; average_rating: number | null;
}
async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await action(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
