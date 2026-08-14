# Batch D — routes, action visibility, and current business semantics

## Scope

- Direct Dashboard URLs now resolve to an explicit allowed, forbidden, feature-unavailable, or not-found state; an unknown route no longer renders the overview.
- Read-authorized staff can see unavailable operational actions as disabled controls with the exact missing permission and the existing StaffTask escalation guidance. The client still cannot execute those actions.
- Service and gift removal language now says “archive”, matching append-only/versioned records.
- `ACCEPTED` order guidance now waits for every active player; it no longer asks for customer readiness.
- Legacy player `availability` is removed from the primary collection columns and remains diagnostic-only in detail.
- Retired `dispatch_timeout_minutes` and `dispatch_max_rounds` fields are filtered even when an older API snapshot returns them.
- The top bar uses only contract-backed order/user search scopes, reports “权限已载入” rather than claiming API health, exposes a real logout action, and explicitly marks the approval API as unavailable.
- The customer Profile navigation entry is only shown when both profile and user-list reads are usable.

## RED baseline

`npx vitest run tests/m4-us-03-dashboard.spec.ts tests/dashboard-collection-action-visibility.spec.ts tests/m15-us-04-bot-config-dashboard.spec.ts tests/dashboard-route-semantics.spec.ts`

- 8 failures: missing disabled-action metadata/UI, archive/readiness wording drift, retired field filter, explicit route resolution, and truthful capability status.

## GREEN evidence

`npx vitest run tests/m4-us-03-dashboard.spec.ts tests/dashboard-collection-action-visibility.spec.ts tests/m15-us-04-bot-config-dashboard.spec.ts tests/dashboard-route-semantics.spec.ts tests/m9-us-15-manual-dispatch.spec.ts tests/m9-us-16-staff-dispatch.spec.ts`

- 6 files passed, 48 tests passed.

`npx vitest run tests/dashboard-route-semantics.spec.ts tests/m6-us-04-dashboard.spec.ts`

- 2 files passed, 17 tests passed.

`npm run typecheck -w @blackcat/dashboard`

- Passed.

`npx eslint apps/dashboard/src --max-warnings 0`

- Passed with zero warnings.

`npx playwright test --project=chromium --reporter=line tests/e2e/dashboard/dashboard-auth-support.spec.ts tests/e2e/dashboard/dashboard-bot-config.spec.ts tests/e2e/dashboard/dashboard-business-tags.spec.ts tests/e2e/dashboard/dashboard-mfa.spec.ts`

- 16 browser tests passed, including forbidden/404 direct URLs and retired Bot configuration fields.

## Contract blocker retained honestly

The OpenAPI document declares `/api/v1/admin/approval-requests`, but the API runtime source contains no corresponding route registration. This Dashboard-only remediation therefore does not invent a pending count or a non-functional approval screen. The top bar identifies the missing integration and lower-level staff continue to use the implemented StaffTask escalation path.
