# M6-US-02 Settlement Review, Export, and Payment Evidence

- Date: 2026-07-19
- Acceptance: AT-SET-004, AT-SET-005, AT-SET-006, AT-SET-010
- Status: completed

## Delivered

- Added Dashboard-only settlement list, detail, preview, create, submit, approve, CSV export, external payment-result registration, and void routes over the shared business API.
- Enforced L2 read, L3 management, L4 destructive/high-value approval, recent step-up, idempotency, optimistic versions, audit reasons, and actor-identity maker-checker rules. Role inheritance cannot satisfy the different-actor check.
- Kept CSV export as a pure read. The transfer list contains immutable player display name, Discord ID, and masked external-account hints, but never bank data or full external account identifiers.
- Payment results are append-only and whole-item only. A failed result can be retried; one successful result is terminal for that item, and only successful source earnings become PAID.
- Batch state converges through APPROVED, EXPORTED, PARTIALLY_PAID, and PAID. The first result registration may atomically establish EXPORTED state; partial-batch payment never implies a partially paid item.
- The system records evidence and ledger state only. It does not initiate bank or payment-provider transfers.
- Review hardening moved US-02 schema changes into additive migration `000003`, preserving the checksum of already-applied US-01 migration `000002` while supporting both fresh installs and upgrades.
- Settlement writes now use the secure staged-write contract. PostgreSQL applies the business transition and success audit in one transaction; audit/commit failure leaves no published business state and the idempotency key can retry safely.
- External account hints are masked again at the domain boundary. Identifiers of four characters or fewer expose no characters; longer identifiers expose only the final four.
- Batch creation uses the same staged-write rule as later transitions. Upgrade migration backfills missing legacy payment evidence with an explicit review marker, preserves duplicate historical facts while preventing new successes, and removes ambiguous legacy account suffixes.

## TDD Evidence

- API RED: transfer export initially omitted player display, Discord, and masked external-account snapshots.
- Database RED: direct SQL accepted a partial successful item payment before the whole-item payment trigger was added.
- Concurrency RED: competing successful registrations could both pass before the unique success guard and row/version locking were added.
- Atomicity RED: stale item versions and mixed valid/invalid result sets required transaction-wide rollback.

## Verification

- `npx vitest run tests/m6-us-02-api.spec.ts tests/m6-us-02-db.spec.ts tests/m6-us-02-migration.spec.ts`: 3 files, 21 tests passed.
- Combined M6-US-01/02 regression: 5 files, 46 tests passed.
- `npm run typecheck`: passed.
- `npm run db:validate`: Prisma schema valid.
- `npm run db:verify:migration`: passed with settlement lifecycle, immutable snapshot, append-only result, whole-item, and duplicate-success guards active.
- `git diff --check`: passed.

## Acceptance Mapping

- AT-SET-004: four-level permissions, step-up, reason, idempotency, current versions, and actor-identity maker-checker are enforced.
- AT-SET-005: deterministic BOM/RFC4180 CSV exports include operationally useful masked snapshots and exclude bank/full account data.
- AT-SET-006: successful payment requires the exact whole-item net amount and atomically marks only its earning sources PAID.
- AT-SET-010: failed results remain append-only and retryable; concurrent/stale/duplicate registrations fail without partial projection.

## Remaining Scope

- Scheduled weekly report generation and notification belong to M6-US-03.
- Dashboard presentation of settlement/report workflows belongs to M6-US-04.

## Security Remediation (2026-07-19)

- Production `apps/api/src/index.ts` now constructs and registers `PostgresSettlementStore`; settlement routes are no longer test-only wiring.
- Production secure writes now use `PostgresIdempotencyStore` over the existing `idempotency_records` unique scope. Atomic reservation, durable completed/failed response replay, expiry reclamation, fingerprint conflict, and selective `COMMIT_FAILED` retry survive process restart.
- Secure middleware now awaits synchronous or asynchronous idempotency stores, preserving existing in-memory test behavior while making the production path durable.
- Both OpenAPI mirrors now declare trusted Dashboard Guild scope, response `guildId`, and dedicated `SettlementVoidInput`. `replacementBatchId` was removed from the generic mutation/create contract and is canonical only on void with its paired replacement payload.
- Durable-idempotency RED failed because `PostgresIdempotencyStore` and production wiring did not exist. The real PostgreSQL restart-style replay test now passes.
- Focused remediation verification: 7 files / 58 tests passed, including real PostgreSQL settlement and idempotency tests; typecheck, Prisma validation, migration verification, OpenAPI/schema mirror comparison, and whitespace validation are part of the completion gate.
