# M4-US-07 Verification Evidence

Verified on 2026-07-18 MDT.

## Delivered

- One cumulative server-side resolver for L1 < L2 < L3 < L4 permissions and SELF/TEAM/BUSINESS/ALL scopes.
- Secure API middleware and `getCurrentStaffCapabilities` use the same policy output; Bot and Dashboard do not authorize locally.
- One amount-level resolver drives gift and refund boundaries, including the inclusive 500000 minor-unit L4 threshold.
- The policy explicitly models redacted versus confidential referral visibility, an empty hard-delete action set, and the L4 Role-grant ceiling.
- Existing Role synchronization remains capped by authoritative internal staff approval and immediate permissions-version/session revocation.

## Acceptance

- AT-RBAC-001: untrusted client level/Role input remains ignored; API resolves the bound staff actor.
- AT-RBAC-009: L4 receives no financial/audit hard-delete capability and the OpenAPI contract exposes no such operation.
- AT-RBAC-010: L2 inherits L1, L3 inherits L1/L2, and L4 inherits all lower capabilities; representative Bot/Dashboard API calls have equal results and real-actor audits.
- AT-RBAC-011: 500000 minor units resolves to L4, same-actor stepped-up execution remains allowed, and no separation-of-duties rule is introduced.

## Gates

- Focused M4 authorization regression: 5 files / 40 tests passed.
- Full `npm test`: 88 files / 452 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Prisma validation/migration and mirror checks inherited unchanged and are rerun before commit.
