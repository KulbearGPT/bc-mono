-- Executable M6 constraints that Prisma schema syntax cannot express.
-- The implementation migration must apply equivalent constraints atomically.

ALTER TABLE settlement_batches
  ADD CONSTRAINT settlement_batches_schedule_source_chk CHECK (
    (source = 'SCHEDULED' AND schedule_key IS NOT NULL AND length(btrim(schedule_key)) > 0)
    OR (source = 'MANUAL' AND schedule_key IS NULL)
  );

ALTER TABLE settlement_item_entries
  ADD CONSTRAINT settlement_item_entries_source_chk CHECK (
    (entry_type = 'PLAYER_EARNING' AND player_earning_id IS NOT NULL AND player_earning_adjustment_id IS NULL)
    OR (entry_type = 'EARNING_ADJUSTMENT' AND player_earning_id IS NULL AND player_earning_adjustment_id IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION enforce_active_settlement_source_membership()
RETURNS trigger AS $$
DECLARE
  source_id uuid := COALESCE(NEW.player_earning_id, NEW.player_earning_adjustment_id);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(source_id::text, 0));
  IF EXISTS (
    SELECT 1
    FROM settlement_item_entries existing
    JOIN settlement_items item ON item.id = existing.settlement_item_id
    JOIN settlement_batches batch ON batch.id = item.settlement_batch_id
    WHERE batch.status <> 'VOIDED'
      AND existing.id <> NEW.id
      AND (
        (NEW.player_earning_id IS NOT NULL AND existing.player_earning_id = NEW.player_earning_id)
        OR (NEW.player_earning_adjustment_id IS NOT NULL AND existing.player_earning_adjustment_id = NEW.player_earning_adjustment_id)
      )
  ) THEN
    RAISE EXCEPTION 'settlement source already belongs to an active batch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_active_settlement_source_membership
BEFORE INSERT ON settlement_item_entries
FOR EACH ROW EXECUTE FUNCTION enforce_active_settlement_source_membership();

-- VOIDED releases active membership by predicate; historical entries remain append-only.
ALTER TABLE weekly_report_revisions
  ADD CONSTRAINT weekly_report_revisions_target_chk CHECK (
    (revision_type = 'PLAYER' AND player_weekly_report_id IS NOT NULL AND weekly_report_summary_id IS NULL)
    OR (revision_type = 'SUMMARY' AND player_weekly_report_id IS NULL AND weekly_report_summary_id IS NOT NULL)
  );

-- Weekly report base snapshots are unique within their business/Guild period.
ALTER TABLE player_weekly_reports
  ADD CONSTRAINT player_weekly_reports_scope_key UNIQUE
    (guild_id, schedule_key, player_user_id, period_start, period_end, currency);

ALTER TABLE weekly_report_summaries
  ADD CONSTRAINT weekly_report_summaries_scope_key UNIQUE
    (guild_id, schedule_key, period_start, period_end, currency);

-- The executable 000004 migration additionally installs projection guards so
-- current_revision advances only with an appended N+1 revision, denies UPDATE
-- and DELETE on revisions, and denies mutation/deletion of base snapshots.

ALTER TABLE weekly_report_revisions
  ADD CONSTRAINT weekly_report_revisions_fingerprint_chk CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  );
