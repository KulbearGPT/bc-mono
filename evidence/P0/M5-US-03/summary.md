# M5-US-03 Release Gate Baseline

Verified on 2026-07-19 EDT.

## Scope Correction

On 2026-07-20, the current release gate was re-scoped to Railway/Sandbox. The gate now requires OWNER+STAFF signoff, Railway/Sandbox configuration evidence, restore/rollback evidence, core order and order-bound gift UAT, permissions/privacy review and an explicit real-money non-goal statement.

Sandbox test balances must not be described as real money, and a current-stage pass must not be interpreted as third-party payment Provider readiness.

## Delivered

- A fail-closed `scripts/p0-release-gate.mjs` evaluator for the complete authoritative acceptance matrix, exact P0 scope, zero blockers, immutable candidate/rollback references, Provider/Discord/backup/Worker evidence, and four explicit approvals.
- Candidate-bound external acceptance: every `EXTERNAL_E2E` row marked `PASSED` must have an `external_candidate_ref` exactly equal to `config.releaseCandidate`; stale passed evidence produces a blocker. The summary exposes the number of passed external cases as `passedExternal`.
- The production CLI requires explicit `P0_SIGNOFF_FILE` and `P0_CONFIG_SNAPSHOT_FILE` paths. It rejects requested or resolved paths containing case-insensitive `example` before examples can participate in a release decision; the pure evaluator remains independently testable.
- An ID-complete Chinese UAT execution pack: five executable sessions map all 47 authoritative `EXTERNAL_E2E` Acceptance IDs exactly once, with contract-derived preconditions, steps, exact expected results, evidence fields, blank result/sign-off cells, candidate binding, safe redaction, failure handling and external-ledger instructions.

## Verification

- RED: `npx vitest run tests/m5-us-03-release-gate.spec.ts` failed as expected because passed external evidence for a different candidate did not yet produce a blocker.
- GREEN: `npx vitest run tests/m5-us-03-release-gate.spec.ts`: 1 file / 5 tests passed.
- RED: after adding the UAT completeness assertion, `npx vitest run tests/m5-us-03-release-gate.spec.ts` failed because the generic checklist contained no external Acceptance ID.
- GREEN: after mapping the five sessions, `npx vitest run tests/m5-us-03-release-gate.spec.ts`: 1 file / 6 tests passed, including 47/47 exact-once external ID coverage.
- Index parity: `cmp docs/index.html outputs/index.html` returned exit code 0 after both indexes linked the canonical UAT and deployment/recovery runbooks.
- Required linked regression: `npx vitest run tests/m5-us-03-release-gate.spec.ts tests/m5-us-01-traceability.spec.ts`: 2 files / 32 tests passed.
- The production CLI refuses fully populated mixed-case `example` sign-off/config fixtures, while explicit non-example fixture paths proceed to the normal acceptance and sign-off evaluation.
- Current linked regression: `npx vitest run tests/m5-us-03-release-gate.spec.ts tests/m5-us-01-traceability.spec.ts`: 2 files / 53 tests passed. `env -u P0_SIGNOFF_FILE -u P0_CONFIG_SNAPSHOT_FILE node scripts/p0-release-gate.mjs` returned `ready: false` with both explicit-input blockers and exited 1 as required.
- Complete synthetic candidate matrix: 175 rows, comprising 47 candidate-bound `EXTERNAL_E2E` `PASSED` rows and 128 `AUTOMATED` `COVERED_BY_REGRESSION` rows, produced `ready: true`, `pendingExternal: 0`, `passedExternal: 47`, and `signedRoles: 4`.
- Current repository evidence after regeneration: `ready: false`, 47 of 175 cases are `PENDING_EXTERNAL`, 0 external cases are `PASSED`, 0/4 roles are signed, and release/config/recovery evidence is incomplete. The other 128 cases remain subject to the full candidate regression, most recently recorded as 125 files / 698 tests passed.
- Scope gate update on 2026-07-20 requires OWNER/STAFF current-stage signoff, Railway/Sandbox/funding-mode evidence, and explicit `realMoneyFundingExcluded` plus `providerIntegrationDeferred` flags. `providerSandboxEvidence` is no longer a current-stage required config field.

## Gate Decision

- M5-US-03: not approved.
- P0 release: blocked.
- No product, operations, support, or engineering approval has been synthesized or inferred.
