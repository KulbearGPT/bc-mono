#!/usr/bin/env bash
set -euo pipefail

e2e_db_name="${E2E_DATABASE_NAME:-blackcat_e2e_dashboard}"
e2e_admin_url="${E2E_ADMIN_DATABASE_URL:-postgresql://blackcat:blackcat@localhost:5432/postgres}"
e2e_app_url="${E2E_DATABASE_URL:-postgresql://blackcat:blackcat@localhost:5432/${e2e_db_name}}"

case "$e2e_db_name" in
  *_e2e|*_e2e_*) ;;
  *)
    echo "Refusing to prepare database '$e2e_db_name': E2E database names must contain _e2e." >&2
    exit 64
    ;;
esac

if [[ ! "$e2e_db_name" =~ ^[a-z][a-z0-9_]*$ ]]; then
  echo "Refusing unsafe E2E database name: '$e2e_db_name'." >&2
  exit 64
fi

if [[ "${NODE_ENV:-test}" != "test" ]]; then
  echo 'Refusing to prepare an E2E database unless NODE_ENV=test.' >&2
  exit 64
fi

if ! psql "$e2e_admin_url" -Atqc "SELECT 1 FROM pg_database WHERE datname = '$e2e_db_name'" | grep -qx '1'; then
  psql "$e2e_admin_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$e2e_db_name\""
fi

DATABASE_URL="$e2e_app_url" npx prisma migrate deploy --schema database/prisma/schema.prisma
echo "Prepared isolated E2E database: $e2e_db_name"
