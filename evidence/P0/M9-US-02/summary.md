# M9-US-02 CAT 数据迁移证据

已新增 CAT 钱包、USD 充值证据、陪玩审核事件、常驻消息投影和 Discord 产品角色任务的 Prisma 合同与 `000011_cat_wallet_onboarding` 迁移。

`tests/m9-us-02-db.spec.ts`、`npm run db:validate` 和 `npm run db:verify:migration` 作为可复核证据。

2026-08-02 修复已发布迁移历史：恢复数据库中已执行的 `000009_sandbox_funding`，将后续钱包与 CAT 迁移顺延为 `000010`、`000011`，并让货币切换跳过已退役的 sandbox provider 表。本机数据库备份后通过 `prisma migrate deploy` 前向升级；完整测试为 149 files / 746 tests 通过，`npm run typecheck`、`npm run build` 与 Bot 常驻迎新消息实测均通过。
