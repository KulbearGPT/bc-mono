# M18-US-07 证据摘要

## 结果

- 状态：DONE（本地运行时与自动化）；真实 Guild 三角色/桌面手机 UAT 归 M18-US-08
- 验收：AT-EXP-002、AT-EXP-004、AT-EXP-005
- 数据迁移：无
- 状态与资金边界：Bot 只展示统一 API 返回的订单、预留与礼物事实，不推导取消、捕获、释放、退款或权限结果

## 实现

- 礼物最终确认采用高风险低密度卡，明确“确认后将预留”与“尚未预留或扣除”；余额过期和不足都说明请求尚未创建、资金未改变。
- 礼物请求成功采用私密温暖反馈，明确预留已建立但尚未正式扣除，避免把 `PENDING_REVIEW` 冒充审批通过、资金捕获或送达成功。
- 礼物批准后的公开庆祝继续使用业务配置快照与既有幂等 Outbox；拒绝仍释放预留且不产生成功广播，未在 Bot 新建第二套审批或通知业务规则。
- 取消预览按“资金影响 → 处理方式 → 当前进度 → 下一步”分组，并明确预览本身没有取消订单或改变资金。
- 修复一项错误终态表达：过去只要取消结果没有客服任务，即使 API 返回 `IN_SERVICE` 等非取消状态也可能显示“订单已取消”；现在只有状态严格等于 `CANCELLED` 才显示取消终态并允许后续流单图，其余状态统一转为客服处理或待核对。
- 客服评分和低分原因加入更温暖但克制的反馈，明确评价不会影响订单扣款或任何陪玩收益。
- 标准错误统一为“原因 → 下一步 → 写入结果 → request_id”；被 API 拒绝与 5xx 未取得可信结果保持不同确定性，不把未知写入描述为未生效。

## RED

```text
npm exec vitest run tests/m18-us-07-support-risk-experience.spec.ts
Test Files  1 failed (1)
Tests       5 failed (5)
原因：旧礼物、取消、评分与错误表面缺少统一密度和字段层级；非 CANCELLED 取消结果还可能错误显示终态。
```

## GREEN

```text
npm exec vitest run \
  tests/m18-us-07-support-risk-experience.spec.ts \
  tests/m2-us-05-bot.spec.ts \
  tests/m2-us-10-bot.spec.ts \
  tests/m6-us-06-bot.spec.ts \
  tests/m7-us-06-bot.spec.ts \
  tests/m8-us-03-bot-display.spec.ts \
  tests/m12-us-04-bot.spec.ts \
  tests/m17-us-10-bot-error-messages.spec.ts \
  tests/m11-us-06-selection-reactions.spec.ts \
  tests/m3-us-02-api.spec.ts \
  tests/m3-us-03-worker.spec.ts \
  -- --config vitest.config.ts
Test Files  11 passed (11)
Tests       64 passed (64)

npm run quality:bot
lint        0 warnings / 0 errors
format      passed
typecheck   passed
build       passed
pieces      22 discovered
Bot tests   56 files / 328 tests passed
```

## 修改文件

- `apps/bot/src/gifts.ts`
- `apps/bot/src/service-center.ts`
- `apps/bot/src/user-facing-error.ts`
- `tests/m18-us-07-support-risk-experience.spec.ts`
- `tests/m2-us-05-bot.spec.ts`
- `tests/m2-us-10-bot.spec.ts`
- `tests/m6-us-06-bot.spec.ts`
- `tests/m7-us-06-bot.spec.ts`
- `tests/m8-us-03-bot-display.spec.ts`
- `tests/m12-us-04-bot.spec.ts`
- `outputs/P0开发交付包/06-开发计划/backlog.csv`
- `docs/P0开发交付包/06-开发计划/backlog.csv`
- `outputs/Codex-P0开发TODO.md`
- `docs/Codex-P0开发TODO.md`

## 剩余风险

- 礼物批准/拒绝的业务写入和公开广播仍以 API、Worker 与业务配置为事实来源；本 Story 没有新增 Bot 端审批规则或在拒绝路径发送情绪化成功消息。
- Discord 手机端字段折行、危险按钮辨识、取消图裁切和三角色对写入确定性的理解尚未在真实 Guild 具名签署，不能据此声称发布完成。
