# M13 七页双视图操作可达性修复结果

## Story 与验收

- Story：`M13-US-04` 跨页一致性、可访问性与发布验收（缺陷修复候选）
- 验收：`AT-LST-004`、`AT-LST-007`
- 日期：2026-08-08 MDT
- 工作分支：`codex/dashboard-action-visibility`

## 未通过基线

L4 fixture、1280×720、CARD 默认视图下，七页的记录动作虽存在于 DOM，但都位于首屏之外：订单动作顶边约 `872.8px`，用户与陪玩约 `765.2px`，服务目录、服务套餐、礼物目录和礼物请求约 `769.8px`。既有测试没有约束动作区域的首屏可发现性。

新增 `tests/dashboard-collection-action-visibility.spec.ts` 后首次执行结果：

```text
Test Files  1 failed (1)
Tests       14 failed (14)
```

失败分别锁定七页缺少统一“可用操作”语义区域，以及卡片操作排在内容摘要之后。

## 实现

- `AdminBusinessPage` 新增共享 `CollectionItemActions`，统一七页 CARD、桌面 TABLE 与窄屏行式列表的详情和 item action 渲染。
- 卡片动作前移至标题之后，在摘要和事实区之前展示；所有动作继续使用原权限集合与 `playerActionApplies` 状态条件。
- 集合级“创建服务版本 / 创建套餐版本 / 创建礼物”继续位于页面标题区，不受视图切换影响。
- `aria-label="可用操作"` 与 `role="group"` 为动作区提供稳定可访问名称。
- E2E API、Dashboard 端口增加可选环境变量；默认 3000/5173 不变，新 worktree 使用 3100/5273，未停止原工作区进程。

## 验证结果

```text
npx vitest run tests/dashboard-collection-action-visibility.spec.ts tests/dashboard-card-workspaces.spec.ts tests/m13-us-03-dashboard-collections.spec.ts tests/m4-us-03-dashboard.spec.ts
Test Files  4 passed (4)
Tests       57 passed (57)
```

```text
DASHBOARD_E2E_API_PORT=3100 DASHBOARD_E2E_PORT=5273 npx playwright test tests/e2e/dashboard/dashboard-collection-action-visibility.spec.ts --project=chromium --reporter=line
7 passed (17.4s)
```

浏览器门禁逐页确认：CARD 首张卡片的“可用操作”区域在 1280×720 初始视口中，切换 TABLE 后同一允许动作仍可见；375×844 CARD 的动作不被裁切且七页均无横向溢出。

```text
npx vitest run tests/*dashboard*.spec.ts tests/m13-us-0*.spec.ts tests/m4-us-03-dashboard.spec.ts tests/dashboard-card-workspaces.spec.ts tests/dashboard-table-labels.spec.ts
Test Files  33 passed (33)
Tests       168 passed (168)

npm run typecheck
passed

npm run build -w @blackcat/dashboard
1598 modules transformed
dist/assets/index-FkoD7GfE.css 84.43 kB
dist/assets/index-CQL2RFdv.js 437.63 kB

git diff --check
passed
```

补充全仓审计：

```text
npx eslint apps/dashboard/src --max-warnings 39
0 errors / 9 existing warnings

npm run e2e:coverage:verify
129 planned IDs = 129 unique implemented IDs

npm test
234 files / 1200 tests passed
4 files / 8 tests failed
```

完整 `npm test` 的 8 个失败均来自本分支未修改的既有门禁：3 个 `m5-us-01-traceability` 与 3 个 `m5-us-03-release-gate` 失败于 `AT-EXP-002` 引用未知 operationId；`m7-us-01-contract` 缺少 `FX-API-CONFLICT` fixture；`m16-us-04-quality-gates` 由未修改的 `apps/api/src/selection-pools.ts:1584` `prefer-const` error 触发。组合 `npm run lint:api-dashboard` 因同一个既有 API error 失败，Dashboard-only lint 为 0 error。上述失败未被误记为本次通过，也未跨 Story 修改。

## 截图

每个修改页面均保存 CARD 与 TABLE 的 1280×720 浏览器截图，共 14 张：

- `screenshots/action-visibility/orders-{card,table}-1280x720.png`
- `screenshots/action-visibility/users-{card,table}-1280x720.png`
- `screenshots/action-visibility/players-{card,table}-1280x720.png`
- `screenshots/action-visibility/service-catalog-{card,table}-1280x720.png`
- `screenshots/action-visibility/service-packages-{card,table}-1280x720.png`
- `screenshots/action-visibility/gift-catalog-{card,table}-1280x720.png`
- `screenshots/action-visibility/gift-requests-{card,table}-1280x720.png`

## 剩余边界

- 本次缺陷修复、自动化和 fixture 截图均已通过，未发现范围内剩余代码问题。
- `M13-US-04` 仍保持未完成：既有真实 L1–L4 员工、真实键盘以及产品/运营/QA 签署尚未齐备，本地 fixture 证据不替代外部验收。
