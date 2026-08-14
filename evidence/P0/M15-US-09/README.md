# M15-US-09 真实客服业务 E2E 与发布审计

日期：2026-08-06

## 自动化结果

```text
npm test
build: PASS
Test Files  216 passed (216)
Tests       1052 passed (1052)

npx playwright test tests/e2e/dashboard --project=chromium
129 passed (2.9m)

node scripts/build-p0-acceptance-matrix.mjs .
Wrote 276 acceptance rows to evidence/P0/acceptance-matrix.csv.
```

首次全量 Chromium 执行为 128/129，正确捕获到员工钱包页误渲染客户代币说明的新回归。修正后目标用例 1/1 通过，完整 129/129 重跑通过。员工界面仍只显示 canonical USD。

## 现实业务覆盖

- 36 个混合状态订单的稳定分页、过滤与相互隔离。
- 老板服务前取消，只处理目标订单且不影响另外 35 单。
- 服务中掉线联系客服，L1 收集证据后由 L2 执行部分处置。
- 完成后独立部分退款，订单保持 COMPLETED，资金和审计只追加。
- 网络超时重试不重复退款；终态、过期版本和超事实处置零写入。
- 客服充值与渠道退款扣款、钱包 Adjustment、Bot 配置、陪玩暂停/恢复、客户展示名、员工双人提权/降级/会话撤销。
- 套餐、服务目录和礼物的创建、新版本、发布、退役/归档及历史不变性。

## 审计修正

- 解决 `AT-MULTI-010` 重复：套餐版本管理更正为独立 `AT-MULTI-014`，并同步 backlog、交互映射和 UAT 清单。
- 将 M15 Bot 配置校验追踪修正到 OpenAPI 实际 `validateBotConfigChange`。
- 补齐 M10/M15 fixture 索引、候选证据摘要、新安全写路由审计库存总数和 69 个外部验收项追踪。
- 输出/文档镜像及验收矩阵已重新同步。

### 陪玩候选资格收口（2026-08-06）

- 确认运行时已将历史 `PUT /api/v1/players/me/availability` 关闭为 404，且回归测试证明请求不产生任何写入。
- 移除 API store 内不可达的陪玩本人 availability 写方法；历史字段只作诊断兼容，不参与报名资格判定。
- 陪玩报名资格仅由客服审核的 `ACTIVE`、同 Guild 与运营标签决定；陪玩仅能在候选池报名/撤回，不能自选“今天接单”。
- 同步修正 Dashboard 字段、Bot 诊断提示、UI 文案、交互原型、API 说明、业务配置、数据模型和产品演示，避免继续误导开发与 UAT。

## 未完成的外部门禁

真实员工 UAT、真实 Discord Guild/Provider 交互、备份恢复演练和发布角色签署未执行。自动化结果不代替这些外部证据，候选发布门禁继续 fail closed。
