# M6-US-04 Dashboard Settlement and Customer Profile Evidence

- Date: 2026-07-19
- Acceptance: AT-PRF-001, AT-PRF-004, AT-PRF-008, AT-PRF-009
- Status: completed

## Delivered

- Added work-focused Dashboard routes for settlement batches, weekly reports, and direct customer Profile URLs, with permission-derived navigation and Lucide controls.
- Added shared API/PostgreSQL customer Profile reads for 30-day, 90-day, and all-time statistics, cursor-paginated orders, and the existing consumption ledger entry point.
- Uses one server-side customer predicate for Profile summary, orders, and consumptions. L1 can read only customers attached to its assigned order or claimed support task; L2-L4 remain inside the trusted Dashboard Guild scope.
- Profile responses are explicit whitelists. They omit referral/beneficiary/rate/commission facts, margin, profit, and player earnings; external account identifiers are masked and L2-visible notes omit author identity.
- Balance availability is exact subtraction and may be negative. Provider failures use the last persisted successful snapshot with stale/error/request-id metadata while statistics, orders, and consumption modules remain usable; when no snapshot exists, only the nullable balance module is unavailable.
- Added migration `000006_m6_customer_profiles` for successful Provider snapshots and append-only internal notes, without creating a second `000005` migration.

## Acceptance Mapping

| Acceptance | Evidence |
|---|---|
| AT-PRF-001 | `tests/m6-us-04-api.spec.ts`, `tests/m6-us-04-db.spec.ts`: 30/90/all windows, `refundCount`, completed-order average, exact minor-unit totals, cursor pages, snapshot timestamps, and same-user cross-Guild exclusion. |
| AT-PRF-004 | API and Dashboard tests scan the Profile whitelist and rendered output for referral, beneficiary, commission, profit, and player-earning leakage; internal note author identity is omitted. |
| AT-PRF-008 | API and Dashboard tests plus Chromium Profile screenshots show Provider timeout isolated to the balance module with `req_provider_timeout`; stale-success remains stale, and a missing snapshot returns nullable unavailable balance fields while identity/statistics/orders remain rendered. |
| AT-PRF-009 | API and real PostgreSQL tests cover L1 assigned-order/task access, unassigned direct URL denial, L2 trusted-Guild scope, and the shared summary/order/consumption predicate. |

## Verification

- Security review regression: customer internal notes now carry trusted Guild provenance and are filtered by `guild_id` in both in-memory and PostgreSQL profile projections. Incremental migration `000008_m6_profile_note_guild` leaves legacy unattributed notes NULL and therefore hidden instead of guessing a Guild during upgrade.

### 2026-08-05 settlement currency regression

- Root cause: the controlled settlement currency state remained `CAT`, while the only rendered option had been changed to `USD`. The browser therefore showed a value that did not match the current canonical CAT contract and API validation.
- Fix: the single settlement currency option now explicitly uses and displays `CAT`; no ledger, settlement, or payment semantics changed.
- RED evidence: `npx vitest run tests/m6-us-04-dashboard.spec.ts` failed 1 of 10 tests because the rendered builder contained `<option>USD</option>`.
- GREEN evidence:

```text
npx vitest run tests/m6-us-04-dashboard.spec.ts
Test Files  1 passed (1)
Tests       10 passed (10)

npx vitest run tests/m6-us-01.spec.ts tests/m6-us-02-api.spec.ts tests/m6-us-03-api.spec.ts tests/m6-us-04-api.spec.ts tests/m6-us-04-dashboard.spec.ts tests/dashboard-release-ui.spec.ts
Test Files  6 passed (6)
Tests       48 passed (48)

npm run typecheck
exit 0

npm run build -w @blackcat/dashboard
vite production build passed (1593 modules)
```

### 2026-08-05 empty settlement preview regression

