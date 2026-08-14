# M2-US-07 Evidence: 用户侧匹配进度透明

## Scope

- Story：M2-US-07 用户侧匹配进度透明
- 验收用例：AT-MAT-001、AT-DSP-004
- 前置依赖：M2-US-02、M2-US-03

## Implemented

- `getOrder` 增加只读 `matching` 投影：`stage`、`notifiedCandidateCount`、`timeoutAt`、`nextStep` 和接单后的 `playerSummary`。
- PostgreSQL 投影只聚合最新派单轮次和候选数量；用户响应不包含候选 ID、候选名单、排序分或筛选细节。
- 待派单无有效轮次时显示 `SEARCHING`，有效轮次显示 `WAITING_FOR_ACCEPTANCE`，超时显示 `TIMED_OUT` 并提示继续等待、取消或联系客服。
- 接单后只显示最终陪玩 ID/展示名和 `CONFIRM_READINESS` 下一步。
- Discord 订单面板在 `PENDING_DISPATCH`/`ACCEPTED` 状态自动切换到匹配进度视图，不再显示草稿编辑控件。

## Verification

- RED：`getOrder` 未返回 matching；`buildMatchingProgressMessage` 不存在；普通订单面板仍显示草稿 Select。
- GREEN：`npx vitest run tests/m2-us-07-api.spec.ts tests/m2-us-07-bot.spec.ts tests/m2-us-07-db.spec.ts`，3 files / 7 tests passed。
- `npm run typecheck`：exit 0。
- `npm test`：42 files / 241 tests passed。

## Residual Risk

- Discord credential 暂未提供，测试 Guild 中派单进度消息更新和接单后面板切换 E2E 未执行。
- P0 不展示候选名单、排序分或复杂推荐理由。
