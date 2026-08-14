# M5-US-05 Verification Evidence

Verified on 2026-07-19 EDT.

## Delivered

- Added a PostgreSQL-backed `SandboxFundingAdapter` selected only by explicit `BUSINESS_ENV` and `FUNDING_ADAPTER`. `PRODUCTION + SANDBOX` fails before server/worker startup; the adapter advertises `LOCAL_RESERVATION_FALLBACK` and never claims native holds or webhooks.
- Added three persistent tables and four enums for Sandbox accounts, append-only balance adjustments and debit/refund transactions. CNY minor-unit, positive amount, direction/math, reservation binding and idempotency constraints are enforced in migration 000009; UPDATE/DELETE on financial facts is rejected by database triggers.
- One-time binding codes use HMAC-SHA-256 with a minimum 32-character secret and are atomically consumed. The provision command creates exactly NORMAL, LOW and SUSPENDED fixtures, prints random plaintext codes once to its terminal response, and stores only HMAC values.
- Debit/refund calls lock the account, preserve full neutral transaction results across store instances, reject stale FundReservation versions and over-refunds, and return the same provider reference for a repeated idempotency key.
- Added L4-only `sandbox_funding.read/manage` routes. Target balance requires Dashboard auth, CSRF, recent step-up, Idempotency-Key, expected version and no active reservation; the server computes the delta and commits the Adjustment and success audit in one PostgreSQL transaction.
- Updated the migration verifier to apply every migration directory in order. This exposed and corrected its stale post-000007 settlement fixture, then verified 63 tables including all three Sandbox tables and both append-only guards.

## TDD Evidence

- RED: `npx vitest run tests/m5-us-05-sandbox-funding.spec.ts tests/m5-us-05-sandbox-funding-db.spec.ts` failed because the Sandbox module and migration did not exist.
- Database REDs then identified obsolete test fixture columns/status constraints and the previously hidden full-chain migration fixture gap; each was corrected against the actual schema rather than bypassed.
- Focused GREEN: Sandbox unit/API/database plus existing Mock/HTTP Funding regressions passed 4 files / 24 tests.

## Final Verification

- Full Vitest JSON run: 128 files, 749 tests, 749 passed, 0 failed, 0 pending.
- `npm run typecheck`, `npm run build`, `npm run db:validate`, full `npm run db:verify:migration`, contract mirror comparisons and `git diff --check` exited successfully.
- `npm run db:verify:migration` reported `table_count=63`, `sandbox_funding_table_count=3`, and `sandbox_funding_guard_count=2` after applying migrations 000001 through 000009.

## Remaining Scope

This Story does not enable Pilot feature phases or client UI. Those remain M5-US-06 and M5-US-07. Railway deployment, restore and real Discord UAT remain external M5-US-09/10 gates and are not claimed here.

## Final-review remediation (2026-07-24 MDT)

- Migration 000009 now grants the late-created Sandbox tables directly to `blackcat_app`: accounts allow only `SELECT`/`INSERT` plus the three runtime update columns; adjustments and transactions allow only `SELECT`/`INSERT`; hard deletion and immutable-fact updates are explicitly revoked. The migration integration test opens a real `blackcat_app` connection and proves required reads/writes plus denied destructive writes.
- Normal order completion no longer fabricates `order:{id}` success rows. It holds the cross-instance user/currency advisory lock, uses short intent and convergence transactions with no ordinary row lock across provider I/O, freshly reads Provider balance and recomputes every active reservation before a fallback debit, and calls the unified adapter with a mode-specific stable key: local fallback uses `debit:order:{orderId}:v1`, while native hold capture uses `capture:hold:{fundReservationId}:v{fundReservationVersion}`. It validates the complete returned transaction/hold binding, persists the observed provider status/reference, and creates capture/consumption/earning/commission/order facts only after confirmed `SUCCEEDED`.
- Failed or unresolved debits retain a `FAILED`, `UNKNOWN`, or `PENDING` external mirror while the order stays `PENDING_CONFIRMATION` and the reservation stays `ACTIVE`; no capture event, consumption, earning, or commission is created. A successful provider result followed by a local convergence failure is recovered from the same mirror without a second debit.
- Provider-unavailable confirmation responses, funding-lock timeouts, and confirmed-provider/local-convergence failures are explicitly retryable; the latter is normalized to internal failure code `PROVIDER_CONVERGENCE_PENDING`. The security idempotency layer permits the same request key to re-enter only for those transient failure reasons, so a cached `503` cannot permanently block convergence. PostgreSQL lock timeout `55P03` maps to a retryable `409 CONFLICT`.
- Fallback recovery queries the stable provider key before any new balance preflight. Thus a debit that succeeded before local observation/finalization failed converges without being stranded by the already-reduced Provider balance; only a genuinely absent transaction re-enters the fresh-balance gate before an idempotent write.
- Provider-native completion validates the original hold reference, reservation/version, order binding, amount/currency, exact captured amount and zero remaining amount, then validates the capture transaction against the stable capture key. It deliberately does not compare the hold to the customer's current active external binding, which may be revoked or changed after the hold was created; the snapshotted provider hold and reservation identity remain authoritative.
- Debit and refund stores take a transaction-scoped advisory lock on the global idempotency key before any account/original-transaction lock and compare the full persisted request fingerprint, including account/reservation binding for debits and reason/business reference for refunds. Deterministic PostgreSQL races prove identical calls converge on one persisted DTO while cross-account or cross-original reuse returns `IDEMPOTENCY_CONFLICT`, never a raw unique violation. The initial refund response is now read back from the committed row, so its nullable reservation fields and timestamps exactly match sequential and concurrent replays.
- The main specification plus OpenAPI, API usage guidance, adapter contract, provider specification, and supplier checklist mirrors now distinguish local order/gift debit keys from provider-native hold capture keys; no canonical funding contract retains the obsolete `debit:reservation` format. Both order and gift runtimes select the same mode-specific keys and tests assert their exact adapter calls.
- Refund `reasonCode` is persisted with an operation-binding check; migration 000009, both authoritative Prisma schema copies, both state-constraint mirrors and the Sandbox design reference are synchronized.
- Provisioning now uses one transaction and an advisory lock, preflights all three fixed fixtures, removes conflict updates, and fails before any write if any fixture was already provisioned. Re-running cannot rotate binding codes, clear consumption state, or reset balances.

