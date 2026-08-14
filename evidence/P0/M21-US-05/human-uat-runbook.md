# M21 订单评价真实 Guild 外部 UAT 手册

实现基线：执行时以当前候选完整 SHA 替换；手册与隔离 Harness 候选起点为 `git:e65e51ae2fa11e7fd7cc45b325360fc0a2006232`。

状态：等待真实老板与具名运营/QA 执行。本文件是执行合同，不是通过证据；不得预填 `PASSED`，也不得由 Codex 或合成 Worker 探针代替桌面/手机用户签署。

## 执行边界

- 仅在 `BUSINESS_ENV=SANDBOX` 的测试 Guild 和名称含 `_uat` 的隔离 PostgreSQL 数据库执行；禁止迁移或写入现有 `blackcat` 数据库。
- 测试订单使用合成昵称和零敏感备注，不使用真实订单、余额、预留、支付资料或客户历史。
- 老板交互只能走真实 Discord 组件与统一业务 API；Bot 不直连数据库。隔离数据库直写只允许用于准备合成 fixture，并必须在 API/Bot 启动前完成。
- 评价事实与公开快照为 append-only；业务数据不做逐行删除。结束时停止服务、删除临时 Discord 频道并整体删除隔离 `_uat` 数据库。
- 开始执行时冻结新的完整 Git SHA。候选变化后，`AT-REVIEW-002` 与 `AT-REVIEW-003` 必须全部重跑。
- 任一场景出现客户身份、1–4 星、留言、金额、钱包、私密频道或内部客服身份公开时立即停止，保留脱敏证据并判定失败。

## 前置条件

- 一名真实老板提供测试 Guild Discord 用户 ID，并可同时使用桌面与手机 Discord。
- 一名运营/QA 可观察好评频道、Bot/API/Worker 日志和隔离数据库只读对账。
- 隔离数据库已应用全部迁移，并准备一个 24 小时内 `COMPLETED` 的订单：三名 `ACTIVE` 陪玩、一名有真实首次响应归属的客服、无既有评价与公开快照。
- 临时私密交互频道只允许老板、Bot 和必要 staff 访问；临时好评频道属于同一 Guild。`review_broadcast_channel_id` 指向该好评频道。
- API、Worker、Bot 使用同一隔离数据库；`REVIEW_CONTINUATION_SIGNING_SECRET` 为稳定的 32 字符以上 SANDBOX 值；服务启动后再发布评价入口。
- 同一 Bot token 不得有远端部署或另一套本地 Bot 正在连接；UAT Harness 的短连接除外。完整老板操作须在 fixture 创建后 60 分钟内完成，避免已完成订单的正常终态清理窗口关闭交互频道。
- 开始前记录订单状态、row version、预留/捕获、钱包、消费、陪玩收益、返佣、派单、准入、权限和处罚计数，作为 `AT-REVIEW-004` 前值。

## 隔离环境命令

以下命令均从本 worktree 根目录执行。`M21_UAT_ENV_FILE` 是现有 SANDBOX 凭据文件，至少包含真实测试 Bot 的 `DISCORD_BOT_TOKEN`、`DISCORD_GUILD_ID` 及业务 API 所需签名/内部凭据；不得提交该文件。`M21_UAT_CUSTOMER_ID` 必须是真实、非 Bot 的测试老板 Discord ID。

```bash
export M21_UAT_ENV_FILE='<SANDBOX env 文件绝对路径>'
set -a
source "$M21_UAT_ENV_FILE"
set +a
export BUSINESS_ENV=SANDBOX
export M21_UAT_CONFIRM=USE_ISOLATED_REVIEW_UAT
export M21_UAT_DB_CONFIRM=CREATE_OR_DROP_ISOLATED_M21_UAT
export M21_UAT_RUN_ID=review05
export M21_UAT_CUSTOMER_ID='<真实测试老板 Discord ID>'
export M21_UAT_DATABASE_NAME=blackcat_m21_review_uat
export M21_UAT_ADMIN_DATABASE_URL='postgresql://blackcat:blackcat@localhost:5432/postgres'
export M21_UAT_DATABASE_URL='postgresql://blackcat:blackcat@localhost:5432/blackcat_m21_review_uat'
export M21_UAT_RUNTIME_DATABASE_URL="$M21_UAT_DATABASE_URL"
export DATABASE_URL="$M21_UAT_DATABASE_URL"
export M21_UAT_REVIEW_SIGNING_SECRET='<至少 32 字符的仅限 SANDBOX 随机值>'
```

