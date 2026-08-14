# M2-US-04 Evidence Summary

## Story

- Story：M2-US-04 双方准备、申请完成与用户确认
- 验收用例：AT-SVC-001; AT-SVC-002; AT-SVC-004; AT-PL-005; AT-RDY-003
- 范围：接单后双方分别确认就绪；只有两方都 READY 才进入 `IN_SERVICE`；陪玩申请完成后由用户确认完成；确认完成原子捕获订单预留并生成消费、陪玩收益和符合条件的 PENDING 返佣；完成确认超时只创建客服任务；旧单方 start 调用固定拒绝并审计。

## 实现文件

- `apps/api/src/service-lifecycle.ts`
  - 新增 `setOrderReadiness`、`requestOrderCompletion`、`confirmOrder`、`expireOrderCompletionConfirmation` 和 `rejectLegacyStartService` domain flow。
  - `InMemoryServiceLifecycleStore` 支持双方 readiness、服务开始、完成申请、确认完成、完成超时客服任务和返佣事实。
  - `PostgresServiceLifecycleStore` 使用事务锁定订单，写入 `order_events`、捕获 `fund_reservations`、创建 `external_transactions`、`consumption_entries`、`player_earnings`、`commissions` 和 `staff_tasks`。
  - API routes：`PUT /api/v1/orders/:orderId/readiness`、`POST /api/v1/orders/:orderId/request-completion`、`POST /api/v1/orders/:orderId/confirm`、`POST /api/v1/orders/:orderId/start`。
- `apps/api/src/security.ts`
  - 新增已认证 actor 权限码 `order.legacy_start.reject`，让旧 start 调用也经过统一审计层。
- `apps/bot/src/service-center.ts`
  - 新增服务生命周期 custom_id 解析和 `handleServiceLifecycleAction`。
  - Bot readiness、申请完成、确认完成均调用统一 API，不在 Bot 内实现业务状态机。
- `apps/bot/src/pieces/interaction-handlers/service-center-buttons.ts`
  - Sapphire Button Handler 接入 `bc:service:*` 面板动作。
- `database/prisma/migrations/000001_p0_baseline/migration.sql`
  - 修正 referral attribution guard 中 PL/pgSQL 变量与列同名导致的歧义。
- `tests/m2-us-04-api.spec.ts`
  - 覆盖参与者归属、拒绝非接单陪玩、runtime route wiring、完成申请、确认完成、返佣、完成超时和旧 start 拒绝审计。
- `tests/m2-us-04-bot.spec.ts`
  - 覆盖生命周期面板渲染、HTTP client 调用统一 API、custom_id 路由和 service button handler。
- `tests/m2-us-04-db.spec.ts`
  - 覆盖 Postgres readiness 事务、完成申请、确认完成原子记账、2% 返佣、完成超时唯一客服任务。

## RED / GREEN 记录

