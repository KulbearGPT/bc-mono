CREATE TYPE "WeeklyReportStatus" AS ENUM ('READY','NEEDS_REVIEW');
CREATE TYPE "WeeklyReportRevisionType" AS ENUM ('PLAYER','SUMMARY');

CREATE TABLE player_weekly_reports (
  id uuid PRIMARY KEY,
  report_key varchar(500) NOT NULL UNIQUE,
  guild_id varchar(32) NOT NULL,
  schedule_key varchar(120) NOT NULL,
  player_user_id uuid NOT NULL,
  settlement_batch_id uuid,
  period_start timestamptz(3) NOT NULL,
  period_end timestamptz(3) NOT NULL,
  cutoff_at timestamptz(3) NOT NULL,
  time_zone varchar(80) NOT NULL,
  currency char(3) NOT NULL,
  status "WeeklyReportStatus" NOT NULL DEFAULT 'READY',
  completed_order_count integer NOT NULL,
  cancelled_order_count integer NOT NULL,
  service_minutes integer NOT NULL,
  order_earning_minor bigint NOT NULL,
  gift_earning_minor bigint NOT NULL,
  adjustment_minor bigint NOT NULL,
  pending_minor bigint NOT NULL,
  settlement_ready_minor bigint NOT NULL,
  batched_minor bigint NOT NULL,
  detail_snapshot jsonb NOT NULL,
  current_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT player_weekly_reports_player_fkey FOREIGN KEY (player_user_id) REFERENCES users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT player_weekly_reports_batch_fkey FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT player_weekly_reports_period_chk CHECK (period_start < period_end AND cutoff_at >= period_end),
  CONSTRAINT player_weekly_reports_currency_chk CHECK (currency = 'CNY'),
  CONSTRAINT player_weekly_reports_counts_chk CHECK (completed_order_count >= 0 AND cancelled_order_count >= 0 AND service_minutes >= 0),
  CONSTRAINT player_weekly_reports_amounts_chk CHECK (pending_minor >= 0 AND settlement_ready_minor >= 0 AND batched_minor >= 0),
  CONSTRAINT player_weekly_reports_revision_chk CHECK (current_revision >= 1),
  CONSTRAINT player_weekly_reports_scope_key UNIQUE
    (guild_id,schedule_key,period_start,period_end,currency,player_user_id)
);

CREATE INDEX player_weekly_reports_guild_period_idx ON player_weekly_reports(guild_id,period_end DESC,id);
CREATE INDEX player_weekly_reports_player_period_idx ON player_weekly_reports(guild_id,player_user_id,period_end DESC,id);
CREATE INDEX player_weekly_reports_status_period_idx ON player_weekly_reports(guild_id,status,period_end DESC);

CREATE TABLE weekly_report_summaries (
  id uuid PRIMARY KEY,
  report_key varchar(500) NOT NULL UNIQUE,
  guild_id varchar(32) NOT NULL,
  schedule_key varchar(120) NOT NULL,
  settlement_batch_id uuid,
  period_start timestamptz(3) NOT NULL,
  period_end timestamptz(3) NOT NULL,
  cutoff_at timestamptz(3) NOT NULL,
  time_zone varchar(80) NOT NULL,
  currency char(3) NOT NULL,
  status "WeeklyReportStatus" NOT NULL DEFAULT 'READY',
  active_player_count integer NOT NULL,
  completed_order_count integer NOT NULL,
  cancelled_order_count integer NOT NULL,
  exception_count integer NOT NULL,
  service_minutes integer NOT NULL,
  gross_amount_minor bigint NOT NULL,
  adjustment_minor bigint NOT NULL,
  pending_minor bigint NOT NULL,
  net_payable_minor bigint NOT NULL,
  detail_snapshot jsonb NOT NULL,
  current_revision integer NOT NULL DEFAULT 1,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL,
  CONSTRAINT weekly_report_summaries_batch_fkey FOREIGN KEY (settlement_batch_id) REFERENCES settlement_batches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT weekly_report_summaries_period_chk CHECK (period_start < period_end AND cutoff_at >= period_end),
  CONSTRAINT weekly_report_summaries_currency_chk CHECK (currency = 'CNY'),
  CONSTRAINT weekly_report_summaries_counts_chk CHECK (
    active_player_count >= 0 AND completed_order_count >= 0 AND cancelled_order_count >= 0
    AND exception_count >= 0 AND service_minutes >= 0
  ),
  CONSTRAINT weekly_report_summaries_amounts_chk CHECK (pending_minor >= 0 AND net_payable_minor >= 0),
  CONSTRAINT weekly_report_summaries_revision_chk CHECK (current_revision >= 1),
  CONSTRAINT weekly_report_summaries_scope_key UNIQUE
    (guild_id,schedule_key,period_start,period_end,currency)
);

