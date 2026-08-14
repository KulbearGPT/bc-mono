# M16-US-01 审查整改合同与 RED 基线

## 范围

- 验收：`AT-REV-001`、`AT-REV-002`。
- 冻结除充值付款事实外的 CAT 展示、陪玩结算 CAT/USD 双展示、钱包流水 `{ items, nextCursor }` envelope，以及客服备注/升级路由 OpenAPI 合同。
- 把代码审查后续运行时修复分为 `M16-US-02`–`M16-US-04`。本 Story 不声称任何运行时修复已交付。

## RED

```text
npx vitest run tests/m16-us-01-review-remediation-contract.spec.ts
Test Files  1 failed (1)
Tests       3 failed | 1 passed (4)
```

失败原因为 M16 币种边界、两条客服写路由 OpenAPI 合同和 M16 backlog 尚未存在。

## GREEN 与合同回归

```text
npx vitest run tests/m16-us-01-review-remediation-contract.spec.ts
Test Files  1 passed (1)
Tests       4 passed (4)

npx vitest run tests/m16-us-01-review-remediation-contract.spec.ts tests/m15-us-01-dashboard-support-parity-contract.spec.ts tests/m9-us-01-contract.spec.ts tests/m8-us-01-contract.spec.ts
Test Files  4 passed (4)
Tests       13 passed (13)
```

额外门禁：

- Ruby Psych 成功解析两份 OpenAPI YAML。
- 交互映射 `147 x 14`、backlog `134 x 22`、验收 `282 x 11` 列宽一致。
- OpenAPI、交互映射、backlog、验收、TODO 与主规格的 `outputs/` / `docs/` 镜像逐字节一致。
- `git diff --check` 通过。

## 修改文件

- `AGENTS.md`
- `outputs/Discord陪玩业务Bot最小原型设计开发文档.html` 及 `docs/` 镜像
- `outputs/P0开发交付包/01-UIUX/交互映射.csv` 及 `docs/` 镜像
- `outputs/P0开发交付包/02-API/openapi.yaml` 及 `docs/` 镜像
- `outputs/P0开发交付包/06-开发计划/backlog.csv` 及 `docs/` 镜像
- `outputs/P0开发交付包/07-验收测试/acceptance-cases.csv` 及 `docs/` 镜像
- `outputs/Codex-P0开发TODO.md` 及 `docs/` 镜像
- `tests/m16-us-01-review-remediation-contract.spec.ts`

## 剩余风险

API 幂等终态、`targetId` 错误 envelope、钱包运行时分页、Dashboard CAT 显示/请求竞态、共享 DTO 和 lint/route parity 仍属于后续 Story，不在本证据中标记完成。
