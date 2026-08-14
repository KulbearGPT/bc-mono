# M17 最终人工 Guild UAT 与签署手册

候选：`git:a07814637ca31a66b3b65bb69bac5d5945ab2111`

状态：等待真实用户与具名签署者执行。本文件是执行合同，不是通过证据；未填写实际结果、时间、request ID 和签名之前不得关闭 `M17-US-09`。

## 执行边界

- 仅在 `BUSINESS_ENV=SANDBOX` 的已配置测试 Guild 执行，禁止生产环境、真实资金或第三方支付渠道。
- 只通过正常 Discord Bot 交互和统一业务 API 改变状态；不得直连数据库写入、伪造用户 Token、手改订单/预留或绕过 Actor Context。
- 开始前由 owner 明确指定测试订单。2026-08-06 的只读 preflight 发现一个已有有效预留的待派订单；未取得 owner 明确授权前不得把该订单用于本手册。
- 建议创建专用测试订单；完成后通过正常取消流程释放预留。订单、事件和资金历史为 append-only，不删除或覆盖。
- 每次失败都保留原始时间、request ID 和脱敏截图；候选 commit 变化后两项必须全部重跑。

## UAT-1：失效组件与错误恢复

参与者：一名真实客户；一名观察公共频道的 staff。

前置条件：客户拥有一个 `DRAFT` 测试订单，Bot/API/Worker 均运行候选版本，订单私密频道可访问。

步骤：

1. 客户从服务中心连续打开同一订单的两个私密交互面板，记录两者显示的相同订单版本。
2. 在第一个面板通过正常组件修改备注、套餐或单点项目，使 API 将订单版本从 `vN` 推进到 `vN+1`。
3. 在仍携带 `vN` custom ID 的第二个面板点击会写入的旧组件。
4. 客户刷新订单，再次执行同一合法动作；staff 同时检查公共入口、订单公开消息和 Bot 日志。

必须同时满足：

- Bot 在 API 调用前完成 Discord acknowledgement，不出现“应用程序未响应”。
- 旧组件只返回 ephemeral 失败信息，包含至少八字符的真实 `request_id`；公共频道不出现订单详情、余额或错误内部对象。
- 旧请求不写入部分结果，订单只保留第一步产生的 `vN+1` 事实；刷新后的合法动作可以继续。
- Bot 日志不含 `BOT_SERVICE_TOKEN`、Discord Token、Authorization header 或完整个人敏感数据。

记录栏：

- 执行人：
- UTC 时间：
- 测试订单 public ID：
- 旧版本 / 当前版本：
- request ID：
- 脱敏截图或录屏路径：
- 实际结果：`PENDING`

## UAT-2：多候选终选与权限收敛

参与者：一名真实客户、至少两名不同的真实陪玩账号、一名 staff。客户不能同时作为该订单的陪玩候选。

前置条件：专用测试订单处于 `PENDING_DISPATCH`，原 FundReservation 有效；两个陪玩均为内部审批 `ACTIVE`、同 Guild 且满足订单业务标签；私密文字分类、选秀语音和 staff task 频道配置有效。

步骤：

1. 客户在订单私密频道选择 3 分钟报名窗口；记录 create-selection-pool 的 request ID、pool ID、订单版本和原预留金额。
2. 两名陪玩分别从自己的 `/player-workbench` 打开候选池，并各自通过 String Select 报名同一个仍有席位的需求；记录两个不同 application ID 和 request ID。
3. 客户提前结束报名。等待 Worker 将候选池推进到 `SELECTION`，创建或恢复 `user_limit=0` 的唯一私密语音房，并在订单频道与 staff task 频道发送同一链接。
4. 客户、两名候选和 staff 分别验证选秀阶段的查看/连接权限；由客户使用终选 String Select 只选择其中一名候选。
5. 等待 `FINALIZED` 同步完成，核对正式参与人、文字/语音权限、未入选结果、订单版本、原预留和重复 Worker 投递。
6. 通过正常客户取消或 staff 合同流程结束专用测试订单，确认预留按合同释放；不得直接删除业务数据。

必须同时满足：

- 两个报名事实属于不同真实 Actor；Bot 不接受客户替候选报名，也不信任客户端自报玩家、Guild 或权限。
- 终选由客户一次原子提交；不存在部分入选。正式参与人只包含所选陪玩，剩余席位与下一步来自 API。
- 入选者保留订单文字和语音权限；未入选者被撤销、在语音内时被移出；staff 保留管理权限。
- 选秀语音 `user_limit=0`，重试或 Worker 重启不重复建房、不重复通知。
- 原 FundReservation 在报名与终选期间不重复创建、不捕获；取消时按统一 API 释放。

记录栏：

- 客户执行人：
- 候选 A / B 执行人：
- staff 观察人：
- UTC 起止时间：
- 测试订单 public ID / pool ID：
- create / apply A / apply B / close / finalize request ID：
- 语音频道 ID及终选前后权限截图路径：
- 订单、参与人和 FundReservation 对账证据路径：
- 实际结果：`PENDING`

## M17 候选签署

完成以上两项后，owner 与 staff 必须分别审阅：

- `AT-BOT-REV-001/002` 的真实 Guild 外部证据；
- `AT-BOT-REV-003/004/005` 的自动化与门禁结果；
- 本手册两项的实际记录、失败记录、request ID、截图和清理结果；
- 候选引用仍为 `git:a07814637ca31a66b3b65bb69bac5d5945ab2111`。

签署栏：

| 角色 | 姓名 | 结论 | UTC 时间 | 证据路径 |
|---|---|---|---|---|
| owner |  | `PENDING` |  |  |
| staff |  | `PENDING` |  |  |

只有两项 UAT 均有具体实际结果且两类签署均为明确批准时，才能把 `M17-US-09` 与 `EP-M17` 改为 `DONE`；不得以本手册存在、自动化通过或 Codex 执行人代替真实签署。
