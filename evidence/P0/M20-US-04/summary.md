# M20-US-04 candidate evidence

## Scope completed

- Removed three production-unreferenced Discord renderers: the first-wins dispatch offer, the obsolete accepted-dispatch card, and the dropdown selection-pool signup card superseded by numeric Reactions.
- Added a release gate proving representative production custom IDs resolve to handlers, legacy component IDs are absent from production renderers, and order/profile pagination preserves the previous cursor.
- Synchronized the acceptance fixture catalog, 307-row candidate matrix, two new external UAT rows, API lifecycle-schema expectation, backlog, interaction mapping, and TODO mirrors.

## Automated evidence

```text
npx vitest run tests/m5-us-01-traceability.spec.ts tests/m5-us-03-release-gate.spec.ts tests/m5-us-06-pilot-features.spec.ts tests/m7-us-01-contract.spec.ts tests/m20-us-04-action-release-gate.spec.ts
Test Files  5 passed (5)
Tests       86 passed (86)

npm test
Test Files  253 passed (253)
Tests       1264 passed (1264)

npm run quality:bot
lint:bot                 exit 0
format:bot:check         exit 0
@blackcat/bot typecheck  exit 0
build                    exit 0
pieces                   24 discovered
Test Files               59 passed (59)
Tests                    343 passed (343)
```

## Runtime and current-Guild evidence

- Stopped the previous Bot/Worker runtime and found two exact orphan listeners: API PID 94806 on port 3000 and Dashboard PID 1542 on port 5173. Both were terminated with SIGTERM after read-only PID/port verification.
- Started API, Worker, Bot, and Dashboard from one `npm run dev` process tree. API logged `api.started` on 3000; Worker logged `worker.started`; Bot discovered 24 Pieces, connected to the Gateway, reloaded one Guild configuration, and completed Role/product-role/Reaction reconciliation. Dashboard started on 5173.
- `/health` returned `OK`; `/ready` returned `READY` with database and config required dependencies ready.
- The first restart queued one idempotent order-panel experience refresh and completed its `PANEL_SYNC` in 848 ms; the final clean restart reported zero remaining normalization jobs.
- Read-only Discord REST checks returned HTTP 200 for active order `P-976789E1` and retained draft `P-1FA1B829`. Both now expose explicit `取消订单`, `联系猫舍前台`, and `刷新最新状态`; the active card also exposes `再发起一轮报名`, while the draft card uses `查看套餐内容`. Neither payload contains expected-player-earning copy or the ambiguous `查看` / `加入单点` labels. Existing message IDs were retained.
- The retained pre-release draft was normalized in place after its API-authoritative DRAFT action view confirmed `CUSTOMER_CANCEL_ORDER`, `CUSTOMER_REFRESH_ORDER`, and `CUSTOMER_CONTACT_SUPPORT`; no business fact, order version, money fact, or channel/message identity changed.

## Open external acceptance

`AT-ACT-002` and `AT-ACT-004` remain `PENDING_EXTERNAL`. A named owner/player/staff walkthrough on desktop and mobile is still required. This candidate does not claim those external sign-offs or the overall release gate are complete.
