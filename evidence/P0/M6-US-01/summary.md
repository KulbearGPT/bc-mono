# M6-US-01 Settlement Domain and Persistence Evidence

- Date: 2026-07-19
- Acceptance: AT-SET-001, AT-SET-002, AT-SET-003
- Status: completed

## Delivered

- Added `SettlementStore`, `InMemorySettlementStore`, `PostgresSettlementStore`, `previewSettlement`, and `createSettlementBatch` with immutable batch/item/entry snapshots.
- P0 candidates are explicitly limited to CNY, confirmed earnings at the inclusive cutoff, and optional `playerUserId` filters.
- Automatic batches use `scheduleKey + periodStart + periodEnd + currency`; concurrent replays re-read the identity after the source lock and return the same batch.
- PostgreSQL locks eligible earnings and adjustments. A database membership guard also takes a source advisory transaction lock and rejects a second active allocation. A VOIDED batch releases its source membership for one replacement batch while preserving the old entries.
- Late adjustments never re-batch a paid earning. Negative-only or non-positive player totals remain unallocated and are exposed by preview as `deferredAdjustmentMinor`; a later positive confirmed earning can absorb the debit into a non-negative settlement item.
- `cutoffAt` is stored independently from the real creation timestamp. Finalization verifies each item against its entries and the batch against its items, then freezes the snapshot against later inserts or rewrites.
- Entry guards require the source to belong to the same player, require earnings to be confirmed no later than the stored cutoff, and preserve source amount, currency, and occurrence time.
- `SettlementItem.netAmountMinor` and batch net are constrained to be non-negative. `VOIDED` is terminal, replacement history can only be set once, entries and payment results reject update/delete, and settlement records reject hard delete.
- PostgreSQL bigint values are range-checked before conversion to JavaScript numbers; out-of-range minor-unit values fail explicitly rather than losing precision.
- Safe-integer checks also cover computed net totals. A `PARTIALLY_PAID` batch cannot be voided, so already-paid sources cannot be released into a replacement batch.
- Direct batch inserts must begin as unfinalized drafts; empty snapshots cannot be finalized. Replacement targets must be finalized, active, same-currency, and acyclic.
- SCHEDULED keys must be non-empty, entry source fields are XOR/type constrained, and payment results use the `SUCCEEDED | FAILED`-only enum. Weekly report tables remain deferred to M6-US-03.

## TDD Evidence

- Domain RED: `npx vitest run tests/m6-us-01.spec.ts` failed because `@blackcat/api/settlements` did not exist.
- Contract-clarification RED: the negative-only carry-forward test failed because the initial implementation created a `netAmountMinor=-1200` item instead of deferring it.
- Database RED: `npx vitest run tests/m6-us-01-db.spec.ts` failed because `000002_m6_settlements/migration.sql` did not exist.
- Concurrency RED: concurrent automatic schedule replay failed with `SOURCE_ALREADY_BATCHED` before the post-lock identity re-read was added.
- Snapshot RED: a valid-looking simultaneous batch/item gross and net amount rewrite succeeded before snapshot immutability triggers were added.
- Integrity-review RED: wrong-player entries, post-finalization inserts, `VOIDED -> DRAFT`, replacement clearing, and unsafe bigint conversion all succeeded before the hardening pass.
- Second-review RED: `PARTIALLY_PAID -> VOIDED`, direct finalized INSERT, empty finalization, PENDING-source Adjustment, unsafe computed net, and unfinalized replacement targets were accepted before the final hardening pass.

## Verification

- `npx vitest run tests/m6-us-01.spec.ts tests/m6-us-01-db.spec.ts`: 2 files, 25 tests passed.
- `npm run typecheck`: passed.
- `npm run db:validate`: Prisma schema valid.
- `npm run db:verify:migration`: passed with settlement ownership, totals, finalization, lifecycle, and append-only guards active.
- Full-suite status is recorded by the final M6 release-gate Story; this Story's focused regression set is authoritative here.
- `git diff --check`: passed.

## Acceptance Mapping

- AT-SET-001: real PostgreSQL races permit one active allocation; earning and adjustment guards reject duplicate or wrong-player membership and roll back partial writes.
- AT-SET-002: sequential and concurrent automatic schedule replays return one deterministic batch without duplicate entries.
- AT-SET-003: finalized entry/item/batch totals remain immutable; late paid-earning debits stay deferred across periods until positive earnings produce a non-negative next-batch item; void and replacement history cannot be reversed.

## Remaining Scope

- Review, approval, export, and external payment-result workflows belong to M6-US-02. No transfer provider or bank integration is implemented here.

## Security Remediation (2026-07-19)

- Added immutable `guildId` ownership derived from trusted Dashboard Actor Context to settlement preview, create, list, get, export, and every mutation. Request-body Guild values are ignored.
- Added incremental migration `000007_settlement_security_remediation`: strict legacy ownership backfill, non-null immutable `guild_id`, Guild-scoped schedule uniqueness and list indexes, same-Guild replacement guards, and a database trigger that rejects cross-Guild source entries.
- Source discovery and source locks now join `orders` and require the trusted Guild. Cross-Guild object reads and mutations return not found.
- Reconciled replacement creation into an atomic void operation. DRAFT/PENDING_REVIEW may omit replacement; APPROVED/EXPORTED require `replacementBatchId` and a standard replacement-create payload. The transaction releases the original source membership, creates/finalizes the replacement, and links the immutable history without allowing two valid memberships.
- Remediation RED evidence: Guild ownership was absent, approved void without replacement returned 200, and direct SQL accepted a cross-Guild source before the new tests and trigger.
- Focused remediation verification: `npx vitest run tests/m6-us-00-contract.spec.ts tests/m6-us-01.spec.ts tests/m6-us-01-db.spec.ts tests/m6-us-02-api.spec.ts tests/m6-us-02-db.spec.ts tests/m6-us-02-migration.spec.ts tests/m6-settlement-security.spec.ts` passed 7 files / 58 tests; `npm run db:validate` and `npm run db:verify:migration` passed.
