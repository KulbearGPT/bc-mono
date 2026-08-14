# M5-US-01 Verification Evidence

Verified on 2026-07-19 EDT.

## Delivered

- A deterministic acceptance matrix generated from the authoritative acceptance and backlog contracts; originally 152 rows and refreshed to 175 rows after M6 on 2026-07-19.
- Requirement/acceptance ID to Story, OpenAPI operation, executable test, and evidence links, with unknown operations and missing automated evidence rejected.
- Honest execution classification: the current matrix contains 128 cases covered by the local automated candidate regression and 47 real Discord/UAT/environment cases retained as `PENDING_EXTERNAL`.
- A schema-versioned external acceptance ledger overlay validates exact fields, external-only IDs, immutable candidate references, UTC timestamps, and non-empty hashed evidence files beneath the acceptance-ID-specific directory. Invalid ledger data, path traversal, example artifacts, symlinks, and mismatched hashes fail matrix generation closed.
- The regenerated 175-row matrix includes `external_candidate_ref`, `external_executed_at`, and `external_evidence_refs`. The initial `{"schemaVersion":1,"results":[]}` ledger leaves all three columns empty: 47 Pending / 0 Passed.
- A dedicated GitHub Actions P0 candidate workflow covering matrix freshness, full tests, TypeScript build, Dashboard Vite build, Prisma, real baseline migration probes, Sapphire Piece discovery, contract mirrors, and patch hygiene.
- Cross-client regression anchors for AT-AUD-004, AT-RBAC-001, and AT-MET-001, proving Bot and Dashboard receive the same API-authorized business projection and audit result.
- The external ledger now requires `evidence[0]` to be a deterministic UTF-8 Markdown attestation whose status and execution metadata match the ledger, whose redaction review is explicitly confirmed, and whose substantive sections meet concrete length, diversity, non-placeholder, non-repetition, outcome, and diagnostics-reference rules. Later evidence entries remain non-empty SHA-256-verified attachments under the same path, example, symlink, regular-file, and realpath controls.

## Gates

- Focused M5-US-01 and cross-client tests: 2 files / 6 tests passed.
- External ledger overlay regression: `npx vitest run tests/m5-us-01-traceability.spec.ts` passed, 1 file / 26 tests; the RED run failed only the two top-level schema-diagnostic cases before the field-specific validation fix.
- `node scripts/build-p0-acceptance-matrix.mjs .` regenerated 175 rows with the empty-ledger baseline.
- Related audit, authorization, and metrics regression: 5 files / 28 tests passed.
- Full `npm test`: 99 files / 500 tests passed.
- Local execution of every non-install P0 CI candidate command: passed; hosted GitHub Actions execution awaits the next push because this delivery is local-commit only.
- Real Discord Guild, Provider sandbox, backup restoration, and signed UAT remain external gates and are not reported as passed here; external UAT is still incomplete.
- Evidence-attestation hardening RED: `npx vitest run tests/m5-us-01-traceability.spec.ts` failed 30/60 tests before the primary/attachment contract, then failed 3/63 adversarial tests before the low-diversity and literal-scaffold checks.
- Evidence-attestation hardening GREEN: `npx vitest run tests/m5-us-01-traceability.spec.ts` passed 1 file / 63 tests; `npx vitest run tests/m5-us-01-traceability.spec.ts tests/m5-us-03-release-gate.spec.ts tests/m5-us-02-recovery.spec.ts` passed 3 files / 75 tests. `npm run typecheck`, 175-row matrix regeneration, OpenAPI/schema/TODO mirror comparisons, and `git diff --check` also passed. The recovery test name now identifies the narrow baseline restore probe and does not claim AT-REC-005 coverage.
