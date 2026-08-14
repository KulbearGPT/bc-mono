# M20-US-02 evidence

## Scope

- Added the server-owned structured `OrderAvailableAction` model.
- Projected role-scoped actions for customer orders, player workbench/lifecycle, and staff order detail.
- Detected existing active cancellation assistance for the customer action view.
- Extended cancellation preview for `EXCEPTION` to create or reuse staff review without changing order or fund state.
- Updated OpenAPI mirrors and Bot transport DTOs.

## RED

```text
pnpm exec vitest run tests/m20-us-02-order-available-actions.spec.ts
Test Files  1 failed (1)
Tests       no tests
Cannot find package '@blackcat/api/order-actions'
```

## GREEN

```text
pnpm exec vitest run tests/m20-us-02-order-available-actions.spec.ts
Test Files  1 passed (1)
Tests       5 passed (5)

pnpm exec vitest run tests/m2-us-10-api.spec.ts tests/m2-us-08-api.spec.ts tests/m10-us-04-lifecycle.spec.ts tests/m19-us-03-service-state-sync.spec.ts tests/m14-us-01-support-workbench-ux-contract.spec.ts tests/m2-us-07-api.spec.ts
Test Files  6 passed (6)
Tests       21 passed (21)

pnpm exec tsc -p apps/api/tsconfig.json --noEmit
pnpm exec tsc -p apps/bot/tsconfig.json --noEmit
exit 0
```

## Safety boundary

The API continues to authorize every write from trusted Actor Context. `availableActions` is a view model, not a capability token, and stale/forbidden writes remain rejected by the write endpoints.
