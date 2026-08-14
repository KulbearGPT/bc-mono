# M4-US-09 Verification Evidence

Verified on 2026-07-18 MDT.

## Delivered

- One `getDashboardSummary` projection reused unchanged by the Sapphire Bot and Dashboard.
- Exactly eight startup metrics computed from orders, tasks, immutable consumption entries, reservation events, dispatch attempts, and de-duplicated exception facts.
- A fixed `Asia/Shanghai` half-open business day, `CNY` currency, integer basis-point dispatch rate, and stable zero values for empty scopes.
- L1 claimed-task, L2 same-Guild team, L3 business, and L4 all-system scopes; L1 money metrics are explicitly nullable and never inferred in a client.
- A Dashboard summary with loading, value, money-redaction, and request-ID error states and no BI, trend, drilldown, or export surface.

## Acceptance

- AT-MET-001: the API and Dashboard expose exactly the approved eight metrics; Bot and Dashboard receive the same server-authorized projection.
- AT-MET-002: business-day boundary, debit/credit netting, reservation remainder, dispatch denominator, empty scope, and role-based redaction are covered.
- The OpenAPI contract fixes metric names, nullability, time zone, currency, and basis-point limits in both maintained mirrors.

## Gates

- M4-US-09 API, Dashboard, and PostgreSQL tests: 3 files / 9 tests passed.
- Full `npm test`: 94 files / 472 tests passed.
- `npm run typecheck` and `npm run build`: passed.
- Dashboard Vite production build: passed.
- Prisma validation and baseline migration verification: passed with 51 tables.
- OpenAPI YAML parsing, OpenAPI mirrors, Prisma schema mirrors, and `git diff --check`: passed.

## Dashboard Chart Presentation Refresh (2026-08-03)

- Replaced the low-density overview hero with a charted presentation of the existing, server-authorized eight-metric projection. No API field, aggregation, scope, time window, currency rule, or authorization behavior changed.
- The overview now renders eight KPI cards, a three-series current-window money composition bar chart, the existing basis-point dispatch success rate as a donut chart, and a task/exception/in-progress health panel. It intentionally does not expose trends, yesterday comparisons, drilldown, exports, or invented values.
- The shared loader is reused by the home overview and support workbench. Loading, request-ID error, zero values, and L1 nullable money remain explicit; chart geometry is derived only from returned authorized metrics.
- RED/GREEN: expanded `tests/m4-us-09-dashboard.spec.ts` and the overview visual gate; focused regression passed 4 files / 19 tests. `npm run typecheck`, Dashboard production build, and `git diff --check` passed.
- Documentation synchronized: main specification mirrors, interaction mapping mirrors, Story evidence, and the P0 TODO completion record.
