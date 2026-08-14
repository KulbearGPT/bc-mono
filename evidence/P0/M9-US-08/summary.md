# M9-US-08 统一业务标签库与受控选择证据

实现统一的 `GAME`、`SERVICE`、`REGION`、`LANGUAGE` 与 `GIFT_CATEGORY` 标签库。标签代码创建后不可修改，不提供删除操作；展示名称和启用状态使用版本号并发控制。服务项目、陪玩批准及礼物版本提交标签 ID，API 再次校验标签存在、类型正确且当前启用。

业务标签新增、改名和启停受 `catalog.manage`、CSRF、幂等与审计保护，但按确认后的业务规则不要求 MFA 近期 step-up。

陪玩审批中的游戏、服务种类与语言使用复选多选；批准后提供“编辑支持范围”，回显既有选择并通过统一 API 以完整标签集合替换，服务端继续重验稳定 ID、类型和启用状态。

服务目录与礼物目录的现有行提供明确编辑操作，默认进入“保存修改”并回填当前字段；提交后创建替代版本，旧版本及其历史订单引用保持不变。

服务目录与礼物目录的新增、编辑和启停不要求 MFA 近期 step-up，仍保留对应管理权限、CSRF、幂等、版本控制与审计。

## 自动化验证

- `npm run build`：通过。
- API 与 Dashboard workspace typecheck：通过。
- 标签、合同追踪、Player、Catalog、Gift 与 Dashboard 聚焦回归：9 个测试文件、131 个测试全部通过。
- `000013_business_tags` 已在本地开发 PostgreSQL 成功应用。
- Web 已重启；浏览器到达 Discord 登录门禁，但当前浏览器没有员工登录态，因此登录后的页面级 UAT 尚未签署。Story 保持未完成。

## Dashboard 标签页对齐修复（2026-08-03）

- RED：新增标签行布局合同后 `tests/m9-us-08-business-tags.spec.ts` 8 项中 1 项失败，复现旧五列网格在半宽标签卡中将操作按钮挤出父容器、按钮文案换行的问题。
- GREEN：`TagRow` 将操作按钮收纳为独立 `.tag-row__actions`，标签行改为受限的“身份 / 名称 / 状态 / 操作”四轨；1120px 以下标签卡堆叠，720px 以下改为移动端两轨，身份与操作不会把父卡撑出视口。
- 验证：业务标签、Dashboard 视觉壳与发布视觉门禁聚焦回归 3 files / 17 tests 通过；`npm run typecheck`、`npm run build -w @blackcat/dashboard`、`git diff --check` 通过。受现有本地 Dashboard 未登录会话影响，本次未将浏览器截图 UAT 误报为已签署；登录后的 AT-TAG-001～004 仍待外部验收。
- 实际修改：`apps/dashboard/src/BusinessTagsPage.tsx`、`apps/dashboard/src/styles.css`、`tests/m9-us-08-business-tags.spec.ts`。

## Dashboard 标签矩阵边界补强（2026-08-03）

- 复核截图后继续修复：标签矩阵显式设置 `width: 100%`、`min-width: 0`、等宽两列和卡片间距；标签行使用固定语义轨道，操作区按钮在轨道内等比分配，避免 ID、名称、状态和操作列边界随内容漂移。
- 断点规则：1120px 以下游戏/服务卡改为单列，720px 以下标签行改为移动端两轨；不再让内容最小宽度反向撑大页面。
- RED/GREEN：扩展布局合同后 1 项失败；实现后 `tests/m9-us-08-business-tags.spec.ts`、`tests/dashboard-release-ui.spec.ts`、`tests/m4-us-01-dashboard-ui.spec.ts` 共 3 files / 17 tests 通过；typecheck、Dashboard production build、`git diff --check` 通过。
- 当前本地 Dashboard 仍被员工登录门禁拦截，未将浏览器截图 UAT 误报为完成；AT-TAG-001～004 仍等待登录后的外部验收。

## Dashboard 表格与卡片行线复核（2026-08-03）

- 根因复核：通用操作区样式把 `td.table-actions` 设置成了 `display: flex`，导致操作单元格脱离原生 table-cell 行高，边框无法与会换行的 ID 单元格对齐；标签网格中的第二个 `.content-panel` 同时命中了相邻面板的 `margin-top: 16px`，因此 GAME 与 SERVICE 顶边错位。
- 修复：表格单元格恢复 `display: table-cell`，按钮改由内部 `.table-actions__group` 承担 flex 布局，并为 ID / 操作列统一显式宽度；标签网格直属卡片统一清除额外顶部外边距。
- RED/GREEN：新增原生表格格式上下文与卡片直属子项对齐合同；实现后聚焦回归 3 files / 18 tests 通过，`npm run typecheck`、`npm run build -w @blackcat/dashboard`、`git diff --check` 均通过。
- 实际修改：`apps/dashboard/src/AdminBusinessPage.tsx`、`apps/dashboard/src/OperationsPage.tsx`、`apps/dashboard/src/SettlementPage.tsx`、`apps/dashboard/src/styles.css`、`tests/dashboard-release-ui.spec.ts`、`tests/m9-us-08-business-tags.spec.ts`。

## 修改范围

- 数据：`database/prisma/migrations/000013_business_tags/migration.sql` 与三份 Prisma 合同镜像。
- API：业务标签管理、启用标签解析，以及服务、陪玩、礼物写入边界。
- Dashboard：业务标签库页面及三类业务表单的受控下拉/多选。
- 合同：主规格、OpenAPI、Backlog、交互映射、验收用例与追踪矩阵。
