# M4-US-03 Verification Evidence

## Delivered

- Shared Bot/Dashboard admin APIs for orders, users and consumption mirrors, players, service and gift catalogs, gift requests, commissions, and player earnings.
- Capability-driven Dashboard pages with search, filters, details, money formatting, empty/error/forbidden states, and consumption pagination.
- L1 order and gift-request access restricted to personally claimed staff tasks; full user/player/catalog directories begin at L2.
- Resource-bound HMAC keyset cursors for admin directory lists, including forged and cross-resource cursor rejection and stable continuation after concurrent inserts.
- Versioned service/gift catalog writes, user risk events, operational status updates, and earning actions through the unified API.
- Logical Dashboard write retries reuse one idempotency key.
- Staged admin mutations: in-memory writes roll back when audit append fails; PostgreSQL writes and success audit records commit in one transaction.
- Persistent PostgreSQL audit sink in production. Invalid client sources are recorded as audit-only `UNKNOWN`, which is never accepted for authentication.
- Admin gift requests expose `rowVersion`, announcement failures are derived from Outbox state, and `ADMIN_CORRECTION` remains a distinct consumption type.

## Verification

- Focused M4 regressions: 6 files, 48 tests passed.
- `pnpm test`: 79 files, 388 tests passed.
- `pnpm typecheck`: passed.
- `npx vite build apps/dashboard --config apps/dashboard/vite.config.ts`: production build passed.
- `pnpm db:validate`: Prisma schema valid.
- `pnpm db:verify:migration`: 47 tables, 3 checked constraints, 7 protection triggers; migration and negative probes passed.
- `git diff --check`: passed.

## Acceptance Mapping

- `AT-RBAC-003`: navigation and API authorization derive from server capabilities; L1 cannot enter L2 directories or read unclaimed order/gift details.
- `AT-CAT-003`: L2 catalog views are read-only; L3 creates and supersedes immutable service/gift versions with optimistic version checks and reasons.
- `AT-EAR-002`: earning confirmation/payment actions require manage permission, expected version, reason, and idempotent unified API writes.

## Residual Scope

- Commission mutation/confidential adjustment workflows, player admission/tag mutations, and gift approval/capture remain in their owning Stories and are not claimed here.
- M4-US-04 owns amount thresholds, MFA, step-up execution policy, and immutable approval evidence beyond the transactional audit boundary established here.

## 2026-08-03 Order Directory Card Layout Regression

- Replaced the intimidating full-width order table with a responsive two-column discussion-card layout and a single-column mobile fallback.
- Each card surfaces the public order number, localized status, game/service display names, region and duration, customer/player business IDs, canonical formatted price, and creation time.
- Full internal UUIDs remain available via title text while the default card footer uses a compact identifier.
- RED/GREEN: the new Dashboard rendering test failed against the table layout, then passed after the card renderer was introduced.
- Verification: `npx vitest run tests/m4-us-03-dashboard.spec.ts` (19/19 passed) and `npm run typecheck` passed.

## 2026-08-04 Detail And Edit Overlay Regression

- Replaced bottom-appended detail and action regions with a shared modal overlay mounted through a `document.body` Portal, keeping the originating list visible without inheriting sidebar/content clipping contexts.
- The overlay has an independently scrollable large panel, sticky heading/close control, body scroll lock, backdrop dismissal, and Escape-key dismissal.
- Existing action forms render inside the same overlay rather than extending the list page; dark and cute themes receive separate backdrop and surface treatment.
- RED/GREEN: detail and action rendering tests initially failed because no modal semantics existed, then passed with `role="dialog"` and `aria-modal="true"`.
- Verification: `npx vitest run tests/m4-us-03-dashboard.spec.ts tests/m4-us-08-dashboard.spec.ts` (2 files / 23 tests passed), `npm run typecheck`, and `npm run build -w @blackcat/dashboard` passed.

## 2026-08-04 Complete Admin Detail Projections