必须先加载凭据文件，再覆盖 `BUSINESS_ENV` 与全部 UAT 数据库变量；不得颠倒顺序。这样即使凭据文件含日常数据库地址，后续 Harness 也只会看到显式隔离库地址。

创建隔离库、应用全部迁移，然后创建两个带唯一 topic 的临时 Discord 频道、三陪玩/首响客服合成订单以及受保护业务基线：

```bash
scripts/uat/m21-review-flow-db.sh create
npx tsx scripts/uat/m21-review-flow-uat.ts prepare \
  | tee "evidence/P0/M21-US-05/prepare-${M21_UAT_RUN_ID}.json"
```

`prepare` 成功后，在第二个终端继承同一组环境变量并启动唯一一套 API、Worker、Bot；保持前台日志直到 UAT 完成：

```bash
scripts/uat/m21-review-flow-services.sh start \
  2>&1 | tee "evidence/P0/M21-US-05/services-${M21_UAT_RUN_ID}.log"
```

老板完成 UAT-1、并在公开预览选择“仅内部保存”后，从第一终端执行零公开与业务事实对账：

```bash
npx tsx scripts/uat/m21-review-flow-uat.ts check-internal \
  | tee "evidence/P0/M21-US-05/internal-${M21_UAT_RUN_ID}.json"
```

老板明确同意公开、Worker 投递完成后验证唯一公共卡及隐私白名单；随后验证同一 Outbox 重放不新增卡，再验证删卡恢复为唯一新卡：

```bash
npx tsx scripts/uat/m21-review-flow-uat.ts verify-final \
  | tee "evidence/P0/M21-US-05/final-${M21_UAT_RUN_ID}.json"
npx tsx scripts/uat/m21-review-flow-uat.ts requeue-broadcast \
  | tee "evidence/P0/M21-US-05/replay-${M21_UAT_RUN_ID}.json"
npx tsx scripts/uat/m21-review-flow-uat.ts verify-final \
  | tee "evidence/P0/M21-US-05/replay-final-${M21_UAT_RUN_ID}.json"
npx tsx scripts/uat/m21-review-flow-uat.ts delete-and-requeue \
  | tee "evidence/P0/M21-US-05/recovery-${M21_UAT_RUN_ID}.json"
npx tsx scripts/uat/m21-review-flow-uat.ts verify-final \
  | tee "evidence/P0/M21-US-05/recovery-final-${M21_UAT_RUN_ID}.json"
```

完成证据采集后，先在服务终端按 `Ctrl-C` 停止进程，再删除精确匹配本次 topic 的临时频道并整体删除隔离库：

```bash
npx tsx scripts/uat/m21-review-flow-uat.ts cleanup \
  | tee "evidence/P0/M21-US-05/cleanup-${M21_UAT_RUN_ID}.json"
scripts/uat/m21-review-flow-db.sh drop
```

若中途失败也必须执行同样的停止、Discord cleanup 和数据库 drop。脚本会拒绝非 `SANDBOX`、名称不含 `_uat` 的数据库或缺少显式确认值的操作。

## UAT-1：AT-REVIEW-002 低点击混合评价与恢复

执行设备：同一老板先桌面、后手机；运营/QA 观察日志和 API request ID。

步骤：

1. 桌面端点击完成订单卡唯一的“评价本次服务”，确认响应为 ephemeral，显示订单整体、三名陪玩和“猫舍前台”，且没有要求一次评完。
2. 仅点击一次给订单整体五星；确认成功后立即关闭面板，不填写留言。
3. 手机端重新打开评价中心，确认整体五星已经保存且不可重复；多选陪玩 A 与陪玩 B，一次点击四星。
4. 单独选择“猫舍前台”并给二星；确认没有强制原因 Modal。陪玩 C 保持未评价。
5. 给“猫舍前台”追加精确测试留言 `private-m21-comment-sentinel`；其他项不追加留言，证明留言始终可选。该哨兵不得出现在公共卡或快照中。
6. 重启 Bot，使用先前打开的旧组件触发一次陈旧交互；确认只回读最新状态、不重放旧评分意图。随后重新打开中心核对全部已保存事实。

必须同时满足：

- 最快整体评价路径为“打开中心 + 一次星级点击”，退出不撤销评分。
- 多人同分为“一次多选 + 一次星级点击”；不同分数可分批完成，未选目标保持未评价。
- 每个合法目标只有一条不可变评分；低分无需原因，留言不覆盖评分且每项最多追加一次。
- 旧组件和 Bot 重启不依赖进程内会话，不重复写入；错误只在 ephemeral 中显示，并提供可追踪 request ID。
- 此阶段好评频道保持零消息，订单与所有资金、收益、返佣、派单、准入、权限和处罚事实不变。

