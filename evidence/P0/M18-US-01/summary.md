# M18-US-01 证据摘要

## 结果

- 状态：DONE（仅合同 Story；不声称 Bot 运行时体验已改造）
- 验收：AT-EXP-001、AT-EXP-002、AT-EXP-003、AT-EXP-004、AT-EXP-005
- API / 数据合同：无变化

## 冻结内容

- 用户可见禁止“选秀”，统一按语境使用“试音”“试音匹配”“试音房”“报名池”“确认陪玩”和“本轮未匹配”；内部 `SelectionPool`、operationId、枚举与源码技术名称可保留。
- 视觉密度目标已按 2026-08-09 决策从参考店铺 60–70% 提升为 80–90%（默认约 85%）；五档分为公共欢迎 90、派单/里程碑 85、订单主面板 70–80、短暂私密反馈 45–55、资金/权限/错误 20–35。
- Embed 阅读顺序为“标题 → 情绪化引导 → 核心事实 → 老板需求 → 当前进度 → 下一步 → 页脚”。
- 关键节点使用“横幅 → Embed → 按钮或 Reaction”；高频报名、撤回、就绪和状态推进原位编辑并沿用既有幂等边界。
- 横幅必须为原创黑猫主题；不复制竞品素材、游戏官方 Logo 或角色立绘。

## RED

```text
npx vitest run tests/m18-us-01-discord-experience-contract.spec.ts
Test Files  1 failed (1)
Tests       3 failed | 1 passed (4)
```

失败原因是主规格尚无 M18、backlog 尚无 EP-M18/M18-US-01–08、交互与验收 ID 尚未建立。

## GREEN

```text
npx vitest run tests/m18-us-01-discord-experience-contract.spec.ts
Test Files  1 passed (1)
Tests       4 passed (4)

npm run build --silent
exit 0
```

合同测试同时校验主规格、交互映射、backlog、验收与 TODO 的 `outputs/` / `docs/` 镜像一致。

## 2026-08-09 密度目标上调

- RED：更新后的合同测试 1 file / 2 failed、2 passed，证明主规格与 backlog 仍停留在 60–70%。
- GREEN：密度合同与下游 Story 验收口径已同步为 80–90%，高风险消息继续保持 20–35，不因品牌升级弱化金额、权限、写入确定性或 request_id。
