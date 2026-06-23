-- Package prices are canonical server-derived snapshots. Backfill every existing
-- immutable version from its slot catalog prices before enforcing non-null data.
ALTER TABLE service_package_versions DISABLE TRIGGER trg_service_package_versions_protect;

UPDATE service_package_versions AS package_version
SET default_customer_price_minor = totals.total_minor
FROM (
  SELECT slot.service_package_version_id,
         SUM(catalog.customer_unit_price_minor * slot.unit_count)::BIGINT AS total_minor
  FROM service_package_slots AS slot
  JOIN service_catalog_versions AS catalog ON catalog.id = slot.service_catalog_version_id
  GROUP BY slot.service_package_version_id
) AS totals
WHERE totals.service_package_version_id = package_version.id;

ALTER TABLE service_package_versions ENABLE TRIGGER trg_service_package_versions_protect;
ALTER TABLE service_package_versions ALTER COLUMN default_customer_price_minor SET NOT NULL;