记录：桌面与手机完整录屏、每次写入 request ID、Bot 重启时间、旧组件响应截图、API 返回的目标与已保存状态、点击次数统计、业务事实前后对账。

## UAT-2：AT-REVIEW-003 明确同意与隐私播报

当前评价组合应为：订单整体五星；陪玩 A/B 四星；猫舍前台二星并可有私密留言；陪玩 C 未评价。

步骤：

1. 打开“预览可公开的五星好评”，确认预览只列订单整体五星与安全订单摘要。
2. 先点击“仅内部保存”或关闭预览；等待 Worker 一个正常轮询周期，确认好评频道仍为零消息，数据库也没有公开快照。
3. 再次打开预览并点击“同意公开五星好评”；记录 API request ID、publication ID、Outbox ID 和首条 Discord message ID。
4. 确认好评频道恰好一张聚合卡，只列订单整体五星；不得出现三名陪玩的四星/未评价状态、猫舍前台二星或留言、老板身份、金额、钱包、备注或私密频道。
5. 重放同一 Outbox，确认 message ID 不变且没有第二张卡；删除该卡后重试，确认恢复为一个新 message ID 且频道仍恰好一张卡。
6. 在第二个隔离运行中，将配置置空、指向其他 Guild 或移除 Bot 的 View/Send 权限；确认失败关闭，不回退到订单频道、礼物频道或其他频道。

必须同时满足：

- 未明确同意时没有发布事实、Outbox 或公共消息；明确同意后仅冻结当时已有的五星安全快照。
- 一至四星、留言、未评价或非五星对象、客户身份、金额、钱包、私密频道和内部客服身份均不进入公开 payload。
- 重放、Discord 失败和删卡恢复只处理同一发布，不重复评价、不重复快照、不改变任何订单或资金事实。
- 同 Guild 配置缺失、跨 Guild 或权限不足均失败关闭。

记录：两次预览截图、取消后的空频道截图、最终公共卡桌面/手机截图、脱敏 Discord payload、request ID、publication/Outbox/message ID、重放与删卡恢复日志、错误配置日志。

## UAT-3：AT-REVIEW-001/004 对账与负例抽查

由运营/QA 使用统一 API 与只读 SQL 执行：

1. 尝试伪造第四名陪玩、其他订单陪玩、无首响客服、跨 Guild、非订单老板、超过 24 小时和重复目标；每次记录 request ID。
2. 并发提交同一目标两次，确认只有一个成功且没有部分批次。
3. 比较执行前后的订单、row version、预留/捕获、钱包、消费、逐人收益、返佣、派单、准入、权限和处罚事实。

通过标准：所有伪造或越权请求整批零写入；并发只形成一个不可变评价；除评价、可选留言、明确同意的发布快照、Outbox、审计和 Discord 消息外，其他业务事实逐项不变。

## 外部证据与签署

- `AT-REVIEW-002` 主证据放在 `evidence/P0/external/AT-REVIEW-002/result.md`，附桌面/手机录屏或截图的 SHA-256。
- `AT-REVIEW-003` 主证据放在 `evidence/P0/external/AT-REVIEW-003/result.md`，附 payload、Outbox/恢复日志和截图的 SHA-256。
- 主证据必须遵循 `scripts/external-acceptance-results.mjs` 的精确 metadata 与 `Preconditions`、`Steps`、`Expected Result`、`Actual Result`、`Diagnostics` 五段合同，并完成敏感信息脱敏复核。
- 将具名执行人、环境、UTC 时间、完整候选 SHA 和证据哈希追加到 `evidence/P0/external-acceptance-results.json`，重新生成验收矩阵并运行发布门禁。

| 角色    | 姓名 | 设备                      | 结论      | UTC 时间 | 证据路径 |
| ------- | ---- | ------------------------- | --------- | -------- | -------- |
| 老板    |      | 桌面 + 手机               | `PENDING` |          |          |
| 运营/QA |      | Discord + 日志 + 只读对账 | `PENDING` |          |          |

只有 `AT-REVIEW-002` 与 `AT-REVIEW-003` 均有具体实际结果、两类具名签署明确批准、`AT-REVIEW-001/004` 自动与对账门禁通过，并且全仓发布门禁无未豁免失败时，才能把 `M21-US-05` 改为 `DONE`。
