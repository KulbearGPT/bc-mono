CREATE INDEX "users_created_at_id_idx" ON "users"("created_at", "id");
CREATE INDEX "users_updated_at_id_idx" ON "users"("updated_at", "id");
CREATE INDEX "users_display_name_id_idx" ON "users"("display_name", "id");

CREATE INDEX "player_profiles_created_at_id_idx" ON "player_profiles"("created_at", "id");
CREATE INDEX "player_profiles_updated_at_id_idx" ON "player_profiles"("updated_at", "id");

CREATE INDEX "service_catalog_versions_created_at_id_idx" ON "service_catalog_versions"("created_at", "id");
CREATE INDEX "service_catalog_versions_price_id_idx" ON "service_catalog_versions"("customer_unit_price_minor", "id");
CREATE INDEX "service_catalog_versions_version_id_idx" ON "service_catalog_versions"("version", "id");

CREATE INDEX "service_package_versions_created_at_id_idx" ON "service_package_versions"("created_at", "id");
CREATE INDEX "service_package_versions_name_id_idx" ON "service_package_versions"("display_name", "id");
CREATE INDEX "service_package_versions_price_id_idx" ON "service_package_versions"("default_customer_price_minor", "id");
CREATE INDEX "service_package_versions_version_id_idx" ON "service_package_versions"("version", "id");

CREATE INDEX "orders_guild_created_at_id_idx" ON "orders"("guild_id", "created_at", "id");
CREATE INDEX "orders_guild_updated_at_id_idx" ON "orders"("guild_id", "updated_at", "id");
CREATE INDEX "orders_guild_amount_id_idx" ON "orders"("guild_id", "amount_minor", "id");

CREATE INDEX "gift_catalog_versions_created_item_idx" ON "gift_catalog_versions"("created_at", "gift_catalog_item_id");
CREATE INDEX "gift_catalog_versions_name_item_idx" ON "gift_catalog_versions"("name", "gift_catalog_item_id");
CREATE INDEX "gift_catalog_versions_price_item_idx" ON "gift_catalog_versions"("price_minor", "gift_catalog_item_id");
CREATE INDEX "gift_catalog_versions_version_item_idx" ON "gift_catalog_versions"("version", "gift_catalog_item_id");

CREATE INDEX "gift_requests_created_at_id_idx" ON "gift_requests"("created_at", "id");
CREATE INDEX "gift_requests_updated_at_id_idx" ON "gift_requests"("updated_at", "id");
CREATE INDEX "gift_requests_price_id_idx" ON "gift_requests"("price_minor", "id");
CREATE INDEX "gift_requests_expires_at_id_idx" ON "gift_requests"("expires_at", "id");
