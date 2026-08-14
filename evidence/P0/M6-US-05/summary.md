# M6-US-05 Verification Summary

## Story And Acceptance

- Story: M6-US-05 Discord User Profile and Player Reports
- Acceptance: AT-PRF-002, AT-PRF-005, AT-PRF-006

## Delivered

- Added `getCurrentUserProfileSummary` and `listCurrentUserOrders`. Both resolve the current user only from trusted `DISCORD_BOT` Actor Context and filter Profile, orders, consumption history, and reservations by the trusted Guild.
- Current-user Profile follows the reviewed US04 balance module: exact available balance, fresh/stale Provider responses, last successful snapshot fallback, and nullable unavailable fields when no successful snapshot exists. A stale Provider success is never persisted as a successful snapshot.
- Self Profile and order DTOs are explicit whitelists. They omit referral source/beneficiary/rate/commission facts, internal notes, risk, profit, margin, Provider transaction identifiers, player user IDs, staff assignment, and player earnings.
- Extended the Sapphire service center with ephemeral Profile, order, consumption, recharge Link Button, and refresh panels. Extended the player workbench with owned weekly-report list/detail navigation.
- All API calls are thin Actor-context adapters. Order, consumption, and weekly-report APIs issue compact resource-bound HMAC cursors that survive process restarts and multi-instance routing; Discord embeds them directly in custom IDs of at most 100 characters without truncation or local state.
- Reused US03 current-player weekly-report ownership checks and added a dedicated self-service DTO mapper. List/detail responses retain only identity-safe period/status/metrics fields; Cross-player reads retain the same non-enumerating 404 as missing reports.

## Independent Review Closure

- Current-player weekly-report list/detail responses omit `guildId`, `playerUserId`, `scheduleKey`, revisions, staff/reason metadata, detail snapshots, source order IDs, and internal issues.
- Current-user consumptions require the trusted Actor Guild at the Store boundary and apply the same order/gift/refund/reversal source-chain predicate as customer Profile facts. A same-user other-Guild record is excluded by test.
- `reservedMinor`, `availableMinor`, and active reservation count describe the global Provider account and include active reservations from every Guild; Profile statistics, order pages, and consumption pages remain trusted-Guild scoped.
- API cursors use a compact binary payload plus a truncated 128-bit HMAC, bind keyset/offset state to its resource, and reject malformed, cross-resource, or tampered values with 400. Production wiring validates and injects `PAGINATION_CURSOR_SIGNING_SECRET` (minimum 32 characters when explicitly configured, with `BOT_SERVICE_TOKEN` compatibility fallback).

## Acceptance Evidence

| Acceptance | Evidence |
|---|---|
| AT-PRF-002 | `tests/m6-us-05-api.spec.ts`: Actor-only resolution, ignored target-ID attempts, trusted Guild filtering including same-user cross-Guild consumption exclusion, global Provider reservation totals, signed cursor pages, self-order DTO whitelist, and non-enumerating 404. |
| AT-PRF-005 | `tests/m6-us-03-api.spec.ts` and `tests/m6-us-05-bot.spec.ts`: strict current-player report DTO, ownership, ephemeral panels, stateless signed pagination IDs, restart verification, tamper rejection, Link Button rendering, thin API requests, and request-id fallback. |
| AT-PRF-006 | API tests cover fresh, stale Provider failure with last snapshot, stale Provider success without persistence, and unavailable balance without a snapshot. Existing order/gift funding writes continue to require live Provider facts. |

## Verification

```text
npx vitest run tests/m6-us-05-api.spec.ts tests/m6-us-05-bot.spec.ts
Test Files  2 passed (2)
Tests       8 passed (8)

npx vitest run tests/m6-us-00-contract.spec.ts tests/m6-us-03*.spec.ts tests/m6-us-04-*.spec.ts tests/m6-us-05-*.spec.ts tests/m3-us-05-*.spec.ts tests/m0-us-01.spec.ts
Test Files  14 passed (14)
Tests       77 passed (77)

npm run typecheck
exit 0

npm run build
exit 0

npm run pieces -w @blackcat/bot
13 Sapphire pieces discovered, including service-center-buttons

npm run db:validate
The schema at database/prisma/schema.prisma is valid

npm run db:verify:migration
migration-apply-ok
table_count=60
weekly_report_guard_count=5
customer_profile_guard_count=2
```

## Residual Risk

- Recharge navigation opens the configured Provider page; clicking the Link Button is not proof of recharge. Any later order or gift write remains fail-closed on a fresh Provider read.
- Cursor signatures are truncated to 128 bits to fit Discord's custom-ID limit. Rotation of `PAGINATION_CURSOR_SIGNING_SECRET` intentionally invalidates outstanding ephemeral pagination controls, which then fail through the normal API/request-id path.
