-- M9-US-08: unified, non-destructive business taxonomy.
ALTER TYPE "SkillTagType" ADD VALUE IF NOT EXISTS 'GIFT_CATEGORY';

ALTER TABLE skill_tags ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE skill_tags ADD CONSTRAINT skill_tags_row_version_chk CHECK (row_version > 0);

ALTER TABLE gift_catalog_versions ADD COLUMN gift_category_tag_id UUID;
ALTER TABLE gift_catalog_versions ADD CONSTRAINT gift_catalog_versions_gift_category_tag_id_fkey
  FOREIGN KEY (gift_category_tag_id) REFERENCES skill_tags(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX gift_catalog_versions_gift_category_tag_id_idx ON gift_catalog_versions(gift_category_tag_id);

CREATE OR REPLACE FUNCTION enforce_gift_category_tag_type()
RETURNS trigger AS $$
DECLARE tag_type "SkillTagType";
BEGIN
  IF NEW.gift_category_tag_id IS NULL THEN RETURN NEW; END IF;
  SELECT type INTO tag_type FROM skill_tags WHERE id=NEW.gift_category_tag_id;
  IF tag_type IS NULL OR tag_type::text <> 'GIFT_CATEGORY' THEN
    RAISE EXCEPTION 'gift category tag must have GIFT_CATEGORY type';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gift_category_tag_type BEFORE INSERT ON gift_catalog_versions
FOR EACH ROW EXECUTE FUNCTION enforce_gift_category_tag_type();
