# M15-US-01 验收证据

## Story

- Story：`M15-US-01` 客服运营闭环合同与 RED 基线
- 状态：合同完成；运行时未实现
- 日期：2026-08-06
- Requirement：`DOP-01; ACCESS-02`
- 验收：`AT-DOP-001` 至 `AT-DOP-008`

## 范围结论

- 后台补齐独立退款、订单频道只读记录、Bot 配置、钱包冲正、员工控制陪玩接单资格、客户展示名和员工账号治理。
- Dashboard 明确不发送、编辑或删除 Discord 消息。
- 陪玩端不提供在线或接单开关；候选池资格以员工维护的内部审核状态为准。
- 老板和陪玩个人操作不属于本里程碑。

## RED 基线

```text
pnpm exec vitest run tests/m15-us-01-dashboard-support-parity-contract.spec.ts
Test Files  1 failed (1)
Tests       4 failed (4)
```

失败证明主规格、交互映射、backlog/验收和三项缺失 API 尚未形成一致合同。

## GREEN

```text
pnpm exec vitest run tests/m15-us-01-dashboard-support-parity-contract.spec.ts --reporter=dot
Test Files  1 passed (1)
Tests       4 passed (4)

ruby -e "require 'yaml'; ARGV.each { |p| YAML.load_file(p) }" <双 OpenAPI>
OpenAPI YAML: 2/2 parsed
```

CSV 列宽校验通过：backlog `130×22`、交互映射 `146×14`、验收 `277×11`。主规格、TODO、交互映射、OpenAPI、backlog 和验收六组 `outputs/`/`docs/` 镜像逐字一致；`git diff --check` 通过。

## 修改文件

- 主规格及 `docs/` 镜像
- OpenAPI、交互映射、backlog、验收用例及其镜像
- 双 TODO、合同测试及本证据

## 剩余风险

M15-US-02 至 M15-US-09 尚未实现。当前只冻结合同，不表示 Dashboard、API、数据库或真实员工 UAT 已完成。
