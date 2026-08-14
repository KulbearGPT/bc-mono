# M2-US-03 Evidence Summary

## Story

- Story：M2-US-03 并发唯一接单与订单频道入场
- 验收用例：AT-DSP-003; AT-DSP-004; AT-WRK-003
- 范围：陪玩从集中派单卡片接单或暂不接单；统一 API 原子写入订单、dispatch attempt、candidate 状态和 OrderAccepted outbox；Bot 生成接单后频道权限计划并让派单按钮失效。

## 实现文件

- `apps/api/src/dispatch.ts`
  - 新增 `acceptOrder` 与 `declineOrderOffer` domain function。
  - `InMemoryDispatchStore` 支持接单、拒单、candidate `ACCEPTED` / `LOST_RACE` / `DECLINED` 状态迁移和 `PANEL_SYNC` outbox。
  - `PostgresDispatchStore.commitAcceptance` 使用事务锁定 active dispatch attempt，条件更新候选、订单和 attempt，插入 `PANEL_SYNC` outbox。
  - `PostgresDispatchStore.declineCandidate` 使用事务只标记当前 active attempt 下的本人候选为 `DECLINED`。
  - API routes 新增 `POST /api/v1/orders/:orderId/accept` 与 `POST /api/v1/orders/:orderId/decline`，从 Discord Actor Context 推导陪玩身份。
- `apps/bot/src/service-center.ts`
  - 新增 `buildAcceptedPlayerChannelPermissionPlan`，只向接单陪玩追加私密订单频道权限。
  - 新增 `buildAcceptedDispatchMessage`，将集中派单卡片改为已接单状态并禁用按钮。
  - `buildDispatchIneligibleReply` 只展示统一 API 工作台返回的未通过资格项，并转换为可操作的中文提示。
- `apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts`
  - `PLAYER_NOT_ELIGIBLE` 后读取本人工作台投影，说明在线状态、接单开关、认证项目或活跃订单原因；读取失败时使用安全兜底提示。
- `tests/m2-us-03-api.spec.ts`
  - 覆盖 in-memory domain 接单、race loser、active-order 不可接单、拒单和 API route Actor 派生。
- `tests/m2-us-03-bot.spec.ts`
  - 覆盖频道权限计划和接单后派单卡片失效。
- `tests/m2-us-03-db.spec.ts`
  - 覆盖 Postgres 并发唯一接单、active-player-slot 约束、OrderAccepted outbox 和拒单事务。

## RED / GREEN 记录

- RED：`tests/m2-us-03-api.spec.ts` 初始要求 `acceptOrder`、`declineOrderOffer` 和 `/accept` route，未实现时失败。
- RED：`tests/m2-us-03-bot.spec.ts` 初始要求接单后频道权限计划和派单卡片失效 renderer，未实现时失败。
- RED：`tests/m2-us-03-db.spec.ts` 初始要求 Postgres 并发唯一接单和拒单事务，`Postgres acceptance/decline is not implemented yet` 时失败。
- RED（2026-08-04）：新增资格失败反馈测试，`buildDispatchIneligibleReply is not a function`，1 failed / 2 passed。
- GREEN：补齐 in-memory、API route、Bot renderer 和 Postgres transaction 后，目标测试、类型检查和全量测试通过。
- GREEN（2026-08-04）：`npx vitest run tests/m2-us-03-bot.spec.ts tests/m9-us-13-auto-dispatch.spec.ts`，2 files / 8 tests passed；`npm run typecheck -w @blackcat/bot` exit 0。

## 验证命令

```bash
npx vitest run tests/m2-us-03-api.spec.ts tests/m2-us-03-bot.spec.ts
```

结果：2 files / 6 tests passed。

```bash
npx vitest run tests/m2-us-03-db.spec.ts
```

结果：1 file / 3 tests passed。

```bash
npx vitest run tests/m2-us-03-api.spec.ts tests/m2-us-03-bot.spec.ts tests/m2-us-03-db.spec.ts
```

结果：3 files / 9 tests passed。

```bash
npm run typecheck
```

结果：`tsc -b tsconfig.build.json` exit 0。

```bash
npm test
```

结果：31 files / 180 tests passed。

## 验收覆盖

- AT-DSP-003：两个陪玩并发接同一 active attempt 时，Postgres 事务锁定 attempt，只允许一个订单进入 `ACCEPTED`，写入 `player_id` / `active_player_slot_id`，失败方返回冲突；未接中的候选标记 `LOST_RACE`。
- AT-DSP-004：接单成功后产生 `PANEL_SYNC` outbox，payload 包含订单频道、面板消息和接单陪玩 Discord 用户；Bot 侧生成频道权限追加计划并将派单卡片按钮置为 disabled。
- 活跃订单约束：陪玩在收到派单后如果已经有 `ACCEPTED` / `IN_SERVICE` / `PENDING_CONFIRMATION` 活跃单，`acceptOrder` 返回 `PLAYER_NOT_ELIGIBLE`，订单保持 `PENDING_DISPATCH`。
- AT-WRK-003：Bot 不再把 `PLAYER_NOT_ELIGIBLE` 压缩成“接单失败”；它读取服务端工作台 eligibility checks，并私密说明本人当前未通过项和返回工作台的下一步。
- 拒单：`declineOrderOffer` 只更新本人候选为 `DECLINED`，不改变订单状态、不影响其他候选。

## 剩余风险

- Discord bot credential 暂未提供，真实测试 Guild 中“接单按钮 → 修改私密频道权限 → 修改集中派单消息”的 E2E 未执行。
- 当前 Story 不实现双方就绪、开始服务、完成确认或取消争议；这些继续由 M2-US-04 和 M2-US-05 覆盖。
