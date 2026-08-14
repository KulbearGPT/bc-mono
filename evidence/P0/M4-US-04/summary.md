# M4-US-04 Verification Evidence

Verified on 2026-07-18 MDT.

## Delivered

- Shared Dashboard/API TOTP enrollment, one-time recovery codes, expiring session-bound step-up challenges, and 15-minute recent-verification state.
- L3/L4 sessions remain at onboarding-only L1 access until MFA enrollment succeeds; capabilities expose enrollment and current step-up validity.
- Five invalid proofs lock an enrollment or challenge. Secrets are encrypted, recovery codes are hash-only, and idempotency fingerprints/responses do not retain plaintext proofs or recovery material.
- PostgreSQL ownership, expiry, replay, immutable-field and single-use protections, plus transaction-local database audit guards for every MFA and step-up state change.
- Dashboard account-security page with execution thresholds, MFA enrollment, recovery-code delivery, and step-up controls.
- Existing amount policies remain authoritative: L2 gift `200000` / refund `50000` execute directly; gift `200100` / refund `50100` enter approval without premature provider, debit, or broadcast effects; L3 can continue after step-up; `500000` remains L4.

## Acceptance

- `AT-GFT-005`: passed.
- `AT-RBAC-004`: passed.
- `AT-RBAC-005`: passed.
- Same-person continuation, stale/expired challenge, single-use recovery, idempotent replay, MFA onboarding downgrade, attempt lockout and immutable audit coverage passed.

## Gates

- Focused `tests/m4-us-04-api.spec.ts` and `tests/m4-us-04-db.spec.ts`: 2 files / 11 tests passed.
- `pnpm test`: 81 files / 399 tests passed.
- `pnpm typecheck`: passed.
- `npx vite build apps/dashboard --config apps/dashboard/vite.config.ts`: passed (`228.64 kB`, gzip `71.15 kB`).
- `pnpm db:validate`: passed.
- `pnpm db:verify:migration`: passed with 51 tables and all MFA ownership, expiry, replay, attempt, atomic-audit and immutable-field probes.
- Runtime, docs and output Prisma schemas match; docs and output OpenAPI contracts match.
- `git diff --check`: passed.