### RED / GREEN

- RED: `npx vitest run tests/m2-us-04-db.spec.ts tests/m5-us-05-sandbox-funding-db.spec.ts` exited 1 with 2 failed files, 7 failed and 10 passed tests. Failures reproduced the synthetic external reference, ignored failed/unknown adapter states, missing replay debit, `blackcat_app` permission denial, concurrent duplicate-key failure, and unsafe successful reprovision.
- Independent-review RED: the same focused area exited 1 with 6 new failures reproducing missing balance revalidation, accepted mismatched provider results, non-retryable/cached provider errors, raw cross-account duplicate-key errors, incomplete debit/refund replay fingerprints, and unmapped PostgreSQL funding-lock timeout.
- Second-review RED: native-hold capture and post-debit/local-failure recovery both failed in 1 file / 2 focused tests, reproducing the incorrect hold-key comparison and balance gate that could strand a successful debit.
- Final-review RED: `npx vitest run tests/m2-us-04-db.spec.ts tests/m2-us-04-api.spec.ts tests/m5-us-05-sandbox-funding-db.spec.ts tests/m5-us-05-sandbox-funding.spec.ts` exited 1 with 4 files, 6 failed and 31 passed tests. Failures reproduced revoked-binding native capture, first/refund-replay DTO drift in sequential and concurrent paths, cached local convergence failure, and contradictory provider-key contracts.
- Re-review RED: `npx vitest run tests/m3-us-03-api.spec.ts tests/m5-us-05-sandbox-funding.spec.ts` exited 1 with 2 failed and 8 passed tests. The failures proved native gift capture still used the fallback gift key and that the highest-priority main specification mirror remained contradictory/stale.
- GREEN: `npx vitest run --no-file-parallelism tests/m2-us-04-db.spec.ts tests/m2-us-04-api.spec.ts tests/m3-us-03-api.spec.ts tests/m5-us-05-sandbox-funding-db.spec.ts tests/m5-us-05-sandbox-funding.spec.ts` exited 0 with 5 files / 40 tests passed and clean PostgreSQL teardown.
- Security/idempotency regression: `npx vitest run tests/m0-us-03.spec.ts tests/m1-us-01-api.spec.ts tests/m1-us-02-api.spec.ts tests/m4-us-03-api.spec.ts` exited 0 with 4 files / 53 tests passed.
- `npm run typecheck`, `npm run db:validate`, `npm run db:verify:migration`, and `git diff --check` exited 0. The migration verifier again reported 63 tables, 3 Sandbox funding tables, and 2 Sandbox append-only guards.

### Modified files

- Runtime/data/contracts: `database/prisma/migrations/000009_sandbox_funding/migration.sql`, both Prisma schema copies, both state-constraint mirrors, both main-specification/OpenAPI/API-guide/adapter-contract/provider-specification/supplier-checklist mirrors, `docs/superpowers/specs/2026-07-19-railway-sandbox-pilot-design.md`, `apps/api/src/sandbox-funding.ts`, `apps/api/src/sandbox-funding-provision.ts`, `apps/api/src/security.ts`, `apps/api/src/service-lifecycle.ts`, `apps/api/src/gifts.ts`, `apps/api/src/index.ts`, and `apps/api/src/worker.ts`.
- Tests/evidence: `tests/m5-us-05-sandbox-funding-db.spec.ts`, `tests/m5-us-05-sandbox-funding.spec.ts`, `tests/m2-us-04-db.spec.ts`, `tests/m2-us-04-api.spec.ts`, `tests/m3-us-03-api.spec.ts`, this summary, and both TODO mirrors.

M5-US-09 and M5-US-10 remain unstarted and incomplete. This remediation is local automated evidence only; it does not claim Railway, Discord, OAuth, restore, ten-order UAT, or human signoff execution.

## Contract-mirror correction (2026-07-24 MDT)

- The final full regression exposed that `reasonCode` existed in the authoritative `outputs/` Prisma schema but was missing from the `docs/` mirror. The missing field was copied exactly into the docs mirror without changing the migration or runtime behavior.
- RED: `npm test` exited 1 with 132 files / 796 tests passed and only `tests/m6-us-00-contract.spec.ts` failing its byte-identical Prisma mirror assertion.
- GREEN: `npx vitest run tests/m6-us-00-contract.spec.ts` passed 1 file / 7 tests; `cmp` confirms both Prisma schemas are byte-identical and `git diff --check` passes.
