# M18-US-06 证据摘要

## 结果

- 状态：DONE（本地运行时与自动化）；真实 Guild 三角色/桌面手机 UAT 归 M18-US-08
- 验收：AT-EXP-002、AT-EXP-003、AT-EXP-004
- 数据迁移：无
- 状态与资金边界：不新增状态迁移，不恢复客户 readiness，不在 Bot/Worker 计算订单金额、捕获或收益

## 合同校正

- 收尾核对发现 M18-US-06 旧文案仍写“双方就绪”，与主规格 M10 的替代合同冲突。按事实来源优先级，现统一为“客户无需 readiness；全部当前有效陪玩 READY 后，API 才可进入 IN_SERVICE”。
- backlog 的 operationId 从不存在的 `markOrderReady` 修正为 OpenAPI 的 `setOrderReadiness`；真实 Guild UAT 明确集中到 M18-US-08，不以本地测试替代。

## 实现

- 新增独立 `service-lifecycle-message.ts`，旧 facade 继续 re-export，`service-center.ts` 从 2503 行降为 2300 行。
- ACCEPTED 卡按 API `participants` 逐名展示 ✅ 已就绪 / ⏳ 未就绪；老板视角说明无需提交 readiness，陪玩视角保留本人就绪动作。
- IN_SERVICE、PENDING_CONFIRMATION、COMPLETED 使用统一私密订单密度、语义色和“核心事实 → 当前进度 → 下一步”字段层级。
- Worker 的持久化订单投影新增逐陪玩 readiness、逐人价格、预计收益、分成来源、就绪期限和服务开始时间；同一 `panelMessageId` 原位更新，不新增里程碑刷屏。
- 共享订单卡按钮改为“陪玩确认就绪”“陪玩申请完成”“老板确认完成”，降低客户与陪玩的权限误解；业务 API 仍做最终 Actor 与对象权限判断。
- 确认前展示的逐人金额均来自 API/数据库快照；完成卡不把预计收益冒充最终付款事实，只说明完成事实以业务 API 记录为准。

## RED

```text
npm exec vitest run tests/m18-us-06-service-lifecycle-experience.spec.ts
Test Files  1 failed (1)
Tests       4 failed (4)
原因：旧生命周期卡缺少统一密度、分字段层级、逐陪玩状态和新版里程碑文案。

新增 Worker 常驻订单卡断言后：
Test Files  1 failed (1)
Tests       1 failed | 5 passed (6)
原因：真实原位更新路径仍只显示聚合状态与“我已就绪”。
```

## GREEN

```text
npm exec vitest run \
  tests/m18-us-06-service-lifecycle-experience.spec.ts \
  tests/m2-us-04-bot.spec.ts \
  tests/m6-us-06-bot.spec.ts \
  tests/m5-us-02-worker-adapters.spec.ts
Test Files  4 passed (4)
Tests       51 passed (51)

npm exec eslint -- apps/api/src/worker-adapters.ts apps/api/src/worker-runtime.ts --max-warnings 0
0 errors / 0 warnings

npm run quality:bot
lint        0 warnings / 0 errors
format      passed
typecheck   passed
build       passed
pieces      22 discovered
Bot tests   55 files / 322 tests passed
```

## 修改文件

- `apps/bot/src/service-lifecycle-message.ts`
- `apps/bot/src/service-center.ts`
- `apps/bot/src/service-center-api.ts`
- `apps/bot/src/bot-copy.ts`
- `apps/bot/src/order-display.ts`
- `apps/api/src/worker-runtime.ts`
- `apps/api/src/worker-adapters.ts`
- `tests/m18-us-06-service-lifecycle-experience.spec.ts`
- `tests/m2-us-04-bot.spec.ts`
- `tests/m5-us-02-worker-adapters.spec.ts`
- `outputs/P0开发交付包/06-开发计划/backlog.csv`
- `docs/P0开发交付包/06-开发计划/backlog.csv`
- `outputs/Codex-P0开发TODO.md`
- `docs/Codex-P0开发TODO.md`

## 剩余风险

- Discord 同一频道的常驻组件对所有参与者可见，因此按钮用角色前缀降低误操作，真正授权仍由统一 API fail-closed；M18-US-08 必须以老板、陪玩、客服三种真实账号验证理解度。
- 图片裁切、手机按钮换行、消息原位编辑与三角色真实 Guild 行为尚未在本 Story 签署，不能据此声称发布完成。
