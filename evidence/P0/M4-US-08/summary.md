# M4-US-08 Verification Evidence

Verified on 2026-07-18 MDT.

## Delivered

- One read-only `getAdminOrder` route and projection for provider balance audit snapshots, order/reservation events, order and in-order gift transactions, consumption, refunds, player earnings, commissions, and append-only adjustments.
- Stable signed cursor pagination bound to the order and staff level, with original money facts kept separate from adjustment facts.
- L1 claimed-task scope, L2 same-Guild team scope, L3 business scope, and L4 all-system scope; commission facts are unavailable below L3 and referral identities, programs, rates, and bases are never serialized.
- A Dashboard order timeline with read-only rows, empty state, pagination, and visible request IDs for subsequent-page failures.
- A production route-registration guard so the support workbench and admin directory cannot register duplicate `getAdminOrder` handlers.

## Acceptance

- AT-TML-001: all required financial facts have stable ordering, explicit direction, non-negative minor-unit amounts, and distinct adjustment entries.
- AT-TML-002: staff-level redaction and resource scope are enforced by the API projection before the Dashboard renders data.
- AT-HIS-002: the staff projection remains separate from current-user history APIs and cannot be used to read another user's private history.
- AT-RFP-005: L1/L2 receive no commission facts; L3/L4 timeline payloads contain no beneficiary, referred-user, rate, base, or attribution fields.

## Gates

- Focused M4 regression: 5 files / 27 tests passed.
- M4-US-08 API, Dashboard, and PostgreSQL tests: 3 files / 10 tests passed.
- Full `npm test`: 91 files / 463 tests passed.
- `npm run typecheck` and `npm run build`: passed.
- Dashboard Vite production build: passed.
- Prisma validation and baseline migration verification: passed with 51 tables.
- OpenAPI YAML parsing, OpenAPI mirrors, Prisma schema mirrors, and `git diff --check`: passed.
