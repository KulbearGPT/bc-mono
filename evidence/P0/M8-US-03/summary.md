# M8-US-03 客户 Bot 接入与发布门禁证据

日期：2026-07-21

## 验收范围

- `AT-TKN-004`：客户钱包、订单、礼物、消费、取消和系统内退款金额仅显示配置代币。
- `AT-TKN-005`：客服 Dashboard、目录/审批及陪玩收益、返佣、周报、结算和转账继续显示 USD。
- `AT-TKN-006`：canonical USD 100（`amountMinor=10000`）在客户钱包显示为 `1,000.00 MB`，不创建代币流水。

## RED

```text
npx vitest run tests/m8-us-03-bot-display.spec.ts
# 1 file: 4 failed / 1 passed
```

失败明确显示旧钱包标题“我的 USD 钱包”、客户金额仍为 USD、Dashboard 缺少固定发放提示，且 Bot 尚未分离客户代币与 payout USD 格式化路径。

## 实现与语义扫描

- `service-center.ts` 将原通用格式化器拆为显式 `formatCustomerMoney` 与 `formatUsdMoney`：客户钱包/订单/消费/取消走前者，返佣、陪玩工作台、派单收益和周报走后者。
- 客户格式化器只接受 canonical `currency=USD`，拒绝把其他币种误标为代币；名称与符号在运行时从已校验的全局环境读取。
- `gifts.ts` 的目录标签、余额判断、预留与确认全部使用客户代币格式化，并从配置生成钱包标签。
- Dashboard 金额输入、余额和流水继续使用 `formatWalletMoney` 的 USD 口径，只增加“到账后按 1 USD = 10 MB 发放。”说明，不并排计算 MB。
- 静态盘点确认 `formatUsdMoney` 仅用于返佣、陪玩收益、周报和 dispatch；`formatCustomerMoney` 仅用于客户资金/消费路径；Dashboard 未导入客户格式化器。
- 独立审查发现服务中心在返佣非空时曾把 USD 收益和 MB 钱包放在同一消息；新增非空返佣 RED 后改为非金额状态与独立入口，客户汇总不再双币同屏。替换配置测试同时扩展到钱包、订单、礼物和消费，USD100 验收改走真实 Bot 刷新 handler。
- 首次最终 audit 因新增安全公告命中锁定的传递依赖 `fast-uri` 3.1.3/4.1.0 而失败；依赖树与 dry-run 确认后，仅将兼容版本更新到 3.1.4/4.1.1，复验为 0 vulnerabilities。
- 安全升级后的第一次全仓复验遇到临时 PostgreSQL 并行资源竞争：6 个 DB 文件发生 hook timeout，首个超时使周报故障注入触发器未清理并连带后续失败。进程盘点无遗留实例；周报组单独 9/9、其余失败组 38/38 通过，随后不修改超时或测试配置、以原 `npm test` 命令干净复跑为 136 files / 706 tests 全通过。

## 验证

```text
npx vitest run tests/m8-us-03-bot-display.spec.ts tests/m1-us-06-bot.spec.ts tests/m2-us-10-bot.spec.ts tests/m3-us-01-bot.spec.ts tests/m6-us-05-bot.spec.ts tests/m6-us-06-bot.spec.ts tests/m7-us-06-bot.spec.ts tests/m7-us-06-dashboard.spec.ts
# 8 files / 32 tests passed

npm test
# 136 files / 709 tests passed（完成审计新增辅助合同与 fixture 完整性回归后）

npm run typecheck
npm run build
npm run db:validate
npm run db:verify:migration
npm audit --audit-level=moderate
git diff --check
# 全部 exit 0；audit 为 0 vulnerabilities；迁移链为 66 tables
```

## 剩余边界

- `AT-TKN-004` 与 `AT-TKN-005` 的真实 Discord/Dashboard UAT 仍为 `PENDING_EXTERNAL`；本 Story 和 M8 门禁只声明自动化候选通过，不声明最终发布签署完成。
- 按仓库规则，M8-US-03 与 M8 完成门禁在 TODO 中保持未勾选，直到上述外部验收证据完成。
- 完成审计已同步修正实施计划：计划不再要求在外部 UAT 前勾选 Story 或总门禁，与 TODO、门禁证据和验收合同一致。
- Prisma 与迁移未修改；数据库和 API 仍只有 USD minor units。
