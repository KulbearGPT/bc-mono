# M5-US-06 Verification Evidence

Verified on 2026-07-19 EDT.

## Delivered

- Added the three-value `PilotFeaturePolicy`: `CORE_ORDER` enables only core orders, `CORE_ORDER_AND_GIFTS` additionally enables gifts, and `OFF` removes Pilot restrictions by enabling all four candidate feature groups.
- The production API entry point parses `PILOT_PHASE` exactly once and fails startup when it is absent or unknown. Legacy isolated server tests default explicitly to `OFF` without reading process environment inside route handlers.
- Extended the shared secure read/write wrappers with `requiredFeature`. After trusted actor and accepted-source resolution, a disabled feature returns HTTP 409 `FEATURE_DISABLED`, appends a `REJECTED` audit with reason `FEATURE_DISABLED:<feature>`, and returns before CSRF, idempotency, permission, step-up, handler, Provider or Outbox work.
- Marked every secure route in gifts (7), commissions (3), referrals (4), settlements (9), weekly reports (6), and customer profiles (2) with its frozen `GIFTS`, `REFERRALS`, or `M6` feature.
- Extended authenticated capabilities with API-authoritative `enabledFeatures` and `businessEnvironment`; synchronized both byte-identical OpenAPI mirrors and the Sandbox `.env.example`.

## TDD Evidence

- RED: `npx vitest run tests/m5-us-06-pilot-features.spec.ts` failed before test collection because `@blackcat/api/pilot-features` did not exist.
- GREEN: the focused policy suite passed 1 file / 5 tests. It covers the exact matrix, unknown/missing startup phase, stable 409 payload, rejection audit, untouched CSRF/step-up/idempotency/handler collaborators, capabilities, and closed OpenAPI schema.
- A focused contract and affected-module run passed 9 files / 44 tests.
- The first full regression exposed an unsynchronized authoritative OpenAPI mirror. After synchronizing only that contract mirror, the failed subset passed 6 files / 58 tests.

## Final Verification

- Full regression: `npm test` passed 129 files / 754 tests.
- `npm run typecheck` and `npm run build` exited successfully.
- All 31 secure route registrations in the six named non-core modules have exactly one feature annotation.
- `git diff --check` and authoritative docs/outputs mirror comparisons passed before commit.
- The acceptance matrix was regenerated from the updated `DONE` delivery status; Railway/Discord/external UAT rows remain external and are not promoted by this Story.

## Modified Files

- Runtime and contract: `.env.example`, `apps/api/package.json`, `apps/api/src/pilot-features.ts`, `apps/api/src/security.ts`, `apps/api/src/index.ts`, `apps/api/src/dashboard-auth.ts`, and both OpenAPI mirrors.
- Route annotations: `apps/api/src/gifts.ts`, `apps/api/src/commissions.ts`, `apps/api/src/referrals.ts`, `apps/api/src/settlements.ts`, `apps/api/src/weekly-reports.ts`, `apps/api/src/customer-profiles.ts`.
- Verification and status: `tests/m5-us-06-pilot-features.spec.ts`, both backlog/TODO mirrors, this evidence file, and the regenerated acceptance matrix.

## Remaining Scope

Client-side Sandbox labels, OWNER balance controls and feature-aware navigation remain M5-US-07. Railway runtime packaging remains M5-US-08. Actual Railway deployment, restore exercise, Discord validation, two-role UAT and the two-day observation remain external M5-US-09/10 gates and are not claimed here.

## Final-review remediation (2026-07-24 MDT)

- CORE_ORDER order completion now keeps consumption and base player-earning facts but does not create referral commissions in either the in-memory or PostgreSQL path.
- `/api/v1/me/profile` is guarded by M6 and `/api/v1/me/commissions` by REFERRALS, while self and admin consumption histories remain part of CORE_ORDER.
- The production worker neither constructs weekly-report stores/handlers nor schedules weekly generation when M6 is disabled. Claiming is filtered to the installed handler types, so pre-existing or restored M6 jobs remain pending without consuming attempts under CORE_ORDER.
- Current-user and lifecycle-readiness responses now carry API-authoritative `enabledFeatures`. The Bot skips disabled API calls, hides REFERRALS/M6 surfaces, renders gift buttons only when `GIFTS` is present, and fails closed without throwing for missing or malformed capability payloads. Both OpenAPI mirrors define the closed response fields.
- CORE_ORDER_AND_GIFTS captures gifts and their core financial facts without creating referral commissions; the route passes the policy decision through the capture command and both in-memory/PostgreSQL completion paths preserve the same phase semantics.

### RED / GREEN

- Restored reviewer RED: 5 expected failures reproduced referral creation, unguarded profile/commission reads and weekly-report installation/scheduling under CORE_ORDER.
- Bot/capability RED: `npx vitest run --no-file-parallelism tests/m2-us-04-bot.spec.ts tests/m2-us-04-api.spec.ts tests/m6-us-06-bot.spec.ts` exited 1 with 2 failed and 21 passed tests because readiness omitted `enabledFeatures` and the Bot still rendered gifts.
- Admin consumption RED: `npx vitest run tests/m5-us-07-dashboard-sandbox.spec.ts` exited 1 with 1 failed and 5 passed tests because CORE_ORDER returned `FEATURE_DISABLED`.
- Service-center fail-closed RED: 3 files exited with 3 failed and 16 passed tests because `/me` omitted capabilities, CORE_ORDER still called/rendered disabled surfaces, and malformed readiness capabilities threw a `TypeError`.
- Gift second-wave RED: `tests/m3-us-02-db.spec.ts` created an eligible lifetime attribution and exited with 1 failed / 1 passed because CORE_ORDER_AND_GIFTS still inserted one commission.
- Existing-job Worker RED: `tests/m6-us-03-worker.spec.ts` exited with 1 failed / 3 passed because CORE_ORDER claimed a pending weekly-report job, incremented its attempt and scheduled a retry.
- Startup-recovery RED: the same worker suite exited with 1 failed / 4 passed because CORE_ORDER recovery changed a stale weekly-report job from PROCESSING to FAILED. PostgreSQL subset assertions also lock both claim and recovery SQL to the installed job types.
- GREEN: the serialized affected suite passed 13 files / 89 tests; `npm run typecheck`, OpenAPI/TODO mirror comparisons and `git diff --check` passed.
- Full regression initially passed 132 files / 796 tests and failed only the unrelated M5-US-05 Prisma mirror assertion. That mirror defect was isolated and committed separately as `bc4add9`; the Story 06 suite remained green.
- Final full regression after all follow-up fixes: `npm test` passed 133 files / 802 tests.

### Modified files

- Runtime: `apps/api/src/accounts.ts`, `apps/api/src/admin-directory.ts`, `apps/api/src/gifts.ts`, `apps/api/src/outbox.ts`, `apps/api/src/service-lifecycle.ts`, `apps/api/src/worker-runtime.ts`, `apps/api/src/worker.ts`, `apps/bot/src/service-center.ts`.
- Contracts/tests: both OpenAPI mirrors and the focused M0/M1/M2/M3/M5/M6 API, database, Bot, Dashboard and worker tests listed in the command evidence above.

M5-US-09 and M5-US-10 remain unstarted and incomplete; this remediation claims no external Railway, Discord or human UAT evidence.
