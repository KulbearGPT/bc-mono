ALTER TYPE "FundReservationEventType" ADD VALUE IF NOT EXISTS 'INCREASED';
ALTER TYPE "FundReservationEventType" ADD VALUE IF NOT EXISTS 'DECREASED';

CREATE OR REPLACE FUNCTION protect_amount_minor_update()
RETURNS trigger AS $$
DECLARE
  protected_column text;
  participant_total bigint;
BEGIN
  FOREACH protected_column IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD)->protected_column IS DISTINCT FROM to_jsonb(NEW)->protected_column THEN
      IF TG_TABLE_NAME = 'orders' AND OLD.status::text = 'DRAFT' AND NEW.status::text = 'DRAFT'
        AND COALESCE(current_setting('app.order_draft_amount_update', true), '') = 'approved' THEN CONTINUE; END IF;
      IF TG_TABLE_NAME = 'orders' AND OLD.status::text = 'PENDING_DISPATCH' AND NEW.status::text = 'ACCEPTED'
        AND protected_column IN ('player_unit_payout_minor', 'expected_player_earning_minor')
        AND COALESCE(current_setting('app.order_acceptance_payout_update', true), '') = 'approved' THEN CONTINUE; END IF;
      IF TG_TABLE_NAME = 'orders' AND protected_column IN ('amount_minor', 'expected_player_earning_minor') AND OLD.status = NEW.status
        AND COALESCE(current_setting('app.order_participant_rebalance', true), '') = 'approved'
        AND NOT EXISTS (SELECT 1 FROM fund_reservations reservation WHERE reservation.order_id = OLD.id AND reservation.status = 'CAPTURED') THEN
        SELECT COALESCE(SUM(CASE WHEN protected_column = 'amount_minor' THEN participant.line_price_minor ELSE participant.expected_earning_minor END) FILTER (WHERE participant.status = 'ACTIVE'), 0) INTO participant_total
        FROM order_participants participant WHERE participant.order_id = OLD.id;
        IF (protected_column = 'amount_minor' AND NEW.amount_minor = participant_total)
          OR (protected_column = 'expected_player_earning_minor' AND NEW.expected_player_earning_minor = participant_total) THEN CONTINUE; END IF;
      END IF;
      IF TG_TABLE_NAME = 'fund_reservations' AND protected_column = 'amount_minor'
        AND OLD.status::text = 'ACTIVE' AND NEW.status::text = 'ACTIVE'
        AND COALESCE(current_setting('app.fund_reservation_rebalance', true), '') = 'approved' THEN CONTINUE; END IF;
      RAISE EXCEPTION 'protected amount column %.% cannot be updated directly', TG_TABLE_NAME, protected_column;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_fund_reservation_event_guard()
RETURNS trigger AS $$
DECLARE
  reservation_record fund_reservations%ROWTYPE;
  last_sequence integer;
  settled_amount bigint;
  next_amount bigint;
