# Railway Sandbox 测试部署手册

本文适用于当前 CAT 钱包、候选池报名/终选、多陪玩就绪、独立礼物和评价广播版本。Sandbox 只用于隔离验证，不代表生产发布。

## 1. 拓扑

Railway Project 创建四个 Service：

| Service | 来源 | 启动命令 | 健康检查 |
|---|---|---|---|
| `postgres` | Railway PostgreSQL | Railway 托管 | Railway 托管 |
| `web` | 根目录 Dockerfile | `npm run start:web` | `/ready` |
| `bot` | 根目录 Dockerfile | `npm run start:bot` | `/health` |
| `worker` | 根目录 Dockerfile | `npm run start:worker` | `/health` |

Dashboard 静态文件由 `web` 同源提供。`bot` 和 `worker` 通过 Railway 私网访问 `web`；只有 `web` 开启 Public Networking。三者配置文件分别为 `railway/web.json`、`railway/bot.json`、`railway/worker.json`。

## 2. Discord 准备

### 2.1 Application

1. 创建 Discord Application/Bot，受控保存 Bot Token、Application ID 和 OAuth Client Secret。
2. 按当前 Bot runtime 启用 `Server Members Intent`、`Presence Intent` 和 `Message Content Intent`。
3. OAuth redirect 添加 `https://<web-domain>/api/v1/auth/discord/callback`。
4. 安装 scopes 使用 `bot`、`applications.commands`。
5. Bot 至少需要 View Channels、Send Messages、Read Message History、Add Reactions、Use Application Commands、Manage Messages、Manage Channels、Manage Roles、Move Members、Embed Links；按最小权限核对测试 Guild。

### 2.2 Guild 对象

准备：

- 公共新人入口频道；
- 候选池/派单、陪玩工作台、客服任务、运营告警频道；
- 礼物审核、礼物广播、独立送礼入口、五星评价广播频道；
- 私密订单 Category 与订单归档 Category；
- 客户、陪玩申请中、已批准陪玩角色；
- L1、L2、L3、L4 员工映射角色，以及可选客服/运营通知角色。

Bot Role 放在它需要管理的产品与员工 Role 上方。Discord Role 只是映射信号；最终授权由 API 的内部审批等级、scope、MFA 和 `permissions_version` 决定。当前 Pilot 验收夹具严格使用 `STAFF → L2`、`OWNER → L4`，`L1 与 L3 映射保持为空`；这只是该 Pilot 的受控验收映射，不得当作产品的固定角色规则。

## 3. Railway Project

1. 连接目标仓库和明确候选分支。
2. 添加 PostgreSQL，命名 `postgres`。
3. 添加 `web`、`bot`、`worker`，都使用根目录 Dockerfile 和各自 `railway/*.json`。
4. 仅为 `web` 生成 HTTPS 公网域名。
5. `web` pre-deploy 运行 `npm run db:migrate:deploy`；Bot/Worker 不重复迁移。

## 4. 环境变量

所有 Secret 只放 Railway Variables 或密码库，不进入仓库、截图和验收附件。示例占位符不能用于真实候选。

### 4.1 web

```text
NODE_ENV=production
BUSINESS_ENV=SANDBOX
DATABASE_URL=<blackcat_app runtime URL>
MIGRATION_DATABASE_URL=<migration owner URL>
API_BASE_URL=https://<web-domain>
BOT_SERVICE_TOKEN=<32+ random chars>
PAGINATION_CURSOR_SIGNING_SECRET=<independent 32+ chars>
GIFT_CONTINUATION_SIGNING_SECRET=<independent 32+ chars>
REVIEW_CONTINUATION_SIGNING_SECRET=<independent 32+ chars>
BOT_CONFIG_VALIDATION_SECRET=<independent 32+ chars>
DASHBOARD_CSRF_SECRET=<independent 32+ chars>
DASHBOARD_MFA_ENCRYPTION_KEY=<independent 32+ chars>
DISCORD_BOT_TOKEN=<bot token>
DISCORD_OAUTH_CLIENT_ID=<application id>
DISCORD_OAUTH_CLIENT_SECRET=<oauth secret>
DISCORD_OAUTH_REDIRECT_URI=https://<web-domain>/api/v1/auth/discord/callback
DISCORD_GUILD_ID=<guild snowflake>
DASHBOARD_URL=https://<web-domain>
BOOTSTRAP_L4_DISCORD_USER_ID=<first deployment only>
```

### 4.2 bot

