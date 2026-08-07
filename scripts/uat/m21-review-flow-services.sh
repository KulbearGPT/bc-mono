#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != 'start' ]]; then
  echo 'Usage: m21-review-flow-services.sh start' >&2
  exit 64
fi
if [[ "${M21_UAT_CONFIRM:-}" != 'USE_ISOLATED_REVIEW_UAT' ]]; then
  echo 'Set M21_UAT_CONFIRM=USE_ISOLATED_REVIEW_UAT to start the M21 review UAT services.' >&2
  exit 64
fi
if [[ "${BUSINESS_ENV:-}" != 'SANDBOX' ]]; then
  echo 'M21 review UAT services are restricted to BUSINESS_ENV=SANDBOX.' >&2
  exit 64
fi

runtime_database_url="${M21_UAT_RUNTIME_DATABASE_URL:-}"
env_file="${M21_UAT_ENV_FILE:-}"
review_secret="${M21_UAT_REVIEW_SIGNING_SECRET:-}"
api_port="${M21_UAT_API_PORT:-33121}"

if [[ -z "$runtime_database_url" || -z "$env_file" || -z "$review_secret" ]]; then
  echo 'M21_UAT_RUNTIME_DATABASE_URL, M21_UAT_ENV_FILE and M21_UAT_REVIEW_SIGNING_SECRET are required.' >&2
  exit 64
fi
database_name="$(node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).pathname.slice(1)))' "$runtime_database_url")"
if [[ "$database_name" != *"_uat"* ]]; then
  echo "Refusing runtime database '$database_name': its name must contain _uat." >&2
  exit 64
fi
if [[ ! -f "$env_file" ]]; then
  echo "M21_UAT_ENV_FILE does not exist: $env_file" >&2
  exit 64
fi
if (( ${#review_secret} < 32 )); then
  echo 'M21_UAT_REVIEW_SIGNING_SECRET must be at least 32 characters.' >&2
  exit 64
fi
if [[ ! "$api_port" =~ ^[0-9]+$ ]] || (( api_port < 1024 || api_port > 65535 )); then
  echo 'M21_UAT_API_PORT must be an integer between 1024 and 65535.' >&2
  exit 64
fi

npm run build

api_base_url="http://127.0.0.1:${api_port}"
echo "Starting isolated M21 review UAT services on $api_base_url using database $database_name."
echo 'Press Ctrl-C after the external UAT; then run Discord cleanup and isolated database drop.'

npx dotenv -e "$env_file" -e .env.example -- \
  env -u PORT \
  NODE_ENV=development \
  BUSINESS_ENV=SANDBOX \
  API_PORT="$api_port" \
  API_BASE_URL="$api_base_url" \
  DATABASE_URL="$runtime_database_url" \
  REVIEW_CONTINUATION_SIGNING_SECRET="$review_secret" \
  WORKER_POLL_INTERVAL_MS=250 \
  ROLE_RECONCILIATION_INTERVAL_MS=3600000 \
  npx concurrently --kill-others-on-fail -n api,worker,bot -c blue,yellow,magenta \
    "npm run start:web" \
    "npm run start:worker" \
    "npm run start:bot"
