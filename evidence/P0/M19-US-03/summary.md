# M19-US-03 就绪、服务与完成跨角色刷新

- 状态：DONE（本地运行时与自动化）
- 验收：`AT-STATE-001`、`AT-STATE-002`、`AT-STATE-003`、`AT-STATE-004`

## 发现与修复

- 订单仍为 `ACCEPTED` 时，原 Worker 的 `sendOnce` 会把已发送的客服协同卡当成完成，后续陪玩逐人就绪不会刷新。现以稳定 nonce 查找并 PATCH 原消息，首次才 POST，重试不刷屏。
- API 权威 readiness 改为只返回当前有效陪玩的 `participants` 和 `allActivePlayersReady`；客户不提交 readiness，全部有效陪玩确认后原子进入 `IN_SERVICE`。
- 客服协同卡和 Dashboard 订单详情逐名展示就绪、截止与开始时间；超时提醒只列未确认陪玩，不再出现“客户未确认”或“双方就绪”。
- OpenAPI、状态约束、业务配置、seed、交互映射、验收和发布追踪已同步，不再保留可被误解为当前规则的旧双边合同。

## 验证证据

- RED：`npx vitest run tests/m19-us-03-service-state-sync.spec.ts` → 1 file / 3 failed。
- GREEN 聚焦：11 files / 86 tests passed。
- 发布追踪与 fixture：3 files / 78 tests passed；验收矩阵可重现生成 302 rows。
- 类型：API、Bot、Dashboard typecheck passed。
- 合同：OpenAPI route parity passed，159 operations。
- 质量：API/Dashboard lint 0 errors（38 条历史 warning，低于上限 39）；Bot lint passed；`git diff --check` passed。
- 全仓：`npm test` → 245 files / 1229 tests passed。

## 外部边界

`AT-STATE-003/004` 的真实 Guild 桌面/手机与客服登录态 UAT 继续由 `M19-US-05` 执行；本 Story 不伪称已获得外部签署。
