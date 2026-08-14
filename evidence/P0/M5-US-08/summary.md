# M5-US-08 Verification Evidence

Verified on 2026-07-20 EDT.

## Delivered

- Added one multi-stage Node 22 Docker image shared by Web, Bot and Worker, with compiled TypeScript/Vite artifacts and Prisma CLI/migrations available for Web pre-deploy.
- Added Railway Config-as-Code for Web, Bot and Worker. Only Web runs migrations and exposes `/ready`; Bot and Worker expose readiness-aware `/health` and use `ON_FAILURE` restart policy.
- Web serves the compiled Dashboard at the same origin with browser-only SPA fallback. API, health, readiness and asset misses are never captured by that fallback.
- Railway `PORT` takes precedence for Web while `API_PORT` remains a local compatibility input. The runbook fixes `web.PORT=3000` so Railway reference variables can construct the private URL; Bot/Worker bind their own injected `PORT` and fail closed before startup when required production inputs are absent.
- Production environment verification requires an explicit business environment, funding adapter and pilot phase, keeps public OAuth/Provider URLs on HTTPS, allows Railway private HTTP only for `API_BASE_URL`, and forbids Sandbox funding in production business mode.
- Added the four-service Railway Sandbox runbook covering public/private topology, per-service variables, startup order, smoke checks, stop switches, log redaction, daily platform backups, weekly encrypted `pg_dump`, application rollback and restore into a new PostgreSQL service.

## TDD and Review Evidence

- RED: the focused runtime suite initially failed because `@blackcat/platform/process-health` did not exist.
- Railway `PORT` regression failed with Web selecting `API_PORT=3000` instead of injected `PORT=4321`, then passed after precedence was corrected.
- The first clean Docker build failed because copied incremental `.tsbuildinfo` files referred to excluded outputs. `.dockerignore` now excludes build metadata, and package exports separate TypeScript types from compiled runtime imports.
- The planned `@fastify/static` 8.3.0 introduced two known moderate advisories. It was upgraded to fixed 10.1.0; `npm audit --omit=dev` reports zero vulnerabilities.
- Independent code review found two important issues: Bot/Worker Railway health and production fail-closed checks were affecting local dev entrypoints, and the runtime image still copied dev dependencies while auditing only production dependencies. Follow-up RED tests reproduced both issues plus the exact `/api` SPA fallback boundary.
- Follow-up fixes gate Bot/Worker process health to `NODE_ENV=production`, keep the local Bot missing-token path usable, exclude exact `/api` from Dashboard fallback, move Prisma CLI into production dependencies and prune dev dependencies in the runtime image.
- Regression RED: after switching `sandbox:provision:prod` to the compiled runtime script, the built container command exited `0` without output because the entrypoint check only matched `sandbox-funding-provision.ts`.
- Added `isSandboxProvisionEntrypoint()` and a focused regression test proving the compiled `/app/apps/api/dist/sandbox-funding-provision.js` path executes while unrelated compiled entrypoints do not.
- Focused `tests/m5-us-08-railway-runtime.spec.ts`: 11 tests passed, including config ownership, SPA isolation, exact API prefix isolation, health transitions, local Bot dev compatibility, source entrypoint fail-closed behavior, URL/environment policy, Railway port selection, compiled Sandbox provisioning entrypoint behavior and pruned compiled-runtime constraints.

## Container and Migration Evidence

- `docker build -t blackcat-m5-us-08:local .` completed on Docker 29.2.1 using `node:22-alpine`; the final manifest list was `sha256:2d7739c5da4fc991563ca714472e4639b1b956f9e103ddceab14172388174199`, and the runtime reports Node v22.23.1.
- Runtime image dependency probe confirmed `node_modules/.bin/tsx` and `node_modules/.bin/vitest` are absent while `node_modules/.bin/prisma` remains executable for Railway pre-deploy migrations.
- An explicitly named disposable PostgreSQL 16 container received migrations `000001` through `000009` through the built image's `db:migrate:deploy` command.
- The built Web container returned `READY` with database/config required dependencies ready, served the Dashboard root for `Accept: text/html`, and preserved machine-request content negotiation.
- The built Worker container completed recovery initialization and returned `{"status":"ok"}` from `/health`.
- Bot/Worker source and compiled entrypoints exited non-zero with sanitized incomplete production environments. The compiled Sandbox provisioning script also exited non-zero with `DATABASE_URL is required.` when run in the built image without required Railway variables, proving it no longer silently no-ops. A real Bot-ready transition requires valid Discord login and is intentionally retained for M5-US-09.
- All temporary containers and the dedicated smoke network were removed by explicit names after verification.
- `npm run db:verify:migration` passed with 63 tables, the full invariant/append-only probes, 3 Sandbox funding tables and 2 Sandbox funding guards.

## Final Verification

- Full regression: `npm test` passed 132 files / 775 tests.
- `npm run typecheck`, `npm run build:railway`, `npm run db:validate`, `npm run db:verify:migration`, `npm audit --omit=dev`, Docker build/smoke, acceptance-matrix generation, both TODO/backlog mirror comparisons, and `git diff --check` passed.
- The regenerated acceptance matrix contains 184 authoritative rows. Real Railway deployment, backups/restoration, Discord/OAuth interaction, ten core orders and two-person signoff remain external M5-US-09 scope.

## Modified Files

- Runtime: `Dockerfile`, `.dockerignore`, `railway/*.json`, root/workspace package manifests, lockfile and `.env.example`.
- Web/Bot/Worker: API static registration and startup, Bot/Worker health lifecycle, platform environment and process-health modules.
- Operations: production environment verifier and both Railway/P0 deployment runbooks.
- Contracts/evidence: M5-US-08 runtime tests, both backlog/TODO mirrors, this evidence file and regenerated acceptance matrix.

