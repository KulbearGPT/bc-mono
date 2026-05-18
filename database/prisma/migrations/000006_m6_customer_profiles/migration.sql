CREATE TABLE provider_balance_snapshots (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provider varchar(50) NOT NULL,
  provider_balance_minor bigint NOT NULL CHECK (provider_balance_minor >= 0),
  currency char(3) NOT NULL,
  fetched_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX provider_balance_snapshots_user_currency_fetched_idx
  ON provider_balance_snapshots(user_id, currency, fetched_at DESC, id DESC);

CREATE TABLE customer_profile_notes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  author_staff_id uuid NOT NULL REFERENCES staff_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  body varchar(2000) NOT NULL CHECK (length(btrim(body)) > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX customer_profile_notes_user_created_idx
  ON customer_profile_notes(user_id, created_at DESC, id DESC);

CREATE TRIGGER trg_provider_balance_snapshots_append_only
BEFORE UPDATE OR DELETE ON provider_balance_snapshots
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

CREATE TRIGGER trg_customer_profile_notes_append_only
BEFORE UPDATE OR DELETE ON customer_profile_notes
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

GRANT SELECT, INSERT ON provider_balance_snapshots, customer_profile_notes TO blackcat_app;
REVOKE UPDATE, DELETE ON provider_balance_snapshots, customer_profile_notes FROM blackcat_app;
