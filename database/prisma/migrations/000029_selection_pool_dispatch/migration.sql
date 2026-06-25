CREATE TYPE selection_pool_status AS ENUM ('COLLECTING','SELECTION','FINALIZED','CANCELLED');
CREATE TYPE selection_pool_close_reason AS ENUM ('TIME_ELAPSED','CUSTOMER_EARLY_CLOSE','ORDER_CANCELLED');
CREATE TYPE selection_application_status AS ENUM ('APPLIED','WITHDRAWN','SELECTED','NOT_SELECTED','INVALIDATED');
CREATE TYPE selection_pool_event_type AS ENUM ('CREATED','CLOSED','FINALIZED','CANCELLED','VOICE_SYNC_REQUESTED');
CREATE TYPE selection_application_event_type AS ENUM ('APPLIED','WITHDRAWN','SELECTED','NOT_SELECTED','INVALIDATED');

CREATE TABLE "selection_pools" (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  round INTEGER NOT NULL CHECK (round > 0),
  status selection_pool_status NOT NULL DEFAULT 'COLLECTING',
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  wait_minutes INTEGER NOT NULL CHECK (wait_minutes BETWEEN 1 AND 30),
  opened_at TIMESTAMPTZ(3) NOT NULL,
  closes_at TIMESTAMPTZ(3) NOT NULL,
  closed_at TIMESTAMPTZ(3),
  close_reason selection_pool_close_reason,
  finalized_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT selection_pools_order_round_key UNIQUE(order_id,round),
  CONSTRAINT selection_pools_window_check CHECK (closes_at > opened_at)
);
CREATE UNIQUE INDEX selection_pools_one_active_per_order_idx ON selection_pools(order_id)
  WHERE status IN ('COLLECTING','SELECTION');
CREATE INDEX selection_pools_status_closes_idx ON selection_pools(status,closes_at);

CREATE TABLE "selection_applications" (
  id UUID PRIMARY KEY,
  selection_pool_id UUID NOT NULL REFERENCES selection_pools(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  order_requirement_id UUID NOT NULL REFERENCES order_requirements(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  player_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status selection_application_status NOT NULL DEFAULT 'APPLIED',
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  eligibility_snapshot JSONB NOT NULL,
  applied_at TIMESTAMPTZ(3) NOT NULL,
  withdrawn_at TIMESTAMPTZ(3),
  decided_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT selection_applications_pool_requirement_player_key UNIQUE(selection_pool_id,order_requirement_id,player_user_id)
);
CREATE INDEX selection_applications_player_status_idx ON selection_applications(player_user_id,status);
CREATE INDEX selection_applications_requirement_status_idx ON selection_applications(order_requirement_id,status);

CREATE TABLE "selection_pool_events" (
  id UUID PRIMARY KEY,
  selection_pool_id UUID NOT NULL REFERENCES selection_pools(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type selection_pool_event_type NOT NULL,
  pool_version INTEGER NOT NULL CHECK (pool_version > 0),
  order_version INTEGER NOT NULL CHECK (order_version > 0),
  actor_user_id UUID,
  actor_staff_id UUID,
  snapshot JSONB NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT selection_pool_events_pool_sequence_key UNIQUE(selection_pool_id,sequence)
);

CREATE TABLE "selection_application_events" (
  id UUID PRIMARY KEY,
  selection_application_id UUID NOT NULL REFERENCES selection_applications(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type selection_application_event_type NOT NULL,
  application_version INTEGER NOT NULL CHECK (application_version > 0),
  actor_user_id UUID,
  snapshot JSONB NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT selection_application_events_application_sequence_key UNIQUE(selection_application_id,sequence)
);

CREATE TRIGGER trg_selection_pool_events_append_only
  BEFORE UPDATE OR DELETE ON selection_pool_events
  FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();
CREATE TRIGGER trg_selection_application_events_append_only
  BEFORE UPDATE OR DELETE ON selection_application_events
  FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

ALTER TABLE outbox_events ADD COLUMN selection_pool_id UUID;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_selection_pool_id_fkey
  FOREIGN KEY (selection_pool_id) REFERENCES selection_pools(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX outbox_events_selection_pool_idx ON outbox_events(selection_pool_id,created_at);

-- Multi-player orders represent active player occupancy through order_participants.
-- The legacy scalar player slot remains valid for old single-player orders only.
ALTER TABLE orders DROP CONSTRAINT order_active_player_slot_status_chk;
ALTER TABLE orders ADD CONSTRAINT order_active_player_slot_status_chk CHECK (
  (status IN ('ACCEPTED','IN_SERVICE','PENDING_CONFIRMATION') AND (
    (player_id IS NULL AND active_player_slot_id IS NULL)
    OR (player_id IS NOT NULL AND active_player_slot_id IS NOT NULL AND active_player_slot_id=player_id)
  ))
  OR (status IN ('DRAFT','PENDING_DISPATCH','COMPLETED','CANCELLED') AND active_player_slot_id IS NULL)
  OR (status='EXCEPTION' AND (
    (player_id IS NULL AND active_player_slot_id IS NULL)
    OR (player_id IS NOT NULL AND active_player_slot_id IS NOT NULL AND active_player_slot_id=player_id)
  ))
);

GRANT SELECT,INSERT,UPDATE ON selection_pools,selection_applications TO blackcat_app;
GRANT SELECT,INSERT ON selection_pool_events,selection_application_events TO blackcat_app;
REVOKE DELETE ON selection_pools,selection_applications,selection_pool_events,selection_application_events FROM blackcat_app;
REVOKE UPDATE ON selection_pool_events,selection_application_events FROM blackcat_app;

-- Retire queued first-wins work. Historical dispatch attempts remain append-only facts.
UPDATE outbox_events
SET status='CANCELLED',row_version=row_version+1,locked_at=NULL,locked_by=NULL,
    last_error='SUPERSEDED_BY_SELECTION_POOL',updated_at=now()
WHERE status IN ('PENDING','PROCESSING','FAILED')
  AND event_type IN ('DISPATCH_START','DISPATCH_MESSAGE','DISPATCH_TIMEOUT');
