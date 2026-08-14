# M4-US-01 Verification Evidence

## Delivered

- Discord OAuth2 authorization-code flow with one-time state validation and active staff lookup.
- Server-side PostgreSQL staff sessions using hashed opaque tokens, secure production cookies, explicit logout revocation, and eight-hour expiry.
- Dashboard actor identity derived only from the server session and current staff record; browser role and actor claims are ignored.
- Immediate session rejection when `permissions_version`, staff status, expiry, or revocation state changes.
- Double-submit CSRF enforcement on shared Dashboard write middleware and logout.
- `getCurrentStaffCapabilities` and eight-metric Dashboard summary shell shared through the API.
- React 401, 403, error, and ready states with capability-driven navigation and credentialed API requests; no localStorage token handling.

## Verification

- `pnpm vitest run tests/m4-us-01-api.spec.ts tests/m4-us-01-dashboard.spec.ts tests/m0-us-03.spec.ts`: 3 files, 25 tests passed.
- `pnpm test`: 73 files, 339 tests passed.
- `pnpm typecheck`: passed.
- `pnpm db:validate`: Prisma schema valid.
- `pnpm db:verify:migration`: 47 tables, 3 checked constraints, 7 append-only/protection triggers; migration and negative constraint probes passed.
- `git diff --check`: passed.

## Acceptance Mapping

- `AT-AUTH-002`: Dashboard self-reported L4/Discord identity is ignored; the L1 server session remains authoritative and stale permission versions return `SESSION_REVOKED`.
- `AT-RBAC-001`: L1 receives only its server-computed capability navigation and basic support permissions; API authorization remains authoritative.

## 2026-08-01 Visual Refresh

### Delivered

- Persisted the `ui-ux-pro-max` recommendation as `design-system/blackcat-operations/MASTER.md`, then adapted its modern gaming-dashboard palette to a high-readability operations workspace.
- Replaced the basic inline shell with a branded sidebar, capability-derived icon navigation, active-route indication, production/Sandbox context, permission sync status, skip link, and responsive top bar.
- Replaced the placeholder home page with a capability-backed overview and quick links. Counts are derived only from server-returned permissions, enabled features, and visible navigation; no business metrics are invented client-side.
- Unified signed-out, forbidden, error, loading, and unavailable states while preserving the existing OAuth2 and API behavior.
- Added semantic design tokens, 44px control targets, visible keyboard focus, reduced-motion handling, responsive 768/720px safeguards, tabular data styling, and WCAG AA text/background pairs.

### Verification

- RED: `npx vitest run tests/m4-us-01-dashboard-ui.spec.ts` — 3/3 failed because the new shell components and accessibility theme safeguards did not exist.
- GREEN: `npx vitest run tests/m4-us-01-dashboard-ui.spec.ts` — 4/4 passed, including the guard that an unknown runtime environment is never mislabeled as production.
- Dashboard regression: 9 files / 57 tests passed, including M4-US-01/02/03/06/08/09, M5 Sandbox, and M6 profile coverage.
- Full regression: `npm test` — 135 files / 814 tests passed after regenerating the deterministic 184-row acceptance matrix.
- `npm run typecheck -w @blackcat/dashboard` — passed.
- `npm run build -w @blackcat/dashboard` — passed.
- `git diff --check` — passed.
- Headless Chrome review at 1440×900 and 390×844 is saved under `evidence/P0/M4-US-01/ui-refresh/`.

### Remaining Boundary

- This refresh changes presentation only. OAuth2, server-owned capabilities, object scope, amount thresholds, and final API authorization remain unchanged.
- Real staff-account UAT is still an external acceptance activity and is not claimed by these screenshots.

### M9 integration verification (2026-08-02)

- Merged the refreshed shell into the CAT wallet/onboarding branch while retaining the current `pilot-features` capability contract, USD receipt top-ups, companion review routes and responsive wallet styles.
- The retired `/sandbox-funding` page and Provider client were intentionally not restored from the older UI branch.
- `npx vitest run tests/m4-us-01-dashboard-ui.spec.ts tests/m9-us-06-dashboard.spec.ts tests/m8-us-03-bot-display.spec.ts`: 3 files / 12 tests passed.
- Dashboard typecheck and Vite production build passed; the post-merge full regression passed 310 files / 746 tests, with a regenerated 207-row acceptance matrix.

## 可爱主题示例与切换器（2026-08-03）