## Remaining Scope

The Railway CLI is installed but unauthenticated (`railway whoami` returned `Unauthorized`). M5-US-09 must not start until an authenticated Railway project plus real Discord/OAuth credentials and OWNER/STAFF participants are available. No external acceptance or pilot signoff is claimed here.

## Security Dependency Remediation (2026-07-24 EDT)

- RED: `npm audit --omit=dev --audit-level=high` exited 1 and reported two high-severity findings: `fast-uri` 3.1.3 and 4.1.0 (GHSA-v2hh-gcrm-f6hx), plus `find-my-way` 9.6.0 (GHSA-c96f-x56v-gq3h).
- Root cause: the M5-US-08 lockfile retained vulnerable transitive resolutions even though the installed Fastify dependency ranges allowed the patched releases.
- Remediation: only `package-lock.json` changed, resolving `fast-uri` 3.1.3 → 3.1.4, nested `fast-uri` 4.1.0 → 4.1.1, and `find-my-way` 9.6.0 → 9.7.0. No direct dependency range or Fastify major version changed.
- GREEN: `npm ci` exited 0; `npm ls fast-uri find-my-way --omit=dev` confirmed the installed patched graph; `npm audit --omit=dev --audit-level=high` exited 0 with `found 0 vulnerabilities`; `npm test` exited 0 with 133 files / 778 tests passed; `npm run typecheck`, `npm run build:railway`, and `git diff --check` each exited 0.
- Scope: M5-US-08 remains completed. This record neither starts M5-US-09 nor changes external acceptance evidence.

## Final Review Remediation (2026-07-26 MDT)

- Finding: the Web production entrypoint only consumed the narrower generic runtime validator, and `/ready` could report `config=READY` while Pilot Discord OAuth, Guild, Dashboard URL, CSRF, or MFA configuration was unusable.
- RED: after adding the Web startup/readiness contract, `npx vitest run tests/m5-us-08-railway-runtime.spec.ts` exited 1 because `@blackcat/platform/production-env` did not exist. The suite then reproduced the actual source Web entrypoint failing for a module-resolution error instead of the missing production key.
- Fix: extracted the existing production validation rules into the shared platform production-environment module. The CLI verifier re-exports the same function, the Web production entrypoint validates it before constructing stores or listening, and production readiness requires both generic runtime and shared production validation to pass. Error output contains rule/key names only, not secret values; non-production readiness retains the existing contract.
- GREEN: after building the new platform export, `npx vitest run tests/m5-us-08-railway-runtime.spec.ts tests/m5-us-02-recovery.spec.ts` passed 2 files / 18 tests; `npm run typecheck` and `npm run build:railway` exited 0. The broader focused Story regression `npx vitest run tests/m5-us-08-railway-runtime.spec.ts tests/m5-us-02-recovery.spec.ts tests/m0-us-01.spec.ts` passed 3 files / 28 tests.
- Runbook RED: `npx vitest run tests/m5-us-08-railway-runtime.spec.ts -t "documents only STAFF to L2"` exited 1 because the guide still created and assigned L1/L3 acceptance roles.
- Runbook GREEN: the same command passed after limiting Pilot acceptance to STAFF → L2 and OWNER → L4, explicitly leaving L1/L3 mappings empty, and removing L1/L3 creation/assignment instructions. The guide also now matches fail-closed Sandbox provisioning instead of claiming that a rerun rotates codes or resets balances.
- Independent review found two Important reproducibility/operations gaps. First, source-entrypoint tests depended on ignored prebuilt platform output. The production validator runtime export now points to its checked JavaScript source, the Docker runtime copies that exact source, and `npm test` builds all existing workspace exports before Vitest. A clean isolated copy with all `dist` and `tsbuildinfo` excluded passed `npm ci`, `npm run build`, and the 3-file / 28-test Story regression. Second, the guide still told the player fixture to rerun provisioning; a new RED assertion reproduced it, and the guide now correctly treats player earnings as local trusted order facts without requiring a customer payment fixture.
- Scoped re-review approved both specification compliance and code quality with no remaining Critical or Important findings. Its Docker build completed, the runtime contained the shared validator source, and the pruned production dependency audit reported zero vulnerabilities.
- Acceptance scope: this remediation supports `AT-RWY-001` and `AT-RWY-002` locally. It does not start or complete M5-US-09/M5-US-10 and does not claim a real Railway deployment, Discord/OAuth interaction, backup/restore exercise, UAT, or external signoff.

## Final Gate Dependency Refresh (2026-07-26 MDT)

- RED: the required final `npm audit --omit=dev --audit-level=high` gate exited 1 after new advisories reported two high-severity path authorization bypasses in `@fastify/static <=10.1.1` and a high-severity unbounded expansion/OOM issue in `brace-expansion <=5.0.7`.
- Remediation: updated the existing pinned `@fastify/static` dependency within major 10 from 10.1.0 to 10.1.2 and refreshed the compatible transitive lock resolution from `brace-expansion` 5.0.7 to 5.0.8. No dependency major changed and no forced audit fix was used.
- GREEN: `npm ls @fastify/static brace-expansion --omit=dev` resolved 10.1.2 and 5.0.8; `npm audit --omit=dev --audit-level=high` exited 0 with `found 0 vulnerabilities`; the M5-US-08/M5-US-02 focused regression passed 2 files / 19 tests; `npm run typecheck`, `npm run build:railway`, and `git diff --check` exited 0.
- Scope remains local M5-US-08 runtime hardening only; no external Railway/Discord/UAT evidence was created.
