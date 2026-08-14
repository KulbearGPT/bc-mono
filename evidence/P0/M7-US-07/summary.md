# M7-US-07 Provider 资金能力退役与发布门禁

## 状态与验收

- 状态：完成
- 验收：AT-WAL-010；AT-AUD-008
- 日期：2026-07-21

## 实际交付

- 删除 API 运行时支付适配器、HTTP Provider 客户端、资金适配契约实现和支付 Webhook handler。
- 删除支付 Provider、充值 URL 和支付 Webhook 的环境变量、启动注入、路由注册及生产环境校验。
- 客户 Profile、订单、礼物、业务退款、Dashboard 和 Bot 仅使用内部 USD 钱包；客户 Profile 不再读写 `provider_balance_snapshots`，礼物与客户目录不再读取客户 `external_accounts`。
- 保留陪玩结算清单所需的脱敏外部收款参考；它不参与客户充值、余额、预留、消费或退款。
- 当前 OpenAPI、业务配置、交互原型、backlog、验收合同和运行手册已切换到客服按 receipt 登记内部 USD 充值的语义。
- `tests/m7-us-07-retirement.spec.ts` 确定性盘点 71 个 API mutation route 与 10 个 production Worker handler；每项均映射 action、可信 Actor 来源、主对象、成功 change builder、失败/拒绝审计路径及 AT-AUD-005..008。

## 验证证据

- `npm test`：133 个测试文件通过，682 个测试通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- `npm run db:validate`：Prisma schema valid。
- `npm run db:verify:migration`：完整迁移链通过，`migration-apply-ok`，`table_count=66`。
- `npm audit --audit-level=moderate`：`found 0 vulnerabilities`。
- `git diff --check`：通过，无空白错误。
- M7 合同、钱包、审计、客户端、退役和追踪定向回归：7 个测试文件、91 个测试通过。
- 退役与受影响 Profile/礼物定向回归：6 个测试文件、24 个测试通过。
- 验收矩阵：`evidence/P0/acceptance-matrix.csv` 已从当前合同重建，共 189 条。

## 边界与剩余发布项

M0–M6 历史证据继续保留，但其旧 Provider、绑定、第三方充值链接、支付 Webhook、陈旧 Provider 余额或非 USD 表述不构成当前能力。真实 Discord Guild、Dashboard 浏览器 UAT、备份恢复签署及产品/运营/客服/技术最终发布签署仍是独立外部门禁，未在本 Story 中伪造完成。
