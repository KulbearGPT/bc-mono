# M5-US-02 Recovery Candidate Evidence

Verified on 2026-07-19 EDT.

## Scope Correction

On 2026-07-20, the current release target was re-scoped to Railway with `BUSINESS_ENV=SANDBOX` and `FUNDING_ADAPTER=SANDBOX`. Third-party payment Provider selection, real recharge, Provider sandbox reconciliation and webhook reconciliation no longer block the current Railway Sandbox release. When a Provider is selected, it must be handled as a future independent integration Story.

M5-US-02 remains open. Its remaining completion evidence is now real Railway deployment, PostgreSQL backup/restore, Bot/Worker recovery, Sandbox Funding business-fact continuity and runbook review evidence.

## Completed Locally

- Production environment validator rejects missing values, known placeholders, short secrets, non-HTTPS endpoints, invalid Guild IDs, and shared application/migration credentials.
- Production-like Compose candidate separates migration ownership and adds PostgreSQL, API, Bot, Worker, and Dashboard restart/dependency declarations.
- A reusable HTTP Payment Provider Adapter implements capability discovery, user resolution, balance lookup, hold lifecycle, fallback debit, refund, transaction recovery, and signed webhook verification.
- API account, order, gift, refund, and webhook services now accept both synchronous test adapters and asynchronous network adapters through the same provider-neutral contract.
- Runtime selection uses the local Mock adapter only outside production when no supplier configuration is present; complete supplier configuration selects the HTTP adapter, while incomplete or missing production configuration fails closed.
- The production Worker claims and routes all eight delivery Job types, recovers stale `PROCESSING` locks at startup, preserves dedupe/idempotency keys, and exposes readiness only after recovery succeeds.
- Discord delivery adapters update or recreate dispatch messages and order panels, archive channels by removing send permission, reconcile Guild roles through the unified API, and use stable nonces for create operations.
- L2+ staff can queue an idempotent panel repair from the Dashboard. The API appends a `PANEL_SYNC` Job and audit record; the Worker rebuilds from current database facts and updates only `panel_message_id` when Discord confirms recreation.
- An isolated PostgreSQL recovery test proves that panel repair leaves order status, amount, row version, and fund records unchanged.
- Panel repair is restricted to the actor/configured Guild and uses a per-request generation, so a later deletion of the same message can be repaired without reusing a completed Job.
- Long-running handlers renew their processing lease; stale recovery remains at least three heartbeat intervals behind active work.
- Role reconciliation uses the Job creation timestamp as a deterministic observation time, keeping retries byte-equivalent for API idempotency.
- Discord message creation paginates history by stable nonce until the Job-time boundary before POST, and Discord 429 `retry_after` values flow into Outbox scheduling.
- AT-WHK-003 rejects invalid and expired webhook signatures without exposing the secret or applying an event.
- The narrow local restore probe performs a real PostgreSQL custom-format dump into a fresh cluster, restores one user and one audit fixture, checks those row counts, and proves audit deletion remains rejected. It is baseline evidence only, not an `AT-REC-005` pass.
- Deployment Runbook records deploy, backup, restore, restart, reconciliation, rollback, and blocking conditions.

## Verification

- `pnpm vitest run tests/m5-us-02-dashboard.spec.ts tests/m5-us-02-worker-adapters.spec.ts tests/m5-us-02-worker-db.spec.ts tests/m5-us-02-worker-delivery.spec.ts tests/m5-us-02-worker-runtime.spec.ts tests/m5-us-02-recovery.spec.ts`: local Dashboard, Worker, database, delivery, restart and deployment-candidate coverage passed.
- `pnpm vitest run tests/m5-us-02-http-provider.spec.ts`: 1 file / 4 tests passed, including all 11 provider-neutral operations, auth/idempotency headers, safe errors, webhook replay rejection, and runtime selection.
- `bash scripts/verify-backup-restore.sh`: `backup-restore-ok`, restored users/audits match, audit deletion rejected.
- The local baseline probe ran against candidate `git:65e9fe61886fd861a3202b5f07d57b86ec47ea23` at `2026-07-19T23:38:53.000Z`: exit `0`, `restored_users=1`, `restored_audits=1`, `audit-delete-rejected`, and `backup-restore-ok`. The retained artifact explicitly records the untested `AT-REC-005` requirements: `evidence/P0/external/AT-REC-005/2026-07-19-local-restore.md`.
- External acceptance matrix after regeneration: 175 total, 128 automated covered, 47 pending external, and 0 passed external. `AT-REC-005` remains `PENDING_EXTERNAL`.
- Full local regression: 125 files / 698 tests passed; TypeScript typecheck, TypeScript build, Dashboard Vite build, Prisma validation, 51-table migration probe, Sapphire Piece discovery, contract mirrors, and clean-patch checks passed.

## Blocking External Evidence

- No real payment supplier, sandbox base URL, credentials, or supplier-specific signature format has been selected; supplier contract mapping and sandbox reconciliation cannot be truthfully executed.
- The Worker runtime and handlers are locally implemented, but no production-like environment with real Discord credentials and Provider credentials has been executed or signed off.
- AT-REC-003 real Discord panel deletion/rebuild, AT-REC-004 restart observation, and a second team member's full Runbook deployment have not been executed.
- AT-REC-005 still requires representative orders, transactions, gifts, commissions, earnings, tasks, and audits; API/Bot startup after restore; referential and immutable-stream integrity checks; and active-order continuity. The narrow local probe does not cover those requirements.

M5-US-02 remains open. This candidate must not be described as production-ready.
