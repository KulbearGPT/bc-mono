-- New recruitment rounds are manually controlled by the order customer.
-- Legacy timing fields and close reasons remain readable for historical rows.
ALTER TYPE selection_pool_close_reason ADD VALUE IF NOT EXISTS 'CUSTOMER_STOPPED';

ALTER TABLE selection_pools
  DROP CONSTRAINT IF EXISTS selection_pools_wait_minutes_check,
  DROP CONSTRAINT IF EXISTS selection_pools_window_check,
  ALTER COLUMN wait_minutes DROP NOT NULL,
  ALTER COLUMN closes_at DROP NOT NULL;

ALTER TABLE selection_pools
  ADD CONSTRAINT selection_pools_legacy_window_pair_check CHECK (
    (wait_minutes IS NULL AND closes_at IS NULL)
    OR (
      wait_minutes BETWEEN 1 AND 30
      AND closes_at IS NOT NULL
      AND closes_at > opened_at
    )
  );

-- A queued legacy deadline must never move COLLECTING to SELECTION after this contract change.
UPDATE outbox_events
SET status='CANCELLED',row_version=row_version+1,locked_at=NULL,locked_by=NULL,
    last_error='SUPERSEDED_BY_MANUAL_SELECTION_RECRUITMENT',updated_at=now()
WHERE status IN ('PENDING','PROCESSING','FAILED')
  AND event_type='SELECTION_POOL_CLOSE';
