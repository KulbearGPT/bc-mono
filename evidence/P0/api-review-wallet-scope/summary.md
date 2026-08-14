# API review — wallet customer scope

## Story and acceptance

- Story: `codex/api-review-wallet-scope`
- Acceptance: `AT-WAL-003`, `AT-WAL-007`, `AT-DOP-004`
- Scope: API authorization wiring and regression tests only. Existing Bot and Dashboard request/response contracts are unchanged.

## RED

`npx vitest run tests/m7-us-04-api.spec.ts`

- Result: 1 failed / 4 passed before implementation.
- Evidence: an L2 Dashboard actor from a different trusted Guild could submit a top-up for the target customer; the API returned HTTP 201 and created a wallet credit instead of failing closed.

## Implementation

- Every admin wallet read and mutation now verifies the target customer through the server-side customer scope using the trusted Dashboard actor, Guild, level, and staff identity.
- Receipt upload checks customer scope before parsing or writing the multipart file.
- Receipt download derives the customer from persisted attachment metadata and verifies scope before opening private content.
- Production wiring reuses the customer-profile PostgreSQL scope store; tests or isolated deployments may inject the same narrow interface explicitly.
- Scope denial is non-enumerable HTTP 404 and does not create wallet, entry, receipt, or attachment facts.

## GREEN and compatibility evidence

`npm run typecheck`

- Result: passed.

`npx vitest run tests/m7-us-04-api.spec.ts tests/m7-us-04-wallet.spec.ts tests/m7-us-04-db.spec.ts tests/m9-us-04-cat-wallet.spec.ts tests/m8-us-02-wallet-display.spec.ts tests/m15-us-05-wallet-adjustment-dashboard.spec.ts tests/e2e/dashboard/dashboard-profile-wallet.spec.ts --exclude 'tests/e2e/**'`

- Result: 6 files / 22 tests passed (the explicitly excluded browser fixture was not counted).
- Scope regression: cross-Guild top-up, admin balance, wallet entries, and private receipt content all return 404; the attempted top-up leaves the ledger at zero.
- Dashboard compatibility: wallet adjustment and customer-wallet display tests passed without client changes.

`npx vitest run tests/m7-us-06-bot.spec.ts tests/m8-us-03-bot-display.spec.ts`

- Result: passed; self-wallet Bot routes and DTOs were not changed.

`git diff --check`

- Result: passed.

## Remaining scope

This Story fixes wallet/customer Guild scope only. Admin/customer order, referral/commission, transactional audit, approval runtime, reservation aggregation, receipt orphan cleanup, and API module debt remain separate review-remediation Stories.
