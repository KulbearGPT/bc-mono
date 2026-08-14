# P0 部署与恢复 Runbook

本文描述 P0 候选的通用部署、恢复和回滚步骤。Railway Sandbox 的具体配置见 [Railway-Sandbox测试部署手册.md](./Railway-Sandbox测试部署手册.md)，外部验收见 [P0-UAT与发布检查表.md](./P0-UAT与发布检查表.md)。

## 1. 不可越过的发布边界

- 内部 CAT 钱包是客户余额、预留、消费和退款的唯一账本。固定 `1 USD = 10 CAT`、`1 USD cent = 1 CAT subunit`；USD 仅作为充值凭证和线下结算辅助。
- P0 不连接 Stripe、PayPal、银行、支付 Provider 或外部转账 API，不配置 Provider token/webhook，也不保存支付密码和完整付款凭证。
- 当前订单使用候选池报名和客户终选，不启用 `auto_dispatch_enabled`、派单轮数或派单超时配置。
- 只有所有当前有效陪玩分别确认本人就绪后才进入 `IN_SERVICE`；客户不提交 readiness。
- 发布必须绑定同一不可变 release candidate。验收矩阵存在 `PENDING_EXTERNAL`、旧候选证据、阻断缺陷或缺少签署时，门禁必须失败关闭。

## 2. 发布前检查

1. 工作树干净，候选 SHA 或镜像 digest 已冻结，P0/P1 范围明确。
2. 镜像完成构建与扫描，`BLACKCAT_APP_IMAGE` 使用不可变 digest，不使用可漂移 tag。
3. 生产 Secret 只来自 Secret Store；不得从 `.env.production.example` 直接复制，也不得写入 Git、日志或截图。
4. 使用真实候选运行：

   ```bash
   npm run verify:non-ui:environment
   npm run test:non-ui:full
   npm run e2e:coverage:verify
   npm run test:e2e:dashboard:isolated
   node scripts/verify-production-env.mjs .env.production
   ```

5. 复核 `evidence/P0/acceptance-matrix.csv`、外部结果账本和 `outputs/P0外部UAT待执行清单.md`。自动化通过不能替代 Discord、Railway、浏览器、恢复和人工签署。
6. 只有真实配置快照、外部证据和 owner/staff 签署齐备后才运行 `npm run test:non-ui:release`；缺少输入时失败是正确结果。

## 3. 部署顺序

### 3.1 Docker Compose

1. 设置不可变 `BLACKCAT_APP_IMAGE` 和独立数据库密码。
2. 校验 Compose：`docker compose -f docker-compose.production.yml config`。
3. 启动 PostgreSQL 并等待健康检查。
4. 单独运行 `migrate`，确认 `npm run db:migrate:deploy` 退出码为 0；迁移失败不得启动新应用版本。
5. 启动 API，等待 `GET /health` 和 `GET /ready` 均为 200。
6. 启动 Worker、Bot 和 Dashboard；分别验证进程健康、API 私网连通和 Dashboard OAuth callback。

### 3.2 Railway

Railway 使用同一镜像的 `web`、`worker`、`bot` 三个 Service 和托管 PostgreSQL。`web` 的 pre-deploy 执行迁移，只有 `web` 开启 Public Networking。完整变量与 Guild 配置见 Railway 手册。

## 4. 部署后 smoke

- `/health`、`/ready`、Bot `/health` 和 Worker `/health` 正常；迁移版本与候选一致。
- L1–L4 登录与 capability 累积继承符合当前审批结果，Discord Role 不会绕过内部授权。
- 公共入口、私密订单频道、候选池、陪玩工作台、客服任务、运营告警、独立礼物入口和评价广播使用目标 Guild 的配置。
- 新用户注册、陪玩申请、CAT 充值证据登记、订单预留、候选报名/撤回/终选、全陪玩就绪、礼物审批和客服接管均产生同 Guild 审计。
- Dashboard 卡片/表格、详情和 Discord 投影显示同一 API 事实；无旧自动派单、Provider 或客户 readiness 文案。
- 记录 deployment ID、候选引用、request ID 和脱敏证据，不记录 Token、TOTP、receipt 正文或个人数据。

## 5. Worker 与 Discord 恢复

- Worker 使用事务内 Outbox/Job。重启后恢复陈旧 `PROCESSING` Job，并沿用原 dedupe/idempotency key；不得重建预留、重复捕获或重复追加钱包记录。
- Worker 心跳与陈旧锁阈值使用运行时配置；若设置 `WORKER_HEARTBEAT_MS` 和 `WORKER_STALE_LOCK_MS`，陈旧阈值至少为心跳三倍。
- Discord 创建消息前以稳定 nonce 查询历史。远端已成功而本地未记录时复用原消息；找不到时才按合同创建替代消息。
- Discord 429 使用响应的 `retry_after` 安排重试，不用固定退避覆盖供应商限流时间。
- Discord 消息、频道或 Role 同步超过重试阈值时建立唯一客服/运营任务；业务状态和资金不得由投影失败回滚。

## 6. 订单面板修复

1. L2+ 在 Dashboard“系统运营”选择“修复已删除面板”，填写订单 UUID 和原因码。
2. Dashboard 调用 `POST /api/v1/admin/orders/{orderId}/panel-repair`；API 按 Actor Guild、权限、版本和幂等键校验。
3. Worker 从数据库重新读取订单、金额、参与人和允许动作，优先更新原消息，仅在确认消息不存在时创建替代消息。
4. 以乐观条件更新 `orders.panel_message_id`。修复不得修改订单状态、`row_version`、预留、交易或金额快照。
5. 并发任务已写入新消息 ID 时，旧修复按冲突失败，不覆盖较新事实。

## 7. 备份与恢复

### 7.1 备份

- 使用 `pg_dump --format=custom --no-owner --no-acl`，完成后计算哈希、加密并存入隔离备份存储。
- 记录候选、数据库版本、migration head、备份时间、操作者和受控存储引用。
- 不把数据库 dump、真实凭证或个人数据提交到仓库。

### 7.2 隔离恢复演练

1. 创建全新隔离数据库，不覆盖原环境。
2. 用 owner 角色执行 `pg_restore`，再用运行时 `blackcat_app` 角色启动 API。
3. 核对 migration、核心表行数与引用，以及订单、参与人、预留、WalletEntry、消费、收益、返佣、结算、Outbox、任务和审计的只追加事实。
4. 验证 `GET /ready`、活跃订单继续、Worker 恢复、面板修复和幂等重放。
5. 本地探针：`bash scripts/verify-backup-restore.sh`。真实发布仍需保存隔离环境的外部恢复证据。

恢复演练不得使用生产 Discord 凭证、真实付款渠道或未脱敏个人数据。

## 8. 回滚

- 应用回滚只切换到上一个不可变镜像，不删除数据库事实，不逆向执行已应用迁移。
- 不兼容迁移、签名异常、余额/预留不一致、重复交易、跨 Guild 泄露或权限越界是立即停止发布条件。
- 回滚后重新检查 `/ready`、migration head、Outbox/交易对账、Role/session 撤权和当前候选标识。
- 记录触发原因、时间线、镜像 digest、request ID、数据影响和后续修复；在新候选上重新执行受影响自动化和外部 UAT。
