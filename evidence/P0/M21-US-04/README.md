# M21-US-04 五星好评聚合播报完成证据

日期：2026-08-13

分支：`codex/order-review`

Story：`M21-US-04`（完成；完整老板端移动交互与外部签署属于 `M21-US-05`）

验收：`AT-REVIEW-003`、`AT-REVIEW-004`

## 已实现范围

- 评价中心只在存在已保存五星且本单尚未发布时显示“预览可公开的五星好评”。预览为 ephemeral，只列当前五星对象和安全订单公开编号。
- “同意公开五星好评”使用固定确认字面值和 Discord interaction 派生幂等键调用统一 API；“仅内部保存”、关闭预览及未点击确认均不创建公开事实。
- `REVIEW_BROADCAST` Worker 只消费 API 创建的不可变发布快照。Worker 边界要求快照和每个目标均为精确白名单字段，目标分数必须为五星；出现留言、低分或额外私密字段时在调用 Discord 前失败关闭。
- 每单聚合为一张 Embed，只包含订单公开编号、服务展示名、完成时间和五星对象安全展示名；不包含客户身份、金额、钱包、订单备注、频道、留言、低分或非五星对象。
- 独立频道字段为 `review_broadcast_channel_id`。统一 Bot 配置 API、Discord `/bot-config` 和 Dashboard 都可选择并发送频道验证消息；Worker 按订单关联 Guild 读取配置，不跨 Guild，也不回退到订单频道或礼物播报频道。
- Discord REST 发送使用发布 ID 派生的稳定 nonce、`enforce_nonce` 和消息历史对账。Outbox 重试不会重复发卡；已记录的 Discord 消息被删除时，Worker 以旧消息 ID 派生恢复 nonce，重建单张卡并回写最新消息 ID。
- 评价公开只追加发布与 Outbox 状态，不改变订单、预留、钱包、消费、收益、返佣、派单、准入、权限或处罚事实。

## TDD 证据

### RED：缺失 Worker 模块

```text
npx vitest run tests/m21-us-04-five-star-broadcast.spec.ts
```

初始结果：suite 加载失败、`0 tests`；缺失 `@blackcat/api/order-review-broadcast`。

### RED：好评频道不可配置

在 Worker 能读取 `review_broadcast_channel_id` 后追加端到端配置合同门禁。专项结果为 `1 failed / 5 passed`：Bot 配置 API、Discord 配置流程、Dashboard 与 OpenAPI 尚未暴露该字段。补齐统一配置合同与运行时后转绿。

### RED：缺少真实 Guild 恢复探针

先在专项测试中要求存在带显式破坏性确认、自清理临时频道、真实广播 handler/adapter 和 `AT-REVIEW-003` 输出的 UAT 脚本。初始结果为 `1 failed / 6 passed`，因为 `scripts/uat/m21-review-broadcast-uat.ts` 尚不存在；补齐探针后转绿。

### RED：删卡后的旧 nonce 无法恢复

首次真实 Guild 探针在删除展示卡并重试时收到 Discord `HTTP 404 / Unknown Message (10008)`。追加 adapter 测试后，旧实现因恢复 nonce 与初始 nonce 相同而失败。修复后，存在旧 `broadcastMessageId` 时先 PATCH；收到 404 后以发布幂等键与旧消息 ID 派生新的稳定恢复 nonce，先查历史再创建。测试同时覆盖“Discord 已创建恢复卡但数据库回写失败”的再次重放，保证不会出现第三张卡。

UAT 脚本本身改为每次使用新的 aggregate UUID，避免 Discord 在临时频道已删除后仍于短时间内保留作者 nonce，确保探针可安全重复执行。

### GREEN：M21 全链路

```text
npx vitest run tests/m21-us-01-review-contract.spec.ts tests/m21-us-02-order-experience-reviews.spec.ts tests/m21-us-02-postgres.spec.ts tests/m21-us-03-bot-review-center.spec.ts tests/m21-us-04-five-star-broadcast.spec.ts
```

结果：`5 files / 28 tests passed`。

专项覆盖：明确同意、取消零写入、混合评价只播五星、私密字段失败关闭、PostgreSQL 同 Guild 配置、发布状态回写、Outbox 重试、缺失消息恢复、真实 Discord REST adapter 稳定 nonce 对账和 DTO 失败关闭。

### 真实 Guild 自清理 UAT

```text
npx dotenv -e ../referenced-chatgpt-conversation-this-is-untrusted/.env -- \
  env M21_UAT_CONFIRM=DELETE_TEMP_REVIEW_CHANNEL \
  npx tsx scripts/uat/m21-review-broadcast-uat.ts
```

最终结果：`AT-REVIEW-003 PASS`。2026-08-13T07:23:37Z 在测试 Guild 验证：安全快照成功渲染、含私密字段的快照在 Discord 调用前被拒绝、同一 Job 重放复用首条消息、删除首条消息后恢复为新消息、频道内最终恰好一张展示卡、业务 API/数据库写入为 0。脚本退出前成功删除临时频道；输出中的临时频道 ID 已失效。

