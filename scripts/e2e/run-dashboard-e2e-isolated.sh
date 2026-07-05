#!/usr/bin/env bash
set -euo pipefail

e2e_admin_url="${E2E_ADMIN_DATABASE_URL:-postgresql://blackcat:blackcat@localhost:5432/postgres}"
e2e_db_name="${E2E_DATABASE_NAME:-blackcat_e2e_dashboard_${$}}"
e2e_app_url="postgresql://blackcat:blackcat@localhost:5432/${e2e_db_name}"

case "$e2e_db_name" in
  *_e2e|*_e2e_*) ;;
  *)
    echo "Refusing isolated run for database '$e2e_db_name': name must contain _e2e." >&2
    exit 64
    ;;
esac
if [[ ! "$e2e_db_name" =~ ^[a-z][a-z0-9_]*$ ]]; then
  echo "Refusing unsafe E2E database name: '$e2e_db_name'." >&2
  exit 64
fi

cleanup() {
  psql "$e2e_admin_url" -v ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$e2e_db_name' AND pid <> pg_backend_pid();" >/dev/null
  psql "$e2e_admin_url" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$e2e_db_name\";" >/dev/null
  echo "Removed isolated E2E database: $e2e_db_name"
}
trap cleanup EXIT

export NODE_ENV=test
export E2E_DATABASE_NAME="$e2e_db_name"
export E2E_DATABASE_URL="$e2e_app_url"
export DATABASE_URL="$e2e_app_url"

npm run e2e:coverage:verify
npm run e2e:db:prepare
npm run test:e2e:dashboard -- "$@"
