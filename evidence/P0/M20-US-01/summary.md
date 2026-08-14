# M20-US-01 evidence

## Scope

- Froze the authoritative Discord status × role action matrix.
- Defined customer cancellation coverage for every actionable non-terminal order state.
- Defined role-separated customer, player, and staff surfaces.
- Replaced ambiguous first-use labels and froze component layout constraints.
- Added M20 backlog, interaction, acceptance, TODO, and master-spec traceability with mirrored delivery contracts.

## RED

```text
pnpm exec vitest run tests/m20-us-01-discord-action-contract.spec.ts
Test Files  1 failed (1)
Tests       4 failed (4)
```

The baseline failed because the M20 matrix, stories, mappings, acceptance gates, and mirrors did not exist.

## GREEN

```text
pnpm exec vitest run tests/m20-us-01-discord-action-contract.spec.ts tests/m18-us-01-discord-experience-contract.spec.ts tests/m19-us-01-cross-role-state-contract.spec.ts
Test Files  3 passed (3)
Tests       12 passed (12)

pnpm build
tsc -b tsconfig.build.json
exit 0
```

## Runtime claim

This contract Story does not claim that API or Discord runtime remediation is complete. Runtime work is isolated to M20-US-02 through M20-US-04.
