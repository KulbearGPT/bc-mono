-- Repair service offerings created while catalog writes copied tag codes into
-- the human-readable name columns. Preserve any name that already differs
-- from its code, because it may be a historical display-name snapshot.
UPDATE service_offerings AS offering
SET game_name = CASE
      WHEN offering.game_name = offering.game_code THEN COALESCE((
        SELECT tag.display_name
        FROM skill_tags AS tag
        WHERE tag.type::text = 'GAME' AND tag.code = offering.game_code
        LIMIT 1
      ), offering.game_name)
      ELSE offering.game_name
    END,
    service_name = CASE
      WHEN offering.service_name = offering.service_code THEN COALESCE((
        SELECT tag.display_name
        FROM skill_tags AS tag
        WHERE tag.type::text = 'SERVICE' AND tag.code = offering.service_code
        LIMIT 1
      ), offering.service_name)
      ELSE offering.service_name
    END,
    updated_at = now()
WHERE (
    offering.game_name = offering.game_code
    AND EXISTS (
      SELECT 1 FROM skill_tags AS tag
      WHERE tag.type::text = 'GAME' AND tag.code = offering.game_code
    )
  ) OR (
    offering.service_name = offering.service_code
    AND EXISTS (
      SELECT 1 FROM skill_tags AS tag
      WHERE tag.type::text = 'SERVICE' AND tag.code = offering.service_code
    )
  );