- Request `req_3c40cadf-267a-4850-9935-fd6e130ac721` reached `PREVIEW_SETTLEMENT_BATCH` and failed inside the handler. Database inspection at the failure time showed two `PENDING` CAT earnings, no `CONFIRMED` earnings, and no existing settlement batch, so the expected result was a normal empty preview.
- Root cause: Dashboard intentionally sends `playerUserIds: null` to mean all players, but the API parser rejected every non-`undefined` non-array value, including the canonical null representation, before querying settlement candidates.
- API fix: accept `null` as all players; an empty preview returns HTTP 200 with zero totals and `items: []`. Creating an empty batch remains HTTP 409 `NO_ELIGIBLE_SOURCES`, so no empty settlement fact is persisted. Invalid date-time input is now mapped to HTTP 400 `VALIDATION_ERROR` instead of escaping as a 500 `RangeError`.
- Dashboard fix: successful empty preview data, plus `NO_ELIGIBLE_SOURCES` from an older API during rolling deployment, is normalized to the explicit state “当前周期没有可结算的已确认收益。” without rendering a request ID. Other errors remain failures and keep their request IDs.
- RED: Dashboard regression failed 1/11 because the empty-preview result/state builder did not exist; the API contract regression then reproduced HTTP 400 `playerUserIds must be an array of user IDs` instead of the expected 200 empty preview.
- GREEN: settlement API/database/security/Dashboard regression passed 7 files / 63 tests; `npm run typecheck` passed; Dashboard production build passed with 1593 modules.

### 2026-08-05 settlement payment editor theme regression

- Root cause: `.payment-editor` and `.payment-editor__item` retained five light-theme literals after the Dashboard moved to the Tactical Ops palette, producing a white payment-result card inside the dark settlement table.
- Fix: the editor now uses `--surface-raised`, `--surface-panel`, `--border-soft`, and `--text-secondary`, plus a restrained dark elevation shadow. No payment-result fields, permissions, or submission behavior changed.
- RED: the new visual contract failed because the editor still contained `#f8fafc`, `#fff`, `#dce3eb`, `#d8e1e9`, and `#4a5870`.
- GREEN: Dashboard release, shell, and settlement tests passed 3 files / 25 tests; `npm run typecheck`, Dashboard production build (1593 modules), and `git diff --check` passed.

```text
npx vitest run tests/m6-us-04-api.spec.ts tests/m6-us-04-db.spec.ts tests/m6-us-04-dashboard.spec.ts
Test Files  3 passed (3)
Tests       22 passed (22)

npx vitest run tests/m6-us-02-*.spec.ts tests/m6-us-03*.spec.ts
Test Files  7 passed (7)
Tests       42 passed (42)

npm run typecheck
exit 0

npm run build -w @blackcat/dashboard
vite production build passed (1583 modules)

npm run db:validate
Prisma schema valid

npm run db:verify:migration
migration-apply-ok; 000001 through 000006 applied; customer_profile_guard_count=2
```

## Independent Review Fixes

- Every Profile ledger query now resolves order, gift, refund, and reversal/adjustment ancestry to an order in the trusted Dashboard Guild. Summary statistics, order pagination, and admin consumption pagination share the same customer scope and Guild boundary; same-user facts from another Guild are excluded in both memory and PostgreSQL tests.
- A successful Provider response with `stale=true` is returned with its original `fetchedAt` and remains stale. It is not appended to `provider_balance_snapshots` and is never relabeled fresh.
- Provider failure without a successful historical snapshot returns HTTP 200 with nullable balance amounts/currency/timestamp and populated stale/error metadata. Identity, statistics, preferences, internal information, orders, and consumptions remain independently usable.

## Browser Layout Evidence

Playwright CLI drove Chromium against the Vite production UI routes with API responses intercepted at the network boundary.

- 1440x900 settlement: document width 1440, no horizontal overflow.
- 390x844 settlement: document width 390, no horizontal overflow; the 820px table is contained by a 342px `overflow-x:auto` region.
- 1440x900 Profile: document width 1440, no horizontal overflow; stale balance request ID and both data tables visible.
- 390x844 Profile: document width 390, no horizontal overflow; both 720px tables are contained by 340px `overflow-x:auto` regions.

Screenshots:

- `evidence/P0/M6-US-04/screenshots/settlements-desktop.png`
- `evidence/P0/M6-US-04/screenshots/settlements-mobile.png`
- `evidence/P0/M6-US-04/screenshots/profile-desktop.png`
- `evidence/P0/M6-US-04/screenshots/profile-mobile.png`

## Remaining Risk

- This Story verifies Dashboard browser layout with deterministic API interception. External Discord Guild and live Provider sandbox UAT remain release-gate activities and are not claimed here.