- 保留科技主题为默认，在真实 Dashboard 壳层新增 `cute` 预览主题：奶油色页面、莓果粉与薄荷青强调色、圆角面板和柔和阴影，同时保留后台页面所需的表格、状态、权限与环境辨识度。
- 右下角悬浮按钮可在科技/可爱主题之间即时切换，使用 `aria-pressed` 和完整可访问名称；仅将主题偏好写入浏览器 `localStorage`，不存储身份、权限或业务数据。600px 以下收为单图标按钮，避免遮挡内容。
- RED/GREEN：新增持久主题、悬浮入口、面板与表格覆盖合同；实现后 `tests/dashboard-release-ui.spec.ts`、`tests/m4-us-01-dashboard-ui.spec.ts`、`tests/m9-us-08-business-tags.spec.ts` 共 3 files / 19 tests 通过。
- `npm run typecheck`、`npm run build -w @blackcat/dashboard`、`git diff --check` 通过。实际修改：`apps/dashboard/src/App.tsx`、`apps/dashboard/src/styles.css`、`tests/dashboard-release-ui.spec.ts`。
- 当前本地浏览器没有员工登录态，因此示例落在登录后的真实运营概览页，但未将登录后人工截图 UAT 误报为完成。

### 概览页主题复核

- 根据页面截图将主题切换入口从右下角悬浮层迁入右上角顶栏，改为紧凑的 40px 图标按钮，仍保留 tooltip、可访问名称、`aria-pressed` 与偏好持久化。
- 删除概览横幅中的营销式长文案，改为“工作台已就绪 / 选择下方工作区开始处理任务”；可爱主题补齐概览横幅、会话快照、快捷入口文字、编号、图标和 hover 状态，不再混入深色科技面板。
- RED/GREEN 后聚焦回归 3 files / 19 tests 通过；`npm run typecheck`、Dashboard production build 与 `git diff --check` 通过。登录后人工截图 UAT 仍待外部验收。

### 标签与面板装饰复核

- 修复可爱主题遗漏的业务标签行：行背景、边框、代码、版本、启用/停用状态与禁用按钮均改用浅色主题，不再继承科技主题的深色实体背景。
- 可爱主题移除 `.content-panel::before` 的科技感短线装饰，避免其在相邻面板、滚动裁切和圆角卡片之间表现为脱离面板的悬浮线段。
- 新增主题覆盖合同后完成 RED/GREEN；聚焦回归 3 files / 19 tests、全仓 typecheck、Dashboard production build 与 `git diff --check` 均通过。

### Dashboard 中文表头统一

- 新增共享字段表头词典，业务对象列表与系统运营动态表格不再直接渲染 API 的 camelCase 英文字段名；表头统一显示中文，原始英文键保留在 `title` tooltip，方便排障与对照接口。
- 已有客户 Profile、钱包、结算、交易时间线和消费记录的静态表头均为中文；未知的未来 API 字段使用“数据字段”兜底，不把英文键直接暴露到界面。
- RED/GREEN：新增 `tests/dashboard-table-labels.spec.ts`，并同步既有操作列顺序合同；聚焦回归 5 files / 39 tests、全仓 typecheck、Dashboard production build 与 `git diff --check` 均通过。
- 实际修改：`apps/dashboard/src/table-labels.ts`、`apps/dashboard/src/AdminBusinessPage.tsx`、`apps/dashboard/src/OperationsPage.tsx` 及对应测试。

## 2026-08-05 Overlay 标题栏边缘回归

### Delivered

- 移除 `.dashboard-overlay .panel-heading` 与 action-panel 专用标题栏的横向负边距，保留纵向吸顶行为。
- 标题栏背景现在被约束在弹窗内容边界内，不再覆盖左右边线、圆角或 action-panel 的紫色装饰。
- 修复作用于 `DashboardOverlay` 公共容器，因此详情页、设置项目分成及其他操作弹窗统一生效。

### Verification

- RED：`npx vitest run tests/m4-us-01-dashboard-ui.spec.ts` — 新增边缘约束用例 1 failed / 4 passed，证明旧样式仍使用横向负边距和横向 padding。
- GREEN：`npx vitest run tests/m4-us-01-dashboard-ui.spec.ts tests/m4-us-03-dashboard.spec.ts` — 2 files / 27 tests passed。
- `npm run typecheck` — passed。
- `npm run build -w @blackcat/dashboard` — Vite production build passed，1593 modules transformed。
- `git diff --check` — passed。

### Acceptance and remaining boundary

- Story：`M4-US-01`；`AT-AUTH-002` 与 `AT-RBAC-001` 的认证、权限及服务端权威边界未改变。
- 本地浏览器没有员工登录会话，无法进入真实详情弹窗；未绕过 OAuth2，也未把真实员工视觉 UAT 误报为完成。

### Follow-up: remove the heading color block

- 根据真实页面反馈，将共用 overlay 标题栏改为透明背景并关闭 `backdrop-filter`；标题、关闭按钮、吸顶行为和底部分隔线保持不变。
- RED：`npx vitest run tests/m4-us-01-dashboard-ui.spec.ts` — 1 failed / 4 passed，证明旧标题栏仍渲染独立背景和模糊。
- GREEN：M4-US-01 与 M4-US-03 聚焦回归 2 files / 27 tests passed；全仓 typecheck 与 Dashboard production build passed。