```text
NODE_ENV=production
BUSINESS_ENV=SANDBOX
API_BASE_URL=http://${{web.RAILWAY_PRIVATE_DOMAIN}}:${{web.PORT}}
BOT_SERVICE_TOKEN=<same service credential as web>
GIFT_CONTINUATION_SIGNING_SECRET=<same gift secret as web>
REVIEW_CONTINUATION_SIGNING_SECRET=<same review secret as web>
DISCORD_BOT_TOKEN=<bot token>
DISCORD_GUILD_ID=<guild snowflake>
```

### 4.3 worker

```text
NODE_ENV=production
BUSINESS_ENV=SANDBOX
DATABASE_URL=<blackcat_app runtime URL>
API_BASE_URL=http://${{web.RAILWAY_PRIVATE_DOMAIN}}:${{web.PORT}}
BOT_SERVICE_TOKEN=<same service credential as web>
DISCORD_BOT_TOKEN=<bot token>
```

不要设置 `FUNDING_ADAPTER`、Provider token/webhook、充值 URL、钱包名称/符号覆盖、`auto_dispatch_enabled`、`dispatch_timeout_minutes` 或 `dispatch_max_rounds`。这些旧配置已退役。CAT 与换算比例是代码和合同固定值。

## 5. 首次启动

1. 部署 `web`，确认 pre-deploy migration 成功，`/health` 与 `/ready` 返回 200。
2. 仅第一次启动设置 `BOOTSTRAP_L4_DISCORD_USER_ID`，由 API 创建唯一初始 L4 Owner。
3. 创建成功后立即从 Railway 删除 bootstrap 变量并重新部署 `web`。
4. 部署 `bot` 与 `worker`，确认各自 `/health` 返回 200。
5. 用 Owner 完成 Dashboard OAuth 登录；核对会话 Guild 和 capability，不信任浏览器自报角色。

## 6. `/bot-config`

在目标 Guild 用授权账号配置以下当前字段：

### Channel/Category

- `public_entry_channel_id`
- `private_order_category_id`
- `order_archive_category_id`
- `dispatch_channel_id`
- `player_workbench_channel_id`
- `staff_task_channel_id`
- `operations_alert_channel_id`
- `gift_review_channel_id`
- `gift_broadcast_channel_id`
- `gift_entry_channel_id`
- `review_broadcast_channel_id`

### Role

- `player_role_id`
- `companion_applicant_role_id`
- `companion_role_id`
- `staff_l1_role_id` 至 `staff_l4_role_id`
- 可选 `staff_notification_role_id`、`operations_notification_role_id`

安全 Role 映射需要 L4；运营字段按 API capability 管理。所有对象必须属于当前 Guild，且 Bot 对目标对象具备所需权限。

### 运营配置

- `new_orders_enabled=true`
- `gift_requests_enabled=true`
- `maintenance_notice` 按测试需要设置
- readiness、完单确认、礼物提醒、频道归档分钟数使用合同允许范围
- 礼物广播模板不包含任意 sender/receiver ID 或敏感资金字段

保存使用预览 token、expected version 和原因，成功后 Bot 缓存刷新；进程重启后配置必须从 API/数据库恢复。不得设置自动派单字段。

## 7. 测试数据与 CAT 充值

没有 Sandbox Funding provision，不运行任何资金 provision 脚本。客户从公共入口注册，API 创建内部账户和 CAT 钱包。授权员工在 Dashboard 登记：USD cents、payment method、receipt number、paid time、note、reason code 和可选私有附件。

例如 25.50 USD = 2550 USD cents = 2550 CAT subunits = 255.0 CAT。成功后必须出现 TopUp 证据、CAT CREDIT 和审计；不得直接覆盖余额。重复 receipt/method 不产生第二次入账。

## 8. Smoke 与外部证据

- 新成员只看见公共入口；个人余额和订单保持 ephemeral/私密。
- 注册与陪玩申请幂等，审批后产品 Role 最终收敛。
- 候选池无倒计时；合格陪玩可报名/撤回，客户终选后只保留正式参与人权限。
- 全部当前有效陪玩逐名就绪后才进入服务中，客户没有 readiness 动作。
- CAT 充值、订单/礼物预留、取消释放、完成/批准捕获和失败零写入可对账。
- 独立礼物入口、匿名展示、五星评价广播、客服与运营通知使用配置频道。
- Web/Bot/Worker 重启后 Outbox、常驻消息、Role、频道和交互状态幂等恢复。
- Dashboard OAuth、SPA route、API route、卡片/表格和跨 Guild 拒绝正常。

记录候选 SHA、Railway deployment IDs、migration 脱敏摘要、健康检查、request ID 和真实 Discord/Dashboard UAT。不得记录 Token、Secret、数据库密码、完整 Session、receipt 正文或个人信息。

当前未执行项和精确步骤以 `outputs/P0外部UAT待执行清单.md` 为执行视图，以验收矩阵和外部结果账本为最终状态来源。
