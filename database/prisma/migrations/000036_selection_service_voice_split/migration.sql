ALTER TABLE orders ADD COLUMN selection_voice_channel_id VARCHAR(32);

-- Before this migration M11 stored its Selection room in voice_channel_id.
-- Preserve that identifier and let the finalized Worker create the Service room.
UPDATE orders
SET selection_voice_channel_id = voice_channel_id,
    voice_channel_id = NULL,
    updated_at = now()
WHERE voice_channel_id IS NOT NULL
  AND status IN ('PENDING_DISPATCH', 'ACCEPTED')
  AND EXISTS (
    SELECT 1
    FROM selection_pools
    WHERE selection_pools.order_id = orders.id
  );
