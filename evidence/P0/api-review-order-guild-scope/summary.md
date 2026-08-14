# API review — order Guild scope

## Story and acceptance

- Story: `codex/api-review-order-guild-scope`
- Acceptance: `AT-LST-008`, `AT-SUX-004`, `AT-MULTI-003`, `AT-ACT-003`
- Scope: unified API order authorization and store inputs. Existing Bot and Dashboard URLs, payloads, and response DTOs are unchanged.

## RED

`npx vitest run tests/m4-us-04-api.spec.ts`

- Result before implementation: 1 failed / 8 passed.
- Evidence: a trusted Dashboard actor could refund a completed order from another Guild; the API returned HTTP 200 and created the refund.

`npx vitest run tests/m1-us-03-api.spec.ts tests/m2-us-11-api.spec.ts`

- Result before implementation: 2 failed / 11 passed.
- Evidence: a customer binding could read the same internal customer's order from another Guild, and L1 could pause another Guild's order; both returned HTTP 200 instead of non-enumerable 404.

The lifecycle regression likewise proves a valid player binding in one Guild cannot write readiness to that player's order in another Guild.

## Implementation

- Admin refund, resolve, and reassign now require the order Guild to equal the trusted actor Guild before any approval, financial, or order facts are staged.
- Customer order read/update/estimate/submit/cancel/recovery paths share `requireVisibleOrder`, which now verifies both customer ownership and binding Guild.
- Automation pause/resume checks order Guild before task scope, status, or version checks.
- Readiness, completion request, and completion confirmation carry trusted Guild into the store commit boundary and revalidate it after the PostgreSQL order row is locked, closing the transaction-time bypass.
- Active-order creation preserves the database's global one-active-order-per-customer invariant: a cross-Guild existing order is not disclosed, and a second active order is not created.
- Missing or mismatched order Guild fails closed as resource not found.

## GREEN and compatibility evidence

`npx vitest run tests/m1-us-03-api.spec.ts tests/m2-us-04-api.spec.ts tests/m2-us-11-api.spec.ts tests/m4-us-04-api.spec.ts`

- Result: 4 files / 33 tests passed.

`npx vitest run tests/m1-us-03-db.spec.ts tests/api-review-refund-integrity-db.spec.ts tests/m1-us-03-api.spec.ts tests/m2-us-04-api.spec.ts tests/m2-us-11-api.spec.ts tests/m4-us-04-api.spec.ts tests/m1-us-07-bot.spec.ts tests/m1-us-08-bot.spec.ts tests/m2-us-05-bot.spec.ts tests/m15-us-02-dashboard-refund.spec.ts`

- Result: 10 files / 64 tests passed, including temporary PostgreSQL migration/integrity runs and Bot/Dashboard compatibility.

`npx vitest run tests/m10-us-04-postgres.spec.ts tests/m10-us-04-lifecycle.spec.ts tests/m2-us-04-bot.spec.ts tests/m2-us-11-bot.spec.ts tests/m15-us-02-dashboard-refund.spec.ts tests/m16-us-03-dashboard-consistency.spec.ts`

- Result: 6 files / 33 tests passed.
- A legacy M10 in-memory fixture initially lacked `guildId`; the fixture was corrected rather than weakening fail-closed production authorization. PostgreSQL records already persist Guild.

`npm run typecheck`

- Result: passed.

`git diff --check`

- Result: passed.

## Client compatibility

- Bot sources were not changed. Order creation, submission, cancellation, lifecycle, and automation Bot tests passed.
- Dashboard sources were not changed. Refund and order consistency tests passed.
- No API URL, request field, response field, permission code, or status transition contract changed for authorized same-Guild callers.

## Remaining scope

Referral/commission scope, transactional gift audit, approval runtime, reservation aggregation, receipt orphan cleanup, and API module debt remain separate remediation Stories.
