# M4-US-06 Verification Evidence

Verified on 2026-07-18 MDT.

## Delivered

- Shared API operations for scoped immutable audit search, failed Job listing and safe retry, current Policy settings, and append-only Policy updates.
- L1 self, L2 same-Guild business team, L3 business, and L4 all-system audit scopes. Access, MFA, session, and Role security records remain self/L4-only.
- Signed cursor pagination, target filtering, true actor user IDs, and redacted operational failures with stable request ID values.
- Failed Job visibility is tiered: L2 sees delivery/display and channel-creation failures, L3 additionally sees business timers/expiry, and L4 additionally sees security Role reconciliation. Manual retry remains restricted to pure delivery/display jobs.
- Policy keys match the frozen OpenAPI enum. Amount, basis-point, and minute settings enforce units, currency semantics, ranges, reason, step-up, and optimistic versioning.
- The shared Policy reader drives subsequent Dashboard threshold display, gift/refund approval levels, dispatch expiry, and MFA step-up validity; existing transaction and approval snapshots are not rewritten.
- PostgreSQL Job and Policy writes commit their success audit in the same transaction; Policy history is appended rather than overwritten.
- A real Bot private-channel failure uses a deterministic request ID, retries API reporting once, creates no order, and becomes visible in the Dashboard recovery list.
- A usable /operations Dashboard page for audit records, failed Jobs, settings, pagination, request ID errors, retry, and Policy editing.
- Dashboard capabilities cumulatively grant Job operations at L2 and Policy operations at L3.
- Channel and Role configuration remains owned by the dedicated M4-US-10 /bot-config contract.

## Acceptance

- AT-AUD-001: passed for actor identity, level/source/client, permission, target, before/after snapshots, reason, request ID, and transactional persistence.
- AT-AUD-004: passed through isolated Bot and Dashboard calls producing equal retry state, version, and stable audit facts; only client source fields differ.
- AT-CHN-003: passed for real Bot channel-failure reporting, user request ID visibility, no order creation on failure, Dashboard recovery visibility, and existing active-order idempotency regression.

## Gates

- Focused operational and regression suite: 7 files / 54 tests passed.
- Full npm test: 87 files / 449 tests passed.
- npm run typecheck: passed.
- npm run build: passed.
- Dashboard Vite production build: passed (236.53 kB, gzip 73.00 kB).
- npm run db:validate: passed.
- npm run db:verify:migration: passed with 51 tables and all negative/append-only probes.
- OpenAPI parsed as YAML; docs/output OpenAPI mirrors and all Prisma schema mirrors match.
- git diff --check: passed.

## Review

- Initial independent review: no Critical; seven Important and three Minor findings.
- All findings were addressed: prefix-based business/security scope separation, tiered Job visibility, actor mapping, retry allowlist, error redaction, reliable channel-failure E2E, Bot/Dashboard parity, runtime Policy wiring, OpenAPI outcome/opaque target identifiers, retry note audit, exact input validation, and key-specific Policy semantics.
