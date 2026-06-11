-- Preserve user-facing taxonomy names separately from stable business codes.
ALTER TABLE orders ADD COLUMN region_name_snapshot VARCHAR(100);

UPDATE orders AS orders
SET game_name_snapshot = offering.game_name,
    service_name_snapshot = offering.service_name,
    region_name_snapshot = COALESCE(region_tag.display_name, orders.region_code_snapshot)
FROM service_catalog_versions AS version
JOIN service_offerings AS offering ON offering.id = version.service_offering_id
LEFT JOIN skill_tags AS region_tag
  ON region_tag.type = 'REGION' AND region_tag.code = offering.region_code
WHERE orders.service_catalog_version_id = version.id;
