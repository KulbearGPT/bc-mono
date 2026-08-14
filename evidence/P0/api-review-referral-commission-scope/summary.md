# API review — referral and commission Guild scope

## Story and acceptance

- Story: `codex/api-review-referral-commission-scope`
- Acceptance: `AT-RFP-005`, `AT-RFP-006`, `AT-RFP-007`, `AT-LST-008`
- Scope: confidential staff referral/commission API and PostgreSQL stores. Current-user beneficiary DTOs remain unchanged.

## RED

`npx vitest run tests/m3-us-07-api.spec.ts tests/m3-us-05-commissions-api.spec.ts`

- Result before implementation: 2 failed / 9 passed.
- Evidence: confidential referral creation and commission list/mutation store inputs received no trusted Guild, so their persistence queries had no way to isolate business facts.

## Implementation

- Trusted Actor Guild is now mandatory in every confidential referral and commission list, detail, create/correct, and mutation store call.
- Referral list/detail scope is derived from the referred customer's persisted Discord account Guild. Creation and correction require both referred customer and beneficiary to be bound in the actor Guild.
- Commission scope is derived from its immutable source consumption through the order, or through the gift and its order; the client cannot supply this relation.
- PostgreSQL mutation and idempotency replay reload the record through the same Guild-scoped query after transaction start/row lock.
- In-memory stores require explicit Guild fixtures and mirror the production fail-closed behavior.
- Cross-Guild lists return an empty page; object reads and writes return non-enumerable 404 and create no facts.

## GREEN and compatibility evidence

`npx vitest run tests/m3-us-07-api.spec.ts tests/m3-us-05-commissions-api.spec.ts tests/m4-us-03-list-pagination.spec.ts`

- Result: 3 files / 18 tests passed.

`npx vitest run tests/m3-us-07-db.spec.ts tests/m3-us-05-db.spec.ts tests/m3-us-07-api.spec.ts tests/m3-us-05-commissions-api.spec.ts tests/m3-us-05-api.spec.ts tests/m3-us-05-bot.spec.ts tests/m4-us-03-list-pagination.spec.ts tests/m6-us-04-dashboard.spec.ts`

- Result: 7 discovered files / 40 tests passed, including temporary PostgreSQL referral/commission transactions, beneficiary-only privacy, Bot rendering, and Dashboard profile compatibility.
- PostgreSQL cross-Guild detail checks return `NOT_FOUND`; same-Guild creation, correction, list pagination, confirmation, paid transition, and idempotent Adjustment remain valid.

`npm run typecheck`

- Result: passed.

`git diff --check`

- Result: passed.

## Client compatibility

- Bot and Dashboard sources, URLs, payloads, and DTOs were not changed.
- Beneficiary self-view remains resolved from trusted Actor Context and still masks the source customer.
- Authorized L2 redacted referral list and L3 confidential workflows retain their existing response shapes.

## Remaining scope

Transactional gift audit, approval runtime, reservation aggregation, receipt orphan cleanup, API module debt, and readiness legacy projection cleanup remain separate remediation Stories.