关键观测：`firstMessageId = replayMessageId`，`recoveredMessageId != firstMessageId`，`visibleReviewMessageCount = 1`，`temporaryResourcesDeleted = true`。

### 配置与关联 Worker 回归

```text
npx vitest run tests/m21-us-04-five-star-broadcast.spec.ts tests/m21-us-02-postgres.spec.ts tests/m15-us-04-bot-config-dashboard.spec.ts tests/m4-us-10-api.spec.ts tests/m4-us-10-bot.spec.ts
```

结果：`5 files / 33 tests passed`。

```text
npx vitest run tests/m0-us-05.spec.ts tests/m5-us-02-worker-runtime.spec.ts tests/m5-us-02-worker-delivery.spec.ts tests/m6-us-03-worker.spec.ts tests/m7-us-03-audit.spec.ts tests/m19-us-05-projection-observability.spec.ts tests/m21-us-03-bot-review-center.spec.ts tests/m21-us-04-five-star-broadcast.spec.ts
```

结果：`8 files / 61 tests passed`。

### 验收追踪与发布门禁回归

```text
npx vitest run tests/m5-us-01-traceability.spec.ts tests/m5-us-03-release-gate.spec.ts tests/m7-us-07-retirement.spec.ts tests/m21-us-01-review-contract.spec.ts tests/m21-us-04-five-star-broadcast.spec.ts
```

结果：`5 files / 87 tests passed`。312 条验收矩阵已重新生成；外部验收总数从 85 更新为 87，并在真实 UAT 清单中各加入一次 `AT-REVIEW-002` 与 `AT-REVIEW-003`；通用写审计清单包含 107 个写路由和 13 个生产 Worker handler。

### 全仓基线

```text
npm test
```

结果：构建通过；Vitest `263 files passed / 15 files failed`、`1377 tests passed / 21 tests failed`。本次引入的 M21、验收矩阵、UAT 清单、Prisma 镜像、Worker 审计计数和 HTTP client 体量失败均已清零。剩余 21 项来自本 Story 未触及的既有基线：`docs/outputs` TODO 在 Dashboard module-boundaries 一行上的镜像漂移触发 11 项合同失败，旧 M2 订单测试 fixture 的 Guild 作用域触发 9 项失败，以及 `service-lifecycle-message.ts` 既有函数复杂度触发 1 项结构失败。本 Story 不擅自改写这些无关范围，也不把全仓门禁描述为通过。

## 静态与合同门禁

```text
npm run build
npm run typecheck --workspace @blackcat/api
npm run typecheck --workspace @blackcat/bot
npm run typecheck --workspace @blackcat/dashboard
npm run lint:api-dashboard
npm run lint:bot
npm run quality:routes
npm run db:validate
npm run pieces --workspace @blackcat/bot
git diff --name-only --diff-filter=ACM -- apps/bot/src | xargs npx prettier --check
git diff --check
```

结果：构建及三个 workspace typecheck 通过；API/Dashboard ESLint `0 errors / 28 warnings`，低于 39 门禁；Bot ESLint `0 warnings`；本 Story 修改的 Bot 文件 Prettier 检查通过；168 条生产路由合同一致；Prisma 合同有效；Sapphire 发现 24 个 Pieces；空白检查通过。

## 实际修改范围

- API：五星播报 PostgreSQL Store、Worker handler、JobType/生产 handler 注册、Discord REST 投递适配器和模块导出。
- Bot：公开预览/确认/仅内部保存路由、API client、DTO 隐私校验和评价中心消息动作。
- 配置：统一 API、Discord `/bot-config`、Dashboard、OpenAPI、主规格和评价交互设计增加 `review_broadcast_channel_id`。
- 追踪：验收矩阵、真实 UAT 清单、通用 Worker 审计计数和 M21 证据索引同步；运行时 Prisma 注释与已冻结数据合同恢复一致。
- 测试：五星隐私/恢复专项及 PostgreSQL 发布/同 Guild 配置集成断言；评价 HTTP client 单独拆分以保持 Bot 模块体量门禁。
- UAT：新增显式确认、合成数据、零业务写入且始终清理临时频道的真实 Guild 播报探针。
- 未修改礼物业务源码、礼物资金状态机或礼物交互。

## Story 边界与剩余外部验收

`M21-US-04` 的 Worker 实服投递、重放、删卡恢复与清理门禁已完成。以下端到端人工项目不由合成 Worker 探针替代，明确留在已解锁的 `M21-US-05`：老板手机端对多陪玩给出混合分数和可选留言、关闭公开预览验证零公开、再次明确同意后的最终视觉/点击体验，以及运营对跨 Guild/无权限配置失败关闭和完整回滚方案的外部签署。
