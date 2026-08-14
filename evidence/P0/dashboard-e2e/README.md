# Dashboard browser E2E evidence

This directory is the reproducible evidence index for the Playwright Dashboard suite.

## Scope and traceability

- The authoritative plan is `outputs/P0开发交付包/07-验收测试/Dashboard-E2E自动化测试开发计划.md`.
- `npm run e2e:coverage:verify` fails unless the plan and executable specs contain exactly the same 118 unique `DE2E-*` IDs, with no missing, extra, or duplicate test IDs.
- Browser specs live in `tests/e2e/dashboard/`; every test title includes its acceptance ID.
- `html/`, `junit.xml`, `test-results/` traces, screenshots, and videos are generated artifacts and are intentionally not committed.

## Reproduction commands

```bash
npm run e2e:coverage:verify
npm run test:e2e:dashboard
npm run test:e2e:dashboard:headed
npm run test:e2e:dashboard:debug
npm run test:e2e:dashboard:compat
npm run test:e2e:dashboard:isolated
npm run test:e2e:dashboard:stability
```

`test:e2e:dashboard:isolated` creates a process-unique PostgreSQL database, applies all migrations from empty, runs the requested Chromium suite, and drops the database from an EXIT trap. Both database scripts reject unsafe names and non-test preparation.

`test:e2e:dashboard:stability` performs 10 consecutive current Chromium full suites by default with Playwright retry disabled. It stops at the first failure and prints the complete failing run.

## Runtime boundary

The suite runs the real Vite Dashboard against a Fastify fixture built with production security middleware and Dashboard route contracts. OAuth/session identity, Discord downstream behavior, domain state, worker transitions, and restart controls are deterministic test adapters. The empty PostgreSQL migration lifecycle is real, but the current browser fixture does not execute all domain mutations through the production PostgreSQL repositories or launch the production API/Worker processes. Those deeper persistence/process guarantees remain covered by existing API/database tests and are an explicit residual risk for this browser suite.

## CI evidence

`.github/workflows/dashboard-e2e.yml` runs plan coverage verification, an isolated PR quick suite, an isolated Chromium full suite on main/manual runs, and a scheduled Chromium/Firefox/WebKit compatibility suite. Playwright retry is disabled. Failures retain trace, screenshot, video, JUnit, HTML, and `test-results` artifacts, all keyed by acceptance IDs in test titles.
