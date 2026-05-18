ALTER TABLE weekly_report_revisions
  ADD COLUMN request_fingerprint varchar(64);

UPDATE weekly_report_revisions
SET request_fingerprint=md5(idempotency_key)||md5('legacy:'||idempotency_key)
WHERE request_fingerprint IS NULL;

ALTER TABLE weekly_report_revisions
  ALTER COLUMN request_fingerprint SET NOT NULL,
  ADD CONSTRAINT weekly_report_revisions_fingerprint_chk
    CHECK (request_fingerprint ~ '^[0-9a-f]{64}$');

REVOKE UPDATE (request_fingerprint) ON weekly_report_revisions FROM blackcat_app;