CREATE INDEX weekly_report_summaries_guild_period_idx ON weekly_report_summaries(guild_id,period_end DESC,id);
CREATE INDEX weekly_report_summaries_status_period_idx ON weekly_report_summaries(guild_id,status,period_end DESC);

CREATE TABLE weekly_report_revisions (
  id uuid PRIMARY KEY,
  revision_type "WeeklyReportRevisionType" NOT NULL,
  player_weekly_report_id uuid,
  weekly_report_summary_id uuid,
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  reason varchar(1000) NOT NULL,
  idempotency_key varchar(200) NOT NULL UNIQUE,
  created_by_staff_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT weekly_report_revisions_player_fkey FOREIGN KEY (player_weekly_report_id) REFERENCES player_weekly_reports(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT weekly_report_revisions_summary_fkey FOREIGN KEY (weekly_report_summary_id) REFERENCES weekly_report_summaries(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT weekly_report_revisions_staff_fkey FOREIGN KEY (created_by_staff_id) REFERENCES staff_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT weekly_report_revisions_revision_chk CHECK (revision >= 2),
  CONSTRAINT weekly_report_revisions_reason_chk CHECK (length(btrim(reason)) >= 2),
  CONSTRAINT weekly_report_revisions_target_chk CHECK (
    (revision_type='PLAYER' AND player_weekly_report_id IS NOT NULL AND weekly_report_summary_id IS NULL)
    OR (revision_type='SUMMARY' AND player_weekly_report_id IS NULL AND weekly_report_summary_id IS NOT NULL)
  ),
  UNIQUE (player_weekly_report_id,revision),
  UNIQUE (weekly_report_summary_id,revision)
);

CREATE INDEX weekly_report_revisions_created_idx ON weekly_report_revisions(created_at,id);

CREATE OR REPLACE FUNCTION deny_weekly_report_delete()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'weekly report record % cannot be deleted',TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_player_weekly_report_projection()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.report_key,NEW.guild_id,NEW.schedule_key,NEW.player_user_id,NEW.settlement_batch_id,
      NEW.period_start,NEW.period_end,NEW.cutoff_at,NEW.time_zone,NEW.currency,NEW.status,
      NEW.completed_order_count,NEW.cancelled_order_count,NEW.service_minutes,NEW.order_earning_minor,
      NEW.gift_earning_minor,NEW.adjustment_minor,NEW.pending_minor,NEW.settlement_ready_minor,
      NEW.batched_minor,NEW.detail_snapshot,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.report_key,OLD.guild_id,OLD.schedule_key,OLD.player_user_id,OLD.settlement_batch_id,
      OLD.period_start,OLD.period_end,OLD.cutoff_at,OLD.time_zone,OLD.currency,OLD.status,
      OLD.completed_order_count,OLD.cancelled_order_count,OLD.service_minutes,OLD.order_earning_minor,
      OLD.gift_earning_minor,OLD.adjustment_minor,OLD.pending_minor,OLD.settlement_ready_minor,
      OLD.batched_minor,OLD.detail_snapshot,OLD.created_at) THEN
    RAISE EXCEPTION 'player weekly report base snapshot is immutable';
  END IF;
  IF NEW.current_revision<>OLD.current_revision+1 OR NOT EXISTS (
    SELECT 1 FROM weekly_report_revisions revision
    WHERE revision.player_weekly_report_id=OLD.id AND revision.revision=NEW.current_revision
  ) THEN
    RAISE EXCEPTION 'player weekly report projection must advance through an appended revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_summary_weekly_report_projection()
RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.report_key,NEW.guild_id,NEW.schedule_key,NEW.settlement_batch_id,
      NEW.period_start,NEW.period_end,NEW.cutoff_at,NEW.time_zone,NEW.currency,NEW.status,
      NEW.active_player_count,NEW.completed_order_count,NEW.cancelled_order_count,NEW.exception_count,
      NEW.service_minutes,NEW.gross_amount_minor,NEW.adjustment_minor,NEW.pending_minor,
      NEW.net_payable_minor,NEW.detail_snapshot,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.report_key,OLD.guild_id,OLD.schedule_key,OLD.settlement_batch_id,
      OLD.period_start,OLD.period_end,OLD.cutoff_at,OLD.time_zone,OLD.currency,OLD.status,
      OLD.active_player_count,OLD.completed_order_count,OLD.cancelled_order_count,OLD.exception_count,
      OLD.service_minutes,OLD.gross_amount_minor,OLD.adjustment_minor,OLD.pending_minor,
      OLD.net_payable_minor,OLD.detail_snapshot,OLD.created_at) THEN
    RAISE EXCEPTION 'summary weekly report base snapshot is immutable';
  END IF;
  IF NEW.current_revision<>OLD.current_revision+1 OR NOT EXISTS (
    SELECT 1 FROM weekly_report_revisions revision
    WHERE revision.weekly_report_summary_id=OLD.id AND revision.revision=NEW.current_revision
  ) THEN
    RAISE EXCEPTION 'summary weekly report projection must advance through an appended revision';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_player_weekly_report_projection
