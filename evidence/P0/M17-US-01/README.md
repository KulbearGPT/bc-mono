# M17-US-01：Bot 审查整改合同与 RED 基线

## 范围

- 验收：`AT-BOT-REV-001` 至 `AT-BOT-REV-005`。
- 交互：`INT-B-M17-001`、`INT-B-M17-002`。
- 冻结边界：本 Epic 不改变订单状态机、资金语义、权限矩阵或统一 API 业务规则。
- 本 Story 只建立合同、Backlog、验收、TODO 与自动化合同门禁，不声明运行时整改完成。

## RED

```text
./node_modules/.bin/vitest run tests/m17-us-01-bot-review-contract.spec.ts
Test Files  1 failed (1)
Tests       3 failed (3)
```

失败原因：主规格、Backlog、交互映射和验收合同中尚不存在 M17 的范围、Story 和验收标识。

## GREEN

```text
./node_modules/.bin/vitest run tests/m17-us-01-bot-review-contract.spec.ts
Test Files  1 passed (1)
Tests       3 passed (3)
```

## 修改文件

- `outputs/Discord陪玩业务Bot最小原型设计开发文档.html` 及 `docs/` 镜像。
- `outputs/P0开发交付包/01-UIUX/交互映射.csv` 及 `docs/` 镜像。
- `outputs/P0开发交付包/06-开发计划/backlog.csv` 及 `docs/` 镜像。
- `outputs/P0开发交付包/07-验收测试/acceptance-cases.csv` 及 `docs/` 镜像。
- `outputs/Codex-P0开发TODO.md` 及 `docs/` 镜像。
- `tests/m17-us-01-bot-review-contract.spec.ts`。

## 剩余门禁

运行时实现、Bot 工程门禁与真实 Guild 验收分别由 M17-US-02 至 M17-US-09 完成；在对应证据就绪前不得将其描述为完成。
