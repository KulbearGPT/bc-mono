CREATE TYPE "OrderCompositionMode" AS ENUM ('PACKAGE_DEFAULT', 'CUSTOMIZED');
ALTER TYPE "OrderRequirementEventType" ADD VALUE 'NOTE_CHANGED';

CREATE TABLE service_packages (
  id UUID NOT NULL,
  code VARCHAR(100) NOT NULL,
  archived_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT service_packages_pkey PRIMARY KEY (id),
  CONSTRAINT service_packages_code_key UNIQUE (code)
);

CREATE TABLE service_package_versions (
  id UUID NOT NULL,
  service_package_id UUID NOT NULL,
  version INTEGER NOT NULL,
  status "CatalogVersionStatus" NOT NULL DEFAULT 'DRAFT',
  active_package_key UUID,
  display_name VARCHAR(100) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  default_customer_price_minor BIGINT,
  currency CHAR(3) NOT NULL,
  created_by_staff_id UUID NOT NULL,
  activated_at TIMESTAMPTZ(3),
  retired_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT service_package_versions_pkey PRIMARY KEY (id),
  CONSTRAINT service_package_versions_identity_key UNIQUE (service_package_id, version),
  CONSTRAINT service_package_versions_active_key UNIQUE (active_package_key),
  CONSTRAINT service_package_versions_version_chk CHECK (version > 0),
  CONSTRAINT service_package_versions_price_chk CHECK (default_customer_price_minor IS NULL OR default_customer_price_minor > 0),
  CONSTRAINT service_package_versions_currency_chk CHECK (currency = 'CAT'),
  CONSTRAINT service_package_versions_package_fkey FOREIGN KEY (service_package_id) REFERENCES service_packages(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT service_package_versions_creator_fkey FOREIGN KEY (created_by_staff_id) REFERENCES staff_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX service_package_versions_status_package_idx ON service_package_versions(status, service_package_id);

CREATE TABLE service_package_slots (
  id UUID NOT NULL,
  service_package_version_id UUID NOT NULL,
  service_catalog_version_id UUID NOT NULL,
  position INTEGER NOT NULL,
  unit_count INTEGER NOT NULL,
  customer_note_template VARCHAR(500),
  CONSTRAINT service_package_slots_pkey PRIMARY KEY (id),
  CONSTRAINT service_package_slots_position_key UNIQUE (service_package_version_id, position),
  CONSTRAINT service_package_slots_position_chk CHECK (position > 0),
  CONSTRAINT service_package_slots_units_chk CHECK (unit_count > 0),
  CONSTRAINT service_package_slots_package_version_fkey FOREIGN KEY (service_package_version_id) REFERENCES service_package_versions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT service_package_slots_catalog_version_fkey FOREIGN KEY (service_catalog_version_id) REFERENCES service_catalog_versions(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX service_package_slots_catalog_version_idx ON service_package_slots(service_catalog_version_id);

ALTER TABLE orders ADD COLUMN source_package_version_id UUID;
ALTER TABLE orders ADD COLUMN composition_mode "OrderCompositionMode";
ALTER TABLE orders ADD CONSTRAINT orders_source_package_version_fkey
  FOREIGN KEY (source_package_version_id) REFERENCES service_package_versions(id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE orders ADD CONSTRAINT orders_package_composition_shape_chk CHECK (
  (source_package_version_id IS NULL AND composition_mode IS NULL)
  OR (source_package_version_id IS NOT NULL AND composition_mode IS NOT NULL)
);
CREATE INDEX orders_source_package_version_idx ON orders(source_package_version_id);

ALTER TABLE order_requirements ADD COLUMN source_package_slot_id UUID;
ALTER TABLE order_requirements ADD COLUMN customer_note VARCHAR(500);
ALTER TABLE order_requirements ADD CONSTRAINT order_requirements_source_package_slot_fkey
  FOREIGN KEY (source_package_slot_id) REFERENCES service_package_slots(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX order_requirements_source_package_slot_idx ON order_requirements(source_package_slot_id);

CREATE FUNCTION protect_service_package_version_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'service package versions and slots cannot be deleted';
  END IF;
  IF TG_TABLE_NAME = 'service_package_slots' THEN
    RAISE EXCEPTION 'service package slots are immutable';
  END IF;
  IF NEW.service_package_id <> OLD.service_package_id
     OR NEW.version <> OLD.version
     OR NEW.display_name <> OLD.display_name
     OR NEW.description <> OLD.description
     OR NEW.default_customer_price_minor IS DISTINCT FROM OLD.default_customer_price_minor
     OR NEW.currency <> OLD.currency
     OR NEW.created_by_staff_id <> OLD.created_by_staff_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'service package version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_service_package_versions_protect
BEFORE UPDATE OR DELETE ON service_package_versions
FOR EACH ROW EXECUTE FUNCTION protect_service_package_version_mutation();

CREATE TRIGGER trg_service_package_slots_protect
BEFORE UPDATE OR DELETE ON service_package_slots
FOR EACH ROW EXECUTE FUNCTION protect_service_package_version_mutation();

GRANT SELECT, INSERT, UPDATE ON service_packages, service_package_versions TO blackcat_app;
GRANT SELECT, INSERT ON service_package_slots TO blackcat_app;
GRANT SELECT, UPDATE (source_package_version_id, composition_mode) ON orders TO blackcat_app;
GRANT SELECT, UPDATE (source_package_slot_id) ON order_requirements TO blackcat_app;
REVOKE DELETE ON service_packages, service_package_versions, service_package_slots FROM blackcat_app;
REVOKE UPDATE ON service_package_slots FROM blackcat_app;
