#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
database_name="${M21_UAT_DATABASE_NAME:-blackcat_m21_review_uat}"
admin_url="${M21_UAT_ADMIN_DATABASE_URL:-postgresql://blackcat:blackcat@localhost:5432/postgres}"
app_url="${M21_UAT_DATABASE_URL:-postgresql://blackcat:blackcat@localhost:5432/${database_name}}"

if [[ "${M21_UAT_DB_CONFIRM:-}" != 'CREATE_OR_DROP_ISOLATED_M21_UAT' ]]; then
  echo 'Set M21_UAT_DB_CONFIRM=CREATE_OR_DROP_ISOLATED_M21_UAT to manage the isolated database.' >&2
  exit 64
fi
if [[ "$database_name" != *"_uat"* ]]; then
  echo "Refusing database '$database_name': its name must contain _uat." >&2
  exit 64
fi
if [[ ! "$database_name" =~ ^[a-z][a-z0-9_]*$ ]]; then
  echo "Refusing unsafe database name '$database_name'." >&2
  exit 64
fi
if [[ "${BUSINESS_ENV:-}" != 'SANDBOX' ]]; then
  echo 'M21 review UAT database management is restricted to BUSINESS_ENV=SANDBOX.' >&2
  exit 64
fi

case "$action" in
  create)
    if ! psql "$admin_url" -Atqc "SELECT 1 FROM pg_database WHERE datname = '$database_name'" | grep -qx '1'; then
      psql "$admin_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$database_name\""
    fi
    DATABASE_URL="$app_url" npx prisma migrate deploy --schema database/prisma/schema.prisma
    echo "Prepared isolated M21 review UAT database: $database_name"
    echo "DATABASE_URL=$app_url"
    ;;
  drop)
    psql "$admin_url" -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$database_name' AND pid <> pg_backend_pid();" >/dev/null
    psql "$admin_url" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$database_name\";" >/dev/null
    echo "Removed isolated M21 review UAT database: $database_name"
    ;;
  *)
    echo 'Usage: m21-review-flow-db.sh create|drop' >&2
    exit 64
    ;;
esac