- Added `getAdminServiceCatalogVersion` and `getAdminServicePackageVersion`; all four card workspaces now read a dedicated detail endpoint instead of reusing list snapshots.
- User and player projections now include staff-visible Discord summaries, canonical review/availability/presence state, numeric version, and timestamps. Player tags include both stable codes and server-resolved display names.
- Catalog and package projections now include immutable version status, server-derived prices, creator and lifecycle timestamps, and ordered slot facts. No client-side price or status inference was introduced.
- Removed the player UI fallback that inferred “可参与派单” from a missing `active` field. Discord presence is labeled diagnostic-only and does not alter selection eligibility.
- RED/GREEN evidence: focused tests first failed on absent catalog/package detail routes and list-only Dashboard routing; implementation then made the dedicated endpoints and UI integration pass.
- Acceptance: `AT-DTL-001`, with matching OpenAPI, backlog, interaction-map and acceptance-case mirrors.
- Verification: 8 focused files / 71 tests passed, including PostgreSQL admin-directory and service-package tests; `npm run typecheck --if-present`, `npm run build -w @blackcat/dashboard`, mirror byte comparisons, and `git diff --check` passed.

## 2026-08-04 Gift Catalog And Gift Request Detail Projections

- Extended `AT-DTL-001` from four to six administrative detail workspaces.
- Added `getAdminGiftCatalogItem`. It returns the current immutable gift version ID, status, server price, resolved category label, broadcast template, creator, and activation/retirement/archive timestamps.
- Enriched `getAdminGiftRequest` with source-order context, sender and receiver staff-visible Discord summaries, reservation state and expiry, verification/approval/capture/announcement lifecycle, broadcast references, failure context, and update time.
- Reservation idempotency keys, wallet owner internals, provider references, and ledger internals remain absent from the response.
- Dashboard gift catalog and gift request rows now open dedicated server reads and render semantic pricing, identity, review/funds, delivery, and lifecycle sections instead of raw field dumps or list snapshots.
- RED/GREEN: contract, route, API and Dashboard tests first failed on the absent catalog detail operation and list-level gift DTOs, then passed after the query projections and structured views were implemented.
- Verification: 10 related files / 86 tests passed, including PostgreSQL admin-directory regression; `npm run typecheck --if-present`, `npm run build -w @blackcat/dashboard`, contract mirror comparisons, and `git diff --check` passed.

## 2026-08-05 Capability-Gated Order Cancellation Candidate

- Added an order-card `取消订单` action backed by the existing `resolveOrder` operation. Visibility requires the server-issued `order.resolve` capability and an order in `ACCEPTED`, `IN_SERVICE`, `PENDING_CONFIRMATION`, or `EXCEPTION`; L1 and terminal-state orders receive no action.
- The form posts `targetStatus=CANCELLED` with the optimistic order version, a contract-valid resolution reason, canonical CAT refund/reservation-release amount, retained player earning, evidence note, and `EXECUTE_OR_REQUEST_APPROVAL`. It does not write status locally or introduce a second cancellation rule.
- Existing API enforcement remains authoritative for Guild/object scope, recent L3/L4 step-up, amount escalation, active reservation settlement, append-only resolution/adjustments, idempotency, audit, and order panel synchronization.
- RED: the focused Dashboard suite failed 2 of 22 tests because no `order.resolve` action or request mapping existed. GREEN: focused suite 22/22 passed; related policy and panel-projection regression totaled 3 files / 28 tests. `npm run typecheck -w @blackcat/dashboard`, `npm run build -w @blackcat/dashboard`, and `git diff --check` passed.
- Acceptance mapping: `AT-CAN-007` and existing interaction `INT-A-015`. Real authenticated L4 browser execution remains external UAT and is not claimed here.
- Files changed for this candidate: `apps/dashboard/src/admin-business.ts`, `apps/dashboard/src/AdminBusinessPage.tsx`, `tests/m4-us-03-dashboard.spec.ts`, both TODO mirrors, and this evidence file.

## 2026-08-05 Service Catalog Display-Name Regression

