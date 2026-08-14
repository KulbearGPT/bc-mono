# API review — gift audit atomicity

## Story and acceptance

- Story: `codex/api-review-gift-audit-atomicity`
- Acceptance: `AT-GFT-006`, `AT-GFT-009`, `AT-RES-009`, `AT-RES-010`, `AT-AUD-001`, `AT-AUD-004`
- Scope: unified API gift request creation, verification, approval/capture, rejection, and customer withdrawal. Bot and Dashboard contracts are unchanged.

## RED

`npx vitest run tests/m3-us-02-api.spec.ts`

- Result before implementation: 2 failed / 7 passed.
- A successful approval or rejection produced no success audit because the route returned a no-op staged commit.
- A deliberately failing audit sink still allowed approval/capture to return 200 and retain the gift, reservation, consumption, and outbox mutations.

## Implementation

- Approval authorization, optional escalation creation/decision, internal-wallet capture, reservation event, external transaction, consumption, referral commission, gift state, staff task, announcement outbox, and success audit now share one PostgreSQL transaction.
- Verification, rejection, and customer withdrawal now defer mutation to the secure route commit boundary and insert the audit in the same transaction.
- In-memory stores snapshot/restore all affected collections when audit persistence fails; gift request creation also rolls back its request/reservation/task/expiry batch.
- Commit failures are explicitly retryable through the existing idempotency recovery path. Replays do not create a second capture or reservation.
- Approval response status remains 202 for escalation and 200 for capture/replay. URLs, request bodies, and response envelopes remain unchanged.

## GREEN and database evidence

`npx vitest run tests/m3-us-02-api.spec.ts`

- Result: 1 file / 9 tests passed, including verification, approval/capture, and rejection audit-failure rollback.

`npx vitest run tests/m3-us-02-db.spec.ts`

- Result: 1 file / 3 tests passed against an isolated temporary PostgreSQL database.
- The new test first inserts the exact audit ID, then runs approval. The forced audit unique-key failure rolls back authorization, wallet entry, transaction, consumption, reservation capture, gift state, and outbox to the original facts.

`npx vitest run tests/m3-us-01-db.spec.ts tests/m3-us-02-db.spec.ts tests/m10-us-05-db.spec.ts tests/m10-us-05-postgres.spec.ts`

- Result: 4 files / 7 tests passed, covering gift creation/capture/release and related wallet persistence.

`npx vitest run tests/m3-us-01-api.spec.ts tests/m3-us-02-api.spec.ts tests/m3-us-03-worker.spec.ts tests/m3-us-06-api.spec.ts tests/m4-us-04-api.spec.ts tests/m4-us-10-api.spec.ts tests/m5-us-06-pilot-features.spec.ts`

- Result: 7 files / 40 tests passed.

`npx vitest run tests/m3-us-01-bot.spec.ts tests/m3-us-02-dashboard.spec.ts tests/m4-us-02-dashboard.spec.ts tests/m4-us-03-dashboard.spec.ts tests/m4-us-10-bot.spec.ts tests/m6-us-05-bot.spec.ts`

- Result: 6 files / 43 Bot/Dashboard compatibility tests passed.

`npm run typecheck`

- Result: passed.

`git diff --check`

- Result: passed.

## Client compatibility

- No Bot or Dashboard source was modified.
- Gift verification, approval, escalation, capture, rejection, and withdrawal keep their existing HTTP operations and payload shapes.
- The only observable failure-path change is intentional: if the success audit cannot be committed, the API returns a retryable 500 and leaves zero business or financial mutation.

## Remaining scope

Generic approval-request runtime routes, reservation aggregation, receipt orphan cleanup, API quality/module debt, and readiness legacy projection cleanup remain separate remediation Stories.
