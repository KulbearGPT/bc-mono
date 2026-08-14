# M2-US-02 Evidence Summary

## Story

- Story：M2-US-02 自动派单候选与集中派单卡片
- 验收用例：AT-DSP-001; AT-DSP-002
- 范围：消费订单进入 `PENDING_DISPATCH` 后，由系统任务调用统一 API 创建派单轮次、候选快照、集中派单消息 Outbox 和 5 分钟超时 Job；Bot 渲染集中派单卡片并提供接单/暂不接单按钮。

## 实现文件

- `apps/api/src/dispatch.ts`
  - 新增 `dispatchOrder`、`expireDispatchAttempt`、`registerDispatchRoutes`。
  - 新增 `InMemoryDispatchStore`、`PostgresDispatchStore`、`InMemoryDispatchPlayerPool`、`PostgresDispatchPlayerPool`。
  - 创建 `dispatch_attempts`、`dispatch_candidates` 和 `outbox_events`，超时只结束当前轮次。
- `apps/api/src/security.ts`
  - 支持 `SYSTEM_JOB` actor source 以服务 token 调用统一 API。
  - 增加 `dispatch.execute` 与 `order.accept` 认证权限入口。
- `apps/api/src/server.ts`
  - `buildApiServer({ dispatch })` 注册 dispatch route。
- `apps/api/src/index.ts`
  - runtime 创建 `PostgresDispatchStore` 与 `PostgresDispatchPlayerPool` 并接入 API。
- `apps/api/package.json`
  - 暴露 `@blackcat/api/dispatch`。
- `.env.example`
  - 增加 prototype 阶段 `DISPATCH_CHANNEL_ID`。
- `apps/bot/src/service-center.ts`
  - 新增 `DispatchOfferSummary`、`buildDispatchOfferMessage`、`HttpBotApiClient.acceptOrder`、`HttpBotApiClient.declineOrderOffer`。
- `apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts`
  - 新增 Sapphire dispatch button handler，将接单和暂不接单动作转成统一 API 调用。
- `tests/m2-us-02-api.spec.ts`
  - dispatch domain/API/system-job 权限/runtime wiring 测试。
- `tests/m2-us-02-bot.spec.ts`
  - 集中派单卡片、Bot API client 和 Sapphire piece 测试。
- `tests/m2-us-02-db.spec.ts`
  - Postgres attempt/candidate/outbox/timeout 集成测试。

## RED / GREEN 记录

- RED：`tests/m2-us-02-api.spec.ts` 初始要求 `@blackcat/api/dispatch`、candidate snapshot、Outbox、SYSTEM_JOB route 和 runtime wiring，未实现时失败。
- RED：`tests/m2-us-02-bot.spec.ts` 初始要求 `buildDispatchOfferMessage`、Bot accept/decline client 和 `dispatch-buttons` piece，未实现时失败。
- RED：`tests/m2-us-02-db.spec.ts` 初始要求 `PostgresDispatchStore` 与 `PostgresDispatchPlayerPool` 写入实际 schema，未实现时失败。
- GREEN：完成最小实现后，目标测试、类型检查和全量测试通过。

## 验证命令

```bash
npx vitest run tests/m2-us-02-api.spec.ts tests/m2-us-02-bot.spec.ts
```

结果：2 files / 6 tests passed。

```bash
npx vitest run tests/m2-us-02-db.spec.ts
```

结果：1 file / 2 tests passed。

```bash
npx vitest run tests/m2-us-02-api.spec.ts -t "runtime API entrypoint wires Postgres dispatch"
```

结果：1 file / 1 selected test passed，3 skipped。

```bash
npx vitest run tests/m2-us-02-api.spec.ts tests/m2-us-02-bot.spec.ts tests/m2-us-02-db.spec.ts
```

结果：3 files / 9 tests passed。

```bash
npm run typecheck
```

结果：`tsc -b tsconfig.build.json` exit 0。

```bash
npm test
```

结果：28 files / 171 tests passed。

## 验收覆盖

- AT-DSP-001：派单候选继续复用 M2-US-01 的 ACTIVE + AVAILABLE + ONLINE + 标签匹配 + active user + 无 active order 规则，并在本 Story 中固化为 `dispatch_candidates` 快照。
- AT-DSP-002：`DISPATCH_TIMEOUT` Job 到期后只将当前 `dispatch_attempt` 标记为 `TIMED_OUT`，候选标记 `EXPIRED`，订单仍保持 `PENDING_DISPATCH`，不释放原资金预留，不自动扩圈。
- Outbox：创建 `DISPATCH_MESSAGE` 与 `DISPATCH_TIMEOUT` 两类 outbox rows，后续 worker 可按现有 OutboxRunner 机制投递。
- Discord 渲染：集中派单卡片只展示订单需求、语音频道和倒计时，不展示预计收益、用户余额或内部定价。

