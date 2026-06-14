CREATE TYPE "OrderRequirementStatus" AS ENUM ('ACTIVE', 'REMOVED');
CREATE TYPE "OrderRequirementEventType" AS ENUM ('ADDED', 'PROJECT_CHANGED', 'QUANTITY_CHANGED', 'REMOVED');

CREATE TABLE order_requirements (
  id UUID NOT NULL,
  order_id UUID NOT NULL,
  service_catalog_version_id UUID NOT NULL,
  status "OrderRequirementStatus" NOT NULL DEFAULT 'ACTIVE',
  row_version INTEGER NOT NULL DEFAULT 1,
  game_code_snapshot VARCHAR(80) NOT NULL,
  game_display_name_snapshot VARCHAR(100) NOT NULL,
  service_code_snapshot VARCHAR(80) NOT NULL,
  service_display_name_snapshot VARCHAR(100) NOT NULL,
  region_code_snapshot VARCHAR(80),
  region_display_name_snapshot VARCHAR(100),
  billing_unit_minutes_snapshot INTEGER NOT NULL,
  unit_count INTEGER NOT NULL,
  requested_player_count INTEGER NOT NULL,
  customer_unit_price_minor_snapshot BIGINT NOT NULL,
  estimated_line_price_minor BIGINT NOT NULL,
  removed_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT order_requirements_pkey PRIMARY KEY (id),
  CONSTRAINT order_requirements_version_positive_chk CHECK (row_version > 0),
  CONSTRAINT order_requirements_quantity_positive_chk CHECK (
    billing_unit_minutes_snapshot > 0 AND unit_count > 0 AND requested_player_count > 0
  ),
  CONSTRAINT order_requirements_money_positive_chk CHECK (
    customer_unit_price_minor_snapshot > 0 AND estimated_line_price_minor > 0
  ),
  CONSTRAINT order_requirements_removed_shape_chk CHECK (
    (status = 'ACTIVE' AND removed_at IS NULL)
    OR (status = 'REMOVED' AND removed_at IS NOT NULL)
  ),
  CONSTRAINT order_requirements_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT order_requirements_service_catalog_version_id_fkey FOREIGN KEY (service_catalog_version_id) REFERENCES service_catalog_versions(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX order_requirements_order_status_created_idx ON order_requirements(order_id, status, created_at);
CREATE INDEX order_requirements_service_catalog_version_id_idx ON order_requirements(service_catalog_version_id);

CREATE TABLE order_requirement_events (
  id UUID NOT NULL,
  order_requirement_id UUID NOT NULL,
  sequence INTEGER NOT NULL,
  event_type "OrderRequirementEventType" NOT NULL,
  requirement_version INTEGER NOT NULL,
  order_version INTEGER NOT NULL,
  actor_user_id UUID,
  snapshot JSONB NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT order_requirement_events_pkey PRIMARY KEY (id),
  CONSTRAINT order_requirement_events_versions_positive_chk CHECK (
    sequence > 0 AND requirement_version > 0 AND order_version > 0
  ),
  CONSTRAINT order_requirement_events_requirement_id_fkey FOREIGN KEY (order_requirement_id) REFERENCES order_requirements(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT order_requirement_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX order_requirement_events_requirement_sequence_key ON order_requirement_events(order_requirement_id, sequence);
CREATE UNIQUE INDEX order_requirement_events_idempotency_key_key ON order_requirement_events(idempotency_key);
CREATE INDEX order_requirement_events_requirement_created_idx ON order_requirement_events(order_requirement_id, created_at);

ALTER TABLE order_participants ADD COLUMN order_requirement_id UUID;
ALTER TABLE order_participants ADD CONSTRAINT order_participants_order_requirement_id_fkey
  FOREIGN KEY (order_requirement_id) REFERENCES order_requirements(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX order_participants_order_requirement_id_idx ON order_participants(order_requirement_id);

CREATE FUNCTION guard_order_requirement_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'order requirements cannot be deleted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM orders WHERE id = OLD.order_id AND status = 'DRAFT'
  ) THEN
    RAISE EXCEPTION 'only draft order requirements can be changed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_order_requirements_guard
BEFORE UPDATE OR DELETE ON order_requirements
FOR EACH ROW EXECUTE FUNCTION guard_order_requirement_mutation();

CREATE TRIGGER trg_order_requirement_events_append_only
BEFORE UPDATE OR DELETE ON order_requirement_events
FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();

GRANT SELECT, INSERT, UPDATE ON order_requirements TO blackcat_app;
GRANT SELECT, INSERT ON order_requirement_events TO blackcat_app;
REVOKE DELETE ON order_requirements, order_requirement_events FROM blackcat_app;
REVOKE UPDATE ON order_requirement_events FROM blackcat_app;
