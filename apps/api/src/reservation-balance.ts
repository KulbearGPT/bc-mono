export const activeReservationStatuses = [
  'PENDING',
  'ACTIVE',
  'DISPUTED',
  'PARTIALLY_SETTLED'
] as const;

const settlementEventTypes = new Set(['CAPTURED', 'RELEASED', 'EXPIRED']);

export interface ReservationBalanceFact {
  id: string;
  userId: string;
  currency: string;
  status: string;
  amountMinor: number;
}

export interface ReservationSettlementFact {
  fundReservationId: string;
  eventType: string;
  amountMinor: number;
}

export function activeReservationRemainder(
  amountMinor: number,
  events: ReadonlyArray<Pick<ReservationSettlementFact, 'eventType' | 'amountMinor'>>
): number {
  assertMinor(amountMinor);
  const settledMinor = events.reduce((total, event) => {
    assertMinor(event.amountMinor);
    return settlementEventTypes.has(event.eventType) ? total + event.amountMinor : total;
  }, 0);
  if (!Number.isSafeInteger(settledMinor)) throw new RangeError('Reservation settlement total is outside the safe integer range.');
  return Math.max(amountMinor - settledMinor, 0);
}

export function sumActiveReservationRemainders(
  reservations: ReadonlyArray<ReservationBalanceFact>,
  events: ReadonlyArray<ReservationSettlementFact>,
  scope: { userId: string; currency: string; excludeReservationId?: string }
): number {
  const eventsByReservation = new Map<string, ReservationSettlementFact[]>();
  for (const event of events) {
    const grouped = eventsByReservation.get(event.fundReservationId) ?? [];
    grouped.push(event);
    eventsByReservation.set(event.fundReservationId, grouped);
  }
  const total = reservations.reduce((sum, reservation) => {
    if (
      reservation.userId !== scope.userId ||
      reservation.currency !== scope.currency ||
      reservation.id === scope.excludeReservationId ||
      !activeReservationStatuses.includes(reservation.status as (typeof activeReservationStatuses)[number])
    ) {
      return sum;
    }
    return sum + activeReservationRemainder(reservation.amountMinor, eventsByReservation.get(reservation.id) ?? []);
  }, 0);
  if (!Number.isSafeInteger(total)) throw new RangeError('Active reservation total is outside the safe integer range.');
  return total;
}

export function reservationSettlementLateralSql(reservationAlias: string, settlementAlias: string): string {
  assertSqlIdentifier(reservationAlias);
  assertSqlIdentifier(settlementAlias);
  return `LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount_minor),0) AS settled_minor
    FROM fund_reservation_events
    WHERE fund_reservation_id=${reservationAlias}.id AND event_type IN ('CAPTURED','RELEASED','EXPIRED')
  ) ${settlementAlias} ON true`;
}

export function reservationRemainingMinorSql(reservationAlias: string, settlementAlias: string): string {
  assertSqlIdentifier(reservationAlias);
  assertSqlIdentifier(settlementAlias);
  return `GREATEST(${reservationAlias}.amount_minor-COALESCE(${settlementAlias}.settled_minor,0),0)`;
}

function assertMinor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Reservation amount must be a non-negative safe integer.');
}

function assertSqlIdentifier(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new TypeError('SQL alias is invalid.');
}
