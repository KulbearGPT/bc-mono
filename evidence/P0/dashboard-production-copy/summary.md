# Dashboard 生产文案全量整改证据

## 范围与结论

- 分支：`codex/dashboard-production-copy`
- 基线：`905496c3727f3be1b91da5b94fa32f5598a5c2ad`
- 范围仅包含 Dashboard 用户可见文案、对应 Dashboard 单元/E2E 断言与本证据；不修改 API 或 Bot 运行时代码。
- 相关既有验收：`AT-ACT-002`、`AT-LST-004`、`AT-STATE-001/003`、Dashboard Chromium E2E。

## 审查方法

逐项检查 `apps/dashboard/src` 中的页面标题、正文、按钮、禁用原因、空状态、错误态、路由兜底、表单标签、placeholder、辅助文本、ARIA/title 与请求编号，并反向扫描以下内部语汇：

- 开发阶段与占位：Pilot、P0、待接入、未开放、OpenAPI、API 运行时；
- 测试语义：测试环境、测试投递、测试消息、Sandbox 环境；
- 实现细节：服务端、API、版本令牌、预检、Snowflake、step-up、原子、快照；
- 工程标签：`request_id`、`minor units`、仅诊断、技术详情、未映射字段、前端事件编号。

## 主要整改

1. 删除不存在审批运行时对应的禁用占位按钮，不再向员工展示“审批接口待接入”及 OpenAPI 实现说明。
2. 将 Pilot 路由兜底改为“此功能当前不可用”，只说明工作区未启用和管理员联系路径。
3. 保留非真实资金警示，将 `SANDBOX 测试环境` 改为“非生产环境”；资金语义不变。
4. 保留 Bot 频道验证能力，将“测试投递”统一改为“发送频道验证消息”；请求路径与写入行为不变。
5. 将 API、服务端、版本令牌、预检、Snowflake、step-up、原子和快照等实现词替换为员工可执行的业务说明。
6. 将所有 Dashboard 错误引用从 `request_id` 统一为“请求编号”，保留可排查标识；页面异常编号改为“故障编号”。
7. 将所有用户可见 `minor units` 改为合同规定的 `CAT subunit`，不改变输入值、币种或金额计算。
8. 将“仅诊断”“技术详情”“未映射字段”等工程标签改为“参考”“订单标识与审计信息”“其他信息”。

## RED / GREEN

RED：

```text
npx vitest run tests/dashboard-production-copy.spec.ts
# 1 file / 2 tests failed
# 同时证明旧内部文案仍存在，且新的生产文案尚未建立。
```

GREEN：

```text
npx vitest run tests/dashboard-production-copy.spec.ts tests/dashboard-route-semantics.spec.ts \
  tests/m14-us-05-support-release.spec.ts tests/m4-us-03-dashboard.spec.ts \
  tests/dashboard-table-labels.spec.ts tests/m15-us-01-dashboard-support-parity-contract.spec.ts \
  tests/dashboard-card-workspaces.spec.ts tests/m14-us-04-order-operational-context.spec.ts \
  tests/m15-us-04-bot-config-dashboard.spec.ts tests/m16-us-03-dashboard-consistency.spec.ts
# 10 files / 69 tests passed

rg -l -0 'apps/dashboard|@blackcat/dashboard' tests/*.spec.ts | xargs -0 npx vitest run
# 52 files / 263 tests passed

npm run typecheck
# passed

npm run build -w @blackcat/dashboard
# passed; JS 458.92 kB, gzip 129.42 kB

npx eslint apps/dashboard/src --max-warnings 0
# passed; zero warnings

npx playwright test --project=chromium --reporter=line
# 142/143 passed；唯一失败为旧 E2E 仍查找“功能暂未开放”。

npx playwright test tests/e2e/dashboard/dashboard-smoke-security.spec.ts \
  --project=chromium --grep 'DE2E-SMK-005' --reporter=line
# 1/1 passed after updating the frozen production copy assertion.

git diff --check
# passed
```

## 保留的业务护栏

- 非生产环境仍明确提示余额不代表已收到 USD；没有隐藏资金环境风险。
- 请求编号仍展示给员工用于排查，只移除了协议字段名。
- Bot 频道验证仍调用原有受控写路径，没有删除配置验证能力。
- 功能开关、权限、状态迁移、幂等、金额和 API 合同均未改变。
