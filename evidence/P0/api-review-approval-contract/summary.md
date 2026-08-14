# API review — trusted approval creation contract

## Story and acceptance

- Story: `codex/api-review-approval-contract`
- Acceptance: `AT-GFT-006`, `AT-RBAC-001`, `AT-RBAC-006`
- Scope: approval creation ownership across the main specification, OpenAPI, API guide, data constraints, interaction/copy maps, backlog, prototypes, and generated mirrors. This Story changes contracts only; approval queue runtime remains a separate Story.

## RED

`npx vitest run tests/api-review-approval-contract.spec.ts`

- Result before contract alignment: 1 file / 2 failed / 1 passed.
- OpenAPI exposed `POST /api/v1/admin/approval-requests` and accepted a client-authored action, target, amount, version, and impact snapshot.
- Interaction and backlog contracts instructed clients to call `createApprovalRequest`, allowing Bot or Dashboard input to masquerade as authoritative business facts.

## Contract decision

- Approval requests can only be created by the relevant business write operation from server-trusted target, amount, version, Guild, and reservation facts.
- `approveGiftRequest`, `refundOrder`, and `resolveOrder` create the supported P0 `GIFT_APPROVE`, `REFUND_EXECUTE`, and `ORDER_RESOLVE` requests when escalation is required.
- The generic approval queue is read/decision-only and cannot create, replace, or edit `payload_snapshot`.
- `ACCESS_CHANGE` remains on the specialized role-elevation flow. Other database enum values are forward-compatible reservations and fail closed until their business contracts and executors exist.
- Main specification, OpenAPI, API guide, data constraints, UI maps, copy inventory, backlog, prototypes, and output/docs mirrors now state the same ownership rule.

## GREEN

`npx vitest run tests/api-review-approval-contract.spec.ts tests/m10-us-01-contract.spec.ts tests/m9-us-01-contract.spec.ts tests/m16-us-01-review-remediation-contract.spec.ts`

- Result: 4 files / 11 tests passed.
- The new regression verifies the missing generic POST/schema, domain operation mappings, fail-closed guidance, and all edited canonical mirrors.

`npm run quality:routes`

- Result: passed for all 164 currently registered production operations. This gate is still one-way in this Story; bidirectional contract-to-runtime enforcement is part of the approval runtime remediation.

`git diff --check`

- Result: passed.

## Client compatibility

- No Bot, Dashboard, or API runtime source was modified.
- Existing domain operation IDs and their request/response contracts remain unchanged.
- Prototype buttons now point at the existing gift domain operation instead of a nonexistent and unsafe generic creation operation.

## Remaining scope

Implement generic approval list/detail/approve/reject execution, make the route contract gate bidirectional, then continue reservation aggregation, receipt orphan cleanup, API quality/module debt, and readiness legacy cleanup as independent Stories.
