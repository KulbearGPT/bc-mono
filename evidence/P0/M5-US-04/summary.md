# M5-US-04 Verification Evidence

Verified on 2026-07-19 EDT.

## Delivered

- Added the Railway Sandbox Pilot contract without claiming runtime implementation or external deployment: explicit business environment, funding adapter and pilot phase values; production fail-closed behavior; four-process Railway target; two display roles backed by the existing L1-L4 authorization model; and stop/rollback conditions.
- Added `getSandboxFundingAccount` and `setSandboxTargetBalance` OpenAPI contracts. Target-balance mutation is L4-only, requires `sandbox_funding.manage`, recent step-up, `Idempotency-Key`, `expectedVersion`, CNY minor units and zero active reservations.
- Added canonical Prisma schema models for Sandbox Provider accounts, append-only balance adjustments and normalized debit/refund transactions. Binding-code plaintext is excluded; only a keyed hash and atomic consumed timestamp are modeled. The physical database migration and runtime repository implementation remain scoped to M5-US-05.
- Added nine authoritative acceptance cases. Five are locally automatable contract/runtime candidates; four Railway/Discord/restore/pilot cases remain `PENDING_EXTERNAL` and are mapped to the UAT runbook.
- Changed acceptance ownership and evidence selection to derive from `delivery_status=DONE` rather than milestone-name assumptions. M5-US-02 and M5-US-03 remain `PLANNED`; their external claims remain incomplete.

## TDD Evidence

- RED: `npx vitest run tests/m5-us-04-contract.spec.ts` failed 1/1 because the authoritative backlog did not yet contain M5-US-04.
- Intermediate RED: after the initial contract edit, the same command failed 1/1 because `sandbox_funding.manage` was not directly traceable from the backlog scope. The Story contract was corrected to name both read and manage permissions.
- GREEN: `npx vitest run tests/m5-us-04-contract.spec.ts` passed 1 file / 1 test.

## Contract Validation

- Both contract Prisma schemas passed `npx prisma validate` with an isolated placeholder PostgreSQL URL.
- Business configuration JSON Schema parsed successfully.
- OpenAPI, Prisma, state constraints, business configuration schema/example, acceptance catalog, interaction map and backlog output/docs mirrors matched byte-for-byte.
- The four new external cases are not reported as executed: AT-RWY-001, AT-RWY-002, AT-PILOT-001 and AT-PILOT-002 require real Railway/Discord/restore evidence in later unlocked Stories.

## Final Verification

- `node scripts/build-p0-acceptance-matrix.mjs .` wrote 184 rows: 133 `COVERED_BY_REGRESSION`, 51 `PENDING_EXTERNAL`, 0 external passed.
- Focused contract/traceability/release-gate regression passed 3 files / 72 tests.
- Full `npm test` passed 126 files / 738 tests.
- `npm run typecheck`, `npm run build`, `npm run db:validate`, `npm run db:verify:migration`, all authoritative output/docs mirror comparisons and `git diff --check` exited successfully.
- Running the release gate without approved non-example sign-off/config inputs returned `ready:false`; the complete P0 release gate remains blocked. M5-US-02 and M5-US-03 remain incomplete, and no external Railway or Discord result is claimed.