BEFORE UPDATE ON player_weekly_reports FOR EACH ROW EXECUTE FUNCTION enforce_player_weekly_report_projection();
CREATE TRIGGER trg_summary_weekly_report_projection
BEFORE UPDATE ON weekly_report_summaries FOR EACH ROW EXECUTE FUNCTION enforce_summary_weekly_report_projection();
CREATE TRIGGER trg_weekly_report_revisions_append_only
BEFORE UPDATE OR DELETE ON weekly_report_revisions FOR EACH ROW EXECUTE FUNCTION deny_append_only_mutation();
CREATE TRIGGER trg_player_weekly_reports_no_delete
BEFORE DELETE ON player_weekly_reports FOR EACH ROW EXECUTE FUNCTION deny_weekly_report_delete();
CREATE TRIGGER trg_weekly_report_summaries_no_delete
BEFORE DELETE ON weekly_report_summaries FOR EACH ROW EXECUTE FUNCTION deny_weekly_report_delete();

GRANT SELECT,INSERT,UPDATE,DELETE ON player_weekly_reports,weekly_report_summaries,weekly_report_revisions TO blackcat_app;
REVOKE DELETE ON player_weekly_reports,weekly_report_summaries,weekly_report_revisions FROM blackcat_app;
REVOKE UPDATE ON weekly_report_revisions FROM blackcat_app;
REVOKE UPDATE (report_key,guild_id,schedule_key,player_user_id,settlement_batch_id,period_start,period_end,cutoff_at,
  time_zone,currency,status,completed_order_count,cancelled_order_count,service_minutes,order_earning_minor,
  gift_earning_minor,adjustment_minor,pending_minor,settlement_ready_minor,batched_minor,detail_snapshot,created_at)
  ON player_weekly_reports FROM blackcat_app;
REVOKE UPDATE (report_key,guild_id,schedule_key,settlement_batch_id,period_start,period_end,cutoff_at,time_zone,currency,
  status,active_player_count,completed_order_count,cancelled_order_count,exception_count,service_minutes,
  gross_amount_minor,adjustment_minor,pending_minor,net_payable_minor,detail_snapshot,created_at)
  ON weekly_report_summaries FROM blackcat_app;
