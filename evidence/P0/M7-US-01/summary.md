# M7-US-01 合同重整证据

- Story：M7-US-01
- 日期：2026-07-21
- 验收：AT-WAL-001、AT-WAL-010、AT-AUD-005、AT-AUD-008
- 范围：仅重整规格、OpenAPI、数据合同、业务配置、交互映射、backlog、验收基线与发布镜像；不声称内部钱包或全量审计运行时已经实现。

## RED

命令：

```text
npx vitest run tests/m7-us-01-contract.spec.ts
```

初始结果：1 个测试文件中 3 项失败、1 项通过。失败原因分别为 OpenAPI 缺少人工充值/渠道退款扣款且仍含旧余额形态，Prisma/验收缺少钱包与 AuditLogChange 合同，以及 outputs/docs 镜像尚未同步。

## 合同变化

- 内部 USD WalletEntry 成为唯一余额事实；`ledgerBalanceMinor = CREDIT - DEBIT`，`availableMinor = ledgerBalanceMinor - reservedMinor`。
- 充值必填客户、正整数金额、paymentChannel、externalTransactionId、paidAt 和 note；图片/PDF 私有凭证可选；渠道与外部交易号组合唯一。
- L1 单笔充值上限为 500000 USD minor units（含）；更高金额最低 L2。
- 业务退款贷记内部钱包；已在线下完成的渠道退款仅在 availableMinor 足够时追加内部借记，禁止负余额。
- Dashboard、Discord、Bot、受控 Webhook 和 Job 的所有非只读尝试均记录成功、失败或拒绝；成功业务变化与 AuditLog/AuditLogChange 同事务。
- 当前 P0 合同移除支付渠道运行时读取、账户绑定、第三方充值 URL、支付 Webhook 和非 USD 资金要求；旧完成记录保留为历史证据并明确由 M7 覆盖。

## GREEN

```text
node -e "JSON.parse(...business-config.schema.json); JSON.parse(...test-fixtures.json)"
JSON OK

npx vitest run tests/m7-us-01-contract.spec.ts
Test Files  1 passed (1)
Tests       4 passed (4)

npx vitest run tests/m6-us-00-contract.spec.ts tests/m7-us-01-contract.spec.ts
Test Files  2 passed (2)
Tests       11 passed (11)

git diff --check
exit 0
```

发布镜像已通过 `rsync -a outputs/ docs/` 同步；合同测试对 OpenAPI、Prisma、验收 CSV 与 TODO 执行逐字节镜像校验。

## 剩余工作

M7-US-02 至 M7-US-07 尚未完成。数据库迁移、通用审计封套、钱包 API、订单/礼物资金迁移、Dashboard/Bot 客户端和 Provider 运行时退役必须依序实现并各自留证后，才能声称新能力已交付。

## 完成审计补充（2026-07-21）

后续逐项审计发现 `AGENTS.md`、API 使用说明、交付包首页、业务配置说明和 HTML Backlog 历史视图仍保留旧 Provider 资金口径。先扩展 `tests/m7-us-01-contract.spec.ts` 并观察到 1/6 失败，再同步这些辅助文档及 outputs/docs 镜像。业务配置同时移除退役的 `account.bind`、`webhook.payment.receive`，加入 `wallet.read`、`wallet.top_up`、`wallet.external_refund`、`wallet.adjust`；示例配置累计权限数为 L1/L2/L3/L4 = 30/59/75/81，唯一权限 81，Schema 枚举 81。

同一次审计继续发现主规格末段仍含人民币/支付适配器文字，OpenAPI 时间线枚举仍含 `PROVIDER_BALANCE_SNAPSHOT`，且 AT-CAN/AT-GFT/AT-WHK/AT-REC/AT-PRF 的部分验收与 fixtures 仍要求 Provider 调用。现已统一为内部钱包事务、WalletEntry、响应丢失后的幂等重放和退役 Webhook 404 语义；验收矩阵保持 196 条并重新生成。

验收全集还引用了 42 个未登记的 `FX-*` 标识。新增的合同断言先以 `FX-ACTIVE-RESERVATION is missing from fixtureIndex` 失败，再补齐现有对象别名与 contracts、环境、结算、周报、钱包、展示配置等 synthetic fixtures；当前 162 个验收 fixture 标识全部存在且 JSON Pointer 可解析。

```text
npx vitest run tests/m7-us-01-contract.spec.ts
# RED: 1 failed / 5 passed（开发规则仍声明 Provider 为资金事实来源）
# GREEN: 1 file / 7 tests passed

node JSON parse business-config.schema.json
# schema-json-ok
ruby YAML parse business-config.example.yaml
# example-yaml-ok
```