- Root cause: tag-backed catalog creation resolved only `code`; `savePostgresCatalogRecord` then wrote that code into both `game_code/game_name` and `service_code/service_name`. The Dashboard already preferred display-name fields, but the API therefore returned `LOLNA/RANKED` as both code and name.
- Catalog creation now carries the resolved business tag's `code` and `displayName` separately through normalization and persistence. PostgreSQL continues to use stable codes for identity while storing `英雄联盟美服` and `上分陪玩` in the human-readable columns.
- Migration `000030_service_offering_display_names` backfills only legacy rows whose name still equals its code and only when a matching business tag exists. Existing non-code historical names remain unchanged.
- Dashboard cards render display names in the title, keep `RANKED` in the service-code fact, and correctly render numeric version values instead of `—`.
- RED: `tests/m1-us-01-api.spec.ts` failed 2/14, the PostgreSQL migration test failed 1/5, and the Dashboard card test failed 1/23 against the old behavior.
- GREEN: `npx vitest run tests/m1-us-01-api.spec.ts tests/m1-us-01-db.spec.ts tests/m4-us-03-dashboard.spec.ts` — 3 files / 42 tests passed; `npm run typecheck`, `npm run db:validate`, `npm run db:verify:migration`, and `npm run build -w @blackcat/dashboard` passed.
- Acceptance mapping: `AT-CAT-003` and `AT-DTL-001`.
- Local runtime verification: `npm run db:migrate:deploy` applied `000030_service_offering_display_names` to `localhost:5432/blackcat`. The repaired row now stores `LOLNA/英雄联盟美服` and `RANKED/上分陪玩`; the already-running API returned HTTP 200 with the same display names and `version: 1`. The open Dashboard page must refresh to replace its previously loaded list state.

## 2026-08-10 Player-Earning Action Visibility Regression

- Root cause: the earnings table exposed both `CONFIRM` and `MARK_PAID` on every row whenever the actor had `earnings.manage`; it silently removed the entire operation column for read-only L2 actors. The page was not part of the seven-resource CARD/TABLE visibility audit because earnings remains a contract-defined table-only workspace.
- The shared item-action renderer now applies the legal state transition before rendering: `PENDING` exposes only `确认收益`, `CONFIRMED` exposes only `标记已支付`, and `PAID`/`REVERSED` rows are read-only. A terminal-only result set no longer reserves an empty operation column.
- L2 receives an explicit read-only notice explaining that both writes require internal L3+ `earnings.manage`; Discord Role is not presented as an authorization fact. L3/L4 receives concise transition guidance above the table.
- RED: `npx vitest run tests/m4-us-03-player-earnings-actions.spec.ts` — 1 file / 3 tests failed against duplicate state-invalid actions, missing read-only guidance, and an empty terminal operation column.
- GREEN and regression evidence:
  - focused component/API set: 7 files / 69 tests passed;
  - Dashboard regression: 38 files / 201 tests passed;
  - Chromium earnings plus seven-page visibility E2E: 13/13 passed on isolated ports 3100/5273;
  - full repository `npm test`: 251 files / 1262 tests passed;
  - `npm run typecheck`, Dashboard production build, Dashboard ESLint (0 errors, 9 existing warnings), acceptance-matrix reproducibility, E2E coverage 129/129, and `git diff --check` passed.
- Browser evidence: L3 `PENDING` and `CONFIRMED`, L2 read-only, and 375×844 responsive states are saved under `evidence/P0/M4-US-03/screenshots/player-earnings-actions/`; the mobile measurement was `scrollWidth=clientWidth=375` and `标记已支付` remained visible in the responsive row list.
- Files changed: `apps/dashboard/src/AdminBusinessPage.tsx`, `apps/dashboard/src/styles.css`, `tests/m4-us-03-player-earnings-actions.spec.ts`, `tests/e2e/dashboard/dashboard-gifts-earnings.spec.ts`, `evidence/P0/acceptance-matrix.csv`, this evidence file, both TODO mirrors, and four screenshots.
- Acceptance mapping: `AT-EAR-002`. API authorization, expected-version, reason, step-up, Guild isolation, append-only history, and idempotency semantics remain server-authoritative and unchanged.
