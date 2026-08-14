# M4-US-10 Verification Evidence

Verified on 2026-07-18 MDT.

## Delivered

- One Guild-only Sapphire `/bot-config` flow with ephemeral command, Channel Select, Role Select, toggle Select, timeout/template Modal, preview, delivery test, confirm, and cancel handlers.
- One reusable API client for `getBotConfig`, `validateBotConfigChange`, `updateBotConfig`, and `testBotConfigDelivery`; custom IDs contain only an operation and short session ID.
- Server-side cumulative L3/L4 authorization, field-level security Role enforcement, trusted service-only startup reads, and no client Role-derived authorization.
- Discord ownership/type/permission/Role-hierarchy checks at preview and confirmation, plus a five-minute HMAC token bound to actor, Guild, version, normalized changes, and reason.
- Atomic PostgreSQL current-row update, canonical staff Role mapping synchronization, append-only configuration event, and success audit with optimistic concurrency.
- The next dispatch or gift capture resolves its channel from the reusable API-backed configuration store; Bot cache refreshes immediately and reloads from API after restart.
- Network-backed Discord interactions defer before API calls, and ephemeral sessions retain only the selected field state instead of a full configuration snapshot.
- A separate `BOT_CONFIG_VALIDATION_SECRET`; no secret, catalog, pricing, gift, commission, Dashboard configuration page, or workflow-builder scope was added.

## Acceptance

- AT-CFG-001/002/003: L3 operational and cumulative L4 security permissions are enforced by API; lower or field-level unauthorized actors are rejected.
- AT-CFG-004/005: native Discord selectors are used and invalid Guild objects, types, permissions, and Role hierarchy do not persist.
- AT-CFG-006/007: preview token and expected-version controls reject bypass, expiry, payload mismatch, and stale writers.
- AT-CFG-008: current config, immutable event, and audit commit atomically.
- AT-CFG-009/010: process restart reloads from API and every interactive response remains ephemeral and session-bound.

## Gates

- M4-US-10 API, Bot, and PostgreSQL tests: 3 files / 22 tests passed.
- Full `npm test`: 97 files / 494 tests passed.
- `npm run typecheck`, `npm run build`, and Sapphire Piece discovery: passed.
- Dashboard Vite production build: passed.
- Prisma validation and baseline migration verification: passed with 51 tables and all protection probes.
- OpenAPI YAML parsing, OpenAPI mirrors, Prisma schema mirrors, and `git diff --check`: passed.
