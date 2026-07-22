-- Persist the single Discord recruitment card and its stable numeric reaction mapping.
-- These columns are delivery projections; SelectionApplication remains the business fact.
ALTER TABLE selection_pools
  ADD COLUMN recruitment_channel_id VARCHAR(32),
  ADD COLUMN recruitment_message_id VARCHAR(32),
  ADD COLUMN reaction_bindings JSONB;

CREATE UNIQUE INDEX selection_pools_recruitment_message_id_key
  ON selection_pools(recruitment_message_id)
  WHERE recruitment_message_id IS NOT NULL;

ALTER TABLE selection_pools
  ADD CONSTRAINT selection_pools_reaction_delivery_complete_check CHECK (
    (recruitment_channel_id IS NULL AND recruitment_message_id IS NULL AND reaction_bindings IS NULL)
    OR (
      recruitment_channel_id IS NOT NULL
      AND recruitment_message_id IS NOT NULL
      AND reaction_bindings IS NOT NULL
      AND jsonb_typeof(reaction_bindings) = 'array'
      AND jsonb_array_length(reaction_bindings) BETWEEN 1 AND 9
    )
  );
