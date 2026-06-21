ALTER TABLE service_packages ADD COLUMN game_code VARCHAR(80);
ALTER TABLE service_packages ADD COLUMN game_name VARCHAR(100);

DO $$
BEGIN
  IF EXISTS (
    SELECT package.id
    FROM service_packages package
    JOIN service_package_versions version ON version.service_package_id = package.id
    JOIN service_package_slots slot ON slot.service_package_version_id = version.id
    JOIN service_catalog_versions catalog ON catalog.id = slot.service_catalog_version_id
    JOIN service_offerings offering ON offering.id = catalog.service_offering_id
    GROUP BY package.id
    HAVING COUNT(DISTINCT offering.game_code) <> 1
  ) THEN
    RAISE EXCEPTION 'existing service package contains slots from multiple games';
  END IF;
END;
$$;

UPDATE service_packages package
SET game_code = source.game_code,
    game_name = source.game_name
FROM (
  SELECT DISTINCT ON (package.id) package.id, offering.game_code, offering.game_name
  FROM service_packages package
  JOIN service_package_versions version ON version.service_package_id = package.id
  JOIN service_package_slots slot ON slot.service_package_version_id = version.id
  JOIN service_catalog_versions catalog ON catalog.id = slot.service_catalog_version_id
  JOIN service_offerings offering ON offering.id = catalog.service_offering_id
  ORDER BY package.id, version.version DESC, slot.position
) source
WHERE source.id = package.id;

ALTER TABLE service_packages ALTER COLUMN game_code SET NOT NULL;
ALTER TABLE service_packages ALTER COLUMN game_name SET NOT NULL;
CREATE INDEX service_packages_game_archived_idx ON service_packages(game_code, archived_at);

GRANT SELECT, INSERT (id, code, game_code, game_name, updated_at), UPDATE (archived_at, updated_at)
  ON service_packages TO blackcat_app;
