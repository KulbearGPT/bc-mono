# M5-US-07 Verification Evidence

Verified on 2026-07-19 EDT.

## Delivered

- Added an OWNER-only Dashboard page for Sandbox account lookup and target-balance changes. The client renders `providerBalanceMinor`, `reservedMinor`, `availableMinor`, currency, version and timestamp exactly as returned by the API; it never calculates availability or a delta.
- Target-balance requests contain only `currency`, `targetProviderBalanceMinor`, `expectedVersion` and fixed `SANDBOX_TEST_SETUP`. A 409 response triggers a fresh GET, preserves the stable error code/request ID, and requires an intentional second submission against the refreshed version.
- Added the exact `SANDBOX 测试环境 · 测试余额不代表真实资金` warning to the authenticated Dashboard shell and the final Bot rendering boundary for ephemeral/private messages. Production rendering remains undecorated.
- Capabilities now publish presentation-only `displayRole`: effective L2 displays `STAFF`, effective L4 displays `OWNER`, and L1/L3 display no collapsed role. Internal levels, inheritance and authorization inputs are unchanged.
- Dashboard navigation consumes API `enabledFeatures`: gift pages require `GIFTS`, commissions require `REFERRALS`, and settlements/reports/customer profiles require `M6`. The Sandbox balance entry additionally requires Sandbox environment, OWNER display role and `sandbox_funding.manage`.
- Bot configuration responses carry the same API-owned environment, feature and display-role fields, and the Sandbox staff panel renders the warning and approved role without inferring Discord Role authorization.
- Inline review found hidden admin gift/customer-consumption endpoints in `admin-directory.ts`; those routes now have API `GIFTS`/`M6` enforcement so crafted requests cannot bypass the feature-aware UI.

## TDD Evidence

- RED: `tests/m5-us-07-dashboard-sandbox.spec.ts` failed because the Dashboard Sandbox module did not exist; `tests/m5-us-07-bot-sandbox.spec.ts` failed because the warning and role functions did not exist.
- Dashboard/Bot and existing navigation/privacy regression passed 11 files / 86 tests.
- Bot configuration and the additional API final-gate regression passed 5 files / 42 tests.
- Tests cover exact warning copy, production suppression, STAFF/OWNER mapping, target payload allowlist, invalid target rejection, 409 refresh, OWNER navigation, disabled feature navigation, final Bot rendering, API-sourced Bot staff presentation, and zero handler calls for hidden admin routes.

## Final Verification

- Full regression: `npm test` passed 131 files / 764 tests.
- `npm run typecheck`, `npm run build`, Dashboard Vite production build, both API/UI contract mirror comparisons, acceptance-matrix regeneration, and `git diff --check` passed.
- The regenerated matrix contains 184 authoritative rows; Railway/Discord/UAT results remain external and pending.

## Modified Files

- Dashboard: `SandboxFundingPage.tsx`, `sandbox-funding.ts`, `App.tsx`, `dashboard-shell.ts`, `admin-business.ts`, `settlements.ts`, `styles.css`, and package exports.
- Bot/API: `discord-renderer.ts`, Bot `index.ts`, both `bot-config.ts` implementations, `dashboard-auth.ts`, `admin-directory.ts`, and both OpenAPI mirrors.
- Contracts/evidence: both interaction mappings, both backlog/TODO mirrors, two M5-US-07 tests, the adjusted capability contract assertion, this evidence file, and the regenerated acceptance matrix.

## Remaining Scope

This Story does not deploy Railway services or validate the UI against a real Discord Guild. Container/runtime packaging and the Railway runbook remain M5-US-08; deployment, restore, real two-role UAT and observation remain external M5-US-09/10 gates.

## Final-review remediation (2026-07-24 MDT)

- Sandbox target-balance writes are now bound to the loaded account identity. A requested `userId` that differs from `account.userId` is rejected before GET or POST, the page submits with `account.userId`, displays that identity beside the snapshot, and clears the loaded snapshot when the lookup text changes. A generation guard prevents an older lookup response from restoring cleared state.
- The production web server injects its already validated closed-enum `BUSINESS_ENV` into the static Dashboard bootstrap. That public fact labels loading, signed-out, forbidden, error and authenticated pages; an authenticated capability can override it only when its value is exactly `SANDBOX` or `PRODUCTION`.
- The final Discord renderer now applies the exact warning to `PUBLIC`, `PRIVATE_CHANNEL` and `EPHEMERAL` Sandbox messages. Production messages remain undecorated.

### RED / GREEN

- Identity/bootstrap/public-message RED: `npx vitest run --no-file-parallelism tests/m5-us-07-dashboard-sandbox.spec.ts tests/m5-us-07-bot-sandbox.spec.ts` exited 1 with 3 failed and 9 passed tests. The client performed the mismatched write, public HTML retained the unresolved environment marker, and public Discord omitted the warning.
- Capability-enum RED: `npx vitest run tests/m5-us-07-dashboard-sandbox.spec.ts` exited 1 with 1 failed and 8 passed tests because the closed-enum resolver did not yet exist.
- Focused GREEN: the seven-file Dashboard, Bot, Pilot-policy and Railway static-runtime regression passed 7 files / 55 tests.
- Full GREEN: `npm test` passed 133 files / 805 tests. `npm run typecheck`, `npm run build`, the Dashboard Vite production build and `git diff --check` passed.

### Modified files

- Runtime/UI: `apps/api/src/index.ts`, `apps/api/src/server.ts`, `apps/bot/src/discord-renderer.ts`, `apps/dashboard/index.html`, `apps/dashboard/src/App.tsx`, `apps/dashboard/src/main.tsx`, `apps/dashboard/src/SandboxFundingPage.tsx` and `apps/dashboard/src/sandbox-funding.ts`.
- Tests/docs: both M5-US-07 test files, this evidence file, both TODO mirrors and `docs/superpowers/plans/2026-07-24-m5-us-07-remediation.md`.

M5-US-09 and M5-US-10 remain unstarted and incomplete. This remediation adds no Railway deployment, real Discord Guild, restore, observation or human UAT evidence.
