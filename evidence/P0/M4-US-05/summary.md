# M4-US-05 Verification Evidence

Verified on 2026-07-18 MDT.

## Delivered

- Six shared access APIs for Discord Role mappings, service-authenticated Role observations, L3/L4 elevation confirmation, manual downgrade, and active-session revocation.
- Sapphire startup reconciliation and `guildMemberUpdate` listeners send normalized observed Role IDs only; the API remains the sole access-policy authority.
- L1/L2 apply automatically. First L3/L4 observations retain the current effective level and create a pending approval that requires a different active L4 with recent step-up.
- Client Role claims never authorize operations. Removed or downgraded Roles, manual downgrades, and explicit revocation invalidate active sessions and advance `permissionsVersion`.
- Guild-wide monotonic mapping generations, serialized concurrent updates, reconciliation Outbox jobs, source-event replay, append-only sync events, and PostgreSQL transactions that commit access state, approval decisions, session revocation, and success audit together.
- Manual revocation is an internal hard cap that Discord reconciliation cannot undo; delayed observations append rejected evidence without overwriting newer access state.
- One-time L4 bootstrap guarded by a PostgreSQL transaction lock and persistent `BOOTSTRAP` role source; retaining the bootstrap environment setting causes startup refusal after first use.
- Empty-database bootstrap now creates the initial internal user and Guild-scoped Discord identity in the same transaction before creating the first L4 staff account; it does not create a Provider external account or payment binding.

## Acceptance

- `AT-ROL-001`: passed for automatic L1/L2 creation and promotion.
- `AT-ROL-002`: passed for first L3 observation remaining pending.
- `AT-ROL-003`: passed for different-L4 confirmation, self-approval defense, and observed-Role recheck.
- `AT-ROL-004`: passed for immediate downgrade/removal, permissions version advance, and old-session 401.
- `AT-ROL-005`: passed for internal-level authorization despite forged client Role claims.
- `AT-RBAC-006`: existing `500000` minor-unit L4 boundary remains covered by the amount-policy regression suite.

## Gates

- Focused `tests/m4-us-05-api.spec.ts`, `tests/m4-us-05-bot.spec.ts`, and `tests/m4-us-05-db.spec.ts`: 3 files / 21 tests passed.
- `pnpm test`: 84 files / 420 tests passed.
- `pnpm typecheck`: passed.
- `pnpm exec vite build apps/dashboard`: passed (`228.64 kB`, gzip `71.15 kB`).
- `pnpm db:validate`: passed.
- `pnpm db:verify:migration`: passed with 51 tables and all existing negative and append-only probes.
- `pnpm exec tsx apps/bot/src/piece-manifest.ts`: passed and discovered `guild-member-update` plus `ready` listeners.
- Runtime, docs, and output Prisma schemas match; docs and output OpenAPI contracts match.
- `git diff --check`: passed.

## Empty-database bootstrap repair

Verified on 2026-08-02 MDT.

- RED: `tests/m4-us-05-bootstrap-empty-db.spec.ts` failed with `The Discord account is not linked to a user.` on an empty migrated database.
- GREEN: the same test passed after the transactional identity bootstrap was added; `tests/m4-us-05-bootstrap-empty-db.spec.ts` and `tests/m4-us-05-db.spec.ts` passed together (2 files / 6 tests).
- The repair preserves the existing one-time lock, `BOOTSTRAP_L4_OWNER` audit, and retained-variable refusal behavior.

## Dashboard access workspace and scoped route loading

Verified on 2026-08-02 MDT.

- RED: `tests/dashboard-access-ui.spec.ts` failed because the access-management page and request builder did not exist; `/access` previously fell through to the overview.
- GREEN: `/access` now renders an L4-only access workspace backed by `listDiscordRoleMappings` and `updateDiscordRoleMapping`. Mapping writes retain the server-provided version, require a reason code, and do not infer authorization in the client.
- High-risk reads preserve the existing recent step-up gate. Browser verification with the authenticated L4 session showed the dedicated access route and the correct step-up-required state with `request_id`.
- Sidebar links now use History API navigation. Route loading is bounded by `dashboard-content`; the sidebar and top bar remain mounted, and no full-screen capability gate appears during workspace changes.
- Focused regression: 4 files / 21 tests passed. Full lower-concurrency regression: 152 files / 755 tests passed. Dashboard typecheck and production build passed (`300.73 kB`, gzip `90.24 kB`; CSS `33.03 kB`, gzip `8.20 kB`).

## Persistent Role-sync recovery and staff reconciliation

Verified on 2026-08-10 MDT.

- RED baseline: the focused API/Bot/Worker/Dashboard suite failed in 5 files with 8 failures because Role observations still called the processing endpoint directly, no periodic scheduler or staff reconciliation route existed, and the access page had no sync evidence or session-revocation copy.
- `guildMemberUpdate` and startup observations now call `queueDiscordRoleSync`; the API transactionally commits an idempotent `ROLE_RECONCILIATION` Outbox job with 8 attempts before returning 202. Failed jobs remain persisted as `FAILED` rather than being discarded.
- The Worker enqueues a deduplicated full-Guild reconciliation every `ROLE_RECONCILIATION_INTERVAL_MS` (default `300000` ms), supports per-staff `MEMBER_FETCH`, and processes persisted observations. If a queued job encounters `MAPPING_VERSION_STALE`, it refreshes the expected version once with a new idempotency key.
- The L4 + recent step-up access page preserves the original permission boundary and now shows each same-Guild employee's latest Role sync time, observed Discord Roles, processing/queue status, last error, and pending elevation. Every employee card exposes “立即从 Discord 对账”, which calls `reconcileStaffDiscordRole` and queues a persistent job.
- A `SESSION_REVOKED` 401 now produces the explicit Dashboard message “权限已变化，请重新登录”; normal unauthenticated sessions retain the ordinary login copy.
- No new table or migration was needed: the existing append-only `staff_role_sync_events` evidence and PostgreSQL `outbox_events` lifecycle are reused.

### Verification

- Focused role-sync regression: 8 files / 59 tests passed.
- Dashboard Chromium: `DE2E-STF-001`–`003`, 3/3 passed, including sync evidence and targeted persistent reconciliation.
- Full `npm test`: 256 files / 1292 tests passed, including production TypeScript build.
- Dashboard production build passed (`446.82 kB`, gzip `126.52 kB`; CSS `84.70 kB`, gzip `17.67 kB`).
- Route/OpenAPI parity passed for 164 production operations; E2E coverage passed for 131 planned = 131 implemented IDs.
- API/Dashboard lint passed with 37 existing warnings and no errors; Bot lint passed with zero warnings; Prisma schema validation and `git diff --check` passed.
- Acceptance coverage: `AT-ROL-001`, `AT-ROL-004`, and `AT-DOP-007`. Real Discord Guild timing and outage recovery remain an external UAT/release check.
