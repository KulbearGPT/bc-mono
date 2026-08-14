# M19-US-01 跨角色状态与刷新合同证据

## 结果

- 状态：合同 Story 完成；不声明后续运行时修复已完成。
- 验收：`AT-STATE-001`、`AT-STATE-002` 合同已冻结；`AT-STATE-003`–`005` 已建立后续运行时与 UAT 门禁。
- 权威规则：客户不提交 readiness；首次开始服务要求所有当前有效陪玩就绪。

## RED

命令：

```text
npx vitest run tests/m19-us-01-cross-role-state-contract.spec.ts
```

结果：1 file / 4 tests failed。缺少 M19 主规格、backlog、交互、验收和跨角色状态刷新矩阵，符合预期 RED。

## GREEN

命令：

```text
npx vitest run tests/m19-us-01-cross-role-state-contract.spec.ts
```

结果：1 file / 4 tests passed。

CSV 结构检查：backlog 163 行、交互映射 160 行、验收 303 行，均为引号平衡。

## 修改范围

- 主规格新增 M19 跨角色状态一致性与实时刷新章节，并修正 M18 当前流程中的旧“双边就绪”措辞。
- 新增 `P0开发交付包/01-UIUX/跨角色状态刷新矩阵.md`。
- backlog 新增一个 Epic 和五个顺序 Story。
- 交互映射新增三条客户/陪玩/客服/工作台刷新合同。
- 验收新增 `AT-STATE-001`–`005`。
- TODO 与 outputs/docs 镜像同步。

## 仍待完成

- `M19-US-02`–`05` 的运行时、Dashboard 主动刷新、时效告警和真实 Guild 多角色 UAT 尚未完成。
- 旧版低优先级文档仍可能包含已被 M10/M19 明确取代的双边 readiness 历史描述；运行时 Story 将同步清理直接使用这些描述的 OpenAPI 示例、客服投影和提醒文案。
