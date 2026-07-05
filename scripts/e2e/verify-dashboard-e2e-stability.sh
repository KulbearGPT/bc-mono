#!/usr/bin/env bash
set -euo pipefail

stability_runs="${E2E_STABILITY_RUNS:-10}"
if [[ ! "$stability_runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "E2E_STABILITY_RUNS must be a positive integer." >&2
  exit 64
fi

stability_tmp="$(mktemp -d "${TMPDIR:-/tmp}/dashboard-e2e-stability.XXXXXX")"
trap 'rm -rf "$stability_tmp"' EXIT

npm run e2e:coverage:verify
for ((run = 1; run <= stability_runs; run += 1)); do
  run_log="$stability_tmp/run-${run}.log"
  echo "Dashboard E2E stability run ${run}/${stability_runs} started."
  if npm run test:e2e:dashboard -- --reporter=line >"$run_log" 2>&1; then
    summary="$(grep -E '[0-9]+ passed' "$run_log" | tail -n 1 | sed 's/^[[:space:]]*//')"
    echo "Dashboard E2E stability run ${run}/${stability_runs} passed: ${summary}"
  else
    echo "Dashboard E2E stability run ${run}/${stability_runs} failed; complete output follows." >&2
    sed -n '1,$p' "$run_log" >&2
    exit 1
  fi
done

echo "Dashboard E2E stability gate passed: ${stability_runs}/${stability_runs} consecutive Chromium full suites."
