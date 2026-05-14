#!/usr/bin/env bash
set -euo pipefail

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/blackcat-restore.XXXXXX")"
SOURCE_DATA="$ROOT/source-data"
SOURCE_SOCKET="$ROOT/source-socket"
RESTORE_DATA="$ROOT/restore-data"
RESTORE_SOCKET="$ROOT/restore-socket"
SOURCE_PORT="$((64000 + $$ % 500))"
RESTORE_PORT="$((64500 + $$ % 500))"

cleanup() {
  pg_ctl -D "$SOURCE_DATA" stop -m fast >/dev/null 2>&1 || true
  pg_ctl -D "$RESTORE_DATA" stop -m fast >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT
mkdir -p "$SOURCE_SOCKET" "$RESTORE_SOCKET"

initdb -D "$SOURCE_DATA" --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$SOURCE_DATA" -o "-p $SOURCE_PORT -k $SOURCE_SOCKET" -l "$ROOT/source.log" start >/dev/null
createdb -h "$SOURCE_SOCKET" -p "$SOURCE_PORT" blackcat
psql -h "$SOURCE_SOCKET" -p "$SOURCE_PORT" -d blackcat -v ON_ERROR_STOP=1 -f database/prisma/migrations/000001_p0_baseline/migration.sql >/dev/null
psql -h "$SOURCE_SOCKET" -p "$SOURCE_PORT" -d blackcat -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO users(id,display_name,status,row_version,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-000000050201','Restore fixture','ACTIVE',1,now(),now());
INSERT INTO audit_logs(id,actor_source,client_id,action,target_type,target_id,outcome,request_id,created_at)
VALUES ('00000000-0000-0000-0000-000000050202','SYSTEM_JOB','RESTORE_TEST','BACKUP_FIXTURE','database','blackcat','SUCCEEDED','req_restore_fixture',now());
SQL
pg_dump -h "$SOURCE_SOCKET" -p "$SOURCE_PORT" -d blackcat --format=custom --no-owner --no-acl -f "$ROOT/blackcat.dump"

initdb -D "$RESTORE_DATA" --no-locale --encoding=UTF8 >/dev/null
pg_ctl -D "$RESTORE_DATA" -o "-p $RESTORE_PORT -k $RESTORE_SOCKET" -l "$ROOT/restore.log" start >/dev/null
createdb -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" blackcat_restore
pg_restore -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d blackcat_restore --no-owner --no-acl "$ROOT/blackcat.dump"

USERS="$(psql -At -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d blackcat_restore -c "SELECT count(*) FROM users")"
AUDITS="$(psql -At -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d blackcat_restore -c "SELECT count(*) FROM audit_logs")"
echo "restored_users=$USERS"
echo "restored_audits=$AUDITS"
if psql -h "$RESTORE_SOCKET" -p "$RESTORE_PORT" -d blackcat_restore -v ON_ERROR_STOP=1 -c "DELETE FROM audit_logs" >/dev/null 2>&1; then
  echo "audit-delete-unexpectedly-allowed" >&2
  exit 1
else
  echo "audit-delete-rejected"
fi
test "$USERS" = "1" && test "$AUDITS" = "1"
echo "backup-restore-ok"
