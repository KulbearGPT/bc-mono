# M18-US-04 证据摘要

## 结果

- 状态：DONE（本地运行时与自动化）；真实 Guild 三角色/桌面手机 UAT 归 M18-US-08
- 验收：AT-EXP-002、AT-EXP-003、AT-EXP-005
- API / 数据合同：无变化

## 实现

- 通用订单卡改为 `PRIVATE_ORDER=58`，依次展示服务内容、订单金额、独立老板需求、当前进度和唯一下一步。
- 提交后卡片将订单状态与资金状态分区；继续明确“只是预留、还没有正式消费”，不在 Bot 中计算可用余额。
- 报名进行中以 Discord `<@user_id>` 实时展示陪玩，只保留一个主操作“终止招募”；招募终止后进入“试音匹配”。
- 报名选择与最终确认卡同步使用分区层级，用户可见不再使用“候选池/候选名单”。
- 提交后 renderer 从兼容 facade 抽离，`service-center.ts` 从 2502 行降至 2439 行，继续通过 M17 `<2500` 门禁。

## RED

```text
npm exec vitest run tests/m18-us-04-order-panel-experience.spec.ts
Test Files  1 failed (1)
Tests       4 failed (4)
原因：旧订单卡没有 fields/density，报名终止后仍使用候选措辞。
```

## GREEN

```text
npm exec vitest run \
  tests/m18-us-04-order-panel-experience.spec.ts \
  tests/m11-us-03-selection-discord.spec.ts \
  tests/m11-us-05-manual-recruitment.spec.ts
Test Files  3 passed (3)
Tests       28 passed (28)

npm run quality:bot
lint        0 warnings / 0 errors
format      passed
typecheck   passed
build       passed
pieces      22 discovered
Bot tests   54 files / 315 tests passed
```

## 剩余外部门禁

AT-EXP-003 的真实 Discord 桌面/手机扫读性、mention 呈现、按钮换行和三角色签署统一在 M18-US-08 执行；本 Story 未伪造该证据。
