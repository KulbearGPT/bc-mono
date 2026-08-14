# M10-US-08 套餐合同证据

日期：2026-08-04

## 冻结范围

- `ServicePackageVersion` 是版本化套餐模板，`ServicePackageSlot` 是可独立修改的默认陪玩席位。
- 应用套餐时，每个槽位原子展开为一条 `requestedPlayerCount = 1` 的 `OrderRequirement`。
- 订单保存套餐版本及 `PACKAGE_DEFAULT` / `CUSTOMIZED` 构成状态；需求保存来源套餐槽位。
- 保持默认构成时可使用服务端套餐价；任何增删改切换为 `CUSTOMIZED` 并由 API 按最终有效需求重报价。
- 客户端只提交套餐版本和订单期望版本，不提交套餐价、目录单价、行价或总价。
- 套餐或目录失效、并发版本冲突、展开中任一失败均为零写入。

## TDD 证据

RED：

```text
npx vitest run tests/m10-us-08-service-packages-contract.spec.ts --reporter=verbose
Test Files  1 failed (1)
Tests       2 failed (2)
```

GREEN：

```text
npx vitest run tests/m10-us-08-service-packages-contract.spec.ts tests/m10-us-01-contract.spec.ts --reporter=dot
Test Files  2 passed (2)
Tests       4 passed (4)

npm run db:validate
PASS

git diff --check
PASS
```

验收追踪：`AT-MULTI-008`、`AT-MULTI-009`。

## 状态

本提交仅冻结合同并建立 GREEN 基线；迁移、运行时 API、Discord、Dashboard 和真实 Guild UAT 尚未实现，因此 `M10-US-08` 保持未完成。