BEGIN
  SELECT * INTO reservation_record FROM fund_reservations WHERE id = NEW.fund_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fund reservation % not found', NEW.fund_reservation_id; END IF;
  SELECT COALESCE(MAX(sequence), 0) INTO last_sequence FROM fund_reservation_events WHERE fund_reservation_id = NEW.fund_reservation_id;
  IF NEW.sequence <> last_sequence + 1 THEN RAISE EXCEPTION 'fund reservation event sequence must be %, got %', last_sequence + 1, NEW.sequence; END IF;
  IF last_sequence = 0 THEN
    IF NEW.event_type <> 'CREATED' OR NEW.amount_minor <> reservation_record.amount_minor OR NEW.reservation_version <> 1 THEN RAISE EXCEPTION 'first fund reservation event must be CREATED for full reservation amount at version 1'; END IF;
    IF NEW.to_status NOT IN ('ACTIVE', 'PENDING', 'FAILED') THEN RAISE EXCEPTION 'first fund reservation event cannot transition to %', NEW.to_status; END IF;
  ELSE
    IF NEW.from_status IS DISTINCT FROM reservation_record.status THEN RAISE EXCEPTION 'fund reservation event from_status % does not match current status %', NEW.from_status, reservation_record.status; END IF;
    IF NEW.reservation_version <> reservation_record.row_version + 1 THEN RAISE EXCEPTION 'fund reservation event version must be %, got %', reservation_record.row_version + 1, NEW.reservation_version; END IF;
  END IF;
  IF last_sequence > 0 AND NOT (
    (reservation_record.status = 'PENDING' AND NEW.event_type IN ('ACTIVATED', 'FAILED') AND NEW.to_status IN ('ACTIVE', 'FAILED'))
    OR (reservation_record.status = 'ACTIVE' AND NEW.event_type IN ('CAPTURED', 'RELEASED', 'DISPUTED', 'EXPIRED') AND NEW.to_status IN ('PARTIALLY_SETTLED', 'CAPTURED', 'RELEASED', 'DISPUTED', 'EXPIRED'))
    OR (reservation_record.status = 'ACTIVE' AND NEW.event_type IN ('INCREASED', 'DECREASED') AND NEW.to_status = 'ACTIVE')
    OR (reservation_record.status = 'PARTIALLY_SETTLED' AND NEW.event_type IN ('CAPTURED', 'RELEASED', 'DISPUTED') AND NEW.to_status IN ('CAPTURED', 'RELEASED', 'DISPUTED'))
    OR (reservation_record.status = 'DISPUTED' AND NEW.event_type IN ('DISPUTE_RESOLVED', 'CAPTURED', 'RELEASED') AND NEW.to_status IN ('ACTIVE', 'PARTIALLY_SETTLED', 'CAPTURED', 'RELEASED'))
  ) THEN RAISE EXCEPTION 'invalid fund reservation transition from % via % to %', reservation_record.status, NEW.event_type, NEW.to_status; END IF;
  IF NEW.event_type IN ('DISPUTED', 'DISPUTE_RESOLVED', 'FAILED') AND NEW.amount_minor <> 0 THEN RAISE EXCEPTION 'non-settlement fund reservation events must have zero amount'; END IF;
  IF NEW.event_type IN ('INCREASED', 'DECREASED') AND NEW.amount_minor <= 0 THEN RAISE EXCEPTION 'reservation adjustment amount must be positive'; END IF;
  SELECT COALESCE(SUM(amount_minor), 0) INTO settled_amount FROM fund_reservation_events WHERE fund_reservation_id = NEW.fund_reservation_id AND event_type IN ('CAPTURED', 'RELEASED', 'EXPIRED');
  IF NEW.event_type IN ('CAPTURED', 'RELEASED', 'EXPIRED') THEN settled_amount := settled_amount + NEW.amount_minor; END IF;
  next_amount := reservation_record.amount_minor + CASE WHEN NEW.event_type = 'INCREASED' THEN NEW.amount_minor WHEN NEW.event_type = 'DECREASED' THEN -NEW.amount_minor ELSE 0 END;
  IF next_amount < settled_amount OR next_amount <= 0 THEN RAISE EXCEPTION 'reservation adjustment would underflow reserved funds'; END IF;
  IF settled_amount > next_amount THEN RAISE EXCEPTION 'fund_reservation_not_over_settled_chk violated for reservation %', NEW.fund_reservation_id; END IF;
  IF NEW.to_status IN ('CAPTURED', 'RELEASED', 'EXPIRED') AND settled_amount <> next_amount THEN RAISE EXCEPTION 'terminal fund reservation status % requires full settlement for reservation %', NEW.to_status, NEW.fund_reservation_id; END IF;
  PERFORM set_config('app.fund_reservation_rebalance', 'approved', true);
  UPDATE fund_reservations SET amount_minor = next_amount, status = NEW.to_status, row_version = NEW.reservation_version, updated_at = now(), settled_at = CASE WHEN NEW.to_status IN ('CAPTURED', 'RELEASED', 'EXPIRED', 'FAILED') THEN COALESCE(settled_at, now()) ELSE settled_at END WHERE id = NEW.fund_reservation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
