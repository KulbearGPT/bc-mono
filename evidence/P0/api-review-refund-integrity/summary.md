# API review — standalone refund integrity

## Story and acceptance

- Story: `codex/api-review-refund-integrity`
- Acceptance: `AT-DOP-001`, `AT-CAN-009`, `AT-REF-005`, `AT-RFP-008`
- Scope: API and PostgreSQL only. Existing Bot and Dashboard request/response contracts are unchanged.

## RED

`npx vitest run tests/m4-us-04-api.spec.ts`

- Result: 1 failed / 7 passed.
- Evidence: after two successful refunds with different idempotency keys, a third refund made cumulative requested refunds exceed the original 200000 CAT charge and incorrectly returned HTTP 200 instead of 422.

## Implementation

- Preflight now derives refundable capacity from the succeeded source charge minus existing `PENDING`/`SUCCEEDED` refunds.
- The PostgreSQL commit locks the source `external_transactions` row before recomputing cumulative refunds, so different idempotency keys cannot race past the limit.
- In-memory fixtures implement the same cumulative invariant.
- Corrected the stale refund invariant message from USD to CAT.

## GREEN and compatibility evidence

`npm run typecheck`

- Result: passed.

`npx vitest run tests/api-review-refund-integrity-db.spec.ts tests/m4-us-04-api.spec.ts tests/m2-us-06-api.spec.ts tests/m2-us-06-db.spec.ts tests/m15-us-02-dashboard-refund.spec.ts tests/dashboard-cat-amount-input.spec.ts tests/m2-us-05-bot.spec.ts tests/m2-us-10-bot.spec.ts`

- Result: 8 files / 23 tests passed.
- PostgreSQL concurrency evidence: two staged refunds for 120000 and 100000 CAT raced against one 200000 CAT charge; exactly one committed, aggregate refund and wallet credit remained at or below the captured amount, and the rejected transaction left no refund/audit partial write.
- Dashboard compatibility: standalone refund form and CAT request builder tests passed without client changes.
- Bot compatibility: cancellation/refund response renderer tests passed without client changes.

`git diff --check`

- Result: passed.

## Remaining scope

This Story fixes only cumulative standalone refund integrity. Guild authorization, transactional gift audit, approval runtime, reservation aggregation, receipt storage, and API module debt remain separate review-remediation Stories.
