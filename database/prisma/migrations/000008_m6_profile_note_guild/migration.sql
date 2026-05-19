ALTER TABLE customer_profile_notes
  ADD COLUMN guild_id varchar(32);

COMMENT ON COLUMN customer_profile_notes.guild_id IS
  'Trusted Discord Guild provenance. NULL legacy rows remain hidden until explicitly reviewed and attributed.';

CREATE INDEX customer_profile_notes_guild_user_created_idx
  ON customer_profile_notes(guild_id, user_id, created_at DESC, id DESC);
