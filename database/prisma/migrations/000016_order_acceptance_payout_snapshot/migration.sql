CREATE OR REPLACE FUNCTION protect_amount_minor_update()
RETURNS trigger AS $$
DECLARE
  protected_column text;
BEGIN
  FOREACH protected_column IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD)->protected_column IS DISTINCT FROM to_jsonb(NEW)->protected_column THEN
      IF TG_TABLE_NAME = 'orders'
        AND OLD.status = 'DRAFT'
        AND NEW.status = 'DRAFT'
        AND COALESCE(current_setting('app.order_draft_amount_update', true), '') = 'approved' THEN
        CONTINUE;
      END IF;
      IF TG_TABLE_NAME = 'orders'
        AND OLD.status = 'PENDING_DISPATCH'
        AND NEW.status = 'ACCEPTED'
        AND protected_column IN ('player_unit_payout_minor', 'expected_player_earning_minor')
        AND COALESCE(current_setting('app.order_acceptance_payout_update', true), '') = 'approved' THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'protected amount column %.% cannot be updated directly', TG_TABLE_NAME, protected_column;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
