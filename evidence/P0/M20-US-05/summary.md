# M20-US-05 Discord Bot 审查修复合同与计划证据

## Story 与验收

- Story：`M20-US-05`
- 验收：`AT-MULTI-005;AT-BOT-REV-005`
- 范围：只冻结修复计划和现行礼物接收人合同，不声称运行时代码已经修复。

## RED

命令：

```text
npx vitest run tests/m20-us-05-discord-bot-remediation-contract.spec.ts
```

结果：`1 file / 3 tests failed`。失败分别证明修复计划/镜像缺失、现行合同仍含单一 `order.playerId` 语义，以及发布镜像不存在。

## GREEN

命令：

```text
npx vitest run tests/m20-us-05-discord-bot-remediation-contract.spec.ts tests/m10-us-01-contract.spec.ts tests/m20-us-01-discord-action-contract.spec.ts
```

结果：`3 files / 9 tests passed`。

附加检查：

```text
git diff --check
```

结果：通过，无空白错误。

## 合同决定

- 客户只能选择订单内有效陪玩明细 `participantIds`。
- API 经订单明细推导真实 receiver；Bot、Dashboard 和请求体不接受任意 `receiverId`。
- 任一参与明细失效时整批零写入。
- M6 历史单陪玩描述保留为历史事实，但明确标注已被 `M10-US-05` 取代。

## 修改文件

- `AGENTS.md`
- `outputs/Discord陪玩业务Bot最小原型设计开发文档.html` 及 `docs` 镜像
- `outputs/docs/P0开发交付包/01-UIUX/交互映射.csv`
- `outputs/docs/P0开发交付包/06-开发计划/backlog.csv`
- `outputs/docs/P0开发交付包/06-开发计划/Discord-Bot代码审查修复计划.md`
- `outputs/docs/P0开发交付包/07-验收测试/acceptance-cases.csv`
- `outputs/docs/Codex-P0开发TODO.md`
- 当前 UAT/演示与历史 Pilot 说明
- `tests/m20-us-05-discord-bot-remediation-contract.spec.ts`

## 剩余风险

运行时问题由 `M20-US-06` 至 `M20-US-13` 顺序处理。在这些 Story 完成前，不得把本合同 Story 描述为 Bot 已可发布。
