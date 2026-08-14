# M20-US-03 evidence

## Scope

- Rendered cancellation or cancellation-review access from every customer-operable non-terminal order view, including all four draft steps, recruitment, selection, lifecycle, paused automation, and the persistent Worker panel.
- Removed player write actions from the persistent customer panel; player lifecycle and workbench views consume only `PLAYER` actions returned by the API.
- Replaced ambiguous first-use labels with verb + object/result copy, separated destructive rows, omitted unavailable disabled navigation, and limited ordinary button rows to three actions.
- Added stateful previous/next navigation for customer orders, consumptions, and player weekly reports.
- Updated the selection Worker and persisted order projection to retain cancellation/support/recovery actions after original-message refreshes.

## RED

```text
npx vitest run tests/m20-us-03-discord-action-renderers.spec.ts
Test Files  1 failed (1)
Tests       6 failed (6)
```

## GREEN

```text
npx vitest run tests/m20-us-03-discord-action-renderers.spec.ts
Test Files  1 passed (1)
Tests       9 passed (9)

npm run quality:bot
lint:bot                 exit 0
format:bot:check         exit 0
@blackcat/bot typecheck  exit 0
build                    exit 0
pieces                   24 discovered
Test Files               58 passed (58)
Tests                    342 passed (342)

npm run typecheck -w @blackcat/api
exit 0
```

## Safety boundary

Discord renderers consume server-owned `availableActions`; they do not infer authorization or business transitions. Every write still passes Actor Context, ownership, version, and API state checks. The persistent Worker projection resolves cancellation-review state from the same append-only staff-task facts before rendering.