## 剩余风险

- Discord bot credential 暂未提供，真实集中派单频道发卡和按钮 E2E 未执行。
- `acceptOrder` 的原子唯一接单、频道授权和按钮失效属于 M2-US-03；本 Story 只放置 Bot client/按钮入口。
- `declineOrderOffer` 的 API 状态持久化将在 M2-US-03 和陪玩工作台 Story 中继续收敛；当前 Story 覆盖卡片入口和 outbox 派发基础。

## 2026-08-04 派单 embed 信息增强

- 实际 Worker Discord REST 投递从纯文本改为标准 embed，明确分区展示订单号、游戏、服务、区服、时长、语音频道、客户备注和接单截止。
- 截止时间使用 Discord `<t:...:F>` 与 `<t:...:R>`，同时展示陪玩本地时间和剩余时间，不再显示 ISO 原始字符串。
- 多项目需求的派单 payload 改为优先使用下单时固化的目录展示名，避免向陪玩展示内部 game/service/region code。
- 无合格候选时使用黄色只读状态 embed，更新复用消息时显式清空旧 content 和操作按钮。`allowed_mentions` 关闭自动 parse，备注不会触发意外提及。

### RED / GREEN 与回归

- RED：`npx vitest run tests/m5-us-02-worker-delivery.spec.ts` → 2 failed / 8 passed，证明旧投递仍为纯文本。
- GREEN：`npx vitest run tests/m2-us-02-api.spec.ts tests/m5-us-02-worker-delivery.spec.ts` → 2 files / 15 tests passed。
- 关联回归：`npx vitest run tests/m2-us-02-api.spec.ts tests/m2-us-02-bot.spec.ts tests/m2-us-02-db.spec.ts tests/m2-us-03-bot.spec.ts tests/m5-us-02-worker-delivery.spec.ts tests/m5-us-02-worker-runtime.spec.ts tests/m10-us-03-postgres.spec.ts` → 7 files / 36 tests passed。
- `npm run typecheck` → exit 0。
- `npm test` → build 通过，182 files / 901 tests passed。

### 未解决风险

- 尚未在真实 Guild 内复验 embed 的视觉密度、频道跳转和按钮交互；本次不将该外部 UAT 描述为已完成。

## 2026-08-04 集中频道操作收敛

- 集中陪玩频道是广播式抢单入口，现只显示“接单”，移除不必要的“无法接单”。未操作即不参与当前抢单，不要求每位候选陪玩在公共频道表态。
- `declineOrderOffer` 业务能力仍保留在本人私密陪玩工作台，用于明确忽略本人当前匹配；本次不改变 API 状态机。
- RED：`tests/m5-us-02-worker-delivery.spec.ts` 1 failed / 9 passed，证明 Worker 仍输出“无法接单”和 decline custom id。
- GREEN：派单关联 4 files / 20 tests 与 `npm run typecheck` 通过。
- 全仓门禁：`npm test` 的 build 通过，179/182 files、895/903 tests 通过；剩余 8 项失败均来自同一工作区中未提交的 M10 服务套餐价格/合同镜像改动（PostgreSQL 6 项、主规格镜像 2 项），与本次派单按钮修改无重叠文件。

## 2026-08-09 派单信息移除预计收益

- 公开数字 Reaction 报名卡、Worker 实际 Discord 派单 embed 和 Bot 私密派单卡均不再渲染预计收益或对应金额。
- 收益字段、内部计算和结算事实保持不变；本次只收窄派单阶段的用户可见信息。
- RED：3 files / 3 failed、14 passed，分别证明三条展示路径仍含预计收益。
- GREEN：`npm exec vitest run tests/m2-us-02-bot.spec.ts tests/m5-us-02-worker-delivery.spec.ts tests/m18-us-05-dispatch-trial-experience.spec.ts` → 3 files / 17 tests passed。
- 派单与报名关联回归：10 files / 87 tests passed；`npm run typecheck` 通过。
- 全仓门禁：`npm test` build 通过，247 files / 1236 tests passed。
