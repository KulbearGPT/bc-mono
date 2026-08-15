# Blackcat Companion P0

Discord 陪玩业务的 P0 仓库，包含权威规格与合同、Fastify 业务 API、异步 Worker、Sapphire/discord.js Bot、React/Vite Dashboard、PostgreSQL/Prisma 数据层、自动化门禁、运维 Runbook 和验收证据。

## 当前状态

工程代码与三层非 UI 自动化候选已经建立，但发布仍然 **fail-closed**。最近提交的 M23 候选证据记录 317 项验收，其中 87 项等待真实 Discord、Dashboard、Railway、恢复或人工 UAT，另有 2 项旧候选通过记录必须绑定最终候选重跑。当前不能表述为生产就绪或 P0 已发布。

状态会随提交变化。开始工作或判断发布状态时，应重新读取：

- `evidence/P0/acceptance-matrix.csv`
- `evidence/P0/M23-US-09/summary.md`
- `outputs/P0外部UAT待执行清单.md`
- `outputs/Codex-P0开发TODO.md`

## 仓库结构

| 路径 | 内容 |
|---|---|
| `apps/api` | 统一业务 API 与 Worker runtime |
| `apps/bot` | Discord 交互适配器，不承载最终业务规则 |
| `apps/dashboard` | 运营 Dashboard，同源调用统一 API |
| `database` | Prisma schema、迁移与种子数据 |
| `modules/platform` | 跨进程平台合同与环境校验 |
| `tests`, `scripts/non-ui`, `tests/e2e` | 单元、集成、非 UI 与浏览器门禁 |
| `outputs` | 权威规格、合同、计划与当前执行清单 |
| `docs` | GitHub Pages 发布镜像与演示入口 |
| `evidence/P0` | Story、门禁和外部验收证据 |

## 业务边界摘要

- Bot、Dashboard 和 Worker 都通过统一 API/平台合同工作；只有 API 访问业务数据库并决定权限、金额与状态迁移。
- 客户内部钱包以 CAT subunit 记账，固定 `1 USD = 10 CAT` 且 `1 USD cent = 1 CAT subunit`。USD 只用于充值凭证和线下结算辅助，不建立第二账本。
- P0 不连接第三方支付或转账渠道；receipt、退款和外部付款结果由授权员工线下核对并登记。
- 当前匹配流程是无截止候选池、陪玩报名与客户终选，不是自动派单。
- 所有当前有效陪玩分别确认本人就绪后，订单才可进入 `IN_SERVICE`；客户不提交 readiness。
- 资金、订单事件、收益、返佣、配置和审计事实只追加，纠错使用 Adjustment 或反向记录。

完整规则见 [AGENTS.md](./AGENTS.md)，业务事实以其中列出的权威规格和合同优先级为准。

## 本地开发

要求：Node.js 22+、npm 10+、Docker Desktop；数据库集成和完整非 UI 门禁还需要 PostgreSQL 客户端工具。

首次安装依赖：

```bash
npm ci
```

根据 `.env.example` 创建本地 `.env`，不要提交密钥。启动数据库、应用迁移和四个开发进程：

```bash
docker compose up -d postgres
npm run db:migrate:deploy
npm run dev
```

`npm run dev` 同时启动 API、Worker、Bot 和 Dashboard。Bot credential 未配置时不会登录 Discord，但 API、Worker 和 Dashboard 仍可用于相应的本地验证。

空数据库首次建立 L4 Owner 时，可仅在第一次 API 启动设置 `BOOTSTRAP_L4_DISCORD_USER_ID` 与目标 `DISCORD_GUILD_ID`；创建成功后立即删除 bootstrap 变量并重启。仓库没有 `sandbox:provision`，也不创建外部 Provider 账户。

数据库连接分为运行时 `DATABASE_URL`（`blackcat_app`）与迁移 `MIGRATION_DATABASE_URL`（owner）。`GET /health` 只检查进程存活，`GET /ready` 会验证数据库、baseline schema 和运行依赖。

## 验证

按改动范围选择最小充分命令：

```bash
npm run typecheck
npm run build
npm run db:validate
npm run db:verify:migration
npm test
```

候选门禁：

```bash
npm run verify:non-ui:environment
npm run test:non-ui:quick
npm run test:non-ui:full
npm run e2e:coverage:verify
npm run test:e2e:dashboard:isolated
```

`npm run test:non-ui:release` 只在真实、非 example 的生产配置快照和签署文件齐备时运行；缺少输入时失败关闭是正确行为。

## 文档与部署

- GitHub Pages 入口：`docs/index.html`
- Railway Sandbox：`docs/runbooks/Railway-Sandbox测试部署手册.md`
- 部署与恢复：`docs/runbooks/P0部署与恢复Runbook.md`
- 外部 UAT：`outputs/P0外部UAT待执行清单.md`

旧 Story 证据可能描述后来被替代的方案。它们是当时执行记录，不是当前业务合同；请从 `evidence/P0/index.md` 和最新验收矩阵进入，不要从旧证据恢复退役设计。