- RED：`expireOrderCompletionConfirmation` 和 `rejectLegacyStartService` 未实现时，API/DB 测试失败。
- RED：`bc:service:*` custom_id 解析和 `handleServiceLifecycleAction` 未实现时，Bot 测试失败。
- RED：有效 2% `PLAYER_LIFETIME` 归因存在时，确认完成未生成 `commissions`，API/DB 测试失败。
- GREEN：补齐 API、Postgres transaction、Bot handler、返佣事务和旧 start 拒绝后，M2-US-04 目标测试与类型检查通过。
- 真实 Guild 回归：接单后 10 分钟 readiness timeout 将订单版本从 6 推进到 7，客户与陪玩旧面板均返回 `Order version is stale`。Bot readiness 动作现于 `CONFLICT` 时读取最新订单；仍为 `ACCEPTED` 时使用新幂等键和最新版本安全重试一次，状态已变化时只刷新面板。新增回归后 `tests/m2-us-04-bot.spec.ts` 11/11、typecheck 与 build 通过。
- 真实 Guild 完成回归：陪玩申请完成已将 `P-374DF0C3` 推进至 `PENDING_CONFIRMATION` v10，但事务未投递 `PANEL_SYNC`，客户面板没有变化；同时 Worker PATCH 未清空旧 embed，导致旧“服务中”卡片继续残留。现将 completion panel sync 与状态迁移置于同一事务，并显式发送 `embeds: []`。恢复任务 `e19cd847-7b51-4766-acad-637ccfde3dda` 完成后，Discord REST 实测原消息状态为 `PENDING_CONFIRMATION`、embed 数为 0，且包含 v10 的“确认完成”和“联系客服”按钮。
- 客户确认完成回归：订单已成功结算为 `COMPLETED` v11，但确认事务未投递最终 `PANEL_SYNC`，Discord 仍引用旧下单卡片。现将 `ORDER_COMPLETED_CHANNEL_SYNC` 与确认结算置于同一事务。恢复任务 `33f4021f-f82a-4f26-9352-e9a99f41593f` 完成后，Discord REST 实测原消息为 `COMPLETED`、embed 数为 0，仅保留 v11“联系客服”；目标回归 3 files / 31 tests、typecheck 与 build 通过。
- 越权按钮反馈回归：共享订单面板会向频道内双方显示当前状态动作，业务 API 仍以可信 Actor Context 拒绝错误角色。Bot 现将 `PERMISSION_DENIED` 按动作转译为仅点击者可见的说明：陪玩点击“确认完成”会被告知该按钮仅供本单客人操作，客人点击“申请完成”会被告知该按钮仅供本单陪玩操作；两者均不修改订单或资金。RED 2 failed / 11 passed；GREEN 目标 2 files / 23 tests及 typecheck 通过。

## 验证命令

```bash
npx vitest run tests/m2-us-04-api.spec.ts tests/m2-us-04-bot.spec.ts tests/m2-us-04-db.spec.ts
```

结果：3 files / 18 tests passed。

```bash
npm run typecheck
```

结果：`tsc -b tsconfig.build.json` exit 0。

```bash
npm run db:validate
```

结果：Prisma schema valid。

```bash
npm run db:verify:migration
```

结果：baseline migration apply ok；关键 guard checks passed；`table_count=47`、`constraint_count=3`、`trigger_count=7`。

```bash
npm test
```

结果：34 files / 198 tests passed。

## 验收覆盖

- AT-SVC-001 / AT-PL-005 / AT-RDY-003：只有订单客户和当前接单陪玩能提交各自 readiness；单方 READY 不开始服务；第二方 READY 在同一事务中写入 `SERVICE_STARTED` event 并进入 `IN_SERVICE`。
- AT-SVC-002：用户确认完成后，订单进入 `COMPLETED`，订单预留进入 `CAPTURED`，生成一条订单消费、一条 PENDING 陪玩收益；存在有效 2% `PLAYER_LIFETIME` 归因时生成一条 PENDING 返佣，金额按订单消费快照 `12000 * 200 / 10000 = 240`。
- AT-SVC-002 越权分支：陪玩无法代替客人确认完成，客人无法代替陪玩申请完成；API 权限拒绝保持为最终事实，Bot 返回明确私密提示。
- AT-SVC-004：完成确认超过 `confirmation_due_at` 后执行 timeout flow，只创建一条 `COMPLETION_REVIEW` 客服任务；订单保持 `PENDING_CONFIRMATION`，不生成消费、收益或返佣。
- 旧 start 调用：`POST /api/v1/orders/:orderId/start` 固定返回 403，并通过统一 secure write route 写失败审计。
- Bot 面板动作：`bc:service:ready`、`bc:service:request-completion`、`bc:service:confirm` 解析后调用统一 API；Bot 不保存或重复实现状态机。

## 剩余风险

- 真实测试 Guild 已完成双方就绪、陪玩申请完成、客户确认完成、最终扣款和结单面板同步 E2E。
- 本 Story 只实现完成确认超时创建客服任务；取消、迟到、缺席、中断、客服结案和自动化暂停/恢复继续由 M2-US-05、M2-US-09、M2-US-11 覆盖。
- 返佣主记录在完成事务中生成；更完整的 PROMOTER_FIRST_PURCHASE 一次性生命周期、PLAYER_LIFETIME 长期规则管理、退款冲正和保密查询继续由 M3-US-07 及相关 Story 覆盖。
