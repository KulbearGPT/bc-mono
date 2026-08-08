CREATE OR REPLACE FUNCTION enforce_order_readiness_guard()
RETURNS trigger AS $$
DECLARE
  active_participant_count BIGINT;
  unready_participant_count BIGINT;
BEGIN
  IF OLD.status = 'ACCEPTED' AND NEW.status = 'IN_SERVICE'
    AND COALESCE(current_setting('app.service_start_override', true), '') <> 'approved' THEN
    SELECT
      count(*),
      count(*) FILTER (WHERE ready_at IS NULL)
    INTO active_participant_count, unready_participant_count
    FROM order_participants
    WHERE order_id = NEW.id
      AND status = 'ACTIVE';

    IF active_participant_count = 0 THEN
      RAISE EXCEPTION 'trg_order_readiness_guard requires active participant facts before service start';
    END IF;
    IF unready_participant_count > 0 THEN
      RAISE EXCEPTION 'trg_order_readiness_guard requires all active order participants ready before service start';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN orders.customer_ready_at IS
  'Legacy compatibility column. Current customer actions never write readiness and this column is not a service-start condition.';
