-- Existing COLLECTING pools predate persisted reaction delivery. Queue one
-- idempotent sync so the Worker converts their single offer card in place.
INSERT INTO outbox_events(
  id,event_type,aggregate_type,aggregate_id,order_id,selection_pool_id,
  dedupe_key,payload,status,row_version,attempt_count,max_attempts,
  available_at,created_at,updated_at
)
SELECT
  gen_random_uuid(),'SELECTION_POOL_SYNC','selection_pool',pool.id,pool.order_id,pool.id,
  'selection-reaction-card-backfill:'||pool.id,
  jsonb_build_object('orderId',pool.order_id,'selectionPoolId',pool.id,'phase','COLLECTING'),
  'PENDING',1,0,8,now(),now(),now()
FROM selection_pools pool
WHERE pool.status='COLLECTING'
  AND pool.recruitment_message_id IS NULL
ON CONFLICT(dedupe_key) DO NOTHING;
